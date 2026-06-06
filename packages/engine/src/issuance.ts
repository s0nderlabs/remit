// Card issuance: compile -> mint K_agent -> build + sign delegation -> store row -> URL.
// Root cards: the USER signs (Stateless7702 smart account; local key in P1-P3, Privy in P4).
// Sub-cards: the PARENT's K_agent signs (offchain, free, instant; no user involvement —
// attenuation IS the permission).

import type { Address, Hex } from "viem";
import { CHAIN_ID, DELEGATION_MANAGER, publicClient, type ChainId } from "./chains";
import { NonceEnforcer } from "@metamask/smart-accounts-kit/contracts";
import { getSmartAccountsEnvironment } from "@metamask/smart-accounts-kit";
import { attenuate, compileCard } from "./compiler";
import {
  decryptSecret,
  encryptSecret,
  generateAgentKey,
  generateCardSecret,
  hashCardSecret,
  withAgentAccount,
} from "./custody";
import {
  buildChildDelegation,
  buildRootDelegation,
  signWithPrivateKey,
  signWithSmartAccount,
  userSmartAccount,
  verifyRootDelegationSignature,
  type DelegationSigner,
} from "./delegations";
import { EngineError, RefusalError } from "./errors";
import { usdcToAtoms } from "./money";
import { periodWindow, type CardRow, type Store } from "./store";
import type { CardTerms, CompiledCard, WireDelegation } from "./types";

export type IssuedCard = {
  cardId: string;
  /** The bearer credential. Shown to the caller ONCE here; only its hash is stored. */
  secret: string;
  kAgentAddress: Address;
  terms: CardTerms;
};

/** Read the user's CURRENT revocation nonce from the NonceEnforcer contract. */
export async function readRevocationNonce(delegator: Address, chainId: ChainId = CHAIN_ID): Promise<bigint> {
  const env = getSmartAccountsEnvironment(chainId);
  const nonce = await NonceEnforcer.read.currentNonce({
    client: publicClient(chainId) as never,
    contractAddress: env.caveatEnforcers.NonceEnforcer as Address,
    delegationManager: DELEGATION_MANAGER,
    delegator,
  });
  return nonce as bigint;
}

export async function issueRootCard(
  deps: {
    store: Store;
    userSigner: DelegationSigner;
    chainId?: ChainId;
    now?: () => number;
    /** test seam: skip the on-chain NonceEnforcer read */
    revocationNonceOverride?: bigint;
  },
  args: { userId: string; name: string; terms: CardTerms },
): Promise<IssuedCard> {
  const chainId = deps.chainId ?? CHAIN_ID;
  const now = deps.now ? deps.now() : Math.floor(Date.now() / 1000);

  const revocationNonce =
    deps.revocationNonceOverride ?? (await readRevocationNonce(deps.userSigner.address, chainId));
  const compiled = compileCard(args.terms, { chainId, revocationNonce, now });

  const { address: kAgentAddress, encryptedPk } = await generateAgentKey();
  const smart = await userSmartAccount(deps.userSigner, chainId);
  const delegation = await signWithSmartAccount(
    smart,
    buildRootDelegation({ delegator: deps.userSigner.address, delegate: kAgentAddress, caveats: compiled.rootCaveats }),
    chainId,
  );
  // Same guarantee as the client-signed lane: never persist a root whose signature
  // doesn't recover to the delegator (catches SDK/domain drift at issuance, not at
  // the first spend after the card URL is already in an agent's hands).
  if (!(await verifyRootDelegationSignature(delegation, deps.userSigner.address, chainId))) {
    throw new EngineError("issuance", "signed root delegation does not recover to the user");
  }

  const secret = generateCardSecret();
  const cardId = crypto.randomUUID();
  deps.store.createCard({
    id: cardId,
    user_id: args.userId,
    parent_card_id: null,
    name: args.name,
    secret_hash: hashCardSecret(secret),
    secret_enc: await encryptSecret(secret),
    terms: compiled.terms,
    kind: compiled.kind,
    compiled,
    delegation,
    k_agent_enc: encryptedPk,
    k_agent_address: kAgentAddress,
    status: "active",
    created_at: now,
  });

  return { cardId, secret, kAgentAddress, terms: compiled.terms };
}

