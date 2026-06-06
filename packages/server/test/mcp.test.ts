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
    store,
    relayer: relayer as unknown as Relayer,
    userSigner: user,
    adminToken: "test-admin",
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
