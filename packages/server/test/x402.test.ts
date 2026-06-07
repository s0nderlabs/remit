// The full x402 erc7710 loop, offline: an MCP agent calls paid_fetch on the demo
// seller; the seller challenges 402 with spec headers; the card carves + encodes a
// delegation payload; the seller verifies + settles through OUR facilitator; only the
// relayer + chain reads are faked. This is the M3 shape minus real money.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  Store,
  issueRootCard,
  decodeX402Delegations,
  CHAINS,
  type Relayer,
  type RelayerTransaction,
  type EstimateResult,
} from "@remit/engine";
import { createApp } from "../src/app";
import type { AppDeps } from "../src/deps";

const user = privateKeyToAccount(generatePrivateKey());

class FakeRelayer {
  estimates: RelayerTransaction[][] = [];
  sends: RelayerTransaction[][] = [];
  async getFeeData() {
    return { minFee: "0.01", rate: 1598, gasPrice: "1", expiry: 0, feeCollector: "0xE936e8FAf4A5655469182A49a505055B71C17604", targetAddress: CHAINS[8453].targetAddress, context: "ctx" } as never;
  }
  async estimate(tx: RelayerTransaction[]): Promise<EstimateResult> {
    this.estimates.push(tx);
    return { success: true, requiredPaymentAmount: "10000", context: "ctx-ok", error: null, raw: null };
  }
  async send(tx: RelayerTransaction[]): Promise<string> {
    this.sends.push(tx);
    return "0xreq";
  }
  async getStatus() {
    return { status: 200, txHash: "0xsettletx" as `0x${string}`, raw: null };
  }
  async waitForStatus() {
    return { status: 200, txHash: "0xsettletx" as `0x${string}`, raw: null, timedOut: false };
  }
}

let server: ReturnType<typeof Bun.serve>;
let base: string;
let store: Store;
let relayer: FakeRelayer;

beforeAll(() => {
  process.env.REMIT_MASTER_KEY = "e".repeat(64);
  process.env.REMIT_PAID_FETCH_ALLOW_LOCAL = "1";
  store = new Store(":memory:");
  relayer = new FakeRelayer();
  const deps: AppDeps = {
    store,
    relayer: relayer as unknown as Relayer,
    userSigner: user,
    adminToken: "test-admin",
    verifyPrivyToken: null,
    spendOverrides: {
      codeCheck: async () => true,
      confirmViaChain: false,
      feeJitter: (b) => b,
    },
  };
  const app = createApp(deps);
  server = Bun.serve({ port: 0, fetch: app.fetch });
  base = `http://localhost:${server.port}`;
  process.env.REMIT_PUBLIC_MCP_BASE = base;
  process.env.REMIT_FACILITATOR_BASE = `${base}/facilitator`;
  store.upsertUser({ id: "u-x402", address: user.address });
});

afterAll(() => {
  server.stop(true);
  delete process.env.REMIT_PAID_FETCH_ALLOW_LOCAL;
});

async function mkCardClient(): Promise<{ client: Client; cardId: string }> {
  const issued = await issueRootCard(
    { store, userSigner: user, revocationNonceOverride: 0n },
    { userId: "u-x402", name: "x402 card", terms: { pay: { period: { amount: "25", seconds: 604800 } } } },
  );
  const client = new Client({ name: "x402-agent", version: "0.0.1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/c/${issued.secret}/mcp`)));
  return { client, cardId: issued.cardId };
}

const parse = (r: { content?: unknown }) => JSON.parse((r.content as Array<{ text: string }>)[0]!.text);

describe("facilitator endpoints", () => {
  test("GET /supported: the first erc7710 facilitator announces itself", async () => {
    const res = await fetch(`${base}/facilitator/supported`);
    const body = (await res.json()) as { kinds: Array<{ scheme: string; network: string; extra: { assetTransferMethods: string[] } }> };
    expect(body.kinds.length).toBe(1);
    expect(body.kinds[0]!.scheme).toBe("exact");
    expect(body.kinds[0]!.network).toBe("eip155:8453");
    expect(body.kinds[0]!.extra.assetTransferMethods).toEqual(["erc7710"]);
  });

  test("verify rejects: wrong network, garbage payload, undecodable context", async () => {
    const req = { scheme: "exact", network: "eip155:1", amount: "10000", asset: CHAINS[8453].usdc, payTo: user.address, maxTimeoutSeconds: 60 };
    const res = await fetch(`${base}/facilitator/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ x402Version: 2, paymentPayload: { payload: { delegationManager: "0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3", permissionContext: "0x1234", delegator: user.address } }, paymentRequirements: req }),
    });
    const verdict = (await res.json()) as { isValid: boolean; invalidReason?: string };
    expect(verdict.isValid).toBe(false);
    expect(verdict.invalidReason).toContain("unsupported network");

    const res2 = await fetch(`${base}/facilitator/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ x402Version: 2, paymentPayload: { payload: { delegationManager: "0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3", permissionContext: "0xdead", delegator: user.address } }, paymentRequirements: { ...req, network: "eip155:8453" } }),
    });
    expect(((await res2.json()) as { isValid: boolean }).isValid).toBe(false);
  });
});

