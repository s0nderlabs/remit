// The spend pipeline: validate (typed refusals, mirror of on-chain enforcement)
// -> carve leaf -> estimate (fee rebuild loop) -> send -> getStatus poll -> receipt.
//
// Validation mirrors the chain EXACTLY (fee-inclusive sums, fixed windows, subtree-wide,
// every ancestor checked) so agents get a clean refusal instead of a revert. The chain
// remains the backstop: anything the server gets wrong still reverts on-chain.

import type { Address, Hex } from "viem";
import { CHAIN_ID, CHAINS, FEE_COLLECTOR, publicClient, type ChainId } from "./chains";
import { applyOrArgs, contractLeafScope, payLeafScope } from "./compiler";
import { withAgentAccount } from "./custody";
import {
  carveLeafDelegation,
  erc20TransferExecution,
  has7702Code,
  signWithPrivateKey,
} from "./delegations";
import { EngineError, RefusalError } from "./errors";
import { atomsToUsdc, parseAtoms, usdcToAtoms } from "./money";
import { Relayer } from "./relayer";
import { periodWindow, type CardRow, type ChargeKind, type Store } from "./store";
import type { CardState, Receipt, Wire7702Auth, WireDelegation, WireExecution } from "./types";

export type SpendMode = "pay" | "contract";

export type SpendRequest = {
  kind: ChargeKind;
  mode: SpendMode;
  /** pay mode */
  to?: Address;
  amountAtoms?: bigint;
  /** contract mode: pre-built work executions (server ABI-encodes upstream) */
  workExecutions?: WireExecution[];
  memo?: string;
  idempotencyKey?: string;
};

export type SpendDeps = {
  store: Store;
  relayer: Relayer;
  chainId?: ChainId;
  now?: () => number;
  /** test seam: overrides the on-chain getCode check */
  codeCheck?: (address: Address, chainId: ChainId) => Promise<boolean>;
  /** confirm inclusion via chain logs (default true; tests with a fake relayer set false) */
  confirmViaChain?: boolean;
  /** fee-uniqueness jitter source (default random 0-999 atoms; tests pin it) */
  feeJitter?: (baseAtoms: bigint) => bigint;
};

const ESTIMATE_RETRIES = 3;

/** Fee uniqueness jitter: every redemption pays minFee + [0..999] atoms (max 0.000999
 * USDC) so the fee-leg Transfer log (from, to=feeCollector, value) is a per-spend
 * fingerprint. confirmRedemption matches on it; without this, two same-fee spends in
 * overlapping block windows are indistinguishable (live M2 finding). */
export function jitteredFee(baseAtoms: bigint): bigint {
  return baseAtoms + BigInt(crypto.getRandomValues(new Uint32Array(1))[0]! % 1000);
}

// ---------------------------------------------------------------------------
// Status / chain helpers
// ---------------------------------------------------------------------------

export function assertChainSpendable(chain: CardRow[], now: number): void {
  for (const card of chain) {
    if (card.status === "frozen") {
      throw new RefusalError("card_frozen", `card ${card.id === chain[0]!.id ? "" : "(ancestor) "}is frozen`, { card_id: card.id });
    }
    if (card.status === "revoked" || card.status === "nuked") {
      throw new RefusalError("card_revoked", "card has been revoked", { card_id: card.id });
    }
    if (card.terms.expiry !== undefined && now >= card.terms.expiry) {
      throw new RefusalError("card_expired", "card has expired", { card_id: card.id, expired_at: card.terms.expiry });
    }
  }
}

/** A card's wire delegation with composite OR-args applied for this redemption's mode. */
export function delegationForMode(card: CardRow, mode: SpendMode): WireDelegation {
  if (!card.compiled.orGroups) return card.delegation;
  return { ...card.delegation, caveats: applyOrArgs(card.compiled, mode) };
}

// ---------------------------------------------------------------------------
// Validation (the refusal engine)
// ---------------------------------------------------------------------------

