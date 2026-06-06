// Freeze / revoke / nuke / rotate: the four control layers (locked semantics).
//
//   FREEZE      server flag, instant, free, reversible. Works because every spend needs
//               a fresh K_agent-signed leaf and K_agent is custodied. Spend validation
//               checks the WHOLE ancestor chain, so freezing a card blocks its subtree.
//   REVOKE      on-chain DelegationManager.disableDelegation, executed FROM A_user,
//               riding 1Shot via a user-signed admin leaf (fee ~cents, no ETH).
//               v1 HONESTY: only delegations whose delegator IS A_user (top-level cards)
//               can be hard-revoked this way; disableDelegation is delegator-only. A
//               sub-card's delegator is the parent's bare-EOA K_agent (gasless by design),
//               so surgical sub-card kills are freeze-grade server-side; the on-chain
//               answer for a sub-card is revoking its top-level ancestor, or the nuke.
//   NUKE        NonceEnforcer.incrementNonce FROM A_user: ONE tx, every delegation bound
//               to the old nonce dies (the always-on nonce caveat), tree-wide, on-chain.
//   ROTATE      new bearer secret, same card/delegation/K_agent (leak response).

import type { Address, Hex } from "viem";
import { getSmartAccountsEnvironment, createDelegation, ScopeType } from "@metamask/smart-accounts-kit";
import { DelegationManager, NonceEnforcer } from "@metamask/smart-accounts-kit/contracts";
import { CHAIN_ID, CHAINS, DELEGATION_MANAGER, FEE_COLLECTOR, publicClient, type ChainId } from "./chains";
import { confirmRedemption, jitteredFee } from "./spend";
import {
  erc20TransferExecution,
  has7702Code,
  signWithSmartAccount,
  userSmartAccount,
  wireDelegation,
  type DelegationSigner,
} from "./delegations";
import { EngineError, RefusalError } from "./errors";
import { parseAtoms, usdcToAtoms } from "./money";
import { readRevocationNonce } from "./issuance";
import type { Relayer } from "./relayer";
import type { Store } from "./store";
import type { Wire7702Auth, WireExecution } from "./types";

export type OpsDeps = {
  store: Store;
  relayer: Relayer;
  userSigner: DelegationSigner;
  chainId?: ChainId;
  feeJitter?: (baseAtoms: bigint) => bigint;
};

export type AdminOpResult = { txHash: Hex | null; requestId: string };

// ---------------------------------------------------------------------------
// Server-side controls (free, instant)
// ---------------------------------------------------------------------------

export function freezeCard(store: Store, cardId: string): void {
  const card = store.getCard(cardId);
  if (!card) throw new RefusalError("card_not_found", "no such card");
  if (card.status !== "active") throw new RefusalError("card_revoked", `card is ${card.status}, cannot freeze`);
  store.setCardStatus(cardId, "frozen");
}

export function unfreezeCard(store: Store, cardId: string): void {
  const card = store.getCard(cardId);
  if (!card) throw new RefusalError("card_not_found", "no such card");
  if (card.status !== "frozen") throw new RefusalError("invalid_terms", `card is ${card.status}, not frozen`);
  store.setCardStatus(cardId, "active");
}

/** Agent-side sub-card revoke: FREEZE-GRADE kill (server stops carving, URL dies).
 * Descendants only: a card may never touch its siblings/ancestors. */
export function agentRevokeSubcard(store: Store, requesterCardId: string, targetCardId: string): void {
  if (requesterCardId === targetCardId) {
    throw new RefusalError("not_your_subcard", "a card cannot revoke itself through this tool");
  }
  const descendants = store.subtreeIds(requesterCardId);
  if (!descendants.includes(targetCardId)) {
    throw new RefusalError("not_your_subcard", "target card is not a descendant of this card");
  }
  store.setSubtreeStatus(targetCardId, "revoked");
}

// ---------------------------------------------------------------------------
// The admin-leaf pipeline (user-signed, single-delegation chain, rides 1Shot)
// ---------------------------------------------------------------------------