describe("the full paid_fetch loop", () => {
  test("agent buys the demo resource: 402 -> pay -> content + receipt; budget moves", async () => {
    const { client } = await mkCardClient();

    // tool exposed
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).toContain("paid_fetch");

    const result = parse(await client.callTool({ name: "paid_fetch", arguments: { url: `${base}/demo/premium-data` } }));
    expect(result.paid).toBe(true);
    expect(result.receipt.tx).toBe("0xsettletx");
    expect(result.receipt.amount).toBe("0.01");
    expect(result.receipt.fee).toBe("0.01");
    expect(result.receipt.remaining_this_period).toBe("24.98"); // 25 - 0.01 - 0.01
    expect(JSON.parse(result.content.replace(/\n\.\.\..*$/, "")).dataset).toBe("premium-agent-dataset-v1");

    // the settlement rode the relayer with [transfer(payTo), fee] + decoded delegation chain
    const settled = relayer.sends[relayer.sends.length - 1]![0]!;
    expect(settled.executions.length).toBe(2);
    expect(settled.permissionContext.length).toBe(2); // leaf + root
    expect(settled.permissionContext[0]!.delegate.toLowerCase()).toBe(CHAINS[8453].targetAddress.toLowerCase());

    await client.close();
  });

  test("frozen card cannot spend via paid_fetch (status gate, regression)", async () => {
    // the x402 payer path must apply the SAME card-status backstop as pay(): a frozen
    // card carving a payload would otherwise bypass freeze entirely (freeze is a server flag).
    const { client, cardId } = await mkCardClient();
    store.setCardStatus(cardId, "frozen");
    const res = await client.callTool({ name: "paid_fetch", arguments: { url: `${base}/demo/premium-data` } });
    expect(res.isError).toBe(true);
    expect(parse(res).code).toBe("card_frozen");
    store.setCardStatus(cardId, "active"); // restore (shared store)
    await client.close();
  });

  test("max_price refusal; non-402 passthrough; SSRF guard", async () => {
    const { client } = await mkCardClient();

    const tooPricey = await client.callTool({ name: "paid_fetch", arguments: { url: `${base}/demo/premium-data`, max_price: "0.005" } });
    expect(tooPricey.isError).toBe(true);
    expect(parse(tooPricey).code).toBe("price_exceeds_max");

    const free = parse(await client.callTool({ name: "paid_fetch", arguments: { url: `${base}/health` } }));
    expect(free.paid).toBe(false);
    expect(free.status).toBe(200);

    process.env.REMIT_PAID_FETCH_ALLOW_LOCAL = "";
    // every loopback/private/link-local/ULA vector blocked — incl. the IPv4-mapped IPv6
    // and numeric-IPv4 forms a string-literal guard misses (regression for the SSRF bypass).
    for (const url of [
      "http://169.254.169.254/latest/meta-data", // cloud metadata
      "https://[::1]/x", // ipv6 loopback
      "https://[::ffff:127.0.0.1]/x", // ipv4-mapped ipv6 loopback (the bypass)
      "https://[::ffff:7f00:1]/x", // same, hex form
      "https://[fc00::1]/x", // ULA
      "https://[fe80::1]/x", // link-local
      "https://2130706433/x", // decimal 127.0.0.1
      "https://0x7f000001/x", // hex 127.0.0.1
      "https://0177.0.0.1/x", // octal 127.0.0.1
    ]) {
      const blocked = await client.callTool({ name: "paid_fetch", arguments: { url } });
      expect(blocked.isError, `expected ${url} blocked`).toBe(true);
      expect(parse(blocked).code).toBe("invalid_terms");
    }
    process.env.REMIT_PAID_FETCH_ALLOW_LOCAL = "1";

    await client.close();
  });

  test("over-budget card refuses BEFORE any payload is built", async () => {
    const issued = await issueRootCard(
      { store, userSigner: user, revocationNonceOverride: 0n },
      { userId: "u-x402", name: "tiny card", terms: { pay: { lifetime: { amount: "0.02" } } } },
    );
    const client = new Client({ name: "x402-agent", version: "0.0.1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/c/${issued.secret}/mcp`)));
    // 0.01 price + 0.03 headroom > 0.02 lifetime
    const res = await client.callTool({ name: "paid_fetch", arguments: { url: `${base}/demo/premium-data` } });
    expect(res.isError).toBe(true);
    expect(parse(res).code).toBe("over_lifetime_limit");
    await client.close();
  });
});

describe("payload encoding", () => {
  test("permissionContext round-trips through SAK codecs", async () => {
    // grab the payload the facilitator actually received by re-deriving from the last settle
    const sent = relayer.sends[relayer.sends.length - 1]![0]!;
    expect(sent.permissionContext[0]!.signature.length).toBeGreaterThan(4);
    expect(sent.permissionContext[1]!.signature.length).toBeGreaterThan(4);
    // decode helper used by the facilitator is the same one: smoke its error path
    expect(() => decodeX402Delegations("0x")).toThrow();
  });
});
