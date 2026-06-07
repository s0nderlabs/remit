// Stripe real-time auth webhook tests: realistic signed events against the live route.
// Approve in-budget / decline over-budget off the SAME card budget the on-chain
// delegation governs; signature + replay + latency (2s wall) all covered.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { Store, issueRootCard, issueSubCard, freezeCard, unfreezeCard, type Relayer } from "@remit/engine";
import { createApp } from "../src/app";
import type { AppDeps } from "../src/deps";
import { verifyStripeSignature } from "../src/stripe/routes";

const user = privateKeyToAccount(generatePrivateKey());
const WHSEC = "whsec_test_secret_for_remit";

let server: ReturnType<typeof Bun.serve>;
let base: string;
let store: Store;
let cardId: string;

beforeAll(async () => {
  process.env.REMIT_MASTER_KEY = "f".repeat(64);
  process.env.REMIT_STRIPE_WEBHOOK_SECRET = WHSEC;
  store = new Store(":memory:");
  const deps: AppDeps = {
    store,
    relayer: {} as Relayer, // webhook path never touches the relayer (2s rule)
    userSigner: user,
    adminToken: null,
    verifyPrivyToken: null,
  };
  server = Bun.serve({ port: 0, fetch: createApp(deps).fetch });
  base = `http://localhost:${server.port}`;
  store.upsertUser({ id: "u-stripe", address: user.address });
  const issued = await issueRootCard(
    { store, userSigner: user, revocationNonceOverride: 0n },
    { userId: "u-stripe", name: "visa-linked card", terms: { pay: { period: { amount: "10", seconds: 604800 } } } },
  );
  cardId = issued.cardId;
});

afterAll(() => {
  server.stop(true);
  delete process.env.REMIT_STRIPE_WEBHOOK_SECRET;
});

