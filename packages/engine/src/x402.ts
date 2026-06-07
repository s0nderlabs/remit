// x402 erc7710: the bridge between a remit card and the x402 payment handshake.
// Spec: x402 PR #732 (merged 2026-03-13) defines assetTransferMethod "erc7710" inside
// exact_evm with payload {delegationManager, permissionContext: bytes, delegator}
// — byte-identical to SAK's experimental x402DelegationProviderPaymentPayload.
// NO shipped facilitator settles it (verified Jun 6: 1Shot's own /supported = {"kinds":[]});
// remit's facilitator (P3) is the first. Settlement rail = the 1Shot relayer.
//
// PAYER side (paid_fetch / pay({x402})): carve a leaf redeemable by the 1Shot target,
// encode [leaf, ...chain] -> payload. A pending charge RESERVES budget at carve time
// (amount + fee headroom) so concurrent spends can't overdraw between carve and settle.
// FACILITATOR side: decode, verify (relayer estimate = the simulation), settle
// (estimate -> send -> chain-log confirmation), report the actual fee in extensions.

import type { Address, Hex } from "viem";
import { encodeDelegations, decodeDelegations } from "@metamask/smart-accounts-kit/utils";
import { CHAIN_ID, CHAINS, DELEGATION_MANAGER, FEE_COLLECTOR, type ChainId } from "./chains";
import { payLeafScope } from "./compiler";
import { withAgentAccount } from "./custody";
import { carveLeafDelegation, erc20TransferExecution, signWithPrivateKey, wireDelegation } from "./delegations";
import { EngineError, RefusalError } from "./errors";
import { atomsToUsdc, parseAtoms, usdcToAtoms } from "./money";
import type { Relayer } from "./relayer";
import type { Store } from "./store";
import { assertChainSpendable, confirmRedemption, delegationForMode, jitteredFee, validateSpend, type SpendDeps } from "./spend";
import { publicClient } from "./chains";
import type { WireDelegation } from "./types";

export type X402Requirement = {
  scheme: string;
  network: string;
  amount: string; // atomic units string
  asset: string;
  payTo: string;
  maxTimeoutSeconds?: number;
  extra?: Record<string, unknown> | null;
};

export type X402PayloadBody = {
  delegationManager: Address;
  permissionContext: Hex;
  delegator: Address;
};

/** Reserved fee headroom while a payload is in flight (actual fee replaces it at settle). */
export const X402_FEE_HEADROOM_ATOMS = 30_000n; // 0.03 USDC

export function caip2For(chainId: ChainId): string {
  return `eip155:${chainId}`;
}

export function requirementMatchesRail(req: X402Requirement, chainId: ChainId = CHAIN_ID): string | null {
  if (req.scheme !== "exact") return `unsupported scheme ${req.scheme}`;
  if (req.network !== caip2For(chainId)) return `unsupported network ${req.network}`;
  if (req.asset.toLowerCase() !== CHAINS[chainId].usdc.toLowerCase()) return `unsupported asset ${req.asset}`;
  const method = (req.extra as { assetTransferMethod?: string } | null | undefined)?.assetTransferMethod;
  if (method !== undefined && method !== "erc7710") return `unsupported assetTransferMethod ${method}`;
  return null;
}

// ---------------------------------------------------------------------------
// PAYER side
// ---------------------------------------------------------------------------

