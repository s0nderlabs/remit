// Dashboard REST API (P4's backend). Single-user v1: Bearer REMIT_ADMIN_TOKEN.
// Two issuance lanes:
//   - DEV (server-signed): POST /cards signs the root with the local A_user key.
//   - PRIVY (client-signed): POST /onboard stores the embedded wallet's 7702 auth;
//     POST /cards/prepare returns an UNSIGNED root delegation the browser signs;
//     POST /cards/finalize takes that signature and persists the card. The server
//     never holds A_user's key in the Privy lane. K_agent stays server-side.

import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { Address, Hex } from "viem";
import {
  EngineError,
  RefusalError,
  cardState,
  freezeCard,
  unfreezeCard,
  revokeCard,
  nukeAll,
  issueRootCard,
  prepareRootCard,
  finalizeRootCard,
  readRevocationNonce,
  rotateCardSecret,
  viewCardSecret,
  type CardTerms,
  type PreparedRootCard,
  type Wire7702Auth,
} from "@remit/engine";
import type { AppDeps } from "../deps";
import { cardUrl } from "../mcp/server";

/** Privy-lane user id convention: the embedded (A_user) address, lowercased. One
 * user row per embedded wallet. */
const privyUserId = (address: string): string => address.toLowerCase();

/** Normalize a caller-supplied userId: addresses fold to lowercase (the stored id),
 * non-address ids (e.g. "elpabl0-dev") pass through. */
const normUserId = (s: string): string => (/^0x[0-9a-fA-F]{40}$/.test(s) ? s.toLowerCase() : s);