// ---------------------------------------------------------------------------
// Client-signed issuance (the Privy lane): the user's embedded wallet signs the
// root delegation in the BROWSER, not on the server. Split in two:
//   prepare  — server compiles caveats, mints K_agent, builds the UNSIGNED root
//              delegation (delegator = the user's embedded address) and hands it
//              back. NOTHING is stored yet.
//   finalize — server takes the client's EIP-712 signature, attaches it, and
//              persists the card row (identical shape to issueRootCard).
// The server holds the PreparedRootCard between the two calls (in-memory, TTL'd).
// The compiler stays authoritative server-side; only the signature crosses to
// the client. K_agent never leaves the server.
// ---------------------------------------------------------------------------

export type PreparedRootCard = {
  prepareId: string;
  userId: string;
  cardId: string;
  name: string;
  /** bearer secret, generated at prepare; hashed + encrypted at finalize */
  secret: string;
  kAgentAddress: Address;
  encryptedPk: Uint8Array;
  compiled: CompiledCard;
  /** the UNSIGNED root delegation the client must sign (signature: "0x") */
  delegation: WireDelegation;
  chainId: ChainId;
  createdAt: number;
};

export async function prepareRootCard(
  deps: {
    store: Store;
    /** the user's embedded (Privy) A_user address = the delegator */
    userAddress: Address;
    chainId?: ChainId;
    now?: () => number;
    /** test seam: skip the on-chain NonceEnforcer read */
    revocationNonceOverride?: bigint;
  },
  args: { userId: string; name: string; terms: CardTerms },
): Promise<PreparedRootCard> {
  const chainId = deps.chainId ?? CHAIN_ID;
  const now = deps.now ? deps.now() : Math.floor(Date.now() / 1000);

  // Prefer the nonce stored at onboarding; fall back to a live read. The compiled
  // NonceEnforcer caveat MUST match A_user's current on-chain revocation nonce.
  const user = deps.store.getUser(args.userId);
  const revocationNonce =
    deps.revocationNonceOverride ??
    (user ? BigInt(user.revocation_nonce) : await readRevocationNonce(deps.userAddress, chainId));

  const compiled = compileCard(args.terms, { chainId, revocationNonce, now });
  const { address: kAgentAddress, encryptedPk } = await generateAgentKey();
  const delegation = buildRootDelegation({
    delegator: deps.userAddress,
    delegate: kAgentAddress,
    caveats: compiled.rootCaveats,
  });

  return {
    prepareId: crypto.randomUUID(),
    userId: args.userId,
    cardId: crypto.randomUUID(),
    name: args.name,
    secret: generateCardSecret(),
    kAgentAddress,
    encryptedPk,
    compiled,
    delegation,
    chainId,
    createdAt: now,
  };
}

export async function finalizeRootCard(
  deps: { store: Store },
  prepared: PreparedRootCard,
  signature: Hex,
): Promise<IssuedCard> {
  if (!signature || signature === "0x") {
    throw new RefusalError("invalid_terms", "missing delegation signature");
  }
  const signedDelegation: WireDelegation = { ...prepared.delegation, signature };
  // The signature must actually authorize THIS delegation: recover it and assert it
  // is the delegator (A_user). Without this a caller could persist a card bound to a
  // signature that never redeems (or that signs a different delegation).
  const recovers = await verifyRootDelegationSignature(
    signedDelegation,
    prepared.delegation.delegator,
    prepared.chainId,
  );
  if (!recovers) {
    throw new RefusalError("invalid_terms", "delegation signature does not recover to the card owner");
  }
  deps.store.createCard({
    id: prepared.cardId,
    user_id: prepared.userId,
    parent_card_id: null,
    name: prepared.name,
    secret_hash: hashCardSecret(prepared.secret),
    secret_enc: await encryptSecret(prepared.secret),
    terms: prepared.compiled.terms,
    kind: prepared.compiled.kind,
    compiled: prepared.compiled,
    delegation: signedDelegation,
    k_agent_enc: prepared.encryptedPk,
    k_agent_address: prepared.kAgentAddress,
    status: "active",
    created_at: prepared.createdAt,
  });
  return {
    cardId: prepared.cardId,
    secret: prepared.secret,
    kAgentAddress: prepared.kAgentAddress,
    terms: prepared.compiled.terms,
  };
}

