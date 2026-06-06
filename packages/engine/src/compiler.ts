// The caveat compiler: CardTerms -> root caveats + carve policy + leaf scopes.
// Every shape here is probe-proven (probes/RESULTS.md):
//   pay root        = [erc20PeriodTransfer?, erc20TransferAmount?, timestamp?, limitedCalls?, nonce]
//   contract root   = [allowedTargets, allowedMethods, timestamp?, limitedCalls?, nonce]
//   composite root  = [LogicalOrWrapper(pay-group | contract-group), timestamp?, limitedCalls?, nonce]
// Build rules (probe10): fee leg must pass the selected group -> contract group ALWAYS
// unions USDC into targets and transfer() into selectors; ONE group governs a whole
// redemption; targets/methods check EVERY execution; OR args per redemption =
// {groupIndex, caveatArgs len == group size, elements "0x00"} ("0x" is rejected).
// Merchant pins NEVER compile into the root (Phase-B live: they collide with the
// mandatory fee leg) -> carve-layer policy.

import { pad, toHex, type Address, type Hex } from "viem";
import { getSmartAccountsEnvironment, ScopeType, createCaveat } from "@metamask/smart-accounts-kit";
import { createCaveatBuilder } from "@metamask/smart-accounts-kit/utils";
import {
  createLogicalOrWrapperTerms,
  createLogicalOrWrapperArgs,
} from "@metamask/delegation-core";
import { CHAIN_ID, CHAINS, LOGICAL_OR_WRAPPER, type ChainId } from "./chains";
import { usdcToAtoms, atomsToUsdc } from "./money";
import { RefusalError } from "./errors";
import type {
  CardTerms,
  CompiledCard,
  ContractTerms,
  OrGroupInfo,
  WireCaveat,
} from "./types";

const TRANSFER_SIG = "transfer(address,uint256)";
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
// Human-readable ABI signature, tuple params allowed: "exactInputSingle((address,uint24,...))"
const SELECTOR_RE = /^[a-zA-Z_]\w*\(.*\)$/;

// Backdate period startDate so ERC20PeriodTransferEnforcer never sees a future start
// (reverts transfer-not-started if startDate > block.timestamp).
const START_DATE_BACKDATE_S = 300;

export type CompileOpts = {
  chainId?: ChainId;
  /** The user's CURRENT NonceEnforcer revocation nonce (bumping it nukes the tree). */
  revocationNonce: bigint;
  /** Unix seconds. Caller supplies (testability); period windows anchor here. */
  now: number;
};

function env(chainId: ChainId) {
  return getSmartAccountsEnvironment(chainId);
}

