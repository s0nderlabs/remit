// Shared probe harness for the 1Shot Public Relayer caveat-composition suite.
// Local-only. NEVER calls relayer_send7710Transaction (or any send method).
// Only relayer_getCapabilities / relayer_getFeeData / relayer_estimate7710Transaction.

import {
  createPublicClient,
  http,
  encodeFunctionData,
  parseAbi,
  type Hex,
  type Address,
} from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { baseSepolia, base } from "viem/chains";
import {
  toMetaMaskSmartAccount,
  Implementation,
  ScopeType,
  getSmartAccountsEnvironment,
  createCaveat,
  createExecution,
  type Delegation,
  type Caveat,
  type SmartAccountsEnvironment,
} from "@metamask/smart-accounts-kit";
import { createCaveatBuilder } from "@metamask/smart-accounts-kit/utils";

// ---------------------------------------------------------------------------
// Chain constants (verified Jun 5 2026; re-fetch capabilities at runtime too)
// ---------------------------------------------------------------------------
export const CHAINS = {
  84532: {
    name: "Base Sepolia",
    chain: baseSepolia,
    rpc: "https://sepolia.base.org",
    relayer: "https://relayer.1shotapi.dev/relayers",
    targetAddress: "0xf1ef956eff4181Ce913b664713515996858B9Ca9" as Address,
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as Address,
  },
  8453: {
    name: "Base",
    chain: base,
    rpc: "https://mainnet.base.org",
    relayer: "https://relayer.1shotapi.com/relayers",
    targetAddress: "0x26a529124f0bbf9af9d8f9f84a43efe47cf1199a" as Address,
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address,
  },
} as const;

export const FEE_COLLECTOR =
  "0xE936e8FAf4A5655469182A49a505055B71C17604" as Address;

export type ChainId = keyof typeof CHAINS;

