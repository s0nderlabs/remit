// P2 surface tests: a REAL MCP client (SDK) speaks Streamable HTTP to the REAL app
// over a live socket. Only the relayer + chain reads are faked. Covers: both auth
// lanes, dynamic tool exposure, pay receipts, typed refusals, sub-card mint/spend/
// revoke through actual MCP tool calls.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Address } from "viem";
import {
  KeyedMutex,
  Store,
  issueRootCard,
  freezeCard,
  type Relayer,
  type RelayerTransaction,
  type EstimateResult,
  type CardTerms,
} from "@remit/engine";
import { createApp } from "../src/app";
import type { AppDeps } from "../src/deps";
import { recordFiatDecision } from "../src/stripe/decisions";

const MERCHANT = "0xAc36D18d2315c8c1F6e93B9074D3C25e2DC14127";
const user = privateKeyToAccount(generatePrivateKey());

class FakeRelayer {
  sends: RelayerTransaction[][] = [];
  async getFeeData() {
    return { minFee: "0.01", rate: 1598, gasPrice: "1", expiry: 0, feeCollector: "0xE936e8FAf4A5655469182A49a505055B71C17604" as Address, targetAddress: "0x26a529124f0bbf9af9d8f9f84a43efe47cf1199a" as Address, context: "ctx" };
  }
  async estimate(_tx: RelayerTransaction[]): Promise<EstimateResult> {
    return { success: true, requiredPaymentAmount: "10000", context: "ctx-ok", error: null, raw: null };
  }
  async send(tx: RelayerTransaction[]): Promise<string> {
    this.sends.push(tx);
    return "0xreq";
  }
  async getStatus() {
    return { status: 200, txHash: "0xfaketx" as `0x${string}`, raw: null };
  }
  async waitForStatus() {
    return { status: 200, txHash: "0xfaketx" as `0x${string}`, raw: null, timedOut: false };
  }
}

let server: ReturnType<typeof Bun.serve>;
let base: string;
let store: Store;
let relayer: FakeRelayer;

beforeAll(() => {
  process.env.REMIT_MASTER_KEY = "d".repeat(64);
  store = new Store(":memory:");
  relayer = new FakeRelayer();
  const deps: AppDeps = {
    spendMutex: new KeyedMutex(),
    store,
    relayer: relayer as unknown as Relayer,
    userSigner: user,
    adminToken: "test-admin",
    verifyPrivyToken: null,
    spendOverrides: { codeCheck: async () => true, confirmViaChain: false, feeJitter: (base) => base },
  };
  const app = createApp(deps);
  server = Bun.serve({ port: 0, fetch: app.fetch });
  base = `http://localhost:${server.port}`;
  process.env.REMIT_PUBLIC_MCP_BASE = base;
  store.upsertUser({ id: "u-test", address: user.address });
});

afterAll(() => {
  server.stop(true);
});

async function issue(terms: CardTerms, name = "test"): Promise<{ cardId: string; secret: string }> {
  const issued = await issueRootCard(
    { store, userSigner: user, revocationNonceOverride: 0n },
    { userId: "u-test", name, terms },
  );
  return { cardId: issued.cardId, secret: issued.secret };
}

async function connect(url: string, headers?: Record<string, string>): Promise<Client> {
  const client = new Client({ name: "test-agent", version: "0.0.1" });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: headers ? { headers } : undefined,
  });
  await client.connect(transport);
  return client;
}

function parse(result: { content?: unknown }): Record<string, unknown> {
  const content = result.content as Array<{ type: string; text: string }>;
  return JSON.parse(content[0]!.text);
}

describe("auth lanes", () => {
  test("path-secret lane connects; bogus secret 401s", async () => {
    const { secret } = await issue({ pay: { period: { amount: "25", seconds: 604800 } } });
    const client = await connect(`${base}/c/${secret}/mcp`);
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual(["card", "issue_subcard", "paid_fetch", "pay", "revoke_subcard"]);
    await client.close();

    await expect(connect(`${base}/c/bogus-secret/mcp`)).rejects.toThrow();
  });

  test("Bearer header lane connects to /mcp", async () => {
    const { secret } = await issue({ pay: { period: { amount: "25", seconds: 604800 } } });
    const client = await connect(`${base}/mcp`, { authorization: `Bearer ${secret}` });
    const tools = await client.listTools();
    expect(tools.tools.some((t) => t.name === "pay")).toBe(true);
    await client.close();
  });
});