function builder(chainId: ChainId) {
  return createCaveatBuilder(env(chainId));
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function invalid(message: string, field?: string): never {
  throw new RefusalError("invalid_terms", message, field ? { field } : undefined);
}

export function validateTerms(terms: CardTerms, now: number): void {
  if (!terms.pay && !terms.contract) {
    invalid("card needs at least one capability: pay and/or contract");
  }
  if (terms.pay) {
    const { period, lifetime } = terms.pay;
    if (!period && !lifetime) invalid("pay needs period and/or lifetime cap", "pay");
    if (period) {
      if (usdcToAtoms(period.amount) <= 0n) invalid("period amount must be > 0", "pay.period.amount");
      if (!Number.isInteger(period.seconds) || period.seconds < 60) {
        invalid("period must be >= 60 seconds", "pay.period.seconds");
      }
    }
    if (lifetime && usdcToAtoms(lifetime.amount) <= 0n) {
      invalid("lifetime amount must be > 0", "pay.lifetime.amount");
    }
  }
  if (terms.contract) {
    const { targets, selectors } = terms.contract;
    if (!targets?.length) invalid("contract scope needs at least one target", "contract.targets");
    if (!selectors?.length) invalid("contract scope needs at least one selector", "contract.selectors");
    for (const t of targets) if (!ADDRESS_RE.test(t)) invalid(`bad target address: ${t}`, "contract.targets");
    for (const s of selectors) if (!SELECTOR_RE.test(s)) invalid(`bad method signature: ${s}`, "contract.selectors");
  }
  if (terms.expiry !== undefined) {
    if (!Number.isInteger(terms.expiry) || terms.expiry <= now) invalid("expiry must be in the future", "expiry");
  }
  if (terms.maxUses !== undefined) {
    if (!Number.isInteger(terms.maxUses) || terms.maxUses < 1) invalid("maxUses must be >= 1", "maxUses");
  }
  if (terms.perTxMax !== undefined && usdcToAtoms(terms.perTxMax) <= 0n) {
    invalid("perTxMax must be > 0", "perTxMax");
  }
  if (terms.merchants !== undefined) {
    if (!terms.merchants.length) invalid("merchant lock needs at least one address", "merchants");
    for (const m of terms.merchants) if (!ADDRESS_RE.test(m)) invalid(`bad merchant address: ${m}`, "merchants");
  }
}

// ---------------------------------------------------------------------------
// Scope normalization (fee-leg build rule)
// ---------------------------------------------------------------------------

/** Union USDC + transfer() into a contract scope so the mandatory fee leg passes. */
export function feeSafeContractScope(terms: ContractTerms, chainId: ChainId = CHAIN_ID): ContractTerms {
  const usdc = CHAINS[chainId].usdc;
  const targets = terms.targets.some((t) => t.toLowerCase() === usdc.toLowerCase())
    ? terms.targets
    : [...terms.targets, usdc];
  const selectors = terms.selectors.includes(TRANSFER_SIG)
    ? terms.selectors
    : [...terms.selectors, TRANSFER_SIG];
  return { targets, selectors };
}

// ---------------------------------------------------------------------------
// Caveat group builders
// ---------------------------------------------------------------------------

function payCaveats(terms: NonNullable<CardTerms["pay"]>, opts: CompileOpts, chainId: ChainId): WireCaveat[] {
  const usdc = CHAINS[chainId].usdc;
  let b = builder(chainId);
  if (terms.period) {
    b = b.addCaveat("erc20PeriodTransfer", {
      tokenAddress: usdc,
      periodAmount: usdcToAtoms(terms.period.amount),
      periodDuration: terms.period.seconds,
      startDate: opts.now - START_DATE_BACKDATE_S,
    });
  }
  if (terms.lifetime) {
    b = b.addCaveat("erc20TransferAmount", {
      tokenAddress: usdc,
      maxAmount: usdcToAtoms(terms.lifetime.amount),
    });
  }
  return b.build() as WireCaveat[];
}

function contractCaveats(terms: ContractTerms, chainId: ChainId): WireCaveat[] {
  const scope = feeSafeContractScope(terms, chainId);
  return builder(chainId)
    .addCaveat("allowedTargets", { targets: scope.targets })
    .addCaveat("allowedMethods", { selectors: scope.selectors })
    .build() as WireCaveat[];
}

/** timestamp? + limitedCalls? + nonce (always), shared by every kind. */
function baseCaveats(terms: CardTerms, opts: CompileOpts, chainId: ChainId): WireCaveat[] {
  let b = builder(chainId);
  if (terms.expiry !== undefined) {
    b = b.addCaveat("timestamp", { afterThreshold: 0, beforeThreshold: terms.expiry });
  }
  if (terms.maxUses !== undefined) {
    b = b.addCaveat("limitedCalls", { limit: terms.maxUses });
  }
  b = b.addCaveat("nonce", { nonce: pad(toHex(opts.revocationNonce), { size: 32 }) });
  return b.build() as WireCaveat[];
}

// ---------------------------------------------------------------------------
// OR-wrapper (composite cards)
// ---------------------------------------------------------------------------

/** Per-redemption args for the LogicalOrWrapper caveat. Inner elements must be "0x00" ("0x" rejected). */
export function orArgs(groupIndex: bigint, groupSize: number): Hex {
  return createLogicalOrWrapperArgs({
    groupIndex,
    caveatArgs: Array(groupSize).fill("0x00"),
  }) as Hex;
}

function orWrapperCaveat(payGroup: WireCaveat[], contractGroup: WireCaveat[]): { caveat: WireCaveat; info: Omit<OrGroupInfo, "caveatPosition"> } {
  const toGroup = (cs: WireCaveat[]) => cs.map((c) => ({ enforcer: c.enforcer, terms: c.terms, args: "0x00" as Hex }));
  const terms = createLogicalOrWrapperTerms({
    caveatGroups: [toGroup(payGroup), toGroup(contractGroup)] as never,
  }) as Hex;
  const sizes = [payGroup.length, contractGroup.length];
  // Placeholder args select the pay group; spend swaps args per redemption.
  const caveat = createCaveat(LOGICAL_OR_WRAPPER, terms, orArgs(0n, sizes[0]!)) as WireCaveat;
  return { caveat, info: { payIndex: 0n, contractIndex: 1n, sizes } };
}

/** Clone root caveats with the OR-wrapper's args swapped for this redemption's mode. */
export function applyOrArgs(compiled: CompiledCard, mode: "pay" | "contract"): WireCaveat[] {
  if (!compiled.orGroups) return compiled.rootCaveats;
  const g = compiled.orGroups;
  const idx = mode === "pay" ? g.payIndex : g.contractIndex;
  const size = g.sizes[Number(idx)];
  if (size === undefined) throw new RefusalError("invalid_terms", `no OR group for mode ${mode}`);
  return compiled.rootCaveats.map((c, i) =>
    i === g.caveatPosition ? { ...c, args: orArgs(idx, size) } : c,
  );
}

// ---------------------------------------------------------------------------
// The compiler
// ---------------------------------------------------------------------------

export function compileCard(terms: CardTerms, opts: CompileOpts): CompiledCard {
  const chainId = opts.chainId ?? CHAIN_ID;
  validateTerms(terms, opts.now);

  const base = baseCaveats(terms, opts, chainId);
  const carvePolicy = {
    perTxMaxAtoms: terms.perTxMax !== undefined ? usdcToAtoms(terms.perTxMax) : null,
    merchants: terms.merchants ?? null,
  };
  const periodStartDate = terms.pay?.period ? opts.now - START_DATE_BACKDATE_S : null;

  if (terms.pay && terms.contract) {
    const payGroup = payCaveats(terms.pay, opts, chainId);
    const contractGroup = contractCaveats(terms.contract, chainId);
    const { caveat, info } = orWrapperCaveat(payGroup, contractGroup);
    return {
      kind: "composite",
      rootCaveats: [caveat, ...base],
      orGroups: { ...info, caveatPosition: 0 },
      carvePolicy,
      periodStartDate,
      terms,
    };
  }

  if (terms.pay) {
    return {
      kind: "pay",
      rootCaveats: [...payCaveats(terms.pay, opts, chainId), ...base],
      orGroups: null,
      carvePolicy,
      periodStartDate,
      terms,
    };
  }

  return {
    kind: "contract",
    rootCaveats: [...contractCaveats(terms.contract!, chainId), ...base],
    orGroups: null,
    carvePolicy,
    periodStartDate,
    terms,
  };
}

// ---------------------------------------------------------------------------
// Leaf scopes (what the carved leaf delegation allows)
// ---------------------------------------------------------------------------

export function payLeafScope(maxAmountAtoms: bigint, chainId: ChainId = CHAIN_ID) {
  return {
    type: ScopeType.Erc20TransferAmount,
    tokenAddress: CHAINS[chainId].usdc,
    maxAmount: maxAmountAtoms,
  } as const;
}

export function contractLeafScope(terms: ContractTerms, chainId: ChainId = CHAIN_ID) {
  const scope = feeSafeContractScope(terms, chainId);
  return {
    type: ScopeType.FunctionCall,
    targets: scope.targets,
    selectors: scope.selectors,
  } as const;
}

// ---------------------------------------------------------------------------
// Sub-card attenuation (exceeds_parent_terms; chain enforces anyway)
// ---------------------------------------------------------------------------

export type ParentRemaining = {
  /** Remaining spend in the parent's current period window (atoms), null if no period cap. */
  periodRemainingAtoms: bigint | null;
  /** Remaining lifetime (atoms), null if no lifetime cap. */
  lifetimeRemainingAtoms: bigint | null;
};

function exceeds(field: string, message: string): never {
  throw new RefusalError("exceeds_parent_terms", message, { field });
}

/**
 * Validate + fill child terms against the parent. Omitted money/expiry/merchant terms
 * inherit the parent capped to remaining; contract scope is NEVER implicitly inherited
 * (a sub-agent asks for exactly the surface it needs; must be a subset of the parent's).
 */
export function attenuate(parent: CardTerms, remaining: ParentRemaining, child: CardTerms, now: number): CardTerms {
  const out: CardTerms = structuredClone(child);

  // --- pay ---
  if (parent.pay) {
    if (!out.pay) {
      // inherit, capped to remaining
      out.pay = {};
      if (parent.pay.period) {
        const cap = remaining.periodRemainingAtoms ?? usdcToAtoms(parent.pay.period.amount);
        const inheritAtoms = cap < usdcToAtoms(parent.pay.period.amount) ? cap : usdcToAtoms(parent.pay.period.amount);
        out.pay.period = { amount: atomsFromBig(inheritAtoms), seconds: parent.pay.period.seconds };
      }
      if (parent.pay.lifetime) {
        const cap = remaining.lifetimeRemainingAtoms ?? usdcToAtoms(parent.pay.lifetime.amount);
        out.pay.lifetime = { amount: atomsFromBig(cap) };
      }
    } else {
      if (out.pay.period && parent.pay.period) {
        if (usdcToAtoms(out.pay.period.amount) > usdcToAtoms(parent.pay.period.amount)) {
          exceeds("pay.period.amount", `child period cap exceeds parent's ${parent.pay.period.amount}`);
        }
      }
      if (out.pay.period && !parent.pay.period && parent.pay.lifetime) {
        if (usdcToAtoms(out.pay.period.amount) > usdcToAtoms(parent.pay.lifetime.amount)) {
          exceeds("pay.period.amount", `child period cap exceeds parent's lifetime ${parent.pay.lifetime.amount}`);
        }
      }
      if (out.pay.lifetime && parent.pay.lifetime) {
        const cap = remaining.lifetimeRemainingAtoms ?? usdcToAtoms(parent.pay.lifetime.amount);
        if (usdcToAtoms(out.pay.lifetime.amount) > cap) {
          exceeds("pay.lifetime.amount", `child lifetime cap exceeds parent's remaining`);
        }
      }
    }
  } else if (out.pay) {
    exceeds("pay", "parent card has no pay capability");
  }

  // --- contract: subset-only, never inherited ---
  if (out.contract) {
    if (!parent.contract) exceeds("contract", "parent card has no contract capability");
    const pTargets = new Set(parent.contract.targets.map((t) => t.toLowerCase()));
    const pSelectors = new Set(parent.contract.selectors);
    for (const t of out.contract.targets) {
      if (!pTargets.has(t.toLowerCase())) exceeds("contract.targets", `target ${t} not in parent scope`);
    }
    for (const s of out.contract.selectors) {
      if (!pSelectors.has(s)) exceeds("contract.selectors", `selector ${s} not in parent scope`);
    }
  }

  // --- expiry ---
  if (parent.expiry !== undefined) {
    if (out.expiry === undefined) out.expiry = parent.expiry;
    else if (out.expiry > parent.expiry) exceeds("expiry", "child expiry exceeds parent's");
  }

  // --- merchants ---
  if (parent.merchants) {
    if (!out.merchants) out.merchants = [...parent.merchants];
    else {
      const pm = new Set(parent.merchants.map((m) => m.toLowerCase()));
      for (const m of out.merchants) {
        if (!pm.has(m.toLowerCase())) exceeds("merchants", `merchant ${m} not in parent whitelist`);
      }
    }
  }

  // --- perTxMax ---
  if (parent.perTxMax !== undefined) {
    if (out.perTxMax === undefined) out.perTxMax = parent.perTxMax;
    else if (usdcToAtoms(out.perTxMax) > usdcToAtoms(parent.perTxMax)) {
      exceeds("perTxMax", "child perTxMax exceeds parent's");
    }
  }

  // --- maxUses ---
  if (parent.maxUses !== undefined && out.maxUses !== undefined && out.maxUses > parent.maxUses) {
    exceeds("maxUses", "child maxUses exceeds parent's");
  }

  validateTerms(out, now);
  return out;
}

function atomsFromBig(atoms: bigint): string {
  return atomsToUsdc(atoms);
}