export function validateSpend(
  deps: SpendDeps,
  chain: CardRow[],
  req: SpendRequest,
  totalAtoms: bigint, // amount + fee (what the enforcers will actually count)
  now: number,
): void {
  const card = chain[0]!;

  if (req.mode === "pay") {
    if (!req.to || req.amountAtoms === undefined) {
      throw new RefusalError("invalid_terms", "pay requires to + amount");
    }
    if (req.amountAtoms <= 0n) throw new RefusalError("invalid_terms", "amount must be > 0");
    // merchant whitelist: every card in the chain that carries one must allow `to`
    for (const c of chain) {
      const merchants = c.compiled.carvePolicy.merchants;
      if (merchants && !merchants.some((m) => m.toLowerCase() === req.to!.toLowerCase())) {
        throw new RefusalError("merchant_not_allowed", `recipient ${req.to} is not on the card's merchant list`, {
          card_id: c.id,
        });
      }
    }
    // per-tx max: tightest in the chain governs (work amount, not fee)
    for (const c of chain) {
      const cap = c.compiled.carvePolicy.perTxMaxAtoms;
      if (cap !== null && req.amountAtoms > cap) {
        throw new RefusalError("per_tx_exceeded", `amount exceeds the per-charge max of ${atomsToUsdc(cap)} USDC`, {
          card_id: c.id,
          per_tx_max: atomsToUsdc(cap),
        });
      }
    }
  } else {
    // contract mode: this card must carry contract scope; targets/methods subset check
    if (!card.terms.contract) {
      throw new RefusalError("target_not_allowed", "this card has no contract capability");
    }
    const execs = req.workExecutions ?? [];
    if (!execs.length) throw new RefusalError("invalid_terms", "execute requires at least one call");
    for (const c of chain) {
      if (!c.terms.contract) continue; // pay-only ancestors govern via OR groups / caps on-chain
      const scope = contractLeafScope(c.terms.contract, deps.chainId ?? CHAIN_ID);
      const allowedTargets = new Set(scope.targets.map((t) => t.toLowerCase()));
      for (const e of execs) {
        if (!allowedTargets.has(e.target.toLowerCase())) {
          throw new RefusalError("target_not_allowed", `target ${e.target} is outside the card's contract scope`, {
            card_id: c.id,
            target: e.target,
          });
        }
      }
    }
  }

  // uses (limitedCalls mirror): subtree-wide per ancestor
  for (const c of chain) {
    if (c.terms.maxUses !== undefined) {
      const used = deps.store.subtreeUsesCount(c.id);
      if (used >= c.terms.maxUses) {
        throw new RefusalError("uses_exhausted", `card has used all ${c.terms.maxUses} redemptions`, { card_id: c.id });
      }
    }
  }

  // money caps: fee-inclusive, fixed windows, subtree-wide, every ancestor
  for (const c of chain) {
    const pay = c.terms.pay;
    if (!pay) continue;
    if (pay.period && c.compiled.periodStartDate !== null) {
      const w = periodWindow(c.compiled.periodStartDate, pay.period.seconds, now);
      const spent = deps.store.subtreeSpentSince(c.id, w.start);
      const cap = usdcToAtoms(pay.period.amount);
      if (spent + totalAtoms > cap) {
        throw new RefusalError(
          "over_period_limit",
          `this charge (incl. ${atomsToUsdc(totalAtoms - (req.amountAtoms ?? 0n))} fee) exceeds the period budget`,
          {
            card_id: c.id,
            remaining_this_period: atomsToUsdc(cap > spent ? cap - spent : 0n),
            period_resets_at: w.resetsAt,
          },
        );
      }
    }
    if (pay.lifetime) {
      const spent = deps.store.subtreeSpentLifetime(c.id);
      const cap = usdcToAtoms(pay.lifetime.amount);
      if (spent + totalAtoms > cap) {
        throw new RefusalError("over_lifetime_limit", "this charge exceeds the card's lifetime budget", {
          card_id: c.id,
          remaining_lifetime: atomsToUsdc(cap > spent ? cap - spent : 0n),
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Estimate-error -> refusal mapping (chain said no; translate when we can)
// ---------------------------------------------------------------------------

function refusalFromEstimateError(err: string): RefusalError | null {
  if (/PeriodTransferEnforcer/i.test(err)) return new RefusalError("over_period_limit", `chain refused: ${err}`);
  if (/TransferAmountEnforcer/i.test(err)) return new RefusalError("over_lifetime_limit", `chain refused: ${err}`);
  if (/TimestampEnforcer/i.test(err)) return new RefusalError("card_expired", `chain refused: ${err}`);
  if (/LimitedCallsEnforcer/i.test(err)) return new RefusalError("uses_exhausted", `chain refused: ${err}`);
  if (/AllowedTargetsEnforcer/i.test(err)) return new RefusalError("target_not_allowed", `chain refused: ${err}`);
  if (/AllowedMethodsEnforcer/i.test(err)) return new RefusalError("method_not_allowed", `chain refused: ${err}`);
  if (/AllowedCalldataEnforcer/i.test(err)) return new RefusalError("merchant_not_allowed", `chain refused: ${err}`);
  return null;
}

// ---------------------------------------------------------------------------
// Confirmation: chain logs are the TRUTH; relayer getStatus is a hint.
// Every redemption carries the mandatory fee transfer (delegator -> feeCollector),
// so a USDC Transfer log matching (from, to=feeCollector, value=fee) since the
// send block IS the inclusion proof, redemption-shape-independent.
// ---------------------------------------------------------------------------

export async function confirmRedemption(
  relayer: Relayer,
  args: { requestId: string; delegator: Address; feeAtoms: bigint; sinceBlock: bigint; chainId?: ChainId },
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<{ status: "confirmed" | "failed" | "pending"; txHash: Hex | null }> {
  const chainId = args.chainId ?? CHAIN_ID;
  const pub = publicClient(chainId);
  const usdc = CHAINS[chainId].usdc;
  const deadline = Date.now() + (opts.timeoutMs ?? 90_000);
  const interval = opts.intervalMs ?? 2_000;

  while (Date.now() < deadline) {
    // 1) relayer hint (fast-path on a clean success)
    const st = await relayer.getStatus(args.requestId);
    if (st.status === 200) return { status: "confirmed", txHash: st.txHash };
    // 2) chain truth: the fee-leg Transfer event is the inclusion proof, independent of
    // the relayer status. Check it BEFORE trusting a 500 — a relayer-side error (or a lag)
    // must not flip an already-included redemption to "failed".
    try {
      const logs = await pub.getLogs({
        address: usdc,
        event: {
          type: "event",
          name: "Transfer",
          inputs: [
            { name: "from", type: "address", indexed: true },
            { name: "to", type: "address", indexed: true },
            { name: "value", type: "uint256", indexed: false },
          ],
        },
        args: { from: args.delegator, to: FEE_COLLECTOR },
        fromBlock: args.sinceBlock,
      });
      const hit = logs.find((l) => (l.args as { value?: bigint }).value === args.feeAtoms);
      if (hit) return { status: "confirmed", txHash: hit.transactionHash };
    } catch {
      // RPC blip: keep polling
    }
    // relayer says failed AND no on-chain fee-leg exists -> a genuine revert
    if (st.status === 500) return { status: "failed", txHash: st.txHash };
    await new Promise((r) => setTimeout(r, interval));
  }
  return { status: "pending", txHash: null };
}

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

export async function spend(deps: SpendDeps, cardId: string, req: SpendRequest): Promise<Receipt> {
  const chainId = deps.chainId ?? CHAIN_ID;
  const now = deps.now ? deps.now() : Math.floor(Date.now() / 1000);
  const store = deps.store;

  // idempotency replay
  if (req.idempotencyKey) {
    const existing = store.chargeByIdempotency(cardId, req.idempotencyKey);
    if (existing) {
      return receiptFromCharge(deps, cardId, existing.status, existing.tx_hash, existing.to_addr ?? req.to ?? FEE_COLLECTOR, existing.amount_atoms, existing.fee_atoms, now, existing.memo ?? undefined);
    }
  }

  const chain = store.ancestorChain(cardId);
  if (!chain.length) throw new RefusalError("card_not_found", "no such card");
  const card = chain[0]!;
  assertChainSpendable(chain, now);

  const user = store.getUser(chain[chain.length - 1]!.user_id);
  if (!user) throw new EngineError("spend", "card has no user row");

  // fee planning: start at minFee (+uniqueness jitter), rebuild if the relayer asks for more
  const jitter = deps.feeJitter ?? jitteredFee;
  const feeData = await deps.relayer.getFeeData(CHAINS[chainId].usdc);
  let feeAtoms = jitter(usdcToAtoms(feeData.minFee));

  const amountAtoms = req.amountAtoms ?? 0n;
  const workExecutions: WireExecution[] =
    req.mode === "pay"
      ? [erc20TransferExecution(CHAINS[chainId].usdc, req.to!, amountAtoms)]
      : (req.workExecutions ?? []);

  // contract-mode work execution VALUE total counts nothing in USDC terms; the on-chain
  // budget for contract cards is the scope itself. Pay caps still count amount+fee.
  validateSpend(deps, chain, req, amountAtoms + feeAtoms, now);

  // authorizationList: only until A_user's 7702 code lands
  const codeCheck = deps.codeCheck ?? has7702Code;
  let authorizationList: Wire7702Auth[] | undefined;
  if (!(await codeCheck(user.address as Address, chainId))) {
    if (!user.auth7702_json) {
      throw new EngineError("spend", "user has no 7702 code and no stored authorization");
    }
    authorizationList = [JSON.parse(user.auth7702_json) as Wire7702Auth];
  }

  const chainDelegations = chain.map((c) => delegationForMode(c, req.mode));

  // estimate loop: carve -> estimate -> (fee mismatch? rebuild) -> send
  let lastError: string | null = null;
  for (let attempt = 0; attempt < ESTIMATE_RETRIES; attempt++) {
    const executions = [...workExecutions, erc20TransferExecution(CHAINS[chainId].usdc, FEE_COLLECTOR, feeAtoms)];

    const scope =
      req.mode === "pay"
        ? payLeafScope(amountAtoms + feeAtoms, chainId)
        : contractLeafScope(card.terms.contract!, chainId);

    const leaf = await withAgentAccount(card.k_agent_enc, async (_account, pk) =>
      signWithPrivateKey(
        pk,
        carveLeafDelegation({ parent: chainDelegations[0]!, from: card.k_agent_address, scope: scope as never, chainId }),
        chainId,
      ),
    );

    const permissionContext = [leaf, ...chainDelegations];
    const est = await deps.relayer.estimate([{ permissionContext, executions }], authorizationList);

    if (!est.success) {
      lastError = est.error;
      const refusal = est.error ? refusalFromEstimateError(est.error) : null;
      if (refusal) throw refusal;
      throw new EngineError("estimate", `relayer estimate failed: ${est.error ?? "unknown"}`);
    }

    const required = est.requiredPaymentAmount ? parseAtoms(est.requiredPaymentAmount) : feeAtoms;
    if (required > feeAtoms) {
      feeAtoms = jitter(required);
      // re-check budgets with the real fee before retrying
      validateSpend(deps, chain, req, amountAtoms + feeAtoms, now);
      continue;
    }

    if (!est.context) throw new EngineError("estimate", "estimate succeeded but returned no context");

    // record BEFORE send so a crash can't double-spend on retry
    const chargeId = crypto.randomUUID();
    store.insertCharge({
      id: chargeId,
      card_id: cardId,
      idempotency_key: req.idempotencyKey ?? null,
      kind: req.kind,
      to_addr: req.to ?? null,
      amount_atoms: amountAtoms,
      fee_atoms: feeAtoms,
      request_id: null,
      tx_hash: null,
      status: "pending",
      memo: req.memo ?? null,
      created_at: now,
    });

    const viaChain = deps.confirmViaChain ?? true;
    // block height BEFORE send: the log-scan window for chain-side confirmation
    const sinceBlock = viaChain ? await publicClient(chainId).getBlockNumber() : 0n;

    let requestId: string;
    try {
      requestId = await deps.relayer.send([{ permissionContext, executions }], est.context, authorizationList);
    } catch (e) {
      store.updateCharge(chargeId, { status: "failed" });
      throw e;
    }
    store.updateCharge(chargeId, { request_id: requestId });

    const confirmation = viaChain
      ? await confirmRedemption(deps.relayer, {
          requestId,
          delegator: user.address as Address,
          feeAtoms,
          sinceBlock,
          chainId,
        })
      : statusToConfirmation(await deps.relayer.waitForStatus(requestId));

    if (confirmation.status === "confirmed") {
      store.updateCharge(chargeId, { status: "confirmed", tx_hash: confirmation.txHash ?? undefined });
      return receiptFromCharge(deps, cardId, "confirmed", confirmation.txHash, req.to ?? FEE_COLLECTOR, amountAtoms, feeAtoms, now, req.memo);
    }
    if (confirmation.status === "failed") {
      store.updateCharge(chargeId, { status: "failed", tx_hash: confirmation.txHash ?? undefined });
      throw new EngineError("send", "transaction reverted on-chain");
    }
    // genuinely still pending: leave the row; reconciliation can settle it later
    return receiptFromCharge(deps, cardId, "pending", confirmation.txHash, req.to ?? FEE_COLLECTOR, amountAtoms, feeAtoms, now, req.memo);
  }

  throw new EngineError("estimate", `estimate loop exhausted: ${lastError ?? "fee kept increasing"}`);
}

function statusToConfirmation(st: { status: number | null; txHash: Hex | null }): {
  status: "confirmed" | "failed" | "pending";
  txHash: Hex | null;
} {
  if (st.status === 200) return { status: "confirmed", txHash: st.txHash };
  if (st.status === 500) return { status: "failed", txHash: st.txHash };
  return { status: "pending", txHash: st.txHash };
}

function receiptFromCharge(
  deps: SpendDeps,
  cardId: string,
  status: Receipt["status"] | "failed",
  tx: Hex | null,
  to: Address,
  amountAtoms: bigint,
  feeAtoms: bigint,
  now: number,
  memo?: string,
): Receipt {
  const state = cardState(deps.store, cardId, now);
  return {
    status: status as Receipt["status"],
    tx,
    to,
    amount: atomsToUsdc(amountAtoms),
    fee: atomsToUsdc(feeAtoms),
    remaining_this_period: state?.remaining_this_period ?? null,
    ...(memo ? { memo } : {}),
  };
}

// ---------------------------------------------------------------------------
// Live card state (the `card` tool / dashboard meters)
// ---------------------------------------------------------------------------

export function cardState(store: Store, cardId: string, now: number): CardState | null {
  const card = store.getCard(cardId);
  if (!card) return null;
  const pay = card.terms.pay;

  let remainingPeriod: string | null = null;
  let resetsAt: number | null = null;
  if (pay?.period && card.compiled.periodStartDate !== null) {
    const w = periodWindow(card.compiled.periodStartDate, pay.period.seconds, now);
    const spent = store.subtreeSpentSince(cardId, w.start);
    const cap = usdcToAtoms(pay.period.amount);
    remainingPeriod = atomsToUsdc(cap > spent ? cap - spent : 0n);
    resetsAt = w.resetsAt;
  }

  let remainingLifetime: string | null = null;
  if (pay?.lifetime) {
    const spent = store.subtreeSpentLifetime(cardId);
    const cap = usdcToAtoms(pay.lifetime.amount);
    remainingLifetime = atomsToUsdc(cap > spent ? cap - spent : 0n);
  }

  const expired = card.terms.expiry !== undefined && now >= card.terms.expiry;

  return {
    card_id: card.id,
    name: card.name,
    status: card.status === "active" && expired ? "expired" : (card.status as CardState["status"]),
    terms: card.terms,
    remaining_this_period: remainingPeriod,
    remaining_lifetime: remainingLifetime,
    period_resets_at: resetsAt,
    expires_at: card.terms.expiry ?? null,
    uses_remaining: card.terms.maxUses !== undefined ? Math.max(0, card.terms.maxUses - store.subtreeUsesCount(cardId)) : null,
    subcards: store.listChildren(cardId).map((c) => c.id),
  };
}
