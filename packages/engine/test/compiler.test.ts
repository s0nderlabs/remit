// Offline compiler tests: assert compiled caveat shapes against the REAL SAK env map
// (getSmartAccountsEnvironment is a static table, no network). Mirrors probe shapes.

import { describe, expect, test } from "bun:test";
import { getSmartAccountsEnvironment } from "@metamask/smart-accounts-kit";
import {
  compileCard,
  validateTerms,
  applyOrArgs,
  orArgs,
  attenuate,
  feeSafeContractScope,
  declaredContractScope,
  canonicalSelector,
  payLeafScope,
  contractLeafScope,
  decodeAllowanceCall,
  allowancePinCaveats,
  allowanceLeafScope,
} from "../src/compiler";
import { CHAINS, LOGICAL_OR_WRAPPER, SWAP_ROUTER_02 } from "../src/chains";
import { RefusalError } from "../src/errors";
import type { Address } from "viem";
import type { CardTerms } from "../src/types";

const NOW = 1_780_000_000; // fixed clock for deterministic shapes
const OPTS = { revocationNonce: 0n, now: NOW } as const;
const env = getSmartAccountsEnvironment(8453);
const E = env.caveatEnforcers as Record<string, Address>;
const USDC = CHAINS[8453].usdc;
const MERCHANT = "0xAc36D18d2315c8c1F6e93B9074D3C25e2DC14127" as Address;

const lc = (a: string) => a.toLowerCase();

const PAY_TERMS: CardTerms = { pay: { period: { amount: "25", seconds: 604800 } }, expiry: NOW + 30 * 86400 };
const CONTRACT_TERMS: CardTerms = {
  contract: { targets: [SWAP_ROUTER_02], selectors: ["approve(address,uint256)", "exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))"] },
  expiry: NOW + 7 * 86400,
};
const COMPOSITE_TERMS: CardTerms = { ...PAY_TERMS, ...CONTRACT_TERMS, expiry: NOW + 7 * 86400 };

describe("compileCard: pay", () => {
  test("default-shaped card: [period, timestamp, nonce]", () => {
    const c = compileCard(PAY_TERMS, OPTS);
    expect(c.kind).toBe("pay");
    expect(c.rootCaveats.map((cv) => lc(cv.enforcer))).toEqual([
      lc(E.ERC20PeriodTransferEnforcer!),
      lc(E.TimestampEnforcer!),
      lc(E.NonceEnforcer!),
    ]);
    expect(c.periodStartDate).toBe(NOW - 300); // backdated, persisted for window math
    expect(c.orGroups).toBeNull();
  });

  test("period + lifetime + maxUses stack", () => {
    const c = compileCard(
      { pay: { period: { amount: "50", seconds: 604800 }, lifetime: { amount: "100" } }, expiry: NOW + 86400, maxUses: 5 },
      OPTS,
    );
    expect(c.rootCaveats.map((cv) => lc(cv.enforcer))).toEqual([
      lc(E.ERC20PeriodTransferEnforcer!),
      lc(E.ERC20TransferAmountEnforcer!),
      lc(E.TimestampEnforcer!),
      lc(E.LimitedCallsEnforcer!),
      lc(E.NonceEnforcer!),
    ]);
  });

  test("no expiry -> no timestamp caveat; nonce always present", () => {
    const c = compileCard({ pay: { lifetime: { amount: "10" } } }, OPTS);
    expect(c.rootCaveats.map((cv) => lc(cv.enforcer))).toEqual([
      lc(E.ERC20TransferAmountEnforcer!),
      lc(E.NonceEnforcer!),
    ]);
  });

  test("merchants + perTxMax land in carve policy, NEVER the root", () => {
    const c = compileCard({ ...PAY_TERMS, merchants: [MERCHANT], perTxMax: "5" }, OPTS);
    expect(c.carvePolicy.merchants).toEqual([MERCHANT]);
    expect(c.carvePolicy.perTxMaxAtoms).toBe(5_000_000n);
    // Phase-B live rule: no AllowedCalldata pin on the root (collides with fee leg)
    expect(c.rootCaveats.map((cv) => lc(cv.enforcer))).not.toContain(lc(E.AllowedCalldataEnforcer!));
  });
});