export function apiRoutes(deps: AppDeps): Hono {
  const app = new Hono();
  const now = () => Math.floor(Date.now() / 1000);

  // Prepared (unsigned) cards awaiting the browser's signature. In-memory, single
  // process, TTL'd — a prepare that never finalizes just expires.
  const pending = new Map<string, { prepared: PreparedRootCard; expires: number }>();
  const PENDING_TTL_MS = 5 * 60_000;
  const gcPending = () => {
    const t = Date.now();
    for (const [k, v] of pending) if (v.expires < t) pending.delete(k);
  };

  // ---- auth ----
  app.use("*", async (c: Context, next: Next) => {
    if (!deps.adminToken) return c.json({ error: "api disabled (no REMIT_ADMIN_TOKEN)" }, 503);
    const m = c.req.header("authorization")?.match(/^Bearer\s+(.+)$/i);
    if (m?.[1] !== deps.adminToken) return c.json({ error: "unauthorized" }, 401);
    await next();
  });

  const handle = async (c: Context, fn: () => Promise<unknown>) => {
    try {
      return c.json((await fn()) as never);
    } catch (e) {
      if (e instanceof RefusalError) return c.json(e.toJSON(), 422);
      if (e instanceof EngineError) return c.json({ status: "error", stage: e.stage, message: e.message }, 502);
      return c.json({ status: "error", message: e instanceof Error ? e.message : String(e) }, 500);
    }
  };

  // ---- Privy lane: onboarding + client-signed issuance ----

  // Onboard: the browser has just created the embedded wallet (A_user) and signed
  // its EIP-7702 authorization. Store the user + the auth (spend/ops consume it as
  // authorizationList until A_user's 7702 code lands) + the current revocation nonce.
  app.post("/onboard", (c) =>
    handle(c, async () => {
      const body = (await c.req.json()) as { address?: Address; auth7702?: Wire7702Auth };
      if (!body.address) throw new RefusalError("invalid_terms", "address required");
      const userId = privyUserId(body.address);
      let nonce = 0n;
      try {
        nonce = await readRevocationNonce(body.address);
      } catch {
        // fresh wallet (no NonceEnforcer state yet) or an RPC blip -> nonce 0
      }
      deps.store.upsertUser({
        id: userId,
        address: body.address,
        auth7702Json: body.auth7702 ? JSON.stringify(body.auth7702) : null,
      });
      deps.store.setRevocationNonce(userId, nonce);
      return {
        user_id: userId,
        address: body.address,
        revocation_nonce: nonce.toString(),
        has_auth7702: !!body.auth7702,
      };
    }),
  );

  // Prepare: compile caveats, mint K_agent, return the UNSIGNED root delegation for
  // the browser to sign. Nothing is persisted until finalize.
  app.post("/cards/prepare", (c) =>
    handle(c, async () => {
      gcPending();
      const body = (await c.req.json()) as { name: string; terms: CardTerms; userAddress?: Address };
      if (!body.userAddress) throw new RefusalError("invalid_terms", "userAddress required (onboard first)");
      const userId = privyUserId(body.userAddress);
      if (!deps.store.getUser(userId)) {
        throw new RefusalError("invalid_terms", "user not onboarded — call /onboard first");
      }
      const prepared = await prepareRootCard(
        { store: deps.store, userAddress: body.userAddress },
        { userId, name: body.name, terms: body.terms },
      );
      pending.set(prepared.prepareId, { prepared, expires: Date.now() + PENDING_TTL_MS });
      return {
        prepare_id: prepared.prepareId,
        chain_id: prepared.chainId,
        k_agent_address: prepared.kAgentAddress,
        // the exact struct the browser must sign (signature: "0x")
        delegation: prepared.delegation,
      };
    }),
  );

  // Finalize: attach the browser's EIP-712 signature and persist the card.
  app.post("/cards/finalize", (c) =>
    handle(c, async () => {
      const body = (await c.req.json()) as { prepare_id?: string; signature?: Hex };
      if (!body.prepare_id || !body.signature) {
        throw new RefusalError("invalid_terms", "prepare_id and signature required");
      }
      const entry = pending.get(body.prepare_id);
      if (!entry) throw new RefusalError("invalid_terms", "unknown or expired prepare_id");
      const issued = await finalizeRootCard({ store: deps.store }, entry.prepared, body.signature);
      // consume only on SUCCESS: a signature that fails recovery can be retried with a
      // corrected one until the TTL expires (the DB primary key backstops any replay)
      pending.delete(body.prepare_id);
      return { card_id: issued.cardId, card_url: cardUrl(issued.secret), terms: issued.terms };
    }),
  );

  // ---- cards ----
  app.post("/cards", (c) =>
    handle(c, async () => {
      if (!deps.userSigner) throw new EngineError("api", "no dev signer configured (REMIT_DEV_USER_PK)");
      const body = (await c.req.json()) as { name: string; terms: CardTerms; userId?: string };
      const userId = normUserId(body.userId ?? "elpabl0-dev");
      deps.store.upsertUser({ id: userId, address: deps.userSigner.address });
      const issued = await issueRootCard(
        { store: deps.store, userSigner: deps.userSigner },
        { userId, name: body.name, terms: body.terms },
      );
      return { card_id: issued.cardId, card_url: cardUrl(issued.secret), terms: issued.terms };
    }),
  );

  app.get("/cards", (c) =>
    handle(c, async () => {
      const userId = normUserId(c.req.query("userId") ?? "elpabl0-dev");
      return deps.store.listCards(userId).map((card) => ({
        ...cardState(deps.store, card.id, now()),
        parent_card_id: card.parent_card_id,
        created_at: card.created_at,
      }));
    }),
  );

  app.get("/cards/:id", (c) =>
    handle(c, async () => {
      const id = c.req.param("id");
      const state = cardState(deps.store, id, now());
      if (!state) throw new RefusalError("card_not_found", "no such card");
      const card = deps.store.getCard(id)!;
      const charges = deps.store.listCharges(id, 50);
      return {
        ...state,
        parent_card_id: card.parent_card_id,
        k_agent_address: card.k_agent_address,
        charges: charges.map((ch) => ({
          id: ch.id,
          kind: ch.kind,
          to: ch.to_addr,
          amount: (Number(ch.amount_atoms) / 1e6).toFixed(6),
          fee: (Number(ch.fee_atoms) / 1e6).toFixed(6),
          status: ch.status,
          tx: ch.tx_hash,
          memo: ch.memo,
          at: ch.created_at,
        })),
      };
    }),
  );

  app.get("/cards/:id/url", (c) =>
    handle(c, async () => {
      const secret = await viewCardSecret(deps.store, c.req.param("id"));
      if (!secret) throw new RefusalError("card_not_found", "no secret on file for this card");
      return { card_url: cardUrl(secret) };
    }),
  );

  app.post("/cards/:id/rotate", (c) =>
    handle(c, async () => {
      const secret = await rotateCardSecret(deps.store, c.req.param("id"));
      return { card_url: cardUrl(secret) };
    }),
  );

  app.post("/cards/:id/freeze", (c) =>
    handle(c, async () => {
      freezeCard(deps.store, c.req.param("id"));
      return { status: "frozen" };
    }),
  );

  app.post("/cards/:id/unfreeze", (c) =>
    handle(c, async () => {
      unfreezeCard(deps.store, c.req.param("id"));
      return { status: "active" };
    }),
  );

  app.post("/cards/:id/revoke", (c) =>
    handle(c, async () => {
      if (!deps.userSigner) throw new EngineError("api", "no dev signer configured");
      const result = await revokeCard(
        { store: deps.store, relayer: deps.relayer, userSigner: deps.userSigner },
        c.req.param("id"),
      );
      return { status: "revoked", tx: result.txHash };
    }),
  );

  app.post("/nuke", (c) =>
    handle(c, async () => {
      if (!deps.userSigner) throw new EngineError("api", "no dev signer configured");
      const body = (await c.req.json().catch(() => ({}))) as { userId?: string };
      const result = await nukeAll(
        { store: deps.store, relayer: deps.relayer, userSigner: deps.userSigner },
        normUserId(body.userId ?? "elpabl0-dev"),
      );
      return { status: "nuked", tx: result.txHash, new_nonce: result.newNonce.toString() };
    }),
  );

  // ---- tree (the demo view's data) ----
  app.get("/tree", (c) =>
    handle(c, async () => {
      const userId = normUserId(c.req.query("userId") ?? "elpabl0-dev");
      const cards = deps.store.listCards(userId);
      type Node = { card: ReturnType<typeof cardState>; children: Node[] };
      const byParent = new Map<string | null, typeof cards>();
      for (const card of cards) {
        const list = byParent.get(card.parent_card_id) ?? [];
        list.push(card);
        byParent.set(card.parent_card_id, list);
      }
      const build = (parentId: string | null): Node[] =>
        (byParent.get(parentId) ?? []).map((card) => ({
          card: cardState(deps.store, card.id, now()),
          children: build(card.id),
        }));
      return { tree: build(null) };
    }),
  );

  return app;
}