export async function buildX402Payload(
  deps: SpendDeps,
  cardId: string,
  req: X402Requirement,
): Promise<{ body: X402PayloadBody; chargeId: string; amountAtoms: bigint }> {
  const chainId = deps.chainId ?? CHAIN_ID;
  const now = deps.now ? deps.now() : Math.floor(Date.now() / 1000);
  const railProblem = requirementMatchesRail(req, chainId);
  if (railProblem) throw new RefusalError("invalid_terms", `cannot pay this challenge: ${railProblem}`);

  const amountAtoms = parseAtoms(req.amount);
  const chain = deps.store.ancestorChain(cardId);
  if (!chain.length) throw new RefusalError("card_not_found", "no such card");
  const card = chain[0]!;

  // card-status gate (frozen / revoked / nuked / expired) — same backstop spend() applies.
  // Without this a frozen card can still pay via paid_fetch / x402 (freeze is a server flag).
  assertChainSpendable(chain, now);

  validateSpend(
    deps,
    chain,
    { kind: "x402", mode: "pay", to: req.payTo as Address, amountAtoms },
    amountAtoms + X402_FEE_HEADROOM_ATOMS,
    now,
  );

  const chainDelegations = chain.map((c) => delegationForMode(c, "pay"));
  const leaf = await withAgentAccount(card.k_agent_enc, async (_a, pk) =>
    signWithPrivateKey(
      pk,
      carveLeafDelegation({
        parent: chainDelegations[0]!,
        from: card.k_agent_address,
        scope: payLeafScope(amountAtoms + X402_FEE_HEADROOM_ATOMS, chainId) as never,
        chainId,
      }),
      chainId,
    ),
  );

  const permissionContext = encodeDelegations([leaf, ...chainDelegations] as never) as Hex;

  const chargeId = crypto.randomUUID();
  deps.store.insertCharge({
    id: chargeId,
    card_id: cardId,
    idempotency_key: null,
    kind: "x402",
    to_addr: req.payTo as Address,
    amount_atoms: amountAtoms,
    fee_atoms: X402_FEE_HEADROOM_ATOMS, // provisional reservation; finalize replaces it
    request_id: null,
    tx_hash: null,
    status: "pending",
    memo: `x402 ${req.payTo}`,
    created_at: now,
  });

  const user = deps.store.getUser(chain[chain.length - 1]!.user_id);
  return {
    body: {
      delegationManager: DELEGATION_MANAGER,
      permissionContext,
      delegator: user!.address as Address,
    },
    chargeId,
    amountAtoms,
  };
}

export function finalizeX402Charge(
  store: Store,
  chargeId: string,
  result: { txHash: Hex | null; feeAtoms: bigint } | "failed",
): void {
  if (result === "failed") {
    store.updateCharge(chargeId, { status: "failed" });
    return;
  }
  // Honesty: a settlement is "confirmed" only with an on-chain tx. A bare 200 with no
  // PAYMENT-RESPONSE receipt is recorded "settlement_unconfirmed" so the ledger matches
  // the receipt the caller gets (the budget reservation is preserved either way).
  store.updateCharge(chargeId, {
    status: result.txHash ? "confirmed" : "settlement_unconfirmed",
    tx_hash: result.txHash ?? undefined,
    fee_atoms: result.feeAtoms,
  });
}

// ---------------------------------------------------------------------------
// FACILITATOR side
// ---------------------------------------------------------------------------

export function decodeX402Delegations(permissionContext: Hex): WireDelegation[] {
  let decoded: unknown[];
  try {
    decoded = decodeDelegations(permissionContext as never) as unknown[];
  } catch (e) {
    throw new EngineError("x402", `permissionContext does not decode as delegations`, e);
  }
  return decoded.map((d) => wireDelegation(d as never));
}

export type X402SettleDeps = {
  relayer: Relayer;
  chainId?: ChainId;
  feeJitter?: (baseAtoms: bigint) => bigint;
  confirmViaChain?: boolean;
  /** test seam: overrides the delegator 7702-code check */
  codeCheck?: (address: Address, chainId: ChainId) => Promise<boolean>;
};

function buildExecutions(req: X402Requirement, feeAtoms: bigint, chainId: ChainId) {
  return [
    erc20TransferExecution(CHAINS[chainId].usdc, req.payTo as Address, parseAtoms(req.amount)),
    erc20TransferExecution(CHAINS[chainId].usdc, FEE_COLLECTOR, feeAtoms),
  ];
}

/** Structural + simulated verification. The relayer estimate IS the simulation
 * (validates every signature + every caveat in the chain against the real chain state). */
