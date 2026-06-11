// #43 Venice NL->CardTerms compiler. The model is FAKED (a scripted ChatFn returns a
// canned plan), so these tests are fully offline + deterministic: they exercise the
// resolver-mediated assembly, the address-provenance guard, the v1 (NFT/native) wall,
// and the live /cards/compile route. The real Venice call is validated separately by a
// .local.ts script once an API key exists.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Address } from "viem";
import { KeyedMutex, Store, type Relayer } from "@remit/engine";
import { createApp } from "../src/app";
import type { AppDeps } from "../src/deps";
import { assemble, compileIntent } from "../src/venice/compiler";
import { registryResolvers } from "../src/venice/resolvers";
import { extractJson, type ChatFn } from "../src/venice/client";

const NOW = 1_780_000_000;
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WETH = "0x4200000000000000000000000000000000000006";
const UNI = "0x2626664c2603336E57B271c5C0b26F421741e481";
const resolvers = registryResolvers();
const lc = (s: string) => s.toLowerCase();

// a ChatFn that always replies with the given plan JSON
const planChat = (plan: unknown): ChatFn => async () => "```json\n" + JSON.stringify(plan) + "\n```";

describe("registry resolvers", () => {
  test("token by symbol + alias; protocol by name; unknown -> null", () => {
    expect(lc(resolvers.token("USDC")!.address)).toBe(lc(USDC));
    expect(lc(resolvers.token("wrapped eth")!.address)).toBe(lc(WETH));
    expect(resolvers.token("not-a-token")).toBeNull();
    const uni = resolvers.protocol("uniswap")!;
    expect(lc(uni.entity.address)).toBe(lc(UNI));
    expect(uni.selectors.some((s) => s.startsWith("exactInputSingle"))).toBe(true);
    expect(resolvers.protocol("sushiswap")).toBeNull();
  });

  test("verifiedContract labels a known registry address without a network call", async () => {
    const v = await resolvers.verifiedContract(USDC);
    expect(v?.label).toBe("USDC");
    expect(v?.source).toBe("registry");
    expect(await resolvers.verifiedContract("0xnope")).toBeNull();
  });
});

describe("extractJson", () => {
  test("pulls JSON from a fenced reply and from bare prose", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('here you go: {"b":2} cheers')).toEqual({ b: 2 });
    expect(() => extractJson("no json here")).toThrow();
  });

  test("stray braces in surrounding prose can't poison the slice", () => {
    expect(extractJson('use {placeholder} then {"pay":{"perTx":"5"}} done')).toEqual({ pay: { perTx: "5" } });
    expect(extractJson('note: {a} {b} ```json\n{"c":3}\n``` trailing }')).toEqual({ c: 3 });
    expect(extractJson('nested strings: {"s":"a \\"}\\" brace"}')).toEqual({ s: 'a "}" brace' });
  });
});