describe("dynamic tool exposure", () => {
  test("contract-only card: execute but NO pay; subcards off: no subcard tools", async () => {
    const { secret } = await issue({
      contract: { targets: ["0x2626664c2603336E57B271c5C0b26F421741e481" as Address], selectors: ["approve(address,uint256)"] },
      subcards: false,
    });
    const client = await connect(`${base}/c/${secret}/mcp`);
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["card", "execute"]);
    await client.close();
  });
});

describe("tools", () => {
  test("card: live state with remaining budget", async () => {
    const { secret } = await issue({ pay: { period: { amount: "25", seconds: 604800 } }, expiry: Math.floor(Date.now() / 1000) + 86400 });
    const client = await connect(`${base}/c/${secret}/mcp`);
    const result = parse(await client.callTool({ name: "card", arguments: {} }));
    expect(result.status).toBe("active");
    expect(result.remaining_this_period).toBe("25");
    expect(result.recent_charges).toEqual([]);
    await client.close();
  });

  test("pay: confirmed receipt; counters move; idempotent retry", async () => {
    const { secret } = await issue({ pay: { period: { amount: "25", seconds: 604800 } } });
    const client = await connect(`${base}/c/${secret}/mcp`);
    const r1 = parse(await client.callTool({ name: "pay", arguments: { to: MERCHANT, amount: "1.5", memo: "api credits", idempotency_key: "k1" } }));
    expect(r1.status).toBe("confirmed");
    expect(r1.tx).toBe("0xfaketx");
    expect(r1.remaining_this_period).toBe("23.49"); // 25 - 1.5 - 0.01
    const sendsBefore = relayer.sends.length;
    const r2 = parse(await client.callTool({ name: "pay", arguments: { to: MERCHANT, amount: "1.5", idempotency_key: "k1" } }));
    expect(r2.tx).toBe("0xfaketx");
    expect(relayer.sends.length).toBe(sendsBefore);
    await client.close();
  });

  test("typed refusal: over_period_limit as isError + structured JSON", async () => {
    const { secret } = await issue({ pay: { period: { amount: "1", seconds: 604800 } } });
    const client = await connect(`${base}/c/${secret}/mcp`);
    const res = await client.callTool({ name: "pay", arguments: { to: MERCHANT, amount: "5" } });
    expect(res.isError).toBe(true);
    const body = parse(res);
    expect(body.status).toBe("refused");
    expect(body.code).toBe("over_period_limit");
    await client.close();
  });

  test("frozen card still answers card; pay refuses card_frozen", async () => {
    const { cardId, secret } = await issue({ pay: { period: { amount: "25", seconds: 604800 } } });
    freezeCard(store, cardId);
    const client = await connect(`${base}/c/${secret}/mcp`);
    const state = parse(await client.callTool({ name: "card", arguments: {} }));
    expect(state.status).toBe("frozen");
    const res = await client.callTool({ name: "pay", arguments: { to: MERCHANT, amount: "1" } });
    expect(res.isError).toBe(true);
    expect(parse(res).code).toBe("card_frozen");
    await client.close();
  });

  test("sub-card lifecycle THROUGH MCP: mint -> sub-agent connects via returned URL -> pays (chain-3) -> revoke kills URL", async () => {
    const { secret } = await issue({ pay: { period: { amount: "25", seconds: 604800 } } }, "lead card");
    const lead = await connect(`${base}/c/${secret}/mcp`);

    const minted = parse(await lead.callTool({
      name: "issue_subcard",
      arguments: { name: "research-budget", terms: { pay: { period: { amount: "5", seconds: 86400 } } } },
    }));
    expect(minted.card_url).toContain("/c/");
    expect(minted.card_id).toBeDefined();

    // the sub-agent connects with NOTHING but the URL
    const sub = await connect(minted.card_url as string);
    const subState = parse(await sub.callTool({ name: "card", arguments: {} }));
    expect(subState.remaining_this_period).toBe("5");
    const subPay = parse(await sub.callTool({ name: "pay", arguments: { to: MERCHANT, amount: "0.5" } }));
    expect(subPay.status).toBe("confirmed");
    // chain-3 wire: [leaf, child, root]
    const lastSend = relayer.sends[relayer.sends.length - 1]![0]!;
    expect(lastSend.permissionContext.length).toBe(3);
    await sub.close();

    // parent's budget saw the child's spend
    const leadState = parse(await lead.callTool({ name: "card", arguments: {} }));
    expect(leadState.remaining_this_period).toBe("24.49"); // 25 - 0.5 - 0.01

    // revoke: the sub URL dies
    const revoked = parse(await lead.callTool({ name: "revoke_subcard", arguments: { card_id: minted.card_id } }));
    expect(revoked.status).toBe("revoked");
    await expect(connect(minted.card_url as string)).rejects.toThrow();

    // and a foreign card_id is refused
    const { cardId: foreignId } = await issue({ pay: { lifetime: { amount: "1" } } }, "other");
    const res = await lead.callTool({ name: "revoke_subcard", arguments: { card_id: foreignId } });
    expect(res.isError).toBe(true);
    expect(parse(res).code).toBe("not_your_subcard");
    await lead.close();
  });

  test("exceeds_parent_terms surfaces through MCP with the field name", async () => {
    const { secret } = await issue({ pay: { period: { amount: "5", seconds: 604800 } } });
    const client = await connect(`${base}/c/${secret}/mcp`);
    const res = await client.callTool({
      name: "issue_subcard",
      arguments: { name: "fat", terms: { pay: { period: { amount: "50", seconds: 604800 } } } },
    });
    expect(res.isError).toBe(true);
    const body = parse(res);
    expect(body.code).toBe("exceeds_parent_terms");
    expect((body.detail as { field: string }).field).toBe("pay.period.amount");
    await client.close();
  });
});

