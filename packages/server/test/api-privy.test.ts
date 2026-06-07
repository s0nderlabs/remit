// The Privy issuance lane, offline: onboard the embedded wallet, prepare an UNSIGNED
// root delegation, sign it the way the browser does (SAK signDelegation — here a local
// key plays the Privy embedded wallet), finalize, and confirm the card lands in the
// tree through the REAL Hono app + real store. No relayer, no chain writes; the onboard
// nonce read points at an unreachable RPC and falls back to 0.
//
// AUTH under test: the admin/ops lane (full access) AND the per-user Privy session
// lane — a FAKE verifier stands in for JWKS verification ("pt-<name>" -> did:privy:<name>),
// so the scoping rules run offline against the real middleware.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  Store,
  userSmartAccount,
  signWithSmartAccount,
  type Relayer,
  type WireDelegation,
} from "@remit/engine";
import { createApp } from "../src/app";
import type { AppDeps } from "../src/deps";
import { onboardProofMessage } from "../src/api/privy";

const user = privateKeyToAccount(generatePrivateKey());
const userId = user.address.toLowerCase();
const ADMIN = "test-admin";

let server: ReturnType<typeof Bun.serve>;
let base: string;
let store: Store;

beforeAll(() => {
  process.env.REMIT_MASTER_KEY = "e".repeat(64);
  // unreachable RPC: onboard's on-chain nonce read fails fast and falls back to 0
  process.env.REMIT_RPC_URL = "http://127.0.0.1:1";
  store = new Store(":memory:");
  const deps: AppDeps = {
    store,
    relayer: {} as unknown as Relayer, // this lane never touches the relayer
    userSigner: null,
    adminToken: ADMIN,
    // fake Privy verifier: "pt-<name>" is a valid session for did:privy:<name>
    verifyPrivyToken: async (token) => (token.startsWith("pt-") ? { did: `did:privy:${token.slice(3)}` } : null),
  };
  server = Bun.serve({ port: 0, fetch: createApp(deps).fetch });
  base = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop(true);
  delete process.env.REMIT_RPC_URL;
});

const postAs = (bearer: string, path: string, body: unknown) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const getAs = (bearer: string, path: string) =>
  fetch(`${base}${path}`, { headers: { authorization: `Bearer ${bearer}` } });
const post = (path: string, body: unknown) => postAs(ADMIN, path, body);
const get = (path: string) => getAs(ADMIN, path);