export async function issueSubCard(
  deps: { store: Store; chainId?: ChainId; now?: () => number },
  args: { parentCardId: string; name: string; terms: CardTerms },
): Promise<IssuedCard> {
  const chainId = deps.chainId ?? CHAIN_ID;
  const now = deps.now ? deps.now() : Math.floor(Date.now() / 1000);
  const store = deps.store;

  const parent = store.getCard(args.parentCardId);
  if (!parent) throw new RefusalError("card_not_found", "parent card not found");
  if (parent.status !== "active") {
    throw new RefusalError(parent.status === "frozen" ? "card_frozen" : "card_revoked", `parent card is ${parent.status}`);
  }
  if (parent.terms.subcards === false) {
    throw new RefusalError("subcards_disabled", "this card may not mint sub-cards");
  }

  // attenuation: child <= parent, omitted money terms inherit capped to remaining
  const remaining = parentRemaining(store, parent, now);
  const childTerms = attenuate(parent.terms, remaining, args.terms, now);

  const user = store.getUser(parent.user_id);
  if (!user) throw new RefusalError("card_not_found", "parent card has no user");
  const compiled = compileCard(childTerms, { chainId, revocationNonce: BigInt(user.revocation_nonce), now });

  const { address: kSubAddress, encryptedPk } = await generateAgentKey();
  const child = buildChildDelegation({
    parent: parent.delegation,
    delegator: parent.k_agent_address,
    delegate: kSubAddress,
    caveats: compiled.rootCaveats,
  });
  const signed = await withAgentAccount(parent.k_agent_enc, async (_a, pk) => signWithPrivateKey(pk, child, chainId));

  const secret = generateCardSecret();
  const cardId = crypto.randomUUID();
  store.createCard({
    id: cardId,
    user_id: parent.user_id,
    parent_card_id: parent.id,
    name: args.name,
    secret_hash: hashCardSecret(secret),
    secret_enc: await encryptSecret(secret),
    terms: childTerms,
    kind: compiled.kind,
    compiled,
    delegation: signed,
    k_agent_enc: encryptedPk,
    k_agent_address: kSubAddress,
    status: "active",
    created_at: now,
  });

  return { cardId, secret, kAgentAddress: kSubAddress, terms: childTerms };
}

function parentRemaining(store: Store, parent: CardRow, now: number) {
  let periodRemainingAtoms: bigint | null = null;
  if (parent.terms.pay?.period && parent.compiled.periodStartDate !== null) {
    const w = periodWindow(parent.compiled.periodStartDate, parent.terms.pay.period.seconds, now);
    const spent = store.subtreeSpentSince(parent.id, w.start);
    const cap = usdcToAtoms(parent.terms.pay.period.amount);
    periodRemainingAtoms = cap > spent ? cap - spent : 0n;
  }
  let lifetimeRemainingAtoms: bigint | null = null;
  if (parent.terms.pay?.lifetime) {
    const spent = store.subtreeSpentLifetime(parent.id);
    const cap = usdcToAtoms(parent.terms.pay.lifetime.amount);
    lifetimeRemainingAtoms = cap > spent ? cap - spent : 0n;
  }
  return { periodRemainingAtoms, lifetimeRemainingAtoms };
}

/** Rotate the bearer URL: new secret, same card / delegation / K_agent. */
export async function rotateCardSecret(store: Store, cardId: string): Promise<string> {
  const card = store.getCard(cardId);
  if (!card) throw new RefusalError("card_not_found", "no such card");
  const secret = generateCardSecret();
  store.rotateSecret(cardId, hashCardSecret(secret), await encryptSecret(secret));
  return secret;
}

/** Re-view the bearer secret (locked feature: the URL is re-viewable, not show-once). */
export async function viewCardSecret(store: Store, cardId: string): Promise<string | null> {
  const card = store.getCard(cardId);
  if (!card?.secret_enc) return null;
  return decryptSecret(card.secret_enc);
}
