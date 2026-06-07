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
import { confirmRedemption, jitteredFee, resolveStoredAuth, statusToConfirmation } from "./spend";
import {
  erc20TransferExecution,
  has7702Code,
  signWithSmartAccount,
  userSmartAccount,
  verifyRootDelegationSignature,
  wireDelegation,
  type DelegationSigner,
} from "./delegations";
import { EngineError, RefusalError } from "./errors";
import { parseAtoms, usdcToAtoms } from "./money";
import { readRevocationNonce } from "./issuance";
import type { Relayer } from "./relayer";
import type { Store } from "./store";
import type { Wire7702Auth, WireDelegation, WireExecution } from "./types";

export type OpsDeps = {
  store: Store;
  relayer: Relayer;
  userSigner: DelegationSigner;
  chainId?: ChainId;
  feeJitter?: (baseAtoms: bigint) => bigint;
  /** test seam: skip the on-chain getCode check (mirrors SpendDeps.codeCheck) */
  codeCheck?: (address: Address, chainId: ChainId) => Promise<boolean>;
  /** test seam: overrides the live account-nonce read (stale-7702-auth guard) */
  accountNonce?: (address: Address, chainId: ChainId) => Promise<number>;
  /** confirm inclusion via chain logs (default true; tests with a fake relayer set false) */
  confirmViaChain?: boolean;
  /** test seam: skip the on-chain NonceEnforcer read after a nuke */
  revocationNonceOverride?: bigint;
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

/** Build the UNSIGNED admin leaf: straight to the relayer target; FunctionCall scope
 * admits ONLY the admin call + the mandatory fee transfer (probe10 rule: fee path must
 * pass scope). Shared by the server-signed lane (adminSend) and the client-signed lane
 * (prepareAdminOp). */
function buildAdminLeaf(userAddress: Address, adminTarget: Address, adminCalldata: Hex, chainId: ChainId) {
  const selector = adminCalldata.slice(0, 10) as Hex;
  const leaf = createDelegation({
    environment: getSmartAccountsEnvironment(chainId),
    from: userAddress,
    to: CHAINS[chainId].targetAddress,
    scope: {
      type: ScopeType.FunctionCall,
      targets: [adminTarget, CHAINS[chainId].usdc],
      selectors: [selector, "transfer(address,uint256)"],
    } as never,
  });
  return wireDelegation(leaf);
}

type AdminLoopDeps = Pick<OpsDeps, "store" | "relayer" | "feeJitter" | "codeCheck" | "accountNonce" | "confirmViaChain"> & {
  chainId?: ChainId;
};

/** The proven estimate/send/confirm loop, one copy for both signing lanes. The fee
 * lives in the EXECUTIONS (not the leaf caveats), so a fee rebuild between attempts
 * never invalidates the one signature on the leaf. */
async function runAdminLoop(
  deps: AdminLoopDeps,
  args: { signedLeaf: WireDelegation; adminTarget: Address; adminCalldata: Hex; userAddress: Address },
): Promise<AdminOpResult> {
  const chainId = deps.chainId ?? CHAIN_ID;
  const usdc = CHAINS[chainId].usdc;

  const jitter = deps.feeJitter ?? jitteredFee;
  const feeData = await deps.relayer.getFeeData(usdc);
  let feeAtoms = jitter(usdcToAtoms(feeData.minFee));

  const codeCheck = deps.codeCheck ?? has7702Code;
  let authorizationList: Wire7702Auth[] | undefined;
  if (!(await codeCheck(args.userAddress, chainId))) {
    const user = deps.store.getUserByAddress(args.userAddress);
    if (!user) throw new EngineError("ops", "user not 7702-coded and no stored authorization");
    authorizationList = await resolveStoredAuth("ops", user, chainId, deps.accountNonce);
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    const executions: WireExecution[] = [
      { target: args.adminTarget, value: "0", data: args.adminCalldata },
      erc20TransferExecution(usdc, FEE_COLLECTOR, feeAtoms),
    ];
    const est = await deps.relayer.estimate(
      [{ permissionContext: [args.signedLeaf], executions }],
      authorizationList,
    );
    if (!est.success) {
      throw new EngineError("ops", `admin estimate failed: ${est.error ?? "unknown"}`);
    }
    const required = est.requiredPaymentAmount ? parseAtoms(est.requiredPaymentAmount) : feeAtoms;
    if (required > feeAtoms) {
      feeAtoms = jitter(required);
      continue;
    }
    if (!est.context) throw new EngineError("ops", "admin estimate returned no context");
    const viaChain = deps.confirmViaChain ?? true;
    const sinceBlock = viaChain ? await publicClient(chainId).getBlockNumber() : 0n;
    const requestId = await deps.relayer.send(
      [{ permissionContext: [args.signedLeaf], executions }],
      est.context,
      authorizationList,
    );
    const confirmation = viaChain
      ? await confirmRedemption(deps.relayer, {
          requestId,
          delegator: args.userAddress,
          feeAtoms,
          sinceBlock,
          chainId,
        })
      : statusToConfirmation(await deps.relayer.waitForStatus(requestId));
    if (confirmation.status === "failed") throw new EngineError("ops", "admin transaction reverted on-chain");
    // A timed-out confirmation is NOT proof the disable/nonce-bump landed. Refuse rather
    // than let the caller mark the tree revoked/nuked in the DB while it's still live
    // on-chain (the over-permissive, security-wrong divergence). The tx may yet mine; a
    // re-revoke/re-nuke is idempotent, so the user simply retries.
    if (confirmation.status === "pending") throw new EngineError("ops", "admin transaction not confirmed in time");
    return { txHash: confirmation.txHash, requestId };
  }
  throw new EngineError("ops", "admin estimate loop exhausted");
}

async function adminSend(
  deps: OpsDeps,
  adminTarget: Address,
  adminCalldata: Hex,
): Promise<AdminOpResult> {
  const chainId = deps.chainId ?? CHAIN_ID;
  const leaf = buildAdminLeaf(deps.userSigner.address, adminTarget, adminCalldata, chainId);
  const smart = await userSmartAccount(deps.userSigner, chainId);
  const signed = await signWithSmartAccount(smart, leaf, chainId);
  return runAdminLoop({ ...deps, chainId }, {
    signedLeaf: signed,
    adminTarget,
    adminCalldata,
    userAddress: deps.userSigner.address,
  });
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

  // tx confirmed: mark the tree dead FIRST (an RPC blip on the nonce re-read must not
  // leave live-looking cards for a dead tree); fall back to stored+1 on a failed read.
  deps.store.setAllUserCardsStatus(userId, "nuked");
  let newNonce: bigint;
  if (deps.revocationNonceOverride !== undefined) {
    newNonce = deps.revocationNonceOverride;
  } else {
    try {
      newNonce = await readRevocationNonce(deps.userSigner.address, chainId);
    } catch {
      const user = deps.store.getUser(userId);
      newNonce = (user ? BigInt(user.revocation_nonce) : 0n) + 1n;
    }
  }
  deps.store.setRevocationNonce(userId, newNonce);
  return { ...result, newNonce };
}

// ---------------------------------------------------------------------------
// Client-signed admin ops (the Privy lane): the USER's embedded wallet signs the
// admin leaf in the BROWSER, mirroring issuance's prepare/finalize split.
//   prepare  — server builds the UNSIGNED admin leaf (delegator = A_user, delegate =
//              the relayer target, FunctionCall scope pinned to the admin selector +
//              the fee transfer). Sub-card revokes never reach here: their delegator
//              is the parent's bare-EOA K_agent, so the user's signature can't disable
//              them on-chain — they're killed server-side immediately.
//   finalize — server verifies the signature recovers to A_user, then runs the SAME
//              estimate/send/confirm loop as the server-signed lane and applies the
//              post-confirm bookkeeping (subtree status / nonce re-read).
// SECURITY: the signed leaf is live, selector-scoped spend authority (admin call +
// fee transfer) until redeemed. Holders of a PreparedAdminOp must keep it single-use
// and short-TTL'd; the route layer consumes it via onValidated the moment the
// signature verifies (before the relayer send — past that point it must never be
// re-finalizable).
// ---------------------------------------------------------------------------

export type PreparedAdminOp = {
  prepareId: string;
  kind: "revoke" | "nuke";
  userId: string;
  userAddress: Address;
  /** revoke target (null for nuke) */
  cardId: string | null;
  adminTarget: Address;
  adminCalldata: Hex;
  /** the UNSIGNED admin leaf the client must sign (signature: "0x") */
  delegation: WireDelegation;
  chainId: ChainId;
  createdAt: number;
};

export type PrepareOpsDeps = {
  store: Store;
  chainId?: ChainId;
  now?: () => number;
};

/** Prepare a client-signed HARD REVOKE of a top-level card. For a sub-card this
 * performs the server-side kill immediately and returns { done: true } — there is
 * nothing for the user to sign (see REVOKE semantics at the top of this file). */
export function prepareRevoke(
  deps: PrepareOpsDeps,
  cardId: string,
): PreparedAdminOp | { done: true; cardId: string } {
  const chainId = deps.chainId ?? CHAIN_ID;
  const now = deps.now ? deps.now() : Math.floor(Date.now() / 1000);
  const card = deps.store.getCard(cardId);
  if (!card) throw new RefusalError("card_not_found", "no such card");
  if (card.status === "revoked" || card.status === "nuked") {
    throw new RefusalError("card_revoked", `card is already ${card.status}`);
  }
  if (card.parent_card_id !== null) {
    // delegator of a sub-card delegation is the parent's bare-EOA K_agent; only the
    // DELEGATOR can disable on-chain. Server-side kill + honest layering.
    deps.store.setSubtreeStatus(cardId, "revoked");
    return { done: true, cardId };
  }
  const user = deps.store.getUser(card.user_id);
  if (!user) throw new EngineError("ops", "card has no user row");
  const adminCalldata = DelegationManager.encode.disableDelegation({ delegation: card.delegation as never }) as Hex;
  return {
    prepareId: crypto.randomUUID(),
    kind: "revoke",
    userId: card.user_id,
    userAddress: user.address as Address,
    cardId,
    adminTarget: DELEGATION_MANAGER,
    adminCalldata,
    delegation: buildAdminLeaf(user.address as Address, DELEGATION_MANAGER, adminCalldata, chainId),
    chainId,
    createdAt: now,
  };
}

/** Prepare a client-signed NUKE (NonceEnforcer bump): one tx, the user's whole tree dies. */
export function prepareNuke(deps: PrepareOpsDeps, userId: string): PreparedAdminOp {
  const chainId = deps.chainId ?? CHAIN_ID;
  const now = deps.now ? deps.now() : Math.floor(Date.now() / 1000);
  const user = deps.store.getUser(userId);
  if (!user) throw new RefusalError("card_not_found", "no such user");
  const env = getSmartAccountsEnvironment(chainId);
  const nonceEnforcer = env.caveatEnforcers.NonceEnforcer as Address;
  const adminCalldata = NonceEnforcer.encode.incrementNonce(DELEGATION_MANAGER) as Hex;
  return {
    prepareId: crypto.randomUUID(),
    kind: "nuke",
    userId,
    userAddress: user.address as Address,
    cardId: null,
    adminTarget: nonceEnforcer,
    adminCalldata,
    delegation: buildAdminLeaf(user.address as Address, nonceEnforcer, adminCalldata, chainId),
    chainId,
    createdAt: now,
  };
}

export type FinalizeOpsDeps = {
  store: Store;
  relayer: Relayer;
  feeJitter?: (baseAtoms: bigint) => bigint;
  codeCheck?: (address: Address, chainId: ChainId) => Promise<boolean>;
  accountNonce?: (address: Address, chainId: ChainId) => Promise<number>;
  confirmViaChain?: boolean;
  /** test seam: skip the on-chain NonceEnforcer read after a nuke */
  revocationNonceOverride?: bigint;
};

/** Attach the browser's signature to a prepared admin op and execute it. */
export async function finalizeAdminOp(
  deps: FinalizeOpsDeps,
  prepared: PreparedAdminOp,
  signature: Hex,
  opts: {
    /** called the moment the signature verifies — the holder of the prepared entry
     * must consume it here (single-use: past this point it may reach the relayer) */
    onValidated?: () => void;
  } = {},
): Promise<AdminOpResult & { newNonce?: bigint }> {
  if (!signature || signature === "0x") {
    throw new RefusalError("invalid_terms", "missing admin leaf signature");
  }
  const signedLeaf: WireDelegation = { ...prepared.delegation, signature };
  // The admin leaf is a ROOT-authority delegation from A_user, same EIP-712 domain as
  // a root card — the issuance-lane recovery check applies unchanged.
  const recovers = await verifyRootDelegationSignature(signedLeaf, prepared.userAddress, prepared.chainId);
  if (!recovers) {
    throw new RefusalError("invalid_terms", "admin leaf signature does not recover to the account owner");
  }
  opts.onValidated?.();

  // Status re-check (prepare->finalize gap, e.g. a concurrent tab nuked first): redeeming
  // the admin leaf again would burn A_user's fee on an already-disabled delegation /
  // already-bumped nonce for no on-chain effect. Short-circuit to the terminal state.
  if (prepared.kind === "revoke") {
    const card = deps.store.getCard(prepared.cardId!);
    if (!card || card.status === "revoked" || card.status === "nuked") {
      return { txHash: null, requestId: "" }; // already terminal; don't rewrite the status
    }
  } else {
    const live = deps.store.listCards(prepared.userId).some((c) => c.status === "active" || c.status === "frozen");
    if (!live) {
      const user = deps.store.getUser(prepared.userId);
      return { txHash: null, requestId: "", newNonce: user ? BigInt(user.revocation_nonce) : 0n };
    }
  }

  const result = await runAdminLoop(
    { ...deps, chainId: prepared.chainId },
    {
      signedLeaf,
      adminTarget: prepared.adminTarget,
      adminCalldata: prepared.adminCalldata,
      userAddress: prepared.userAddress,
    },
  );

  if (prepared.kind === "revoke") {
    deps.store.setSubtreeStatus(prepared.cardId!, "revoked");
    return result;
  }
  // nuke bookkeeping: the tx CONFIRMED (runAdminLoop throws otherwise), so the tree is
  // dead on-chain — mark it dead FIRST, then re-read the bumped nonce. An RPC blip on
  // the read must not leave the store claiming live cards for a dead tree; fall back to
  // stored+1 (our confirmed bump incremented exactly once).
  deps.store.setAllUserCardsStatus(prepared.userId, "nuked");
  let newNonce: bigint;
  if (deps.revocationNonceOverride !== undefined) {
    newNonce = deps.revocationNonceOverride;
  } else {
    try {
      newNonce = await readRevocationNonce(prepared.userAddress, prepared.chainId);
    } catch {
      const user = deps.store.getUser(prepared.userId);
      newNonce = (user ? BigInt(user.revocation_nonce) : 0n) + 1n;
    }
  }
  deps.store.setRevocationNonce(prepared.userId, newNonce);
  return { ...result, newNonce };
}
