// Dashboard REST API. Two auth lanes on every /api route:
//   - ADMIN (ops): Bearer REMIT_ADMIN_TOKEN — full access, server-side curl/scripts.
//   - PRIVY (dashboard): Bearer <Privy access token>, verified offline against the
//     app JWKS. Every read/control is scoped to the cards of the AUTHENTICATED user.
//     The wallet<->login binding is PROVEN at onboard: the embedded wallet signs
//     "remit-onboard:v1:<did>" (personal_sign), so a Privy login can only ever claim
//     an address whose key it holds — and the DID inside the message kills replay.
// Two issuance lanes:
//   - DEV (server-signed): POST /cards signs the root with the local A_user key (admin only).
//   - PRIVY (client-signed): POST /onboard stores the embedded wallet's 7702 auth;
//     POST /cards/prepare returns an UNSIGNED root delegation the browser signs;
//     POST /cards/finalize takes that signature and persists the card. The server
//     never holds A_user's key in the Privy lane. K_agent stays server-side.

import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import { isAddressEqual, recoverMessageAddress } from "viem";
import type { Address, Hex } from "viem";
import {
  EngineError,
  RefusalError,
  cardState,
  finalizeAdminOp,
  freezeCard,
  unfreezeCard,
  revokeCard,
  nukeAll,
  issueRootCard,
  prepareNuke,
  prepareRevoke,
  prepareRootCard,
  finalizeRootCard,
  readRevocationNonce,
  rotateCardSecret,
  viewCardSecret,
  type CardRow,
  type CardTerms,
  type PreparedAdminOp,
  type PreparedRootCard,
  type UserRow,
  type Wire7702Auth,
} from "@remit/engine";
import type { AppDeps } from "../deps";
import { cardUrl } from "../mcp/server";
import { onboardProofMessage } from "./privy";

/** Privy-lane user id convention: the embedded (A_user) address, lowercased. One
 * user row per embedded wallet. */
const privyUserId = (address: string): string => address.toLowerCase();

/** Normalize a caller-supplied userId: addresses fold to lowercase (the stored id),
 * non-address ids (e.g. "elpabl0-dev") pass through. */
const normUserId = (s: string): string => (/^0x[0-9a-fA-F]{40}$/.test(s) ? s.toLowerCase() : s);

/** Constant-time bearer compare (hash both sides so length differences don't leak). */
const tokenEqual = (a: string, b: string): boolean =>
  timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());

type AuthCtx = { kind: "admin" } | { kind: "privy"; did: string };

/** Auth/scoping failure: a 403, distinct from engine refusals (422). */
class ForbiddenError extends Error {}

