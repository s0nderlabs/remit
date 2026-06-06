// The Privy issuance lane, offline: onboard the embedded wallet, prepare an UNSIGNED
// root delegation, sign it the way the browser does (SAK signDelegation — here a local
// key plays the Privy embedded wallet), finalize, and confirm the card lands in the
// tree through the REAL Hono app + real store. No relayer, no chain writes; the onboard
// nonce read points at an unreachable RPC and falls back to 0.

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
  };
  server = Bun.serve({ port: 0, fetch: createApp(deps).fetch });
  base = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop(true);
  delete process.env.REMIT_RPC_URL;
});

const post = (path: string, body: unknown) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const get = (path: string) => fetch(`${base}${path}`, { headers: { authorization: `Bearer ${ADMIN}` } });

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
