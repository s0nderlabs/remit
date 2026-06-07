// Stripe Issuing real-time authorization webhook (SIMULATED Visa leg, test-mode-only
// forever — locked). The HARD constraint: synchronous {"approved": bool} within a
// 2-SECOND window, decided ENTIRELY from the local card snapshot. NEVER an RPC call
// in this handler.
//
// Mapping: the Issuing card carries metadata.remit_card_id; an approved authorization
// records a fee-less charge against the SAME card budget the on-chain delegation
// governs ("one delegation, crypto leg AND Visa leg"). USD cents -> USDC atoms x10^4.
//
// Signature verification: stripe-signature header (t=...,v1=HMAC-SHA256(`${t}.${body}`))
// via WebCrypto; secret in REMIT_STRIPE_WEBHOOK_SECRET.

import { Hono } from "hono";
import { cardState, periodWindow, usdcToAtoms, type Store } from "@remit/engine";
import type { AppDeps } from "../deps";

const STRIPE_VERSION = "2025-03-31.basil";
const TOLERANCE_S = 300;

// ---------------------------------------------------------------------------
// signature verification (WebCrypto, no stripe SDK)
// ---------------------------------------------------------------------------

export async function verifyStripeSignature(
  body: string,
  header: string | undefined,
  secret: string,
  nowS = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  if (!header) return false;
  const parts = Object.fromEntries(
    header.split(",").map((kv) => kv.split("=", 2) as [string, string]),
  ) as Record<string, string>;
  const t = Number(parts.t);
  if (!Number.isFinite(t) || Math.abs(nowS - t) > TOLERANCE_S) return false;
  const v1 = parts.v1;
  if (!v1) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${parts.t}.${body}`)));
  const expected = [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
  // constant-time-ish compare
  if (expected.length !== v1.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ v1.charCodeAt(i);
  return diff === 0;
}

// ---------------------------------------------------------------------------
// the 2s decision (cache-only)
// ---------------------------------------------------------------------------

export function decideAuthorization(
  store: Store,
  remitCardId: string,
  amountCents: number,
  nowS: number,
): { approved: boolean; reason: string } {
  // Walk the WHOLE ancestor chain (leaf first, root last) exactly like spend.ts: a
  // sub-card's Visa charge must respect every ancestor's freeze, expiry, and budget,
  // not just the mapped card's. ancestorChain reads only local rows, so this stays
  // inside Stripe's 2s window (no RPC).
  const chain = store.ancestorChain(remitCardId);
  if (chain.length === 0) return { approved: false, reason: "unknown_card" };

  const amountAtoms = BigInt(amountCents) * 10_000n; // cents -> 6-dec atoms
  for (const card of chain) {
    const isLeaf = card.id === remitCardId;
    if (card.status !== "active") {
      return { approved: false, reason: isLeaf ? `card_${card.status}` : `ancestor_${card.status}` };
    }
    if (card.terms.expiry !== undefined && nowS >= card.terms.expiry) {
      return { approved: false, reason: isLeaf ? "card_expired" : "ancestor_expired" };
    }
    if (card.compiled.carvePolicy.perTxMaxAtoms !== null && amountAtoms > card.compiled.carvePolicy.perTxMaxAtoms) {
      return { approved: false, reason: "per_tx_exceeded" };
    }
    // uses (limitedCalls mirror, same walk as spend.ts): a maxUses card must not keep
    // approving Visa charges after the redemption cap the rest of the system enforces
    if (card.terms.maxUses !== undefined && store.subtreeUsesCount(card.id) >= card.terms.maxUses) {
      return { approved: false, reason: "uses_exhausted" };
    }
    const pay = card.terms.pay;
    if (!pay) {
      // the mapped card itself must be spendable; a pay-less ANCESTOR (contract-only)
      // imposes no budget and is skipped (status/expiry above still bind it).
      if (isLeaf) return { approved: false, reason: "no_pay_capability" };
      continue;
    }
    if (pay.period && card.compiled.periodStartDate !== null) {
      const w = periodWindow(card.compiled.periodStartDate, pay.period.seconds, nowS);
      const spent = store.subtreeSpentSince(card.id, w.start);
      if (spent + amountAtoms > usdcToAtoms(pay.period.amount)) {
        return { approved: false, reason: "over_period_limit" };
      }
    }
    if (pay.lifetime) {
      const spent = store.subtreeSpentLifetime(card.id);
      if (spent + amountAtoms > usdcToAtoms(pay.lifetime.amount)) {
        return { approved: false, reason: "over_lifetime_limit" };
      }
    }
  }
  return { approved: true, reason: "in_budget" };
}

// ---------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------

export function stripeRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  app.post("/stripe/webhook", async (c) => {
    const secret = process.env.REMIT_STRIPE_WEBHOOK_SECRET;
    if (!secret) return c.json({ error: "webhook not configured" }, 503);
    const body = await c.req.text();
    if (!(await verifyStripeSignature(body, c.req.header("stripe-signature"), secret))) {
      return c.json({ error: "bad signature" }, 400);
    }

    const event = JSON.parse(body) as {
      type: string;
      data: {
        object: {
          id: string;
          amount?: number;
          currency?: string;
          pending_request?: { amount?: number; currency?: string } | null;
          card?: { id?: string; metadata?: Record<string, string> } | null;
        };
      };
    };

    if (event.type !== "issuing_authorization.request") {
      return c.json({ received: true }); // other events: ack only
    }

    const auth = event.data.object;
    const nowS = Math.floor(Date.now() / 1000);
    const remitCardId = auth.card?.metadata?.remit_card_id;
    const currency = auth.pending_request?.currency ?? auth.currency ?? "usd";
    const amountCentsRaw = auth.pending_request?.amount ?? auth.amount;
    const amountCents = amountCentsRaw ?? 0;

    let approved = false;
    let reason = "no_remit_card_mapping";
    if (currency !== "usd") {
      reason = "unsupported_currency";
    } else if (amountCentsRaw === undefined || !Number.isInteger(amountCentsRaw) || amountCentsRaw < 0) {
      // absent/malformed amount fails CLOSED (an explicit 0 still passes: that's a
      // legitimate zero-dollar verification, and it consumes no budget)
      reason = "invalid_amount";
    } else if (remitCardId && deps.store.chargeByIdempotency(remitCardId, `stripe-${auth.id}`)) {
      // at-least-once delivery: same authorization MUST get the original answer,
      // not a re-decision against the budget it already consumed
      approved = true;
      reason = "duplicate_delivery";
    } else if (remitCardId) {
      // CONCURRENCY CONTRACT (vs the crypto leg sharing this budget): this decide ->
      // insert block is fully SYNCHRONOUS (single-threaded runtime: nothing interleaves
      // inside it), and the crypto spend pipeline re-validates the budget in its own
      // synchronous validate+insert pair right before reserving. Together those make
      // fiat/crypto overspend impossible WITHOUT this handler taking the spend mutex —
      // which it must never do: the mutex is held across up-to-90s on-chain
      // confirmations, and Stripe's sync reply window is a hard 2 seconds.
      const decision = decideAuthorization(deps.store, remitCardId, amountCents, nowS);
      approved = decision.approved;
      reason = decision.reason;

      if (approved) {
        // count the simulated Visa charge against the SAME budget (fee-less);
        // idempotency key dedupes Stripe's at-least-once delivery
        try {
          deps.store.insertCharge({
            id: crypto.randomUUID(),
            card_id: remitCardId,
            idempotency_key: `stripe-${auth.id}`,
            kind: "admin",
            to_addr: null,
            amount_atoms: BigInt(amountCents) * 10_000n,
            fee_atoms: 0n,
            request_id: auth.id,
            tx_hash: null,
            status: "confirmed",
            memo: `visa-sim authorization ${auth.id} (${reason})`,
            created_at: nowS,
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (/UNIQUE constraint failed/i.test(msg)) {
            // duplicate delivery raced past the chargeByIdempotency check: keep the
            // original decision (the first insert already holds the budget)
          } else {
            // the approval could not be persisted; approving without a ledger row
            // would make this spend invisible to every future budget check -> fail closed
            approved = false;
            reason = "persist_failed";
            console.error(`[stripe] charge persist failed for ${auth.id}: ${msg}`);
          }
        }
      }
    }

    console.log(`[stripe] issuing_authorization.request ${auth.id}: ${approved ? "APPROVE" : "DECLINE"} (${reason})`);
    c.header("Stripe-Version", STRIPE_VERSION);
    return c.json({ approved });
  });

  return app;
}