describe("compileCard: contract", () => {
  test("targets+methods root, fee leg unioned in", () => {
    const c = compileCard(CONTRACT_TERMS, OPTS);
    expect(c.kind).toBe("contract");
    expect(c.rootCaveats.map((cv) => lc(cv.enforcer))).toEqual([
      lc(E.AllowedTargetsEnforcer!),
      lc(E.AllowedMethodsEnforcer!),
      lc(E.TimestampEnforcer!),
      lc(E.NonceEnforcer!),
    ]);
  });

  test("feeSafeContractScope unions USDC + transfer()", () => {
    const s = feeSafeContractScope({ targets: [SWAP_ROUTER_02], selectors: ["approve(address,uint256)"] });
    expect(s.targets.map(lc)).toContain(lc(USDC));
    expect(s.selectors).toContain("transfer(address,uint256)");
    // idempotent: no dupes when already present
    const s2 = feeSafeContractScope(s);
    expect(s2.targets.length).toBe(s.targets.length);
    expect(s2.selectors.length).toBe(s.selectors.length);
  });
});

describe("compileCard: composite (probe10 shape)", () => {
  test("root = [OR, timestamp, nonce]; OR at position 0 with manual enforcer addr", () => {
    const c = compileCard(COMPOSITE_TERMS, OPTS);
    expect(c.kind).toBe("composite");
    expect(c.rootCaveats.map((cv) => lc(cv.enforcer))).toEqual([
      lc(LOGICAL_OR_WRAPPER), // NOT in the SDK env map; manual address
      lc(E.TimestampEnforcer!),
      lc(E.NonceEnforcer!),
    ]);
    expect(c.orGroups).toEqual({ payIndex: 0n, contractIndex: 1n, sizes: [1, 2], caveatPosition: 0 });
  });

  test("applyOrArgs swaps ONLY the wrapper args per mode", () => {
    const c = compileCard(COMPOSITE_TERMS, OPTS);
    const pay = applyOrArgs(c, "pay");
    const contract = applyOrArgs(c, "contract");
    expect(pay[0]!.args).toBe(orArgs(0n, 1));
    expect(contract[0]!.args).toBe(orArgs(1n, 2));
    // terms identical; non-wrapper caveats untouched
    expect(pay[0]!.terms).toBe(contract[0]!.terms);
    expect(pay.slice(1)).toEqual(contract.slice(1));
    // original compiled caveats not mutated
    expect(c.rootCaveats[0]!.args).toBe(orArgs(0n, 1));
  });
});

describe("leaf scopes", () => {
  test("pay leaf = Erc20TransferAmount", () => {
    const s = payLeafScope(1_020_000n);
    expect(s.tokenAddress).toBe(USDC);
    expect(s.maxAmount).toBe(1_020_000n);
  });
  test("contract leaf = FunctionCall with fee path", () => {
    const s = contractLeafScope({ targets: [SWAP_ROUTER_02], selectors: ["approve(address,uint256)"] });
    expect(s.targets.map(lc)).toContain(lc(USDC));
    expect(s.selectors).toContain("transfer(address,uint256)");
  });
  test("declaredContractScope does NOT union USDC/transfer (no scope-escape)", () => {
    const s = declaredContractScope({ targets: [SWAP_ROUTER_02], selectors: ["approve(address,uint256)"] });
    expect(s.targets.map(lc)).not.toContain(lc(USDC)); // the fee-leg pair is invisible to the agent
    expect(s.selectors).not.toContain("transfer(address,uint256)");
    expect(s.targets.map(lc)).toEqual([lc(SWAP_ROUTER_02)]);
    expect(s.selectors).toEqual(["approve(address,uint256)"]);
  });
});