async function adminSend(
  deps: OpsDeps,
  adminTarget: Address,
  adminCalldata: Hex,
): Promise<AdminOpResult> {
  const chainId = deps.chainId ?? CHAIN_ID;
  const usdc = CHAINS[chainId].usdc;
  const env = getSmartAccountsEnvironment(chainId);
  const selector = adminCalldata.slice(0, 10) as Hex;

  // user-signed leaf straight to the relayer target; FunctionCall scope admits ONLY
  // the admin call + the mandatory fee transfer (probe10 rule: fee path must pass scope)
  const leaf = createDelegation({
    environment: env,
    from: deps.userSigner.address,
    to: CHAINS[chainId].targetAddress,
    scope: {
      type: ScopeType.FunctionCall,
      targets: [adminTarget, usdc],
      selectors: [selector, "transfer(address,uint256)"],
    } as never,
  });
  const smart = await userSmartAccount(deps.userSigner, chainId);
  const signed = await signWithSmartAccount(smart, wireDelegation(leaf), chainId);

  const jitter = deps.feeJitter ?? jitteredFee;
  const feeData = await deps.relayer.getFeeData(usdc);
  let feeAtoms = jitter(usdcToAtoms(feeData.minFee));

  let authorizationList: Wire7702Auth[] | undefined;
  if (!(await has7702Code(deps.userSigner.address, chainId))) {
    const user = deps.store.getUserByAddress(deps.userSigner.address);
    if (!user?.auth7702_json) throw new EngineError("ops", "user not 7702-coded and no stored authorization");
    authorizationList = [JSON.parse(user.auth7702_json) as Wire7702Auth];
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    const executions: WireExecution[] = [
      { target: adminTarget, value: "0", data: adminCalldata },
      erc20TransferExecution(usdc, FEE_COLLECTOR, feeAtoms),
    ];
    const est = await deps.relayer.estimate([{ permissionContext: [signed], executions }], authorizationList);
    if (!est.success) {
      throw new EngineError("ops", `admin estimate failed: ${est.error ?? "unknown"}`);
    }
    const required = est.requiredPaymentAmount ? parseAtoms(est.requiredPaymentAmount) : feeAtoms;
    if (required > feeAtoms) {
      feeAtoms = jitter(required);
      continue;
    }
    if (!est.context) throw new EngineError("ops", "admin estimate returned no context");
    const sinceBlock = await publicClient(chainId).getBlockNumber();
    const requestId = await deps.relayer.send([{ permissionContext: [signed], executions }], est.context, authorizationList);
    const confirmation = await confirmRedemption(deps.relayer, {
      requestId,
      delegator: deps.userSigner.address,
      feeAtoms,
      sinceBlock,
      chainId,
    });
    if (confirmation.status === "failed") throw new EngineError("ops", "admin transaction reverted on-chain");
    return { txHash: confirmation.txHash, requestId };
  }
  throw new EngineError("ops", "admin estimate loop exhausted");
}

// ---------------------------------------------------------------------------
// REVOKE (hard, on-chain, top-level cards)
// ---------------------------------------------------------------------------

export async function revokeCard(deps: OpsDeps, cardId: string): Promise<AdminOpResult> {
  const store = deps.store;
  const card = store.getCard(cardId);
  if (!card) throw new RefusalError("card_not_found", "no such card");
  if (card.parent_card_id !== null) {
    // delegator of a sub-card delegation is the parent's bare-EOA K_agent; the chain
    // only lets the DELEGATOR disable. Server-side kill + honest layering.
    store.setSubtreeStatus(cardId, "revoked");
    throw new RefusalError(
      "invalid_terms",
      "sub-cards revoke server-side (done); for an on-chain kill revoke the top-level card or nuke",
      { card_id: cardId },
    );
  }
  const calldata = DelegationManager.encode.disableDelegation({ delegation: card.delegation as never }) as Hex;
  const result = await adminSend(deps, DELEGATION_MANAGER, calldata);
  store.setSubtreeStatus(cardId, "revoked");
  return result;
}

// ---------------------------------------------------------------------------
// NUKE (cascade: every card bound to the old nonce dies in ONE tx)
// ---------------------------------------------------------------------------

export async function nukeAll(deps: OpsDeps, userId: string): Promise<AdminOpResult & { newNonce: bigint }> {
  const chainId = deps.chainId ?? CHAIN_ID;
  const env = getSmartAccountsEnvironment(chainId);
  const nonceEnforcer = env.caveatEnforcers.NonceEnforcer as Address;
  const calldata = NonceEnforcer.encode.incrementNonce(DELEGATION_MANAGER) as Hex;

  const result = await adminSend(deps, nonceEnforcer, calldata);

  const newNonce = await readRevocationNonce(deps.userSigner.address, chainId);
  deps.store.setRevocationNonce(userId, newNonce);
  deps.store.setAllUserCardsStatus(userId, "nuked");
  return { ...result, newNonce };
}