describe("compiler: assemble", () => {
  test("pay limits + expiry + maxUses compile to CardTerms", async () => {
    const r = await assemble(
      { pay: { period: { amount: "10", unit: "week" }, perTx: "2" }, expiryDays: 30, maxUses: 5 },
      "let it spend 10 USDC a week, max 2 per tx, for 30 days, 5 times",
      resolvers,
      NOW,
    );
    expect(r.draft).not.toBeNull();
    expect(r.draft!.pay!.period).toEqual({ amount: "10", seconds: 604800 });
    expect(r.draft!.perTxMax).toBe("2");
    expect(r.draft!.expiry).toBe(NOW + 30 * 86400);
    expect(r.draft!.maxUses).toBe(5);
  });

  test("swap clause compiles a token-locked contract scope with approve + perTradeMax", async () => {
    const r = await assemble(
      { swaps: [{ protocol: "Uniswap", sell: "USDC", buy: "WETH", perTradeMax: "50" }] },
      "only let it swap USDC to WETH on Uniswap, max 50 per trade",
      resolvers,
      NOW,
    );
    const ct = r.draft!.contract!;
    expect(ct.targets.map(lc)).toContain(lc(UNI));
    expect(ct.targets.map(lc)).toContain(lc(USDC));
    expect(ct.targets.map(lc)).toContain(lc(WETH));
    expect(ct.selectors).toContain("approve(address,uint256)");
    expect(ct.selectors.some((s) => s.startsWith("exactInputSingle"))).toBe(true);
    expect(ct.tokens!.map(lc)).toEqual([lc(USDC)]); // the SELL token is the allowance token
    expect(ct.perTradeMax).toBe("50");
    // labels are human, not hex
    expect(r.labels.find((l) => lc(l.address) === lc(UNI))!.label).toBe("Uniswap V3 SwapRouter02");
    expect(r.warnings).toEqual([]);
  });

  test("perTradeMax on a non-USDC sell leg is dropped with a warning (v1 enforces USDC only)", async () => {
    const r = await assemble(
      { swaps: [{ protocol: "Uniswap", sell: "WETH", buy: "USDC", perTradeMax: "50" }] },
      "let it swap WETH to USDC on Uniswap, max 50 per trade",
      resolvers,
      NOW,
    );
    const ct = r.draft!.contract!;
    expect(ct.tokens!.map(lc)).toEqual([lc(WETH)]);
    expect(ct.perTradeMax).toBeUndefined(); // a cap the engine can't enforce never reaches the draft
    expect(r.warnings.some((w) => w.includes("per-trade"))).toBe(true);
  });

  test("garbled perTradeMax can't win the tightest-cap pick; valid caps min correctly", async () => {
    const r = await assemble(
      {
        swaps: [
          { protocol: "Uniswap", sell: "USDC", buy: "WETH", perTradeMax: "50" },
          { protocol: "Uniswap", sell: "USDC", buy: "WETH", perTradeMax: "10x" },
          { protocol: "Uniswap", sell: "USDC", buy: "WETH", perTradeMax: "25" },
        ],
      },
      "swap USDC to WETH on Uniswap with caps",
      resolvers,
      NOW,
    );
    expect(r.draft!.contract!.perTradeMax).toBe("25");
    expect(r.warnings.some((w) => w.includes("10x"))).toBe(true);
  });

  test("unknown protocol/token degrade to warnings, not bad addresses", async () => {
    const r = await assemble(
      { swaps: [{ protocol: "ShadyDEX", sell: "USDC", buy: "DOGE" }] },
      "swap USDC to DOGE on ShadyDEX",
      resolvers,
      NOW,
    );
    expect(r.draft).toBeNull(); // nothing resolved -> no contract scope
    expect(r.warnings.some((w) => w.includes("ShadyDEX"))).toBe(true);
  });

  test("merchant addresses only lock when the user typed them; names warn", async () => {
    const addr = "0xAc36D18d2315c8c1F6e93B9074D3C25e2DC14127";
    const r = await assemble(
      { pay: { lifetime: { amount: "100" } }, merchants: [addr, "Acme Store"] },
      `pay up to 100 USDC, only to ${addr} and Acme Store`,
      resolvers,
      NOW,
    );
    expect(r.draft!.merchants!.map(lc)).toEqual([lc(addr)]);
    expect(r.warnings.some((w) => w.includes("Acme Store"))).toBe(true);
  });

  test("address-provenance guard: a model-invented address is dropped", async () => {
    const invented = "0x1111111111111111111111111111111111111111";
    const r = await assemble(
      { pay: { lifetime: { amount: "100" } }, merchants: [invented] },
      "pay up to 100 USDC", // the invented address is NOT in the intent text
      resolvers,
      NOW,
    );
    expect(r.draft!.merchants).toBeUndefined();
    expect(r.warnings.some((w) => w.includes("didn't contain"))).toBe(true);
  });

  test("the NFT/native clause is the v1 wall: unsupported -> warning, not terms", async () => {
    const r = await assemble(
      {
        merchants: ["0xAc36D18d2315c8c1F6e93B9074D3C25e2DC14127"],
        swaps: [{ protocol: "Uniswap", sell: "USDC", buy: "WETH" }],
        unsupported: ["buy NFTs up to 0.1 ETH on some marketplace"],
      },
      "merchants 0xAc36D18d2315c8c1F6e93B9074D3C25e2DC14127, swap USDC->WETH on uniswap, buy NFTs up to 0.1 ETH",
      resolvers,
      NOW,
    );
    // the expressible parts survive
    expect(r.draft!.contract).toBeDefined();
    // the NFT clause is honestly flagged as v2
    expect(r.warnings.some((w) => w.toLowerCase().includes("nft") || w.includes("native-value"))).toBe(true);
  });

  test("compileIntent runs the fake brain end-to-end", async () => {
    const chat = planChat({ pay: { period: { amount: "5", unit: "day" } } });
    const r = await compileIntent("5 USDC a day", { chat, resolvers, now: () => NOW });
    expect(r.draft!.pay!.period).toEqual({ amount: "5", seconds: 86400 });
  });
});

// ---------------------------------------------------------------------------
// /cards/compile route (fake Venice dep)
// ---------------------------------------------------------------------------

describe("/cards/compile route", () => {
  const user = privateKeyToAccount(generatePrivateKey());

  function mkApp(veniceChat: ChatFn | null) {
    const store = new Store(":memory:");
    const deps: AppDeps = {
      spendMutex: new KeyedMutex(),
      store,
      relayer: {} as unknown as Relayer,
      userSigner: user,
      adminToken: "test-admin",
      verifyPrivyToken: null,
      veniceChat,
    };
    return createApp(deps);
  }

  const savedMasterKey = process.env.REMIT_MASTER_KEY;
  beforeAll(() => {
    process.env.REMIT_MASTER_KEY = "e".repeat(64);
  });
  afterAll(() => {
    if (savedMasterKey === undefined) delete process.env.REMIT_MASTER_KEY;
    else process.env.REMIT_MASTER_KEY = savedMasterKey;
  });

  async function compile(app: ReturnType<typeof createApp>, intent: string) {
    const res = await app.request("/api/cards/compile", {
      method: "POST",
      headers: { authorization: "Bearer test-admin", "content-type": "application/json" },
      body: JSON.stringify({ intent }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  test("returns a labeled draft for a swap intent", async () => {
    const app = mkApp(planChat({ swaps: [{ protocol: "Uniswap", sell: "USDC", buy: "WETH", perTradeMax: "25" }] }));
    const { status, body } = await compile(app, "only swap USDC to WETH on uniswap, max 25 a trade");
    expect(status).toBe(200);
    const draft = body.draft as { contract?: { perTradeMax?: string } };
    expect(draft.contract!.perTradeMax).toBe("25");
    expect((body.labels as Array<{ label: string }>).some((l) => l.label === "USDC")).toBe(true);
  });

  test("disabled when no Venice chat configured", async () => {
    const app = mkApp(null);
    const { status, body } = await compile(app, "anything");
    expect(status).toBe(502);
    expect(String(body.message)).toContain("compiler disabled");
  });

  test("empty intent -> invalid_terms", async () => {
    const app = mkApp(planChat({}));
    const { status, body } = await compile(app, "   ");
    expect(status).toBe(422);
    expect(body.code).toBe("invalid_terms");
  });
});