describe("selector canonicalization", () => {
  test("canonicalSelector normalizes aliases + whitespace", () => {
    expect(canonicalSelector("withdraw(uint)")).toBe("withdraw(uint256)");
    expect(canonicalSelector("approve(address, uint256)")).toBe("approve(address,uint256)");
    expect(canonicalSelector("exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))")).toBe(
      "exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))",
    );
  });
  test("compileCard stores canonical selectors (uint -> uint256)", () => {
    const c = compileCard({ contract: { targets: [SWAP_ROUTER_02], selectors: ["withdraw(uint)", "approve(address, uint256)"] } }, OPTS);
    expect(c.terms.contract!.selectors).toEqual(["withdraw(uint256)", "approve(address,uint256)"]);
  });
  test("attenuate accepts an aliased child selector as a subset match", () => {
    const parent: CardTerms = { contract: { targets: [SWAP_ROUTER_02], selectors: ["withdraw(uint256)"] } };
    const child: CardTerms = { contract: { targets: [SWAP_ROUTER_02], selectors: ["withdraw(uint)"] } };
    const out = attenuate(parent, {}, child, NOW); // should NOT throw exceeds_parent_terms
    expect(out.contract!.selectors).toEqual(["withdraw(uint256)"]);
  });
});

describe("maxUses: on-chain limit scaled to executions (per-execution enforcer)", () => {
  // The LimitedCallsEnforcer counts executions, not redemptions, and every redemption
  // appends a fee-leg execution (+ up to 5 work calls). Scale the on-chain limit so it
  // never falsely blocks a redemption the server-side maxUses cap allows. limit = N*6.
  test("limitedCalls caveat encodes maxUses * 6", () => {
    const c2 = compileCard({ contract: { targets: [SWAP_ROUTER_02], selectors: ["approve(address,uint256)"] }, maxUses: 2 }, OPTS);
    expect(c2.rootCaveats.some((cv) => BigInt(cv.terms) === 12n)).toBe(true); // 2 * 6
    const c1 = compileCard({ contract: { targets: [SWAP_ROUTER_02], selectors: ["approve(address,uint256)"] }, maxUses: 1 }, OPTS);
    expect(c1.rootCaveats.some((cv) => BigInt(cv.terms) === 6n)).toBe(true); // 1 * 6, NOT 1
    expect(c1.rootCaveats.some((cv) => BigInt(cv.terms) === 1n)).toBe(false);
  });
});

describe("validateTerms refusals", () => {
  const bad = (terms: CardTerms, code = "invalid_terms") => {
    try {
      validateTerms(terms, NOW);
      throw new Error("expected refusal");
    } catch (e) {
      expect(e).toBeInstanceOf(RefusalError);
      expect((e as RefusalError).code).toBe(code as never);
    }
  };
  test("empty card", () => bad({}));
  test("pay with no caps", () => bad({ pay: {} }));
  test("zero amount", () => bad({ pay: { period: { amount: "0", seconds: 604800 } } }));
  test("past expiry", () => bad({ pay: { lifetime: { amount: "1" } }, expiry: NOW - 1 }));
  test("bad merchant address", () => bad({ pay: { lifetime: { amount: "1" } }, merchants: ["0xnope" as Address] }));
  test("bad selector", () => bad({ contract: { targets: [SWAP_ROUTER_02], selectors: ["not a sig"] } }));
  // unparseable-but-regex-valid selectors must be rejected (else a phantom on-chain
  // selector gets stored that no real call matches).
  test("unparseable selector (passes regex, fails ABI parser)", () =>
    bad({ contract: { targets: [SWAP_ROUTER_02], selectors: ["withdraw(UINT)"] } }));
  test("unparseable selector with a bogus type", () =>
    bad({ contract: { targets: [SWAP_ROUTER_02], selectors: ["foo(bar)"] } }));
});

