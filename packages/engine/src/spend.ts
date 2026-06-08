// The spend pipeline: validate (typed refusals, mirror of on-chain enforcement)
// -> carve leaf -> estimate (fee rebuild loop) -> send -> getStatus poll -> receipt.
//
// Validation mirrors the chain EXACTLY (fee-inclusive sums, fixed windows, subtree-wide,
// every ancestor checked) so agents get a clean refusal instead of a revert. The chain
// remains the backstop: anything the server gets wrong still reverts on-chain.

import { toFunctionSelector, type Address, type Hex } from "viem";
import { CHAIN_ID, CHAINS, FEE_COLLECTOR, publicClient, type ChainId } from "./chains";
import { applyOrArgs, canonicalSelector, contractLeafScope, declaredContractScope, payLeafScope } from "./compiler";
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
  /** test seam: overrides the live account-nonce read (stale-7702-auth guard) */
  accountNonce?: (address: Address, chainId: ChainId) => Promise<number>;
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

/** Resolve the authorizationList for a not-yet-7702-coded delegator from the stored
 * auth, REFUSING if the account nonce has advanced past the signed nonce: a 7702
 * authorization is single-nonce, so a stale one is guaranteed to revert on-chain.
 * The user heals it by re-onboarding (the dashboard re-signs a fresh auth on login). */
