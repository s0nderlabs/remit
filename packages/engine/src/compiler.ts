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

import { pad, parseAbiItem, toFunctionSelector, toFunctionSignature, toHex, type Address, type Hex } from "viem";
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
export const APPROVE_SIG = "approve(address,uint256)";
const INCREASE_ALLOWANCE_SIG = "increaseAllowance(address,uint256)";
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
// Human-readable ABI signature, tuple params allowed: "exactInputSingle((address,uint24,...))"
const SELECTOR_RE = /^[a-zA-Z_]\w*\(.*\)$/;

// Backdate period startDate so ERC20PeriodTransferEnforcer never sees a future start
// (reverts transfer-not-started if startDate > block.timestamp).
const START_DATE_BACKDATE_S = 300;

// The on-chain LimitedCallsEnforcer counts per EXECUTION, but maxUses is a REDEMPTION
// count (the server enforces it that way via subtreeUsesCount). Every redemption appends
// a fee-leg execution, and a contract `execute` may batch up to 5 work calls, so one
// redemption is up to 6 executions. LIVE-CONFIRMED Jun 8 2026 on Base mainnet: a
// maxUses:3 card died on-chain after one 3-execution swap (old limit=maxUses), and a
// maxUses:1 card ran a 2-call (3-execution) redemption once the limit was scaled
// (tx 0xb037f7d7). We scale the on-chain limit by the worst case so the chain never
// falsely pre-empts a redemption the server-side maxUses cap would allow; the server
// remains the binding, redemption-accurate limit. (5 = execute tool's calls.max(5);
// +1 = USDC fee leg. Pay/x402-only redemptions are just 2 executions, so they scale by 2.)
const MAX_EXECUTIONS_PER_REDEMPTION = 6;

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

/** Parse a request-supplied USD amount at a validation site: malformed input ("abc",
 * 7+ decimals) raises a typed invalid_terms refusal instead of money.ts's bare Error,
 * which would surface as a 500 instead of a 422. */
function usdAtoms(amount: string, field: string): bigint {
  try {
    return usdcToAtoms(amount);
  } catch {
    invalid(`${field} must be a USDC amount with at most 6 decimals`, field);
  }
}

export function validateTerms(terms: CardTerms, now: number): void {
  if (!terms.pay && !terms.contract) {
    invalid("card needs at least one capability: pay and/or contract");
  }
  if (terms.pay) {
    const { period, lifetime } = terms.pay;
    if (!period && !lifetime) invalid("pay needs period and/or lifetime cap", "pay");
    if (period) {
      if (usdAtoms(period.amount, "pay.period.amount") <= 0n) invalid("period amount must be > 0", "pay.period.amount");
      if (!Number.isInteger(period.seconds) || period.seconds < 60) {
        invalid("period must be >= 60 seconds", "pay.period.seconds");
      }
    }
    if (lifetime && usdAtoms(lifetime.amount, "pay.lifetime.amount") <= 0n) {
      invalid("lifetime amount must be > 0", "pay.lifetime.amount");
    }
  }
  if (terms.contract) validateAndNormalizeContract(terms.contract);
  if (terms.expiry !== undefined) {
    if (!Number.isInteger(terms.expiry) || terms.expiry <= now) invalid("expiry must be in the future", "expiry");
  }
  if (terms.maxUses !== undefined) {
    if (!Number.isInteger(terms.maxUses) || terms.maxUses < 1) invalid("maxUses must be >= 1", "maxUses");
  }
  if (terms.perTxMax !== undefined && usdAtoms(terms.perTxMax, "perTxMax") <= 0n) {
    invalid("perTxMax must be > 0", "perTxMax");
  }
  if (terms.merchants !== undefined) {
    if (!terms.merchants.length) invalid("merchant lock needs at least one address", "merchants");
    for (const m of terms.merchants) if (!ADDRESS_RE.test(m)) invalid(`bad merchant address: ${m}`, "merchants");
  }
}

/** Validate + normalize a contract scope IN PLACE: canonical selectors, plus the
 * tokens union (a declared allowance token must be a callable target with approve in
 * scope, so both are unioned in). Idempotent; runs at validateTerms and again at
 * attenuation BEFORE the parent-subset checks, so a child can't smuggle scope in via
 * `tokens` that the post-check union would silently add. */
