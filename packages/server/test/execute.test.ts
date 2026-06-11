// Contract-lane (`execute`) coverage: a REAL MCP client speaks Streamable HTTP to
// the REAL app over a live socket; only the relayer + chain reads are faked. This is
// the end-to-end `callTool({name:"execute"})` exercise the surface tests never did.
// Asserts encoded calldata (single + atomic multi-call), arg coercion, every typed
// refusal, both auth lanes, composite (pay+contract) routing, idempotency, and uses.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { encodeFunctionData, parseAbi, type Address } from "viem";
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

// Base-mainnet-shaped addresses (values are real but the chain is faked here).
const ROUTER = "0x2626664c2603336E57B271c5C0b26F421741e481" as Address; // Uniswap SwapRouter02
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
const POOL = "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5" as Address; // Aave V3 Pool (Base)
const WETH = "0x4200000000000000000000000000000000000006" as Address;
const SPENDER = "0xAc36D18d2315c8c1F6e93B9074D3C25e2DC14127" as Address;
const FEE_COLLECTOR = "0xE936e8FAf4A5655469182A49a505055B71C17604" as Address;
const TRANSFER_SIG = "transfer(address,uint256)";
const EXACT_INPUT_SINGLE_SIG =
  "exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96))";

const user = privateKeyToAccount(generatePrivateKey());

// Mirror of the server's encodeScopedCall coercion, so we can assert exact calldata.
function calldata(sig: string, args: Array<string | number | boolean>): `0x${string}` {
  const abi = parseAbi([`function ${sig}`]);
  const fn = sig.slice(0, sig.indexOf("("));
  const coerced = args.map((v) => (typeof v === "string" && /^\d+$/.test(v) ? BigInt(v) : v));
  return encodeFunctionData({ abi, functionName: fn, args: coerced as never });
}

class FakeRelayer {
  sends: RelayerTransaction[][] = [];
  async getFeeData() {
    return {
      minFee: "0.01",
      rate: 1598,
      gasPrice: "1",
      expiry: 0,
      feeCollector: FEE_COLLECTOR,
      targetAddress: "0x26a529124f0bbf9af9d8f9f84a43efe47cf1199a" as Address,
      context: "ctx",
    };
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
    spendOverrides: { codeCheck: async () => true, confirmViaChain: false, feeJitter: (b) => b },
  };
  const app = createApp(deps);
  server = Bun.serve({ port: 0, fetch: app.fetch });
  base = `http://localhost:${server.port}`;
  process.env.REMIT_PUBLIC_MCP_BASE = base;
  store.upsertUser({ id: "u-exec", address: user.address });
});

afterAll(() => {
  server.stop(true);
});