describe("attenuate (sub-cards)", () => {
  const parent: CardTerms = {
    pay: { period: { amount: "25", seconds: 604800 } },
    contract: { targets: [SWAP_ROUTER_02, USDC], selectors: ["approve(address,uint256)", "transfer(address,uint256)"] },
    expiry: NOW + 30 * 86400,
    merchants: [MERCHANT],
  };
  const remaining = { periodRemainingAtoms: 10_000_000n, lifetimeRemainingAtoms: null };

  test("tighter child passes", () => {
    const child = attenuate(parent, remaining, { pay: { period: { amount: "5", seconds: 86400 } } }, NOW);
    expect(child.pay!.period!.amount).toBe("5");
    expect(child.expiry).toBe(parent.expiry); // inherited
    expect(child.merchants).toEqual([MERCHANT]); // inherited
  });

  test("omitted pay inherits capped to remaining", () => {
    const child = attenuate(parent, remaining, {}, NOW);
    expect(child.pay!.period!.amount).toBe("10"); // min(25, remaining 10)
  });

  test("child over parent cap -> exceeds_parent_terms naming the field", () => {
    try {
      attenuate(parent, remaining, { pay: { period: { amount: "30", seconds: 604800 } } }, NOW);
      throw new Error("expected refusal");
    } catch (e) {
      expect((e as RefusalError).code).toBe("exceeds_parent_terms");
      expect((e as RefusalError).detail?.field).toBe("pay.period.amount");
    }
  });

  test("contract scope is subset-only, never inherited", () => {
    const child = attenuate(parent, remaining, {}, NOW);
    expect(child.contract).toBeUndefined();
    expect(() =>
      attenuate(parent, remaining, { contract: { targets: ["0x1111111111111111111111111111111111111111" as Address], selectors: ["transfer(address,uint256)"] } }, NOW),
    ).toThrow();
  });

  test("longer expiry refused; foreign merchant refused", () => {
    expect(() => attenuate(parent, remaining, { pay: { period: { amount: "1", seconds: 86400 } }, expiry: NOW + 60 * 86400 }, NOW)).toThrow();
    expect(() => attenuate(parent, remaining, { pay: { period: { amount: "1", seconds: 86400 } }, merchants: ["0x2222222222222222222222222222222222222222" as Address] }, NOW)).toThrow();
  });

  test("pay child of contract-only parent refused", () => {
    const contractOnly: CardTerms = { contract: parent.contract! };
    expect(() => attenuate(contractOnly, { periodRemainingAtoms: null, lifetimeRemainingAtoms: null }, { pay: { lifetime: { amount: "1" } } }, NOW)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// #42: allowance tokens + perTradeMax (validate/normalize, decode, pins, attenuate)
// ---------------------------------------------------------------------------

describe("contract.tokens + perTradeMax: validation and normalization", () => {
  const WETH = "0x4200000000000000000000000000000000000006" as Address;

  test("tokens union into targets, approve unions into selectors", () => {
    const terms: CardTerms = {
      contract: { targets: [SWAP_ROUTER_02], selectors: ["exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))"], tokens: [USDC] },
    };
    validateTerms(terms, NOW);
    expect(terms.contract!.targets.map(lc)).toContain(lc(USDC));
    expect(terms.contract!.selectors).toContain("approve(address,uint256)");
  });

  test("normalization is idempotent (no duplicate unions)", () => {
    const terms: CardTerms = {
      contract: { targets: [SWAP_ROUTER_02, USDC], selectors: ["approve(address,uint256)"], tokens: [USDC] },
    };
    validateTerms(terms, NOW);
    validateTerms(terms, NOW);
    expect(terms.contract!.targets.filter((t) => lc(t) === lc(USDC)).length).toBe(1);
    expect(terms.contract!.selectors.filter((s) => s === "approve(address,uint256)").length).toBe(1);
  });

  test("bad token address / empty list / non-positive perTradeMax refused", () => {
    expect(() => validateTerms({ contract: { targets: [SWAP_ROUTER_02], selectors: ["approve(address,uint256)"], tokens: ["0xnope" as Address] } }, NOW)).toThrow(RefusalError);
    expect(() => validateTerms({ contract: { targets: [SWAP_ROUTER_02], selectors: ["approve(address,uint256)"], tokens: [] } }, NOW)).toThrow(RefusalError);
    expect(() => validateTerms({ contract: { targets: [SWAP_ROUTER_02], selectors: ["approve(address,uint256)"], perTradeMax: "0" } }, NOW)).toThrow(RefusalError);
  });

  test("malformed amounts refuse with a typed invalid_terms, never a bare 500-class Error", () => {
    // perTradeMax: non-numeric and over-precise both 422
    expect(() => validateTerms({ contract: { targets: [SWAP_ROUTER_02], selectors: ["approve(address,uint256)"], perTradeMax: "abc" } }, NOW)).toThrow(RefusalError);
    expect(() => validateTerms({ contract: { targets: [SWAP_ROUTER_02], selectors: ["approve(address,uint256)"], perTradeMax: "1.1234567" } }, NOW)).toThrow(RefusalError);
    // pay amounts and perTxMax share the same guard
    expect(() => validateTerms({ pay: { period: { amount: "abc", seconds: 3600 } } }, NOW)).toThrow(RefusalError);
    expect(() => validateTerms({ pay: { lifetime: { amount: "1.0000001" } } }, NOW)).toThrow(RefusalError);
    expect(() => validateTerms({ pay: { lifetime: { amount: "5" } }, perTxMax: "nope" }, NOW)).toThrow(RefusalError);
  });

  test("tokens compile into the on-chain root scope (allowedTargets carries the token)", () => {
    const c = compileCard(
      { contract: { targets: [SWAP_ROUTER_02], selectors: ["exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))"], tokens: [WETH] } },
      OPTS,
    );
    const targetsCaveat = c.rootCaveats.find((cv) => lc(cv.enforcer) === lc(E.AllowedTargetsEnforcer!))!;
    expect(lc(targetsCaveat.terms)).toContain(lc(WETH).slice(2));
  });
});

describe("decodeAllowanceCall + allowance pins", () => {
  const SPENDER = SWAP_ROUTER_02;

  const approveData = (spender: Address, amount: bigint): `0x${string}` =>
    ("0x095ea7b3" + spender.slice(2).toLowerCase().padStart(64, "0") + amount.toString(16).padStart(64, "0")) as `0x${string}`;

  test("approve decodes to token/spender/amount", () => {
    const al = decodeAllowanceCall({ target: USDC, data: approveData(SPENDER, 50_000n) })!;
    expect(lc(al.token)).toBe(lc(USDC));
    expect(lc(al.spender)).toBe(lc(SPENDER));
    expect(al.amountAtoms).toBe(50_000n);
    expect(al.sig).toBe("approve(address,uint256)");
  });

  test("increaseAllowance decodes as allowance too", () => {
    const data = ("0x39509351" + SPENDER.slice(2).toLowerCase().padStart(64, "0") + (7n).toString(16).padStart(64, "0")) as `0x${string}`;
    const al = decodeAllowanceCall({ target: USDC, data })!;
    expect(al.sig).toBe("increaseAllowance(address,uint256)");
    expect(al.amountAtoms).toBe(7n);
  });

  test("non-allowance methods return null", () => {
    expect(decodeAllowanceCall({ target: USDC, data: "0xa9059cbb" + "0".repeat(128) as `0x${string}` })).toBeNull();
  });

  test("malformed allowance calldata refused (trailing bytes / dirty spender word)", () => {
    expect(() => decodeAllowanceCall({ target: USDC, data: (approveData(SPENDER, 1n) + "ff") as `0x${string}` })).toThrow(RefusalError);
    const dirty = ("0x095ea7b3" + "ff".repeat(12) + SPENDER.slice(2) + (1n).toString(16).padStart(64, "0")) as `0x${string}`;
    expect(() => decodeAllowanceCall({ target: USDC, data: dirty })).toThrow(RefusalError);
  });

  test("pins: AllowedCalldata spender@4 + amount@36, exact padded values", () => {
    const al = decodeAllowanceCall({ target: USDC, data: approveData(SPENDER, 123_456n) })!;
    const pins = allowancePinCaveats(al, 8453);
    expect(pins.length).toBe(2);
    for (const p of pins) expect(lc(p.enforcer)).toBe(lc(E.AllowedCalldataEnforcer!));
    expect(lc(pins[0]!.terms)).toBe(
      "0x" + (4n).toString(16).padStart(64, "0") + SPENDER.slice(2).toLowerCase().padStart(64, "0"),
    );
    expect(lc(pins[1]!.terms)).toBe(
      "0x" + (36n).toString(16).padStart(64, "0") + (123_456n).toString(16).padStart(64, "0"),
    );
  });

  test("allowanceLeafScope narrows to [token] x [called sig]", () => {
    const al = decodeAllowanceCall({ target: USDC, data: approveData(SPENDER, 1n) })!;
    const scope = allowanceLeafScope(al);
    expect(scope.targets).toEqual([USDC]);
    expect(scope.selectors).toEqual(["approve(address,uint256)"]);
  });
});

describe("attenuate: tokens + perTradeMax", () => {
  const WETH = "0x4200000000000000000000000000000000000006" as Address;
  const swapSig = "exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))";
  const mkParent = (): CardTerms => {
    const p: CardTerms = {
      contract: { targets: [SWAP_ROUTER_02], selectors: [swapSig], tokens: [USDC, WETH], perTradeMax: "5" },
    };
    validateTerms(p, NOW); // stored parents are normalized
    return p;
  };
  const noRemaining = { periodRemainingAtoms: null, lifetimeRemainingAtoms: null };

  test("child tokens subset allowed; foreign token refused", () => {
    const parent = mkParent();
    const ok = attenuate(parent, noRemaining, { contract: { targets: [SWAP_ROUTER_02], selectors: [swapSig], tokens: [USDC] } }, NOW);
    expect(ok.contract!.tokens!.map(lc)).toEqual([lc(USDC)]);
    expect(() =>
      attenuate(parent, noRemaining, { contract: { targets: [SWAP_ROUTER_02], selectors: [swapSig], tokens: ["0x3333333333333333333333333333333333333333" as Address] } }, NOW),
    ).toThrow(RefusalError);
  });

  test("tokens are NOT inherited by a silent child (no surprise allowance capability)", () => {
    const parent = mkParent();
    const child = attenuate(parent, noRemaining, { contract: { targets: [SWAP_ROUTER_02], selectors: [swapSig] } }, NOW);
    expect(child.contract!.tokens).toBeUndefined();
    expect(child.contract!.selectors).not.toContain("approve(address,uint256)");
  });

  test("child can't smuggle scope via tokens (normalize-before-subset)", () => {
    // parent WITHOUT approve anywhere in scope
    const parent: CardTerms = { contract: { targets: [SWAP_ROUTER_02], selectors: [swapSig] } };
    validateTerms(parent, NOW);
    expect(() =>
      attenuate(parent, noRemaining, { contract: { targets: [SWAP_ROUTER_02], selectors: [swapSig], tokens: [USDC] } }, NOW),
    ).toThrow(RefusalError);
  });

  test("perTradeMax inherits when silent only onto an approve-capable child; child above parent refused; tighter ok", () => {
    const parent = mkParent();
    // approve-capable silent child (tokens union approve into scope) inherits the cap
    const capable = attenuate(parent, noRemaining, { contract: { targets: [SWAP_ROUTER_02], selectors: [swapSig], tokens: [USDC] } }, NOW);
    expect(capable.contract!.perTradeMax).toBe("5");
    // a child with no approve in scope can never trigger the cap: nothing to inherit
    const silent = attenuate(parent, noRemaining, { contract: { targets: [SWAP_ROUTER_02], selectors: [swapSig] } }, NOW);
    expect(silent.contract!.perTradeMax).toBeUndefined();
    const tighter = attenuate(parent, noRemaining, { contract: { targets: [SWAP_ROUTER_02], selectors: [swapSig], perTradeMax: "1" } }, NOW);
    expect(tighter.contract!.perTradeMax).toBe("1");
    try {
      attenuate(parent, noRemaining, { contract: { targets: [SWAP_ROUTER_02], selectors: [swapSig], perTradeMax: "10" } }, NOW);
      throw new Error("expected refusal");
    } catch (e) {
      expect((e as RefusalError).detail?.field).toBe("contract.perTradeMax");
    }
  });
});
