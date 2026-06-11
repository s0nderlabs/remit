// Delegation builders + signing. Ports the proven probe mechanics:
//   - ROOT delegations are constructed DIRECTLY (createDelegation refuses a bare
//     custom caveat set; it demands scope/parent), authority = ROOT_AUTHORITY.
//   - CHILD (sub-card) delegations: authority = hashDelegation(parent). Caveat args
//     are EXCLUDED from the hash (proven; see delegations.test.ts) so per-redemption
//     OR-args never invalidate signatures.
//   - LEAF carving uses createDelegation({parentDelegation, scope}) (probe-proven).
//   - Stateless7702 signs via smartAccount.signDelegation; bare-EOA keys via the
//     top-level signDelegation({privateKey, ...}).
//   - 7702 auths sign with the LIVE account nonce; wire shape: exactly the relayer's.

import { encodeFunctionData, isAddressEqual, parseAbi, recoverTypedDataAddress, type Address, type Hex } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import {
  toMetaMaskSmartAccount,
  Implementation,
  createDelegation,
  signDelegation,
  getSmartAccountsEnvironment,
  ROOT_AUTHORITY,
  type Delegation,
} from "@metamask/smart-accounts-kit";
import {
  hashDelegation,
  toDelegationStruct,
  SIGNABLE_DELEGATION_TYPED_DATA,
} from "@metamask/smart-accounts-kit/utils";
import { CHAINS, CHAIN_ID, DELEGATION_MANAGER, publicClient, type ChainId } from "./chains";
import { EngineError } from "./errors";
import type { Wire7702Auth, WireCaveat, WireDelegation, WireExecution } from "./types";