const ERC20_ABI = parseAbi([
  "function transfer(address to, uint256 amount) returns (bool)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

// ---------------------------------------------------------------------------
// Throwaway keys
// ---------------------------------------------------------------------------
export function freshKey() {
  const pk = generatePrivateKey();
  const account = privateKeyToAccount(pk);
  return { pk, account, address: account.address as Address };
}

export function freshSalt(): Hex {
  // fresh random 32-byte salt per delegation
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return ("0x" +
    [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")) as Hex;
}

// ---------------------------------------------------------------------------
// Public client + smart account builder
// ---------------------------------------------------------------------------
export function publicClientFor(chainId: ChainId) {
  const c = CHAINS[chainId];
  return createPublicClient({ chain: c.chain, transport: http(c.rpc) });
}

export function envFor(chainId: ChainId): SmartAccountsEnvironment {
  return getSmartAccountsEnvironment(chainId);
}

export function caveatBuilderFor(chainId: ChainId) {
  return createCaveatBuilder(envFor(chainId));
}

// Build a Stateless7702 smart account at `address`, signed by `account`.
// PROBE FINDING #3: which signer shape does the SDK type/runtime accept?
// We attempt signer:{account} first and record the result.
export async function buildStateless7702(
  chainId: ChainId,
  address: Address,
  account: ReturnType<typeof privateKeyToAccount>,
) {
  const client = publicClientFor(chainId);
  const smart = await toMetaMaskSmartAccount({
    client,
    implementation: Implementation.Stateless7702,
    address,
    signer: { account },
  });
  return smart;
}

// ---------------------------------------------------------------------------
// Wire formatting: every bigint in a delegation struct -> 0x-hex before JSON.
// Delegation struct from the SDK already has salt as Hex and all fields Hex,
// but we normalize defensively (in case any field is a bigint).
// ---------------------------------------------------------------------------
function bigintToHex(v: bigint): Hex {
  return ("0x" + v.toString(16)) as Hex;
}

export function wireDelegation(d: Delegation): Record<string, unknown> {
  const norm = (x: unknown): unknown =>
    typeof x === "bigint" ? bigintToHex(x) : x;
  return {
    delegate: d.delegate,
    delegator: d.delegator,
    authority: d.authority,
    caveats: d.caveats.map((c) => ({
      enforcer: c.enforcer,
      terms: c.terms,
      args: c.args,
    })),
    salt: norm(d.salt),
    signature: d.signature,
  };
}

// ---------------------------------------------------------------------------
// Executions
// ---------------------------------------------------------------------------
export type WireExecution = { target: Address; value: string; data: Hex };

export function erc20TransferExecution(
  token: Address,
  to: Address,
  amount: bigint,
): WireExecution {
  return {
    target: token,
    value: "0",
    data: encodeFunctionData({
      abi: ERC20_ABI,
      functionName: "transfer",
      args: [to, amount],
    }),
  };
}

export function erc20ApproveExecution(
  token: Address,
  spender: Address,
  amount: bigint,
): WireExecution {
  return {
    target: token,
    value: "0",
    data: encodeFunctionData({
      abi: ERC20_ABI,
      functionName: "approve",
      args: [spender, amount],
    }),
  };
}

// USDC has 6 decimals: dollars -> atoms
export function usdc(dollars: number): bigint {
  return BigInt(Math.round(dollars * 1e6));
}

// minFee comes back as a dollar-decimal string like "0.01"; -> token atoms (6 dec)
export function minFeeToAtoms(minFee: string): bigint {
  // parse decimal string safely without float drift
  const [whole, frac = ""] = minFee.split(".");
  const fracPadded = (frac + "000000").slice(0, 6);
  return BigInt(whole) * 1_000_000n + BigInt(fracPadded || "0");
}

// ---------------------------------------------------------------------------
// 7702 authorization signing
// ---------------------------------------------------------------------------
// Sign an EIP-7702 authorization for `account` to delegate to the Stateless7702
// implementation. Returns the authorizationList entry in relayer wire shape.
export async function sign7702Auth(
  chainId: ChainId,
  account: ReturnType<typeof privateKeyToAccount>,
) {
  const env = envFor(chainId);
  const impl = env.implementations.EIP7702StatelessDeleGatorImpl as Address;
  const client = publicClientFor(chainId);
  // nonce: read on-chain transaction count; unfunded keys are 0 but read anyway
  let nonce = 0;
  try {
    nonce = await client.getTransactionCount({ address: account.address });
  } catch {
    nonce = 0;
  }
  const auth = await account.signAuthorization({
    contractAddress: impl,
    chainId: Number(chainId),
    nonce,
  });
  // wire shape for relayer authorizationList entries
  return {
    chainId: "0x" + Number(chainId).toString(16),
    address: impl,
    nonce: "0x" + nonce.toString(16),
    yParity: "0x" + (auth.yParity ?? 0).toString(16),
    r: auth.r,
    s: auth.s,
    raw: auth,
  };
}

// ---------------------------------------------------------------------------
// Relayer JSON-RPC client
// ---------------------------------------------------------------------------
let rpcId = 1;
export async function relayerCall(
  chainId: ChainId,
  method: string,
  params: unknown,
) {
  const url = CHAINS[chainId].relayer;
  const body = {
    jsonrpc: "2.0",
    id: rpcId++,
    method,
    params,
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    return { httpStatus: res.status, raw: text, parsed: null };
  }
  return { httpStatus: res.status, raw: text, parsed: json };
}

export async function getCapabilities(chainId: ChainId) {
  // params = FLAT array of decimal chainId strings
  return relayerCall(chainId, "relayer_getCapabilities", [String(chainId)]);
}

export async function getFeeData(chainId: ChainId, token: Address) {
  // bare object {chainId, token}
  return relayerCall(chainId, "relayer_getFeeData", {
    chainId: String(chainId),
    token,
  });
}

export async function estimate(
  chainId: ChainId,
  transactions: Array<{
    permissionContext: Array<Record<string, unknown>>;
    executions: WireExecution[];
  }>,
  authorizationList?: Array<Record<string, unknown>>,
) {
  const params: Record<string, unknown> = {
    chainId: String(chainId),
    transactions,
  };
  if (authorizationList) params.authorizationList = authorizationList;
  return relayerCall(chainId, "relayer_estimate7710Transaction", params);
}

// ---------------------------------------------------------------------------
// Re-exports for probes
// ---------------------------------------------------------------------------
export {
  toMetaMaskSmartAccount,
  Implementation,
  ScopeType,
  createCaveat,
  createExecution,
};
export type { Delegation, Caveat };