async function issue(terms: CardTerms, name = "contract-card"): Promise<{ cardId: string; secret: string }> {
  const issued = await issueRootCard(
    { store, userSigner: user, revocationNonceOverride: 0n },
    { userId: "u-exec", name, terms },
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

/** Flatten every transaction item's executions in redemption order. Contract-mode
 * redemptions now split allowance calls into their own pinned items (#42), so the
 * physical execution list spans multiple items; the agent-visible ordering is the
 * concatenation. */
function lastExecutions(): Array<{ target: string; value: string; data: string }> {
  const items = relayer.sends[relayer.sends.length - 1]!;
  return items.flatMap((tx) => tx.executions) as unknown as Array<{ target: string; value: string; data: string }>;
}

// ---------------------------------------------------------------------------
// happy paths: real encoded calldata
// ---------------------------------------------------------------------------

describe("execute: encoded calldata", () => {
  test("single approve: pinned item, fee in its own item, chain-2 context", async () => {
    // realistic swap-card shape: scope the token + the spender (the router)
    const { secret } = await issue({
      contract: { targets: [USDC, SPENDER], selectors: ["approve(address,uint256)"] },
    });
    const client = await connect(`${base}/c/${secret}/mcp`);
    const r = parse(
      await client.callTool({
        name: "execute",
        arguments: { calls: [{ target: USDC, method: "approve(address,uint256)", args: [SPENDER, "1000000"] }] },
      }),
    );
    expect(r.status).toBe("confirmed");
    expect(r.tx).toBe("0xfaketx");
    expect(r.amount).toBe("0"); // contract mode moves no USDC of its own
    expect(r.fee).toBe("0.01");

    // the approve is isolated in item 0 behind exact-spender + exact-amount pins; the
    // fee leg gets its own item (a pinned item must hold ONLY its allowance execution)
    const items = relayer.sends[relayer.sends.length - 1]!;
    expect(items.length).toBe(2);
    expect(items[0]!.executions.length).toBe(1);
    expect((items[0]!.executions[0]! as { data: string }).data).toBe(calldata("approve(address,uint256)", [SPENDER, "1000000"]));
    expect(items[1]!.executions.length).toBe(1);
    expect((items[1]!.executions[0]! as { target: string }).target.toLowerCase()).toBe(USDC.toLowerCase()); // fee leg
    expect((items[1]!.executions[0]! as { data: string }).data).toBe(calldata(TRANSFER_SIG, [FEE_COLLECTOR, "10000"]));
    // each item rides [leaf, root]
    expect(items[0]!.permissionContext.length).toBe(2);
    await client.close();
  });

  test("atomic multi-call: approve + supply in ONE redemption, ordered, fee leg last", async () => {
    const { secret } = await issue({
      contract: {
        targets: [USDC, POOL],
        selectors: ["approve(address,uint256)", "supply(address,uint256,address,uint16)"],
      },
    });
    const client = await connect(`${base}/c/${secret}/mcp`);
    const r = parse(
      await client.callTool({
        name: "execute",
        arguments: {
          calls: [
            { target: USDC, method: "approve(address,uint256)", args: [POOL, "500000"] },
            { target: POOL, method: "supply(address,uint256,address,uint16)", args: [USDC, "500000", user.address, 0] },
          ],
          memo: "stake leg",
        },
      }),
    );
    expect(r.status).toBe("confirmed");
    expect(r.memo).toBe("stake leg");

    // approve (spender POOL, in scope) isolates into a pinned item; supply + fee ride
    // the second item. Flattened agent-order is still approve, supply, fee.
    const ex = lastExecutions();
    expect(ex.length).toBe(3); // approve, supply, fee leg
    expect(ex[0]!.data).toBe(calldata("approve(address,uint256)", [POOL, "500000"]));
    expect(ex[1]!.target.toLowerCase()).toBe(POOL.toLowerCase());
    expect(ex[1]!.data).toBe(calldata("supply(address,uint256,address,uint16)", [USDC, "500000", user.address, 0]));
    expect(ex[2]!.target.toLowerCase()).toBe(USDC.toLowerCase()); // fee leg
    const items = relayer.sends[relayer.sends.length - 1]!;
    expect(items.length).toBe(2); // [pinned approve] + [supply, fee]
    expect(items[0]!.executions.length).toBe(1);
    await client.close();
  });

  test("arg coercion: address, large uint as decimal string, bool", async () => {
    const { secret } = await issue({
      contract: { targets: [POOL], selectors: ["setApprovalForAll(address,bool)", "mint(address,uint256)"] },
    });
    const client = await connect(`${base}/c/${secret}/mcp`);
    parse(
      await client.callTool({
        name: "execute",
        arguments: { calls: [{ target: POOL, method: "setApprovalForAll(address,bool)", args: [SPENDER, true] }] },
      }),
    );
    expect(lastExecutions()[0]!.data).toBe(calldata("setApprovalForAll(address,bool)", [SPENDER, true]));

    const big = "115792089237316195423570985008687907853269984665640564039457584007913129639935"; // uint256 max
    parse(
      await client.callTool({
        name: "execute",
        arguments: { calls: [{ target: POOL, method: "mint(address,uint256)", args: [user.address, big] }] },
      }),
    );
    expect(lastExecutions()[0]!.data).toBe(calldata("mint(address,uint256)", [user.address, big]));
    await client.close();
  });
});

// ---------------------------------------------------------------------------
// typed refusals
// ---------------------------------------------------------------------------

describe("execute: typed refusals", () => {
  async function execOn(secret: string, call: { target: string; method: string; args: Array<string | number | boolean> }) {
    const client = await connect(`${base}/c/${secret}/mcp`);
    const res = await client.callTool({ name: "execute", arguments: { calls: [call] } });
    await client.close();
    return res;
  }

  test("off-allowlist target -> target_not_allowed (no send)", async () => {
    const { secret } = await issue({ contract: { targets: [ROUTER], selectors: ["approve(address,uint256)"] } });
    const before = relayer.sends.length;
    const res = await execOn(secret, { target: POOL, method: "approve(address,uint256)", args: [SPENDER, "1"] });
    expect(res.isError).toBe(true);
    expect(parse(res).code).toBe("target_not_allowed");
    expect(relayer.sends.length).toBe(before);
  });

  test("off-allowlist method -> method_not_allowed", async () => {
    const { secret } = await issue({ contract: { targets: [ROUTER], selectors: ["approve(address,uint256)"] } });
    const res = await execOn(secret, { target: ROUTER, method: "mint(address)", args: [user.address] });
    expect(res.isError).toBe(true);
    expect(parse(res).code).toBe("method_not_allowed");
  });

  test("malformed args (wrong arity) -> invalid_terms", async () => {
    const { secret } = await issue({ contract: { targets: [ROUTER], selectors: ["approve(address,uint256)"] } });
    const res = await execOn(secret, { target: ROUTER, method: "approve(address,uint256)", args: [SPENDER] });
    expect(res.isError).toBe(true);
    expect(parse(res).code).toBe("invalid_terms");
  });

  test("maxUses exhausts across redemptions -> uses_exhausted", async () => {
    const { secret } = await issue({ contract: { targets: [USDC, SPENDER], selectors: ["approve(address,uint256)"] }, maxUses: 1 });
    const client = await connect(`${base}/c/${secret}/mcp`);
    const ok = parse(await client.callTool({ name: "execute", arguments: { calls: [{ target: USDC, method: "approve(address,uint256)", args: [SPENDER, "1"] }] } }));
    expect(ok.status).toBe("confirmed");
    const res = await client.callTool({ name: "execute", arguments: { calls: [{ target: USDC, method: "approve(address,uint256)", args: [SPENDER, "1"] }] } });
    expect(res.isError).toBe(true);
    expect(parse(res).code).toBe("uses_exhausted");
    await client.close();
  });

  test("frozen card still answers card; execute refuses card_frozen", async () => {
    const { cardId, secret } = await issue({ contract: { targets: [ROUTER], selectors: ["approve(address,uint256)"] } });
    freezeCard(store, cardId);
    const client = await connect(`${base}/c/${secret}/mcp`);
    expect(parse(await client.callTool({ name: "card", arguments: {} })).status).toBe("frozen");
    const res = await client.callTool({ name: "execute", arguments: { calls: [{ target: ROUTER, method: "approve(address,uint256)", args: [SPENDER, "1"] }] } });
    expect(res.isError).toBe(true);
    expect(parse(res).code).toBe("card_frozen");
    await client.close();
  });

  test("revoked card refuses the connection entirely", async () => {
    const { cardId, secret } = await issue({ contract: { targets: [ROUTER], selectors: ["approve(address,uint256)"] } });
    store.setCardStatus(cardId, "revoked");
    await expect(connect(`${base}/c/${secret}/mcp`)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// auth lanes + idempotency
// ---------------------------------------------------------------------------

describe("execute: lanes + idempotency", () => {
  test("Bearer header lane executes identically to path-secret lane", async () => {
    const { secret } = await issue({ contract: { targets: [USDC, SPENDER], selectors: ["approve(address,uint256)"] } });
    const client = await connect(`${base}/mcp`, { authorization: `Bearer ${secret}` });
    const r = parse(await client.callTool({ name: "execute", arguments: { calls: [{ target: USDC, method: "approve(address,uint256)", args: [SPENDER, "7"] }] } }));
    expect(r.status).toBe("confirmed");
    expect(lastExecutions()[0]!.data).toBe(calldata("approve(address,uint256)", [SPENDER, "7"]));
    await client.close();
  });

  test("idempotency_key replays the same receipt without a second send", async () => {
    const { secret } = await issue({ contract: { targets: [USDC, SPENDER], selectors: ["approve(address,uint256)"] } });
    const client = await connect(`${base}/c/${secret}/mcp`);
    const args = { calls: [{ target: USDC, method: "approve(address,uint256)", args: [SPENDER, "3"] }], idempotency_key: "exec-k1" };
    const r1 = parse(await client.callTool({ name: "execute", arguments: args }));
    const before = relayer.sends.length;
    const r2 = parse(await client.callTool({ name: "execute", arguments: args }));
    expect(r2.tx).toBe(r1.tx);
    expect(relayer.sends.length).toBe(before);
    await client.close();
  });
});

// ---------------------------------------------------------------------------
// composite cards: pay + contract off one delegation
// ---------------------------------------------------------------------------

describe("execute: composite (pay + contract)", () => {
  test("composite card exposes pay AND execute; both redeem off the OR-wrapper", async () => {
    const { secret } = await issue({
      pay: { period: { amount: "10", seconds: 604800 } },
      contract: { targets: [USDC, SPENDER], selectors: ["approve(address,uint256)"] },
    }, "composite");
    const client = await connect(`${base}/c/${secret}/mcp`);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("pay");
    expect(names).toContain("execute");

    // contract leg
    const ex = parse(await client.callTool({ name: "execute", arguments: { calls: [{ target: USDC, method: "approve(address,uint256)", args: [SPENDER, "1"] }] } }));
    expect(ex.status).toBe("confirmed");
    // pay leg off the SAME card
    const pay = parse(await client.callTool({ name: "pay", arguments: { to: SPENDER, amount: "1" } }));
    expect(pay.status).toBe("confirmed");
    // On a pay-bearing card the execute's relayer fee IS metered (it's a USDC charge
    // counted subtree-wide): 10 - 0.01 (execute fee) - 1 - 0.01 (pay fee) = 8.98.
    expect(pay.remaining_this_period).toBe("8.98");
    await client.close();
  });
});

// ---------------------------------------------------------------------------
// full-lane capabilities: raw calldata (tuple/multicall), msg.value,
// scope-escape fix, contract sub-cards
// ---------------------------------------------------------------------------

describe("execute: raw calldata (tuple/array methods)", () => {
  test("Uniswap exactInputSingle via raw data: encodes, selector checked, exact bytes forwarded", async () => {
    const { secret } = await issue({
      contract: { targets: [ROUTER], selectors: [EXACT_INPUT_SINGLE_SIG] },
    }, "swap-card");
    const rawSwap = encodeFunctionData({
      abi: parseAbi([`function ${EXACT_INPUT_SINGLE_SIG}`]),
      functionName: "exactInputSingle",
      args: [
        {
          tokenIn: USDC,
          tokenOut: WETH,
          fee: 500,
          recipient: user.address,
          amountIn: 500000n,
          amountOutMinimum: 0n,
          sqrtPriceLimitX96: 0n,
        },
      ] as never,
    });
    const client = await connect(`${base}/c/${secret}/mcp`);
    const r = parse(await client.callTool({ name: "execute", arguments: { calls: [{ target: ROUTER, data: rawSwap }] } }));
    expect(r.status).toBe("confirmed");
    const ex = lastExecutions();
    expect(ex[0]!.target.toLowerCase()).toBe(ROUTER.toLowerCase());
    expect(ex[0]!.data).toBe(rawSwap); // bytes forwarded verbatim
    expect(ex[0]!.value).toBe("0");
    await client.close();
  });

  test("raw data whose selector is off-allowlist -> method_not_allowed", async () => {
    const { secret } = await issue({ contract: { targets: [ROUTER], selectors: [EXACT_INPUT_SINGLE_SIG] } }, "swap-only");
    const approveData = encodeFunctionData({ abi: parseAbi(["function approve(address,uint256)"]), functionName: "approve", args: [SPENDER, 1n] });
    const client = await connect(`${base}/c/${secret}/mcp`);
    const res = await client.callTool({ name: "execute", arguments: { calls: [{ target: ROUTER, data: approveData }] } });
    expect(res.isError).toBe(true);
    expect(parse(res).code).toBe("method_not_allowed");
    await client.close();
  });
});

describe("execute: native value is 0 (payable deferred to v2)", () => {
  test("contract execs always carry value 0", async () => {
    const { secret } = await issue({ contract: { targets: [WETH], selectors: ["deposit()"] } }, "weth-deposit");
    const client = await connect(`${base}/c/${secret}/mcp`);
    const r = parse(await client.callTool({
      name: "execute",
      arguments: { calls: [{ target: WETH, method: "deposit()", args: [] }] },
    }));
    expect(r.status).toBe("confirmed");
    expect(lastExecutions()[0]!.value).toBe("0"); // SDK caps the carved leaf at valueLte:0n
    await client.close();
  });
});

describe("execute: input shape + selector canonicalization", () => {
  test("method AND data both supplied -> invalid_terms", async () => {
    const { secret } = await issue({ contract: { targets: [ROUTER], selectors: ["approve(address,uint256)"] } });
    const client = await connect(`${base}/c/${secret}/mcp`);
    const data = encodeFunctionData({ abi: parseAbi(["function approve(address,uint256)"]), functionName: "approve", args: [SPENDER, 1n] });
    const res = await client.callTool({ name: "execute", arguments: { calls: [{ target: ROUTER, method: "approve(address,uint256)", args: [SPENDER, "1"], data }] } });
    expect(res.isError).toBe(true);
    expect(parse(res).code).toBe("invalid_terms");
    await client.close();
  });

  test("alias selector canonicalizes: card declares withdraw(uint), agent calls withdraw(uint256)", async () => {
    // validateTerms normalizes the declared selector to withdraw(uint256) at issue.
    const { secret } = await issue({ contract: { targets: [POOL], selectors: ["withdraw(uint)"] } }, "alias-card");
    const client = await connect(`${base}/c/${secret}/mcp`);
    // canonical call matches
    const r1 = parse(await client.callTool({ name: "execute", arguments: { calls: [{ target: POOL, method: "withdraw(uint256)", args: ["5"] }] } }));
    expect(r1.status).toBe("confirmed");
    // the aliased call also matches (the request is canonicalized too)
    const r2 = parse(await client.callTool({ name: "execute", arguments: { calls: [{ target: POOL, method: "withdraw(uint)", args: ["5"] }] } }));
    expect(r2.status).toBe("confirmed");
    // both encode the same canonical selector 0x2e1a7d4d
    expect(lastExecutions()[0]!.data.slice(0, 10)).toBe("0x2e1a7d4d");
    await client.close();
  });
});

describe("execute: scope-escape is closed", () => {
  test("a Uniswap-only card CANNOT call USDC.transfer (via method or raw data)", async () => {
    const { secret } = await issue({ contract: { targets: [ROUTER], selectors: ["approve(address,uint256)"] } }, "no-drain");
    const client = await connect(`${base}/c/${secret}/mcp`);
    // via method+args
    const r1 = await client.callTool({ name: "execute", arguments: { calls: [{ target: USDC, method: TRANSFER_SIG, args: [SPENDER, "1000000"] }] } });
    expect(r1.isError).toBe(true);
    expect(parse(r1).code).toBe("target_not_allowed");
    // via raw data (transfer selector to USDC) -> target still refused
    const xfer = encodeFunctionData({ abi: parseAbi([`function ${TRANSFER_SIG}`]), functionName: "transfer", args: [SPENDER, 1000000n] });
    const r2 = await client.callTool({ name: "execute", arguments: { calls: [{ target: USDC, data: xfer }] } });
    expect(r2.isError).toBe(true);
    expect(parse(r2).code).toBe("target_not_allowed");
    await client.close();
  });

  test("a card that DECLARES USDC + transfer CAN call it (fix doesn't over-restrict)", async () => {
    const { secret } = await issue({ contract: { targets: [USDC], selectors: [TRANSFER_SIG] } }, "usdc-mover");
    const client = await connect(`${base}/c/${secret}/mcp`);
    const r = parse(await client.callTool({ name: "execute", arguments: { calls: [{ target: USDC, method: TRANSFER_SIG, args: [SPENDER, "1"] }] } }));
    expect(r.status).toBe("confirmed");
    await client.close();
  });
});

describe("execute: contract sub-cards", () => {
  test("narrow a contract sub-card (subset), it gets execute, redeems chain-3", async () => {
    const { secret } = await issue({
      contract: { targets: [USDC, SPENDER, POOL], selectors: ["approve(address,uint256)", "supply(address,uint256,address,uint16)"] },
    }, "lead-contract");
    const lead = await connect(`${base}/c/${secret}/mcp`);
    const minted = parse(await lead.callTool({
      name: "issue_subcard",
      arguments: { name: "swap-sub", terms: { contract: { targets: [USDC, SPENDER], selectors: ["approve(address,uint256)"] } } },
    }));
    expect(minted.card_url).toContain("/c/");

    const sub = await connect(minted.card_url as string);
    expect((await sub.listTools()).tools.map((t) => t.name)).toContain("execute");
    const r = parse(await sub.callTool({ name: "execute", arguments: { calls: [{ target: USDC, method: "approve(address,uint256)", args: [SPENDER, "1"] }] } }));
    expect(r.status).toBe("confirmed");
    // item 0 = the pinned approve, riding the chain-3 context [leaf, child, root]
    expect(relayer.sends[relayer.sends.length - 1]![0]!.permissionContext.length).toBe(3);
    await sub.close();
    await lead.close();
  });

  test("contract sub-card exceeding parent targets -> exceeds_parent_terms(contract.targets)", async () => {
    const { secret } = await issue({ contract: { targets: [ROUTER], selectors: ["approve(address,uint256)"] } }, "lead-t");
    const lead = await connect(`${base}/c/${secret}/mcp`);
    const res = await lead.callTool({
      name: "issue_subcard",
      arguments: { name: "fat-target", terms: { contract: { targets: [POOL], selectors: ["approve(address,uint256)"] } } },
    });
    expect(res.isError).toBe(true);
    const body = parse(res);
    expect(body.code).toBe("exceeds_parent_terms");
    expect((body.detail as { field: string }).field).toBe("contract.targets");
    await lead.close();
  });

  test("contract sub-card exceeding parent selectors -> exceeds_parent_terms(contract.selectors)", async () => {
    const { secret } = await issue({ contract: { targets: [ROUTER], selectors: ["approve(address,uint256)"] } }, "lead-s");
    const lead = await connect(`${base}/c/${secret}/mcp`);
    const res = await lead.callTool({
      name: "issue_subcard",
      arguments: { name: "fat-method", terms: { contract: { targets: [ROUTER], selectors: ["mint(address)"] } } },
    });
    expect(res.isError).toBe(true);
    const body = parse(res);
    expect(body.code).toBe("exceeds_parent_terms");
    expect((body.detail as { field: string }).field).toBe("contract.selectors");
    await lead.close();
  });
});

// ---------------------------------------------------------------------------
// #42: token list + perTradeMax over the live MCP socket
// ---------------------------------------------------------------------------

describe("execute: allowance token list + perTradeMax (server surface)", () => {
  const swapSig = EXACT_INPUT_SINGLE_SIG;
  const rawSwap = encodeFunctionData({
    abi: parseAbi([`function ${swapSig}`]),
    functionName: "exactInputSingle",
    args: [{ tokenIn: USDC, tokenOut: WETH, fee: 500, recipient: user.address, amountIn: 20000n, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n }] as never,
  });

  async function call(secret: string, args: unknown) {
    const client = await connect(`${base}/c/${secret}/mcp`);
    const res = await client.callTool({ name: "execute", arguments: args as never });
    await client.close();
    return res;
  }

  test("tokens unioned into scope at issue: a token-list card can approve + swap", async () => {
    // declare ROUTER + swap; tokens [USDC] unions USDC target + approve selector
    const { secret } = await issue(
      { contract: { targets: [ROUTER], selectors: [swapSig], tokens: [USDC], perTradeMax: "0.05" } },
      "swap-tokenlist",
    );
    const r = parse(await call(secret, {
      calls: [
        { target: USDC, method: "approve(address,uint256)", args: [ROUTER, "20000"] },
        { target: ROUTER, data: rawSwap },
      ],
    }));
    expect(r.status).toBe("confirmed");
    const items = relayer.sends[relayer.sends.length - 1]!;
    expect(items.length).toBe(2); // [pinned approve] + [swap, fee]
    // pin amount is exactly 20000
    const pinned = items[0]!.permissionContext[0]!.caveats.filter((c) => c.terms.length === 130);
    expect(pinned.some((c) => BigInt("0x" + c.terms.slice(-64)) === 20000n)).toBe(true);
  });

  test("approve of a token off the list -> token_not_allowed", async () => {
    // WETH callable (declared target) but not on the allowance token list
    const { secret } = await issue(
      { contract: { targets: [ROUTER, WETH], selectors: [swapSig], tokens: [USDC] } },
      "tokenlist-deny",
    );
    const res = await call(secret, { calls: [{ target: WETH, method: "approve(address,uint256)", args: [ROUTER, "1"] }] });
    expect(res.isError).toBe(true);
    expect(parse(res).code).toBe("token_not_allowed");
  });

  test("USDC approve over perTradeMax -> per_trade_exceeded; at cap confirms", async () => {
    const { secret } = await issue(
      { contract: { targets: [ROUTER], selectors: [swapSig], tokens: [USDC], perTradeMax: "0.05" } },
      "pertrade",
    );
    const over = await call(secret, { calls: [{ target: USDC, method: "approve(address,uint256)", args: [ROUTER, "50001"] }] });
    expect(over.isError).toBe(true);
    expect(parse(over).code).toBe("per_trade_exceeded");
    const ok = parse(await call(secret, { calls: [{ target: USDC, method: "approve(address,uint256)", args: [ROUTER, "50000"] }] }));
    expect(ok.status).toBe("confirmed");
  });

  test("spender outside scope -> spender_not_allowed", async () => {
    const { secret } = await issue(
      { contract: { targets: [USDC], selectors: ["approve(address,uint256)"], tokens: [USDC] } },
      "spender-deny",
    );
    const res = await call(secret, { calls: [{ target: USDC, method: "approve(address,uint256)", args: [POOL, "1"] }] });
    expect(res.isError).toBe(true);
    expect(parse(res).code).toBe("spender_not_allowed");
  });

  test("sub-card token list must be a subset of parent's", async () => {
    // parent: WETH is a callable target (approve in scope) but NOT an allowance token;
    // only USDC is. So a child asking to add WETH to its token list is a tokens
    // violation even though WETH is a legal target.
    const { secret } = await issue(
      { contract: { targets: [ROUTER, WETH], selectors: [swapSig, "approve(address,uint256)"], tokens: [USDC] } },
      "tokenlist-lead",
    );
    const lead = await connect(`${base}/c/${secret}/mcp`);
    const denied = await lead.callTool({
      name: "issue_subcard",
      arguments: { name: "fat-tokens", terms: { contract: { targets: [ROUTER, WETH], selectors: [swapSig, "approve(address,uint256)"], tokens: [WETH] } } },
    });
    expect(denied.isError).toBe(true);
    expect((parse(denied).detail as { field: string }).field).toBe("contract.tokens");
    const ok = parse(await lead.callTool({
      name: "issue_subcard",
      arguments: { name: "subset-tokens", terms: { contract: { targets: [ROUTER], selectors: [swapSig], tokens: [USDC] } } },
    }));
    expect(ok.card_url).toContain("/c/");
    await lead.close();
  });
});