const ERC20_ABI = parseAbi([
  "function transfer(address to, uint256 amount) returns (bool)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

// ---------------------------------------------------------------------------
// Salts + wire normalization
// ---------------------------------------------------------------------------

export function freshSalt(): Hex {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return ("0x" + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")) as Hex;
}

function bigintToHex(v: bigint): Hex {
  return ("0x" + v.toString(16)) as Hex;
}

/** Normalize any SDK Delegation into the relayer wire shape (all hex, no bigints). */
export function wireDelegation(d: Delegation | WireDelegation): WireDelegation {
  const salt = typeof d.salt === "bigint" ? bigintToHex(d.salt) : (d.salt as Hex);
  return {
    delegate: d.delegate as Address,
    delegator: d.delegator as Address,
    authority: d.authority as Hex,
    caveats: d.caveats.map((c) => ({
      enforcer: c.enforcer as Address,
      terms: c.terms as Hex,
      args: c.args as Hex,
    })),
    salt,
    signature: (d.signature ?? "0x") as Hex,
  };
}

// ---------------------------------------------------------------------------
// Smart account (Stateless7702, the user's A_user)
// ---------------------------------------------------------------------------

export type DelegationSigner = {
  address: Address;
  signMessage: PrivateKeyAccount["signMessage"];
  signTypedData: PrivateKeyAccount["signTypedData"];
};

/** Build the user's Stateless7702 smart-account view. signer:{account} is the proven shape. */
export async function userSmartAccount(account: DelegationSigner, chainId: ChainId = CHAIN_ID) {
  // `client` cast: SAK 1.6.0 bundles d.ts against an older viem; structural PublicClient
  // identity drifts (TS2719). Runtime unaffected (one physical viem copy).
  return toMetaMaskSmartAccount({
    client: publicClient(chainId) as never,
    implementation: Implementation.Stateless7702,
    address: account.address,
    signer: { account: account as never },
  });
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

export function buildRootDelegation(args: {
  delegator: Address;
  delegate: Address;
  caveats: WireCaveat[];
  salt?: Hex;
}): WireDelegation {
  return {
    delegate: args.delegate,
    delegator: args.delegator,
    authority: ROOT_AUTHORITY as Hex,
    caveats: args.caveats,
    salt: args.salt ?? freshSalt(),
    signature: "0x",
  };
}

/** Sub-card child delegation: authority binds to the SIGNED parent's hash. */
export function buildChildDelegation(args: {
  parent: WireDelegation;
  delegator: Address; // the parent card's K_agent address
  delegate: Address; // the child card's K_sub address
  caveats: WireCaveat[];
  salt?: Hex;
}): WireDelegation {
  return {
    delegate: args.delegate,
    delegator: args.delegator,
    authority: hashDelegation(args.parent as never) as Hex,
    caveats: args.caveats,
    salt: args.salt ?? freshSalt(),
    signature: "0x",
  };
}

/** Leaf carve for a spend: delegate MUST be the relayer targetAddress. Scope from
 * compiler.payLeafScope / contractLeafScope. extraCaveats append to the scope's set
 * (e.g. AllowedCalldata approve pins); the SDK merges both into the signed caveat array. */
export function carveLeafDelegation(args: {
  parent: WireDelegation;
  from: Address; // the card's K_agent address
  scope: Parameters<typeof createDelegation>[0]["scope"];
  extraCaveats?: WireCaveat[];
  salt?: Hex;
  chainId?: ChainId;
}): WireDelegation {
  const chainId = args.chainId ?? CHAIN_ID;
  const leaf = createDelegation({
    environment: getSmartAccountsEnvironment(chainId),
    from: args.from,
    to: CHAINS[chainId].targetAddress,
    parentDelegation: args.parent as never,
    scope: args.scope,
    ...(args.extraCaveats?.length ? { caveats: args.extraCaveats as never } : {}),
    salt: args.salt ?? freshSalt(),
  });
  return wireDelegation(leaf);
}

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

/** Sign with the user's Stateless7702 smart account (A_user). */
export async function signWithSmartAccount(
  smart: Awaited<ReturnType<typeof userSmartAccount>>,
  delegation: WireDelegation,
  chainId: ChainId = CHAIN_ID,
): Promise<WireDelegation> {
  const signature = await smart.signDelegation({ delegation: delegation as never, chainId });
  return { ...delegation, signature };
}

/** Sign with a bare-EOA private key (K_agent / K_sub). Offchain, free. */
export async function signWithPrivateKey(
  privateKey: Hex,
  delegation: WireDelegation,
  chainId: ChainId = CHAIN_ID,
): Promise<WireDelegation> {
  const signature = await signDelegation({
    privateKey,
    delegation: delegation as never,
    delegationManager: DELEGATION_MANAGER,
    chainId,
  });
  return { ...delegation, signature };
}

// Stateless7702 signDelegation emits a plain EIP-712 ECDSA signature over the kit's
// SIGNABLE_DELEGATION_TYPED_DATA under the DelegationManager domain. Proven recovery
// shape (harness-privy step 3 / issuance.test.ts): domain {DelegationManager, "1",
// chainId, DELEGATION_MANAGER}, message = toDelegationStruct (salt -> uint256).
const DELEGATION_DOMAIN_NAME = "DelegationManager";
const DELEGATION_DOMAIN_VERSION = "1";

/** Recover a signed root delegation's signer and assert it equals `expectedSigner`.
 * Used at finalize so a client-signed card can't be stored with a signature that
 * doesn't actually authorize the delegation (the chain would reject it at redemption,
 * but we refuse it up front). Returns false on any malformed/unrecoverable input. */
export async function verifyRootDelegationSignature(
  delegation: WireDelegation,
  expectedSigner: Address,
  chainId: ChainId = CHAIN_ID,
): Promise<boolean> {
  if (!delegation.signature || delegation.signature === "0x") return false;
  try {
    const message = toDelegationStruct({ ...delegation, signature: "0x" } as never);
    // The kit's readonly TypedData arrays don't structurally line up with viem's
    // mutable generic, so the whole params object is cast (same as harness-privy).
    const recovered = await recoverTypedDataAddress({
      domain: {
        name: DELEGATION_DOMAIN_NAME,
        version: DELEGATION_DOMAIN_VERSION,
        chainId: Number(chainId),
        verifyingContract: DELEGATION_MANAGER,
      },
      types: SIGNABLE_DELEGATION_TYPED_DATA,
      primaryType: "Delegation",
      message,
      signature: delegation.signature,
    } as never);
    return isAddressEqual(recovered, expectedSigner);
  } catch (e) {
    // fail closed, but leave a trace: an internal fault here would otherwise surface
    // to users only as a misleading "signature does not recover" refusal
    console.warn("[delegations] signature recovery threw:", e instanceof Error ? e.message : e);
    return false;
  }
}

// ---------------------------------------------------------------------------
// EIP-7702 authorization (A_user only; agents stay bare EOAs forever)
// ---------------------------------------------------------------------------

export async function sign7702Auth(
  account: PrivateKeyAccount,
  chainId: ChainId = CHAIN_ID,
  nonceOverride?: number,
): Promise<Wire7702Auth> {
  const env = getSmartAccountsEnvironment(chainId);
  const impl = env.implementations.EIP7702StatelessDeleGatorImpl as Address;
  if (!impl) throw new EngineError("delegations", `no EIP7702StatelessDeleGatorImpl for chain ${chainId}`);
  let nonce = nonceOverride ?? 0;
  if (nonceOverride === undefined) {
    try {
      nonce = await publicClient(chainId).getTransactionCount({ address: account.address });
    } catch (e) {
      throw new EngineError("delegations", "could not read live nonce for 7702 auth", e);
    }
  }
  const auth = await account.signAuthorization({ contractAddress: impl, chainId: Number(chainId), nonce });
  return {
    chainId: ("0x" + Number(chainId).toString(16)) as Hex,
    address: impl,
    nonce: ("0x" + nonce.toString(16)) as Hex,
    yParity: ("0x" + (auth.yParity ?? 0).toString(16)) as Hex,
    r: auth.r,
    s: auth.s,
  };
}

/** Does the account already carry 7702 code? (-> omit authorizationList entirely) */
export async function has7702Code(address: Address, chainId: ChainId = CHAIN_ID): Promise<boolean> {
  const code = await publicClient(chainId).getCode({ address });
  return !!code && code !== "0x";
}

// ---------------------------------------------------------------------------
// Executions
// ---------------------------------------------------------------------------

export function erc20TransferExecution(token: Address, to: Address, amount: bigint): WireExecution {
  return {
    target: token,
    value: "0",
    data: encodeFunctionData({ abi: ERC20_ABI, functionName: "transfer", args: [to, amount] }),
  };
}

export function erc20ApproveExecution(token: Address, spender: Address, amount: bigint): WireExecution {
  return {
    target: token,
    value: "0",
    data: encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [spender, amount] }),
  };
}

export function feeExecution(feeCollector: Address, feeAtoms: bigint, chainId: ChainId = CHAIN_ID): WireExecution {
  return erc20TransferExecution(CHAINS[chainId].usdc, feeCollector, feeAtoms);
}