export async function resolveStoredAuth(
  stage: string,
  user: { address: string; auth7702_json: string | null },
  chainId: ChainId,
  accountNonce?: (address: Address, chainId: ChainId) => Promise<number>,
): Promise<Wire7702Auth[]> {
  if (!user.auth7702_json) {
    throw new EngineError(stage, "user not 7702-coded and no stored authorization");
  }
  const auth = JSON.parse(user.auth7702_json) as Wire7702Auth;
  let live: number | null = null;
  try {
    live = await (accountNonce ??
      ((a: Address, cid: ChainId) => publicClient(cid).getTransactionCount({ address: a })))(
      user.address as Address,
      chainId,
    );
  } catch {
    // RPC blip: proceed with the stored auth — the relayer pre-simulates and the chain backstops
  }
  if (live !== null && BigInt(auth.nonce) !== BigInt(live)) {
    throw new RefusalError(
      "invalid_terms",
      "stored 7702 authorization is stale (the account nonce advanced past the signed nonce) — sign in on the dashboard to refresh it",
      { signed_nonce: BigInt(auth.nonce).toString(), account_nonce: live.toString() },
    );
  }
  return [auth];
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
      // Validate against the DECLARED scope, not the fee-safe one: a card scoped to
      // (say) Uniswap must NOT also permit USDC.transfer just because the fee leg unions
      // those in on-chain. Every ancestor's declared scope must allow every target AND
      // selector (engine-level gate, mirroring the MCP tool's encodeScopedCall check, so
      // any future non-MCP caller that hand-builds workExecutions can't bypass it).
      const declared = declaredContractScope(c.terms.contract);
      const allowedTargets = new Set(declared.targets.map((t) => t.toLowerCase()));
      const allowedSelectors = new Set(
        declared.selectors.flatMap((s) => {
          try {
            return [toFunctionSelector(canonicalSelector(s)).toLowerCase()];
          } catch {
            return []; // a malformed legacy/stored selector matches no real calldata; skip it
          }
        }),
      );
      for (const e of execs) {
        if (!allowedTargets.has(e.target.toLowerCase())) {
          throw new RefusalError("target_not_allowed", `target ${e.target} is outside the card's contract scope`, {
            card_id: c.id,
            target: e.target,
          });
        }
        const selector = (e.data ?? "0x").slice(0, 10).toLowerCase();
        if (!allowedSelectors.has(selector)) {
          throw new RefusalError("method_not_allowed", `selector ${selector} is outside the card's contract scope`, {
            card_id: c.id,
            selector,
          });
        }
        if (e.value && e.value !== "0") {
          throw new RefusalError("invalid_terms", "native value is not supported on contract cards");
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
      // A charge that FAILED before it was ever broadcast (request_id null) was never
      // sent on-chain — retrying the same key must re-attempt, not seal the failure.
      // A failure WITH a request_id might have landed on-chain, so it stays terminal.
      if (existing.status === "failed" && existing.request_id === null) {
        store.deleteCharge(existing.id); // clear the dead row so the unique idem index frees up
      } else {
        return receiptFromCharge(deps, cardId, existing.status, existing.tx_hash, existing.to_addr ?? req.to ?? FEE_COLLECTOR, existing.amount_atoms, existing.fee_atoms, now, existing.memo ?? undefined);
      }
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

  // authorizationList: only until A_user's 7702 code lands (stale-nonce-guarded)
  const codeCheck = deps.codeCheck ?? has7702Code;
  let authorizationList: Wire7702Auth[] | undefined;
  if (!(await codeCheck(user.address as Address, chainId))) {
    authorizationList = await resolveStoredAuth("spend", user, chainId, deps.accountNonce);
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

    // Budget re-validate + reservation insert as ONE synchronous pair (no await between):
    // the Stripe webhook's fiat leg writes into the SAME budget rows with its own
    // atomic-sync decide+insert and CANNOT take the spend mutex (its 2s reply window
    // can't queue behind a 90s crypto confirmation). A fiat charge that landed during
    // the estimate await gap is therefore always visible here, before we reserve+send.
    validateSpend(deps, chain, req, amountAtoms + feeAtoms, now);

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

    // TOCTOU guard: a freeze/revoke can land during the async estimate round-trips.
    // Re-read the chain's status from the store (no RPC) and bail BEFORE broadcasting
    // rather than emitting a spend we already had grounds to refuse. The chain remains
    // the ultimate backstop for anything that still slips through.
    try {
      assertChainSpendable(store.ancestorChain(cardId), now);
    } catch (e) {
      store.updateCharge(chargeId, { status: "failed" });
      throw e;
    }

    let requestId: string;
    try {
      requestId = await deps.relayer.send([{ permissionContext, executions }], est.context, authorizationList);
    } catch (e) {
      store.updateCharge(chargeId, { status: "failed" });
      throw e;
    }
    // record request_id + the broadcast block: reconcile scans the fee-leg log from
    // since_block (never head-lookback), so a landed log is found no matter how long
    // the sweep was down.
    store.updateCharge(chargeId, { request_id: requestId, since_block: sinceBlock });

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

export function statusToConfirmation(st: { status: number | null; txHash: Hex | null }): {
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
// Reconcile sweep: settle charges left "pending" (confirmRedemption timed out but
// the tx may have landed). A pending charge counts against budget forever until
// resolved, so this re-checks each broadcast-but-unconfirmed charge against chain
// logs and flips it to confirmed/failed. Safe to call periodically (idempotent).
// ---------------------------------------------------------------------------

export async function reconcilePending(
  deps: SpendDeps,
  opts: {
    olderThanSeconds?: number;
    lookbackBlocks?: bigint;
    /** test seam: fee-leg Transfer log scan (delegator -> feeCollector since fromBlock) */
    scanFeeLogs?: (delegator: Address, fromBlock: bigint) => Promise<Array<{ value: bigint; txHash: Hex }>>;
    /** test seam: chain head */
    blockNumber?: () => Promise<bigint>;
  } = {},
): Promise<{ reconciled: number; stillPending: number }> {
  const chainId = deps.chainId ?? CHAIN_ID;
  const now = deps.now ? deps.now() : Math.floor(Date.now() / 1000);
  // cutoff defaults to 10 min (>> confirmRedemption's 90s timeout): a tx unmined this
  // long on Base (2s blocks) is genuinely dropped, so failing it can't race a late mine.
  const cutoff = now - (opts.olderThanSeconds ?? 600);
  const stale = deps.store.pendingChargesOlderThan(cutoff);
  // x402 reservations that never reached a relayer broadcast (request_id null) leak
  // budget if the inline finalize was lost; free them after a generous TTL.
  const x402Cutoff = now - (opts.olderThanSeconds ?? 600) * 6; // ~1h default
  const x402Orphans = deps.store.pendingX402ChargesOlderThan(x402Cutoff);
  if (!stale.length && !x402Orphans.length) return { reconciled: 0, stillPending: 0 };

  let reconciled = 0;
  for (const orphan of x402Orphans) {
    deps.store.updateCharge(orphan.id, { status: "failed" });
    reconciled++;
  }
  if (!stale.length) return { reconciled, stillPending: 0 };

  const pub = publicClient(chainId);
  const usdc = CHAINS[chainId].usdc;
  const scan =
    opts.scanFeeLogs ??
    (async (delegator: Address, fromBlock: bigint) => {
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
        args: { from: delegator, to: FEE_COLLECTOR },
        fromBlock,
      });
      return logs.map((l) => ({ value: (l.args as { value?: bigint }).value ?? 0n, txHash: l.transactionHash }));
    });

  let head: bigint;
  try {
    head = await (opts.blockNumber ?? (() => pub.getBlockNumber()))();
  } catch {
    return { reconciled, stillPending: stale.length }; // RPC down: next sweep
  }
  const fallbackFrom = head > (opts.lookbackBlocks ?? 5000n) ? head - (opts.lookbackBlocks ?? 5000n) : 0n;

  // Group stale charges by ancestor user so we scan each user's fee-leg logs ONCE, from
  // the earliest broadcast block among that user's charges (every charge's fee-leg lives
  // in [its since_block, head]). A per-user consumed-txHash set stops two same-fee charges
  // (the 0..999 jitter only probabilistically unique) from both claiming one log.
  const byUser = new Map<string, { address: Address; charges: typeof stale; minFrom: bigint }>();
  let stillPending = 0;
  for (const charge of stale) {
    const user = deps.store.getUser(deps.store.ancestorChain(charge.card_id).at(-1)?.user_id ?? "");
    if (!user) {
      stillPending++; // orphaned row (card/user gone): can't resolve a delegator — surface it
      continue;
    }
    const from = charge.since_block ? BigInt(charge.since_block) : fallbackFrom;
    const g = byUser.get(user.id) ?? { address: user.address as Address, charges: [] as typeof stale, minFrom: from };
    g.charges.push(charge);
    if (from < g.minFrom) g.minFrom = from;
    byUser.set(user.id, g);
  }

  for (const { address, charges, minFrom } of byUser.values()) {
    let logs: Array<{ value: bigint; txHash: Hex }>;
    try {
      logs = await scan(address, minFrom);
    } catch {
      stillPending += charges.length; // RPC blip: leave them for the next sweep
      continue;
    }
    const consumed = new Set<Hex>();
    for (const charge of charges) {
      // the fee jitter makes (delegator, feeCollector, value) a per-spend fingerprint;
      // skip logs already claimed by an earlier charge this sweep
      const hit = logs.find((l) => l.value === charge.fee_atoms && !consumed.has(l.txHash));
      if (hit) {
        consumed.add(hit.txHash);
        deps.store.updateCharge(charge.id, { status: "confirmed", tx_hash: hit.txHash });
      } else {
        // no unclaimed fee-leg log since the broadcast block: the redemption never landed.
        deps.store.updateCharge(charge.id, { status: "failed" });
      }
      reconciled++;
    }
  }
  return { reconciled, stillPending };
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