export function apiRoutes(deps: AppDeps): Hono<{ Variables: { auth: AuthCtx } }> {
  const app = new Hono<{ Variables: { auth: AuthCtx } }>();
  const now = () => Math.floor(Date.now() / 1000);

  // Prepared (unsigned) cards awaiting the browser's signature. In-memory, single
  // process, TTL'd — a prepare that never finalizes just expires.
  const pending = new Map<string, { prepared: PreparedRootCard; expires: number }>();
  const PENDING_TTL_MS = 5 * 60_000;
  const gcPending = () => {
    const t = Date.now();
    for (const [k, v] of pending) if (v.expires < t) pending.delete(k);
  };

  // Prepared admin ops (client-signed revoke/nuke). STRICTER than card prepares: a
  // SIGNED admin leaf is live spend authority (admin call + fee transfer), so these
  // get a 2-minute TTL (enforced at finalize, not just opportunistic GC) and are
  // single-use — consumed the instant the signature verifies, BEFORE the relayer send,
  // never re-finalizable past that point. `inProgress` is the SYNCHRONOUS claim: two
  // concurrent finalizes both pass Map.get before the first await, so the flag (set
  // before any await) is what actually makes single-use atomic.
  const pendingAdmin = new Map<string, { prepared: PreparedAdminOp; expires: number; inProgress?: boolean }>();
  const ADMIN_TTL_MS = 2 * 60_000;
  const gcAdmin = () => {
    const t = Date.now();
    for (const [k, v] of pendingAdmin) if (v.expires < t) pendingAdmin.delete(k);
  };
  /** finalize deps for client-signed admin ops (test seams ride in via opsOverrides) */
  const adminFinalizeDeps = () => ({ store: deps.store, relayer: deps.relayer, ...(deps.opsOverrides ?? {}) });

  // ---- auth: admin token (ops) OR verified Privy session (dashboard) ----
  app.use("*", async (c: Context<{ Variables: { auth: AuthCtx } }>, next: Next) => {
    if (!deps.adminToken && !deps.verifyPrivyToken) {
      return c.json({ error: "api disabled (no REMIT_ADMIN_TOKEN and no REMIT_PRIVY_APP_ID)" }, 503);
    }
    const token = c.req.header("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (token) {
      if (deps.adminToken && tokenEqual(token, deps.adminToken)) {
        c.set("auth", { kind: "admin" });
        return next();
      }
      if (deps.verifyPrivyToken) {
        const verified = await deps.verifyPrivyToken(token);
        if (verified) {
          c.set("auth", { kind: "privy", did: verified.did });
          return next();
        }
      }
    }
    return c.json({ error: "unauthorized" }, 401);
  });

  const handle = async (c: Context<{ Variables: { auth: AuthCtx } }>, fn: () => Promise<unknown>) => {
    try {
      return c.json((await fn()) as never);
    } catch (e) {
      if (e instanceof ForbiddenError) return c.json({ error: e.message }, 403);
      if (e instanceof RefusalError) return c.json(e.toJSON(), 422);
      if (e instanceof EngineError) return c.json({ status: "error", stage: e.stage, message: e.message }, 502);
      return c.json({ status: "error", message: e instanceof Error ? e.message : String(e) }, 500);
    }
  };

  // ---- scoping helpers ----

  /** The onboarded user bound to the authenticated Privy DID (privy lane only). */
  const boundUser = (c: Context<{ Variables: { auth: AuthCtx } }>): UserRow => {
    const auth = c.get("auth");
    if (auth.kind !== "privy") throw new ForbiddenError("privy session required");
    const user = deps.store.getUserByPrivyDid(auth.did);
    if (!user) throw new ForbiddenError("not onboarded — sign in on the dashboard first");
    return user;
  };

  /** The userId this request may act for: admin picks (query/body), privy is pinned. */
  const scopedUserId = (c: Context<{ Variables: { auth: AuthCtx } }>, requested?: string): string =>
    c.get("auth").kind === "admin" ? normUserId(requested ?? "elpabl0-dev") : boundUser(c).id;

  /** Card lookup that refuses to reveal other users' cards (same shape as not-found). */
  const ownedCard = (c: Context<{ Variables: { auth: AuthCtx } }>, id: string): CardRow => {
    const card = deps.store.getCard(id);
    if (!card || (c.get("auth").kind === "privy" && card.user_id !== boundUser(c).id)) {
      throw new RefusalError("card_not_found", "no such card");
    }
    return card;
  };

  const adminOnly = (c: Context<{ Variables: { auth: AuthCtx } }>): void => {
    if (c.get("auth").kind !== "admin") throw new ForbiddenError("admin token required");
  };

  // ---- Privy lane: onboarding + client-signed issuance ----

  // Onboard: the browser has just created the embedded wallet (A_user) and signed
  // its EIP-7702 authorization. Store the user + the auth (spend/ops consume it as
  // authorizationList until A_user's 7702 code lands) + the current revocation nonce.
  // In the privy lane the request must also carry the onboard PROOF (personal_sign
  // over "remit-onboard:v1:<did>"): possession of the key, bound to THIS login.
  app.post("/onboard", (c) =>
    handle(c, async () => {
      const body = (await c.req.json()) as { address?: Address; auth7702?: Wire7702Auth; proof?: Hex };
      if (!body.address) throw new RefusalError("invalid_terms", "address required");
      const userId = privyUserId(body.address);
      const auth = c.get("auth");

      let privyDid: string | undefined;
      if (auth.kind === "privy") {
        if (!body.proof) throw new RefusalError("invalid_terms", "onboard proof signature required");
        let signer: Address;
        try {
          signer = await recoverMessageAddress({ message: onboardProofMessage(auth.did), signature: body.proof });
        } catch {
          throw new RefusalError("invalid_terms", "onboard proof is not a valid signature");
        }
        if (!isAddressEqual(signer, body.address)) {
          throw new RefusalError("invalid_terms", "onboard proof does not recover to the wallet address");
        }
        // binding conflicts (belt and suspenders — the proof already makes cross-claims unforgeable)
        const byDid = deps.store.getUserByPrivyDid(auth.did);
        if (byDid && byDid.id !== userId) {
          throw new ForbiddenError("this login is already bound to a different wallet");
        }
        const existing = deps.store.getUser(userId);
        if (existing?.privy_did && existing.privy_did !== auth.did) {
          throw new ForbiddenError("this wallet is already bound to a different login");
        }
        privyDid = auth.did;
      }

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
        privyDid,
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
  // the browser to sign. Nothing is persisted until finalize. Privy callers are
  // pinned to their own onboarded wallet; admin supplies userAddress explicitly.
  app.post("/cards/prepare", (c) =>
    handle(c, async () => {
      gcPending();
      const body = (await c.req.json()) as { name: string; terms: CardTerms; userAddress?: Address };
      let userAddress: Address;
      if (c.get("auth").kind === "privy") {
        userAddress = boundUser(c).address;
      } else {
        if (!body.userAddress) throw new RefusalError("invalid_terms", "userAddress required (onboard first)");
        userAddress = body.userAddress;
      }
      const userId = privyUserId(userAddress);
      if (!deps.store.getUser(userId)) {
        throw new RefusalError("invalid_terms", "user not onboarded — call /onboard first");
      }
      const prepared = await prepareRootCard(
        { store: deps.store, userAddress },
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

  // Finalize: attach the browser's EIP-712 signature and persist the card. A privy
  // caller can only finalize their OWN prepare (foreign ids look nonexistent).
  app.post("/cards/finalize", (c) =>
    handle(c, async () => {
      const body = (await c.req.json()) as { prepare_id?: string; signature?: Hex };
      if (!body.prepare_id || !body.signature) {
        throw new RefusalError("invalid_terms", "prepare_id and signature required");
      }
      const entry = pending.get(body.prepare_id);
      if (
        !entry ||
        entry.expires < Date.now() || // TTL enforced at finalize, not just prepare-path GC
        (c.get("auth").kind === "privy" && entry.prepared.userId !== boundUser(c).id)
      ) {
        throw new RefusalError("invalid_terms", "unknown or expired prepare_id");
      }
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
      adminOnly(c); // server-signed dev lane: signs with the SERVER key, never user-facing
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
      const userId = scopedUserId(c, c.req.query("userId"));
      return deps.store.listCards(userId).map((card) => ({
        ...cardState(deps.store, card.id, now()),
        parent_card_id: card.parent_card_id,
        created_at: card.created_at,
      }));
    }),
  );

  app.get("/cards/:id", (c) =>
    handle(c, async () => {
      const card = ownedCard(c, c.req.param("id"));
      const state = cardState(deps.store, card.id, now());
      if (!state) throw new RefusalError("card_not_found", "no such card");
      const charges = deps.store.listCharges(card.id, 50);
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
      const card = ownedCard(c, c.req.param("id"));
      const secret = await viewCardSecret(deps.store, card.id);
      if (!secret) throw new RefusalError("card_not_found", "no secret on file for this card");
      return { card_url: cardUrl(secret) };
    }),
  );

  app.post("/cards/:id/rotate", (c) =>
    handle(c, async () => {
      const card = ownedCard(c, c.req.param("id"));
      const secret = await rotateCardSecret(deps.store, card.id);
      return { card_url: cardUrl(secret) };
    }),
  );

  app.post("/cards/:id/freeze", (c) =>
    handle(c, async () => {
      freezeCard(deps.store, ownedCard(c, c.req.param("id")).id);
      return { status: "frozen" };
    }),
  );

  app.post("/cards/:id/unfreeze", (c) =>
    handle(c, async () => {
      unfreezeCard(deps.store, ownedCard(c, c.req.param("id")).id);
      return { status: "active" };
    }),
  );

  // ---- client-signed revoke/nuke (the Privy lane): prepare -> browser signs -> finalize ----

  // Step 1: build the admin leaf for the browser to sign. Sub-cards die server-side
  // immediately (their on-chain delegator is the parent's K_agent, not A_user — there
  // is nothing for the user to sign).
  app.post("/cards/:id/revoke/prepare", (c) =>
    handle(c, async () => {
      gcAdmin();
      const card = ownedCard(c, c.req.param("id"));
      const result = prepareRevoke({ store: deps.store }, card.id);
      if ("done" in result) return { status: "revoked", onchain: false };
      pendingAdmin.set(result.prepareId, { prepared: result, expires: Date.now() + ADMIN_TTL_MS });
      return {
        prepare_id: result.prepareId,
        chain_id: result.chainId,
        kind: result.kind,
        // the exact admin leaf the browser must sign (signature: "0x")
        delegation: result.delegation,
      };
    }),
  );

  // Step 2: attach the signature and execute the on-chain disableDelegation.
  app.post("/cards/:id/revoke/finalize", (c) =>
    handle(c, async () => {
      const body = (await c.req.json()) as { prepare_id?: string; signature?: Hex };
      if (!body.prepare_id || !body.signature) {
        throw new RefusalError("invalid_terms", "prepare_id and signature required");
      }
      const card = ownedCard(c, c.req.param("id")); // foreign cards look nonexistent
      const entry = pendingAdmin.get(body.prepare_id);
      if (
        !entry ||
        entry.expires < Date.now() || // TTL enforced HERE, not just by prepare-path GC
        entry.prepared.kind !== "revoke" ||
        entry.prepared.cardId !== card.id ||
        (c.get("auth").kind === "privy" && entry.prepared.userId !== boundUser(c).id)
      ) {
        throw new RefusalError("invalid_terms", "unknown or expired prepare_id");
      }
      if (entry.inProgress) throw new RefusalError("invalid_terms", "finalize already in progress");
      entry.inProgress = true; // synchronous claim: blocks a concurrent double-fire
      try {
        const result = await finalizeAdminOp(adminFinalizeDeps(), entry.prepared, body.signature, {
          // single-use: consumed the moment the signature verifies (a bad signature is
          // retryable until the TTL; a verified one must never finalize twice)
          onValidated: () => pendingAdmin.delete(body.prepare_id!),
        });
        return { status: "revoked", tx: result.txHash };
      } finally {
        entry.inProgress = false; // no-op if consumed; re-arms retry on a bad signature
      }
    }),
  );

  app.post("/nuke/prepare", (c) =>
    handle(c, async () => {
      gcAdmin();
      const body = (await c.req.json().catch(() => ({}))) as { userId?: string };
      const prepared = prepareNuke({ store: deps.store }, scopedUserId(c, body.userId));
      pendingAdmin.set(prepared.prepareId, { prepared, expires: Date.now() + ADMIN_TTL_MS });
      return {
        prepare_id: prepared.prepareId,
        chain_id: prepared.chainId,
        kind: prepared.kind,
        delegation: prepared.delegation,
      };
    }),
  );

  app.post("/nuke/finalize", (c) =>
    handle(c, async () => {
      const body = (await c.req.json()) as { prepare_id?: string; signature?: Hex };
      if (!body.prepare_id || !body.signature) {
        throw new RefusalError("invalid_terms", "prepare_id and signature required");
      }
      const entry = pendingAdmin.get(body.prepare_id);
      if (
        !entry ||
        entry.expires < Date.now() || // TTL enforced HERE, not just by prepare-path GC
        entry.prepared.kind !== "nuke" ||
        (c.get("auth").kind === "privy" && entry.prepared.userId !== boundUser(c).id)
      ) {
        throw new RefusalError("invalid_terms", "unknown or expired prepare_id");
      }
      if (entry.inProgress) throw new RefusalError("invalid_terms", "finalize already in progress");
      entry.inProgress = true; // synchronous claim: blocks a concurrent double-fire
      try {
        const result = await finalizeAdminOp(adminFinalizeDeps(), entry.prepared, body.signature, {
          onValidated: () => pendingAdmin.delete(body.prepare_id!),
        });
        return { status: "nuked", tx: result.txHash, new_nonce: result.newNonce!.toString() };
      } finally {
        entry.inProgress = false;
      }
    }),
  );

  app.post("/cards/:id/revoke", (c) =>
    handle(c, async () => {
      // server-signed (deps.userSigner = the dev key), like /cards and /nuke: admin-only.
      // The privy lane revokes client-side via /revoke/prepare + /revoke/finalize above.
      adminOnly(c);
      const card = ownedCard(c, c.req.param("id"));
      if (!deps.userSigner) throw new EngineError("api", "no dev signer configured");
      const result = await revokeCard(
        { store: deps.store, relayer: deps.relayer, userSigner: deps.userSigner },
        card.id,
      );
      return { status: "revoked", tx: result.txHash };
    }),
  );

  app.post("/nuke", (c) =>
    handle(c, async () => {
      adminOnly(c); // server-signed; the privy lane gets a client-signed nuke (wired separately)
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
      const userId = scopedUserId(c, c.req.query("userId"));
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