async function sign(body: string, secret = WHSEC, t = Math.floor(Date.now() / 1000)): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${body}`)));
  return `t=${t},v1=${[...mac].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function authEvent(id: string, amountCents: number, remitCardId: string | null): string {
  return JSON.stringify({
    type: "issuing_authorization.request",
    data: {
      object: {
        id,
        amount: 0,
        currency: "usd",
        pending_request: { amount: amountCents, currency: "usd" },
        card: { id: "ic_test", metadata: remitCardId ? { remit_card_id: remitCardId } : {} },
      },
    },
  });
}

async function post(body: string, sigHeader?: string) {
  const t0 = Date.now();
  const res = await fetch(`${base}/stripe/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": sigHeader ?? (await sign(body)) },
    body,
  });
  return { res, ms: Date.now() - t0, body: (await res.json()) as { approved?: boolean; error?: string } };
}

describe("signature", () => {
  test("valid signature verifies; tampered/stale/missing rejected", async () => {
    const body = authEvent("iauth_1", 100, cardId);
    expect(await verifyStripeSignature(body, await sign(body), WHSEC)).toBe(true);
    expect(await verifyStripeSignature(body + " ", await sign(body), WHSEC)).toBe(false);
    expect(await verifyStripeSignature(body, await sign(body, "whsec_wrong"), WHSEC)).toBe(false);
    expect(await verifyStripeSignature(body, await sign(body, WHSEC, 1000), WHSEC)).toBe(false); // stale t
    expect(await verifyStripeSignature(body, undefined, WHSEC)).toBe(false);
    const { res } = await post(body, "t=1,v1=dead");
    expect(res.status).toBe(400);
  });
});

describe("the 2s decision", () => {
  test("in-budget APPROVES fast and consumes budget; over-budget DECLINES", async () => {
    // $4.00 on a $10/week card -> approve
    const a1 = await post(authEvent("iauth_a1", 400, cardId));
    expect(a1.res.status).toBe(200);
    expect(a1.body.approved).toBe(true);
    expect(a1.res.headers.get("stripe-version")).toBe("2025-03-31.basil");
    expect(a1.ms).toBeLessThan(2000);

    // $4.00 again -> approve (8 total)
    const a2 = await post(authEvent("iauth_a2", 400, cardId));
    expect(a2.body.approved).toBe(true);

    // $4.00 again -> DECLINE (12 > 10)
    const a3 = await post(authEvent("iauth_a3", 400, cardId));
    expect(a3.body.approved).toBe(false);

    // $1.50 still fits (8 + 1.5 <= 10)
    const a4 = await post(authEvent("iauth_a4", 150, cardId));
    expect(a4.body.approved).toBe(true);
  });

  test("duplicate delivery: approved again, budget NOT double-counted", async () => {
    const before = store.subtreeSpentLifetime(cardId);
    const dup = await post(authEvent("iauth_a1", 400, cardId)); // same id as the first
    expect(dup.body.approved).toBe(true);
    expect(store.subtreeSpentLifetime(cardId)).toBe(before);
  });

  test("frozen card declines; unknown mapping declines; non-usd declines", async () => {
    freezeCard(store, cardId);
    const frozen = await post(authEvent("iauth_f", 100, cardId));
    expect(frozen.body.approved).toBe(false);
    const { unfreezeCard } = await import("@remit/engine");
    unfreezeCard(store, cardId);

    const unmapped = await post(authEvent("iauth_u", 100, null));
    expect(unmapped.body.approved).toBe(false);

    const eur = JSON.parse(authEvent("iauth_e", 100, cardId));
    eur.data.object.pending_request.currency = "eur";
    const eurRes = await post(JSON.stringify(eur));
    expect(eurRes.body.approved).toBe(false);
  });

  test("crypto charges and visa-sim share ONE budget", async () => {
    // simulate an on-chain charge consuming most of the remaining window
    store.insertCharge({
      id: crypto.randomUUID(), card_id: cardId, idempotency_key: null, kind: "pay",
      to_addr: null, amount_atoms: 400_000n, fee_atoms: 10_000n, request_id: null,
      tx_hash: "0xcrypto" as never, status: "confirmed", memo: "on-chain leg", created_at: Math.floor(Date.now() / 1000),
    });
    // spent so far: 9.50 (visa) + 0.41 (crypto) = 9.91; $0.10 fits, $0.20 doesn't
    const fits = await post(authEvent("iauth_mix1", 9, cardId));
    expect(fits.body.approved).toBe(true);
    const over = await post(authEvent("iauth_mix2", 20, cardId));
    expect(over.body.approved).toBe(false);
  });
});

describe("sub-card ancestor enforcement (the decision walks the whole chain)", () => {
  test("a frozen PARENT declines an active sub-card's Visa charge", async () => {
    const root = await issueRootCard(
      { store, userSigner: user, revocationNonceOverride: 0n },
      { userId: "u-stripe", name: "freeze-parent", terms: { pay: { period: { amount: "10", seconds: 604800 } }, subcards: true } },
    );
    const sub = await issueSubCard(
      { store },
      { parentCardId: root.cardId, name: "freeze-child", terms: { pay: { period: { amount: "5", seconds: 604800 } } } },
    );
    // the sub-card is in budget on its own AND under the parent -> approve
    expect((await post(authEvent("iauth_sub_ok", 100, sub.cardId))).body.approved).toBe(true);
    // freeze only the PARENT; the sub-card row is still "active" but must now decline
    freezeCard(store, root.cardId);
    expect((await post(authEvent("iauth_sub_frozen", 100, sub.cardId))).body.approved).toBe(false);
    unfreezeCard(store, root.cardId); // leave no frozen state behind in the shared store
  });

  test("the PARENT's budget bounds the sub-card, even when the sub-card alone would fit", async () => {
    const root = await issueRootCard(
      { store, userSigner: user, revocationNonceOverride: 0n },
      { userId: "u-stripe", name: "budget-parent", terms: { pay: { period: { amount: "5", seconds: 604800 } }, subcards: true } },
    );
    // two siblings each capped at the full parent budget ($5) — legal nesting
    const a = await issueSubCard({ store }, { parentCardId: root.cardId, name: "sib-a", terms: { pay: { period: { amount: "5", seconds: 604800 } } } });
    const b = await issueSubCard({ store }, { parentCardId: root.cardId, name: "sib-b", terms: { pay: { period: { amount: "5", seconds: 604800 } } } });
    // $4 through A -> fits ($4 <= parent $5)
    expect((await post(authEvent("iauth_sib_a", 400, a.cardId))).body.approved).toBe(true);
    // $4 through B fits B's OWN cap ($4 <= $5) but the parent subtree is now $8 > $5 -> decline
    expect((await post(authEvent("iauth_sib_b", 400, b.cardId))).body.approved).toBe(false);
  });
});