describe("Privy lane: onboard + client-signed issuance", () => {
  test("onboard stores the user + 7702 auth", async () => {
    const auth7702 = {
      chainId: "0x2105",
      address: ("0x" + "1".repeat(40)) as `0x${string}`,
      nonce: "0x0",
      yParity: "0x0",
      r: ("0x" + "2".repeat(64)) as `0x${string}`,
      s: ("0x" + "3".repeat(64)) as `0x${string}`,
    };
    const res = await post("/api/onboard", { address: user.address, auth7702 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user_id: string; has_auth7702: boolean; revocation_nonce: string };
    expect(body.user_id).toBe(userId);
    expect(body.has_auth7702).toBe(true);
    expect(body.revocation_nonce).toBe("0");
    expect(store.getUser(userId)?.auth7702_json).toContain("0x2105");
  });

  test("prepare -> client-sign -> finalize -> card lands in the tree", async () => {
    const terms = {
      pay: { period: { amount: "25", seconds: 604800 } },
      expiry: Math.floor(Date.now() / 1000) + 30 * 86400,
      subcards: true,
    };
    const prep = (await (await post("/api/cards/prepare", { name: "privy card", terms, userAddress: user.address })).json()) as {
      prepare_id: string;
      k_agent_address: string;
      delegation: WireDelegation;
    };
    expect(prep.prepare_id).toBeTruthy();
    expect(prep.delegation.signature).toBe("0x");
    expect(prep.delegation.delegator.toLowerCase()).toBe(userId);
    expect(prep.delegation.delegate.toLowerCase()).toBe(prep.k_agent_address.toLowerCase());
    // prepare persists nothing
    expect(store.listCards(userId).length).toBe(0);

    // the browser signs the exact struct (local key stands in for the embedded wallet)
    const smart = await userSmartAccount(user, 8453);
    const signed = await signWithSmartAccount(smart, prep.delegation, 8453);

    const fin = (await (await post("/api/cards/finalize", { prepare_id: prep.prepare_id, signature: signed.signature })).json()) as {
      card_id: string;
      card_url: string;
    };
    expect(fin.card_id).toBeTruthy();
    expect(fin.card_url).toContain("/c/");

    const tree = (await (await get(`/api/tree?userId=${userId}`)).json()) as { tree: Array<{ card: { card_id: string } }> };
    expect(tree.tree.length).toBe(1);
    expect(tree.tree[0]!.card.card_id).toBe(fin.card_id);

    const detail = (await (await get(`/api/cards/${fin.card_id}`)).json()) as { name: string; status: string };
    expect(detail.name).toBe("privy card");
    expect(detail.status).toBe("active");

    // the stored card carries the CLIENT signature, delegator = the embedded wallet
    const card = store.getCard(fin.card_id)!;
    expect(card.delegation.signature).toBe(signed.signature);
    expect(card.delegation.delegator.toLowerCase()).toBe(userId);
  });

  test("prepare refuses an un-onboarded address", async () => {
    const stranger = privateKeyToAccount(generatePrivateKey());
    const res = await post("/api/cards/prepare", {
      name: "x",
      terms: { pay: { period: { amount: "1", seconds: 86400 } } },
      userAddress: stranger.address,
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe("invalid_terms");
  });

  test("finalize refuses an unknown prepare_id", async () => {
    const res = await post("/api/cards/finalize", { prepare_id: "nope", signature: ("0x" + "1".repeat(130)) });
    expect(res.status).toBe(422);
  });
});

// ---------------------------------------------------------------------------
// Privy SESSION lane: per-user auth + scoping (fake verifier, real middleware)
// ---------------------------------------------------------------------------

describe("Privy session auth + per-user scoping", () => {
  // two real wallets playing two Privy logins
  const alice = privateKeyToAccount(generatePrivateKey());
  const bob = privateKeyToAccount(generatePrivateKey());
  const ALICE = "pt-alice"; // -> did:privy:alice
  const BOB = "pt-bob"; // -> did:privy:bob
  const terms = { pay: { period: { amount: "10", seconds: 604800 } }, subcards: false };

  const onboardAs = async (bearer: string, acct: typeof alice, did: string) =>
    postAs(bearer, "/api/onboard", {
      address: acct.address,
      proof: await acct.signMessage({ message: onboardProofMessage(did) }),
    });

  test("bogus bearer is 401; missing bearer is 401", async () => {
    expect((await getAs("pt", "/api/tree")).status).toBe(401);
    expect((await getAs("nonsense", "/api/tree")).status).toBe(401);
    expect((await fetch(`${base}/api/tree`)).status).toBe(401);
  });

  test("valid session but never onboarded -> 403 on reads", async () => {
    const res = await getAs("pt-ghost", "/api/tree");
    expect(res.status).toBe(403);
  });

  test("onboard without proof -> 422; proof from the wrong key -> 422", async () => {
    const noProof = await postAs(ALICE, "/api/onboard", { address: alice.address });
    expect(noProof.status).toBe(422);
    // bob's key signs alice's message: recovers to bob, not the claimed address
    const wrongKey = await postAs(ALICE, "/api/onboard", {
      address: alice.address,
      proof: await bob.signMessage({ message: onboardProofMessage("did:privy:alice") }),
    });
    expect(wrongKey.status).toBe(422);
  });

  test("a proof signed for ANOTHER did cannot be replayed", async () => {
    // alice's real proof for did:privy:alice, presented under bob's session: the
    // message recovers under did:privy:bob and no longer matches alice's address
    const proof = await alice.signMessage({ message: onboardProofMessage("did:privy:alice") });
    const res = await postAs(BOB, "/api/onboard", { address: alice.address, proof });
    expect(res.status).toBe(422);
  });

  test("onboard with a valid proof binds the wallet to the login", async () => {
    const res = await onboardAs(ALICE, alice, "did:privy:alice");
    expect(res.status).toBe(200);
    expect(store.getUser(alice.address.toLowerCase())?.privy_did).toBe("did:privy:alice");

    const bobRes = await onboardAs(BOB, bob, "did:privy:bob");
    expect(bobRes.status).toBe(200);
  });

  test("a second login cannot claim an already-bound wallet (even with the key)", async () => {
    // simulate key compromise: alice's key signs a proof for bob's did
    const proof = await alice.signMessage({ message: onboardProofMessage("did:privy:bob") });
    const res = await postAs(BOB, "/api/onboard", { address: alice.address, proof });
    expect(res.status).toBe(403);
  });

  test("prepare is PINNED to the session's wallet (body.userAddress ignored)", async () => {
    const res = await postAs(ALICE, "/api/cards/prepare", {
      name: "alice card",
      terms,
      userAddress: bob.address, // hostile: try to mint for someone else's wallet
    });
    expect(res.status).toBe(200);
    const prep = (await res.json()) as { delegation: WireDelegation };
    expect(prep.delegation.delegator.toLowerCase()).toBe(alice.address.toLowerCase());
  });

  test("full privy issuance + the other user sees NONE of it", async () => {
    const prep = (await (await postAs(ALICE, "/api/cards/prepare", { name: "alice main", terms })).json()) as {
      prepare_id: string;
      delegation: WireDelegation;
    };
    const smart = await userSmartAccount(alice, 8453);
    const signed = await signWithSmartAccount(smart, prep.delegation, 8453);

    // bob cannot finalize alice's prepare (looks nonexistent)
    const hijack = await postAs(BOB, "/api/cards/finalize", { prepare_id: prep.prepare_id, signature: signed.signature });
    expect(hijack.status).toBe(422);

    const fin = (await (await postAs(ALICE, "/api/cards/finalize", { prepare_id: prep.prepare_id, signature: signed.signature })).json()) as {
      card_id: string;
      card_url: string;
    };
    expect(fin.card_id).toBeTruthy();

    // alice sees her card; the userId query param is ignored for privy sessions
    const aliceTree = (await (await getAs(ALICE, `/api/tree?userId=${bob.address.toLowerCase()}`)).json()) as {
      tree: Array<{ card: { card_id: string } }>;
    };
    expect(aliceTree.tree.some((n) => n.card.card_id === fin.card_id)).toBe(true);

    // bob's view is empty of alice's cards
    const bobTree = (await (await getAs(BOB, "/api/tree")).json()) as { tree: Array<{ card: { card_id: string } }> };
    expect(bobTree.tree.some((n) => n.card.card_id === fin.card_id)).toBe(false);

    // bob cannot read, reveal, rotate, or freeze alice's card — all look nonexistent
    for (const probe of [
      getAs(BOB, `/api/cards/${fin.card_id}`),
      getAs(BOB, `/api/cards/${fin.card_id}/url`),
      postAs(BOB, `/api/cards/${fin.card_id}/rotate`, {}),
      postAs(BOB, `/api/cards/${fin.card_id}/freeze`, {}),
    ]) {
      const res = await probe;
      expect(res.status).toBe(422);
      expect(((await res.json()) as { code: string }).code).toBe("card_not_found");
    }

    // alice CAN do all of those
    expect((await getAs(ALICE, `/api/cards/${fin.card_id}`)).status).toBe(200);
    expect((await getAs(ALICE, `/api/cards/${fin.card_id}/url`)).status).toBe(200);

    // admin ops lane still sees everything
    const adminView = await get(`/api/cards/${fin.card_id}`);
    expect(adminView.status).toBe(200);
  });

  test("server-signed ops are admin-only for privy sessions", async () => {
    expect((await postAs(ALICE, "/api/cards", { name: "x", terms })).status).toBe(403);
    expect((await postAs(ALICE, "/api/nuke", {})).status).toBe(403);
    // revoke is server-signed too (deps.userSigner) — a privy session must not reach it,
    // even on its OWN card (the privy lane revokes client-side, wired separately)
    const prep = (await (await postAs(ALICE, "/api/cards/prepare", { name: "alice revoke", terms })).json()) as {
      prepare_id: string;
      delegation: WireDelegation;
    };
    const smart = await userSmartAccount(alice, 8453);
    const signed = await signWithSmartAccount(smart, prep.delegation, 8453);
    const fin = (await (await postAs(ALICE, "/api/cards/finalize", { prepare_id: prep.prepare_id, signature: signed.signature })).json()) as {
      card_id: string;
    };
    expect((await postAs(ALICE, `/api/cards/${fin.card_id}/revoke`, {})).status).toBe(403);
  });
});