export async function verifyX402(
  deps: X402SettleDeps,
  body: X402PayloadBody,
  req: X402Requirement,
): Promise<{ isValid: boolean; invalidReason?: string; payer?: string }> {
  const chainId = deps.chainId ?? CHAIN_ID;
  const railProblem = requirementMatchesRail(req, chainId);
  if (railProblem) return { isValid: false, invalidReason: railProblem };
  if (body.delegationManager.toLowerCase() !== DELEGATION_MANAGER.toLowerCase()) {
    return { isValid: false, invalidReason: `unsupported delegationManager ${body.delegationManager}` };
  }
  let delegations: WireDelegation[];
  try {
    delegations = decodeX402Delegations(body.permissionContext);
  } catch {
    return { isValid: false, invalidReason: "permission_context_undecodable" };
  }
  if (!delegations.length) return { isValid: false, invalidReason: "empty_permission_context" };
  const leaf = delegations[0]!;
  if (leaf.delegate.toLowerCase() !== CHAINS[chainId].targetAddress.toLowerCase()) {
    return {
      isValid: false,
      invalidReason: `leaf_not_redeemable: this facilitator settles via the 1Shot relayer; the leaf delegation's delegate must be ${CHAINS[chainId].targetAddress}`,
    };
  }
  const root = delegations[delegations.length - 1]!;
  if (root.delegator.toLowerCase() !== body.delegator.toLowerCase()) {
    return { isValid: false, invalidReason: "delegator_mismatch" };
  }
  const hasCode = deps.codeCheck
    ? await deps.codeCheck(body.delegator, chainId)
    : await publicClient(chainId)
        .getCode({ address: body.delegator })
        .then((code) => !!code && code !== "0x")
        .catch(() => false);
  if (!hasCode) {
    return { isValid: false, invalidReason: "delegator_not_upgraded: payer account has no 7702 code" };
  }
  const minFee = usdcToAtoms("0.01");
  const est = await deps.relayer.estimate([
    { permissionContext: delegations, executions: buildExecutions(req, minFee, chainId) },
  ]);
  if (!est.success) {
    return { isValid: false, invalidReason: `simulation_failed: ${est.error ?? "unknown"}` };
  }
  return { isValid: true, payer: body.delegator };
}

export async function settleX402(
  deps: X402SettleDeps,
  body: X402PayloadBody,
  req: X402Requirement,
): Promise<{ txHash: Hex | null; feeAtoms: bigint; payer: Address }> {
  const chainId = deps.chainId ?? CHAIN_ID;
  const verification = await verifyX402(deps, body, req);
  if (!verification.isValid) throw new EngineError("x402", `verify failed: ${verification.invalidReason}`);

  const delegations = decodeX402Delegations(body.permissionContext);
  const jitter = deps.feeJitter ?? jitteredFee;
  const feeData = await deps.relayer.getFeeData(CHAINS[chainId].usdc);
  let feeAtoms = jitter(usdcToAtoms(feeData.minFee));

  for (let attempt = 0; attempt < 3; attempt++) {
    const executions = buildExecutions(req, feeAtoms, chainId);
    const est = await deps.relayer.estimate([{ permissionContext: delegations, executions }]);
    if (!est.success) throw new EngineError("x402", `settle estimate failed: ${est.error ?? "unknown"}`);
    const required = est.requiredPaymentAmount ? parseAtoms(est.requiredPaymentAmount) : feeAtoms;
    if (required > feeAtoms) {
      feeAtoms = jitter(required);
      continue;
    }
    if (!est.context) throw new EngineError("x402", "settle estimate returned no context");

    const viaChain = deps.confirmViaChain ?? true;
    const sinceBlock = viaChain ? await publicClient(chainId).getBlockNumber() : 0n;
    const requestId = await deps.relayer.send([{ permissionContext: delegations, executions }], est.context);
    const confirmation = viaChain
      ? await confirmRedemption(deps.relayer, { requestId, delegator: body.delegator, feeAtoms, sinceBlock, chainId })
      : await deps.relayer.waitForStatus(requestId).then((s) => ({
          status: s.status === 200 ? ("confirmed" as const) : s.status === 500 ? ("failed" as const) : ("pending" as const),
          txHash: s.txHash,
        }));
    if (confirmation.status === "failed") throw new EngineError("x402", "settlement reverted on-chain");
    if (confirmation.status === "pending") throw new EngineError("x402", "settlement not confirmed in time");
    return { txHash: confirmation.txHash, feeAtoms, payer: body.delegator };
  }
  throw new EngineError("x402", "settle fee loop exhausted");
}

export function feeAtomsToUsdc(feeAtoms: bigint): string {
  return atomsToUsdc(feeAtoms);
}