export function validateAndNormalizeContract(ct: ContractTerms): void {
  const { targets, selectors, tokens, perTradeMax } = ct;
  if (!targets?.length) invalid("contract scope needs at least one target", "contract.targets");
  if (!selectors?.length) invalid("contract scope needs at least one selector", "contract.selectors");
  for (const t of targets) if (!ADDRESS_RE.test(t)) invalid(`bad target address: ${t}`, "contract.targets");
  for (const s of selectors) {
    if (!SELECTOR_RE.test(s)) invalid(`bad method signature: ${s}`, "contract.selectors");
    // SELECTOR_RE is looser than the ABI parser; reject signatures the parser can't
    // read (e.g. "withdraw(UINT)") rather than silently storing a phantom on-chain
    // selector that no real call matches.
    try {
      parseAbiItem(`function ${s}`);
    } catch {
      invalid(`unparseable method signature: ${s}`, "contract.selectors");
    }
  }
  // Normalize to canonical signatures (all parse now) so encode, raw-data check, and
  // on-chain allowedMethods agree (uint -> uint256, whitespace stripped). NOTE: this
  // mutates the contract terms in place; callers pass single-use request bodies and the
  // store re-deserializes per read, so aliasing is safe (double-canonicalize is a no-op).
  ct.selectors = selectors.map(canonicalSelector);
  if (tokens !== undefined) {
    if (!tokens.length) invalid("token list needs at least one address", "contract.tokens");
    for (const t of tokens) if (!ADDRESS_RE.test(t)) invalid(`bad token address: ${t}`, "contract.tokens");
    const have = new Set(ct.targets.map((t) => t.toLowerCase()));
    for (const t of tokens) {
      if (!have.has(t.toLowerCase())) {
        ct.targets = [...ct.targets, t];
        have.add(t.toLowerCase());
      }
    }
    if (!ct.selectors.includes(APPROVE_SIG)) ct.selectors = [...ct.selectors, APPROVE_SIG];
  }
  if (perTradeMax !== undefined && usdAtoms(perTradeMax, "contract.perTradeMax") <= 0n) {
    invalid("perTradeMax must be > 0", "contract.perTradeMax");
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
    // limit is in EXECUTIONS (per-execution enforcer); maxUses is in REDEMPTIONS. Scale
    // by the worst-case executions/redemption so the chain backstops without falsely
    // blocking a redemption the server-side maxUses (subtreeUsesCount) already allows.
    // pay/x402-only = 2 exec (work + fee); contract/composite can batch up to 6.
    const execsPerRedemption = terms.contract ? MAX_EXECUTIONS_PER_REDEMPTION : 2;
    b = b.addCaveat("limitedCalls", { limit: terms.maxUses * execsPerRedemption });
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

/** The scope the USER declared, for VALIDATING agent-requested calls. Unlike
 * contractLeafScope this does NOT union in the fee leg's USDC + transfer(): the agent
 * must never be able to call USDC.transfer just because the fee mechanism needs that
 * pair authorized on-chain. Tool/engine validation uses this; the on-chain leaf and
 * root caveats use the fee-safe scope so the appended fee leg still passes. */
export function declaredContractScope(terms: ContractTerms) {
  return { targets: terms.targets, selectors: terms.selectors };
}

// ---------------------------------------------------------------------------
// ERC-20 allowance calls (approve / increaseAllowance): decode + on-chain pins
// ---------------------------------------------------------------------------

const APPROVE_LIKE: Record<string, string> = Object.fromEntries(
  [APPROVE_SIG, INCREASE_ALLOWANCE_SIG].map((sig) => [toFunctionSelector(sig).toLowerCase(), sig]),
);

export type AllowanceCall = {
  /** the token contract (the execution target) */
  token: Address;
  /** who may pull the allowance */
  spender: Address;
  amountAtoms: bigint;
  /** the canonical signature that was called (approve or increaseAllowance) */
  sig: string;
};

/** Decode an execution as an ERC-20 allowance grant, or null if it's another method.
 * Calldata must be the exact canonical shape (selector + two 32-byte words): trailing
 * bytes would survive the byte-window pins AND the token's decoder, so refuse them. */
export function decodeAllowanceCall(e: { target: Address; data: Hex }): AllowanceCall | null {
  const data = (e.data ?? "0x").toLowerCase();
  const sig = APPROVE_LIKE[data.slice(0, 10)];
  if (!sig) return null;
  if (data.length !== 2 + 8 + 64 + 64) {
    throw new RefusalError("invalid_terms", "malformed allowance calldata (must be selector + spender + amount)");
  }
  const spenderWord = data.slice(10, 74);
  if (!/^0{24}/.test(spenderWord)) {
    throw new RefusalError("invalid_terms", "malformed allowance calldata (spender is not an address)");
  }
  return {
    token: e.target,
    spender: ("0x" + spenderWord.slice(24)) as Address,
    amountAtoms: BigInt("0x" + data.slice(74, 138)),
    sig,
  };
}

/** AllowedCalldata byte-window pins for ONE allowance execution: spender at offset 4,
 * amount at offset 36 (32-byte padded exact values). The pinned leaf must govern ONLY
 * the allowance execution — a caveat is evaluated against every execution in its
 * redemption item (Phase-B SEND #3 + probe-multiitem, live-verified Jun 10 2026). */
export function allowancePinCaveats(call: AllowanceCall, chainId: ChainId = CHAIN_ID): WireCaveat[] {
  return builder(chainId)
    .addCaveat("allowedCalldata", { startIndex: 4, value: pad(call.spender, { size: 32 }) })
    .addCaveat("allowedCalldata", { startIndex: 36, value: pad(toHex(call.amountAtoms), { size: 32 }) })
    .build() as WireCaveat[];
}

/** The leaf scope for a pinned allowance item: exactly [token] x [the called sig]. */
export function allowanceLeafScope(call: AllowanceCall) {
  return { type: ScopeType.FunctionCall, targets: [call.token], selectors: [call.sig] } as const;
}

/** Canonical function signature (uint -> uint256, whitespace stripped) so the
 * method-encode path, the raw-data 4-byte selector check, and the on-chain
 * allowedMethods enforcer all key off the same selector. Falls back to the input
 * when it can't be parsed (validateTerms already rejects non-signatures). */
export function canonicalSelector(sig: string): string {
  try {
    // parseAbiItem canonicalizes (uint -> uint256, whitespace stripped); the "function "
    // prefix guarantees an AbiFunction at runtime, so the union-narrowing cast is safe.
    return toFunctionSignature(parseAbiItem(`function ${sig}`) as never);
  } catch {
    return sig;
  }
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
        if (usdAtoms(out.pay.period.amount, "pay.period.amount") > usdcToAtoms(parent.pay.period.amount)) {
          exceeds("pay.period.amount", `child period cap exceeds parent's ${parent.pay.period.amount}`);
        }
      }
      if (out.pay.period && !parent.pay.period && parent.pay.lifetime) {
        if (usdAtoms(out.pay.period.amount, "pay.period.amount") > usdcToAtoms(parent.pay.lifetime.amount)) {
          exceeds("pay.period.amount", `child period cap exceeds parent's lifetime ${parent.pay.lifetime.amount}`);
        }
      }
      if (out.pay.lifetime && parent.pay.lifetime) {
        const cap = remaining.lifetimeRemainingAtoms ?? usdcToAtoms(parent.pay.lifetime.amount);
        if (usdAtoms(out.pay.lifetime.amount, "pay.lifetime.amount") > cap) {
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
    // Normalize FIRST (canonical selectors + tokens->targets/approve union) so the
    // subset checks below see the child's REAL surface: a child declaring only
    // `tokens` would otherwise grow targets/selectors after the checks passed.
    validateAndNormalizeContract(out.contract);
    const pTargets = new Set(parent.contract.targets.map((t) => t.toLowerCase()));
    const pSelectors = new Set(parent.contract.selectors.map(canonicalSelector));
    for (const t of out.contract.targets) {
      if (!pTargets.has(t.toLowerCase())) exceeds("contract.targets", `target ${t} not in parent scope`);
    }
    for (const s of out.contract.selectors) {
      if (!pSelectors.has(canonicalSelector(s))) exceeds("contract.selectors", `selector ${s} not in parent scope`);
    }
    // tokens: when the parent restricts allowance tokens, a child list must stay inside
    // it. NEVER inherited when silent: normalization unions tokens into targets +
    // approve into selectors, so inheriting would grant a silent child allowance
    // capability it didn't ask for. The ancestor chain-walk at spend time enforces the
    // parent's gate on the whole subtree regardless.
    if (parent.contract.tokens && out.contract.tokens) {
      const pt = new Set(parent.contract.tokens.map((t) => t.toLowerCase()));
      for (const t of out.contract.tokens) {
        if (!pt.has(t.toLowerCase())) exceeds("contract.tokens", `token ${t} not in parent token list`);
      }
    }
    // perTradeMax: tightest governs; inherit when silent, but only onto a child that
    // can actually grant allowances (approve in its normalized scope). A no-approve
    // child can never trigger the cap (nor can any of its descendants, since the
    // selector-subset rule stops them from re-adding approve), so inheriting would
    // just render a dead cap in the UI. The ancestor walk at spend time enforces the
    // parent's cap on the whole subtree regardless.
    if (parent.contract.perTradeMax !== undefined) {
      if (out.contract.perTradeMax === undefined) {
        if (out.contract.selectors.includes(APPROVE_SIG)) {
          out.contract.perTradeMax = parent.contract.perTradeMax;
        }
      } else if (usdcToAtoms(out.contract.perTradeMax) > usdcToAtoms(parent.contract.perTradeMax)) {
        exceeds("contract.perTradeMax", `child perTradeMax exceeds parent's ${parent.contract.perTradeMax}`);
      }
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
