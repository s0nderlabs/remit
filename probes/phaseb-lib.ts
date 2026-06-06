// Phase B harness: FUNDED MAINNET sends through the 1Shot Public Relayer (Base 8453).
// This module DOES call relayer_send7710Transaction (authorized for Phase B only).
// Estimate FIRST, send IMMEDIATELY (quote contexts expire ~45s).

import {
  createPublicClient,
  http,
  erc20Abi,
  formatUnits,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import {
  CHAINS,
  FEE_COLLECTOR,
  freshSalt,
  buildStateless7702,
  envFor,
  caveatBuilderFor,
  wireDelegation,
  erc20TransferExecution,
  usdc,
  sign7702Auth,
  estimate,
  relayerCall,
  type WireExecution,
  type ChainId,
  type Delegation,
} from "./lib";
import {
  createDelegation,
  signDelegation,
  ROOT_AUTHORITY,
  ScopeType,
} from "@metamask/smart-accounts-kit";

export const CID = 8453 as const;
export const C = CHAINS[CID];
export const USDC = C.usdc;

export function pub() {
  return createPublicClient({ chain: base, transport: http(C.rpc) });
}

// ---- account loading (funded A_user + locally-held merchant/agents) ----
function reqEnv(k: string): string {
  const v = process.env[k];
  if (!v) throw new Error(`missing env ${k}`);
  return v;
}

export function loadAccounts() {
  // .env.funded and .env.phaseb are loaded by bun automatically? No — load manually.
  const user = privateKeyToAccount(reqEnv("FUNDED_USER_PK") as Hex);
  const merchant = privateKeyToAccount(reqEnv("MERCHANT_PK") as Hex);
  const agent1 = privateKeyToAccount(reqEnv("AGENT1_PK") as Hex);
  const agent2 = privateKeyToAccount(reqEnv("AGENT2_PK") as Hex);
  return { user, merchant, agent1, agent2 };
}

export const ZERO_NONCE =
  "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex;

// ---- balances snapshot ----
export async function usdcBalance(addr: Address): Promise<bigint> {
  return pub().readContract({
    address: USDC,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [addr],
  });
}

export async function snapshot(addrs: Record<string, Address>) {
  const out: Record<string, { usdc: string; raw: bigint; code: string; eth: string }> = {};
  for (const [name, addr] of Object.entries(addrs)) {
    const [bal, code, eth] = await Promise.all([
      usdcBalance(addr),
      pub().getCode({ address: addr }),
      pub().getBalance({ address: addr }),
    ]);
    out[name] = {
      usdc: formatUnits(bal, 6),
      raw: bal,
      code: code ?? "0x",
      eth: (Number(eth) / 1e18).toString(),
    };
  }
  return out;
}

// ---- 7702 auth with LIVE on-chain nonce ----
export async function userAuth(account: ReturnType<typeof privateKeyToAccount>) {
  // sign7702Auth already reads live nonce via getTransactionCount
  const a = await sign7702Auth(CID, account);
  return {
    chainId: a.chainId,
    address: a.address,
    nonce: a.nonce,
    yParity: a.yParity,
    r: a.r,
    s: a.s,
  };
}

// ---- the send wrapper (authorized Phase B only) ----
export async function send(
  transactions: Array<{ permissionContext: any[]; executions: WireExecution[] }>,
  authorizationList: Array<Record<string, unknown>> | undefined,
  context: string,
) {
  const params: Record<string, unknown> = {
    chainId: String(CID),
    transactions,
    context,
  };
  if (authorizationList) params.authorizationList = authorizationList;
  return relayerCall(CID, "relayer_send7710Transaction", params);
}

export {
  CHAINS,
  FEE_COLLECTOR,
  freshSalt,
  buildStateless7702,
  envFor,
  caveatBuilderFor,
  wireDelegation,
  erc20TransferExecution,
  usdc,
  estimate,
  relayerCall,
  createDelegation,
  signDelegation,
  ROOT_AUTHORITY,
  ScopeType,
};
export type { Delegation, WireExecution };