describe("dashboard api", () => {
  test("auth required; tree endpoint shapes", async () => {
    const noAuth = await fetch(`${base}/api/tree`);
    expect(noAuth.status).toBe(401);
    const res = await fetch(`${base}/api/tree?userId=u-test`, { headers: { authorization: "Bearer test-admin" } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tree: Array<{ card: { name: string }; children: unknown[] }> };
    expect(Array.isArray(body.tree)).toBe(true);
    expect(body.tree.length).toBeGreaterThan(0);
  });

  test("freeze/unfreeze + url re-view through the API", async () => {
    const { cardId } = await issue({ pay: { lifetime: { amount: "2" } } }, "api-card");
    const h = { authorization: "Bearer test-admin" };
    expect((await fetch(`${base}/api/cards/${cardId}/freeze`, { method: "POST", headers: h })).status).toBe(200);
    const detail = (await (await fetch(`${base}/api/cards/${cardId}`, { headers: h })).json()) as { status: string };
    expect(detail.status).toBe("frozen");
    expect((await fetch(`${base}/api/cards/${cardId}/unfreeze`, { method: "POST", headers: h })).status).toBe(200);
    const url = (await (await fetch(`${base}/api/cards/${cardId}/url`, { headers: h })).json()) as { card_url: string };
    expect(url.card_url).toContain("/c/");
  });
});

// ---------------------------------------------------------------------------
// Fiat tools: registered only when a Stripe client is wired (pay cards)
// ---------------------------------------------------------------------------

describe("fiat tools", () => {
  const FIAT_PAN = "4000000000000005"; // obviously-fake test PAN
  const linked = new Map<string, string>(); // remit card id -> Issuing card id

  const fakeStripe = {
    authCalls: [] as Array<{ cardId: string; amountCents: number; merchantName: string }>,
    mintable: true, // false simulates an account with no cardholder (mint impossible)
    mints: [] as string[],
    async findCardForRemitCard(remitCardId: string) {
      return linked.get(remitCardId) ?? null;
    },
    // auto-mint semantics: resolve the link, minting on first need (client.ts parity)
    async ensureCardForRemitCard(remitCardId: string) {
      const existing = linked.get(remitCardId);
      if (existing) return existing;
      if (!fakeStripe.mintable) return null;
      const ic = `ic_minted_${fakeStripe.mints.length + 1}`;
      fakeStripe.mints.push(remitCardId);
      linked.set(remitCardId, ic);
      return ic;
    },
    async getCardDetails(icId: string, _opts?: { reveal?: boolean }) {
      return {
        id: icId,
        last4: FIAT_PAN.slice(-4),
        exp_month: 12,
        exp_year: 2030,
        brand: "Visa",
        status: "active",
        number: FIAT_PAN,
        cvc: "123",
        cardholder_name: "remit agent",
        metadata: {} as Record<string, string>,
      };
    },
    async createTestAuthorization(args: { cardId: string; amountCents: number; merchantName: string }) {
      fakeStripe.authCalls.push(args);
      const id = `iauth_test_${fakeStripe.authCalls.length}`;
      // the in-process webhook decides + caches synchronously inside the test
      // authorization round-trip; simulate exactly that
      recordFiatDecision(id, { approved: true, reason: "in_budget", cardId: args.cardId });
      return { id, approved: true, status: "closed", amount: args.amountCents, currency: "usd" };
    },
    async listActiveCardIds() {
      return [...new Set(linked.values())];
    },
  };

  // second app instance: same store, stripe wired (the global one has none)
  let fiatServer: ReturnType<typeof Bun.serve>;
  let fiatBase: string;

  beforeAll(() => {
    const fiatDeps = {
      spendMutex: new KeyedMutex(),
      store,
      relayer: relayer as unknown as Relayer,
      userSigner: user,
      adminToken: null,
      verifyPrivyToken: null,
      stripe: fakeStripe,
    } as unknown as AppDeps;
    fiatServer = Bun.serve({ port: 0, fetch: createApp(fiatDeps).fetch });
    fiatBase = `http://localhost:${fiatServer.port}`;
    // widen the host allowlist to this second server (REMIT_PUBLIC_MCP_BASE pins the first)
    process.env.REMIT_ALLOWED_HOSTS = new URL(fiatBase).host;
  });

  afterAll(() => {
    fiatServer.stop(true);
    delete process.env.REMIT_ALLOWED_HOSTS;
  });

  test("stripe absent: pay card exposes neither fiat_pay nor card_credentials", async () => {
    const { secret } = await issue({ pay: { lifetime: { amount: "5" } } }, "no-stripe");
    const client = await connect(`${base}/c/${secret}/mcp`);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain("fiat_pay");
    expect(names).not.toContain("card_credentials");
    await client.close();
  });

  test("stripe wired: both tools on a pay card; fiat_pay carries the cached decision reason; credentials reveal", async () => {
    const { cardId, secret } = await issue({ pay: { period: { amount: "25", seconds: 604800 } } }, "fiat-card");
    linked.set(cardId, "ic_fake_1");
    const client = await connect(`${fiatBase}/c/${secret}/mcp`);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("fiat_pay");
    expect(names).toContain("card_credentials");

    const r = parse(await client.callTool({ name: "fiat_pay", arguments: { amount: "1.25", merchant: "coffee bar" } }));
    expect(r.approved).toBe(true);
    expect(r.reason).toBe("in_budget"); // from the decisions cache, not the generic fallback
    expect(r.authorization_id).toBeDefined();
    expect(r.merchant).toBe("coffee bar");
    expect(r.note).toBeUndefined();
    expect(r.settlement).toBeUndefined(); // no fiatSettler wired
    const call = fakeStripe.authCalls[fakeStripe.authCalls.length - 1]!;
    expect(call.cardId).toBe("ic_fake_1");
    expect(call.amountCents).toBe(125);

    const creds = parse(await client.callTool({ name: "card_credentials", arguments: {} }));
    expect(creds.brand).toBe("Visa");
    expect(creds.number).toBe(FIAT_PAN);
    expect(creds.cvc).toBe("123");
    expect(creds.last4).toBe("0005");
    await client.close();
  });

  test("unlinked card AUTO-MINTS a Visa on first use (every delegation is a card)", async () => {
    const { cardId, secret } = await issue({ pay: { lifetime: { amount: "5" } } }, "unlinked");
    expect(linked.has(cardId)).toBe(false);
    const client = await connect(`${fiatBase}/c/${secret}/mcp`);
    const creds = parse(await client.callTool({ name: "card_credentials", arguments: {} }));
    expect(creds.brand).toBe("Visa");
    expect(fakeStripe.mints).toContain(cardId); // the mint happened, bound to THIS card
    expect(linked.get(cardId)).toBeDefined();
    // fiat_pay rides the SAME minted card (no second mint)
    const r = parse(await client.callTool({ name: "fiat_pay", arguments: { amount: "1" } }));
    expect(r.approved).toBe(true);
    expect(fakeStripe.mints.filter((m) => m === cardId).length).toBe(1);
    await client.close();
  });

  test("mint impossible (no cardholder): typed no_fiat_card refusal on both tools", async () => {
    const { secret } = await issue({ pay: { lifetime: { amount: "5" } } }, "unmintable");
    fakeStripe.mintable = false;
    try {
      const client = await connect(`${fiatBase}/c/${secret}/mcp`);
      const pay = await client.callTool({ name: "fiat_pay", arguments: { amount: "1" } });
      expect(pay.isError).toBe(true);
      expect(parse(pay).code).toBe("no_fiat_card");
      const creds = await client.callTool({ name: "card_credentials", arguments: {} });
      expect(creds.isError).toBe(true);
      expect(parse(creds).code).toBe("no_fiat_card");
      await client.close();
    } finally {
      fakeStripe.mintable = true;
    }
  });
});

// ---------------------------------------------------------------------------
// Hardening: host allowlist, rate limits, secret hygiene (#24)
// ---------------------------------------------------------------------------

describe("mcp hardening", () => {
  test("Host header outside the allowlist is rejected (421); allowed host passes", async () => {
    const { secret } = await issue({ pay: { lifetime: { amount: "1" } } }, "host-card");
    // REMIT_PUBLIC_MCP_BASE = base, so the test server's own host is allowed
    const evil = await fetch(`${base}/c/${secret}/mcp`, {
      method: "POST",
      headers: { host: "evil.example.com", "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(evil.status).toBe(421);
    expect(await evil.text()).not.toContain(secret);
  });

  test("bad-secret 401 body never echoes the attempted secret", async () => {
    const probe = "deadbeef".repeat(8);
    const res = await fetch(`${base}/c/${probe}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain(probe);
  });

  test("repeated bad-secret attempts from one source hit the brute-force limiter (429)", async () => {
    // the limiter allows 30/min per IP; same-process fetches share the "unknown" key.
    // burn through the window with distinct bogus secrets, expect a 429 tail.
    let got429 = false;
    for (let i = 0; i < 40; i++) {
      const res = await fetch(`${base}/c/bogus-${i}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      });
      if (res.status === 429) {
        got429 = true;
        break;
      }
      expect(res.status).toBe(401);
    }
    expect(got429).toBe(true);
  });

  // LAST in the suite: an early 413 leaves the unconsumed request body on the
  // keep-alive connection, which can wedge the NEXT request that reuses it.
  test("oversized body is rejected (413) before parsing", async () => {
    const { secret } = await issue({ pay: { lifetime: { amount: "1" } } }, "big-card");
    const res = await fetch(`${base}/c/${secret}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", connection: "close" },
      // a real 2 MiB body (the fetch client sets the true content-length)
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: { pad: "x".repeat(2 * 1024 * 1024) } }),
    });
    expect(res.status).toBe(413);
  });
});
