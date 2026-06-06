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
  payLeafScope,
  contractLeafScope,
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
