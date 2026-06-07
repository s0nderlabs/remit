"use client";

// useRemit: the browser signing surface for the Privy lane. Encapsulates the embedded
// wallet + the two shims proven in Phase C (harness-privy), exposing two operations:
//   sign7702()        -> the EIP-7702 authorization (wire shape the engine stores)
//   signDelegation(d) -> the EIP-712 ERC-7710 root delegation signature
//
// SHIM 1 (debigint): Privy's iframe RPC JSON-serializes typed data, so the kit's
//   uint256 salt (a BigInt) throws "Do not know how to serialize a BigInt". EIP-712 v4
//   accepts decimal strings for uints and hashes identically, so deep-convert before
//   the RPC boundary.
// SHIM 2 (rpcSafeAccount): toViemAccount().signTypedData in @privy-io/react-auth@3.29.2
//   signs with a RANDOM EPHEMERAL KEY. Route signTypedData through the wallet's own
//   EIP-1193 provider (eth_signTypedData_v4) instead, which signs with the embedded key.

import { useCallback, useMemo } from "react";
import {
  usePrivy,
  useWallets,
  toViemAccount,
  useSign7702Authorization,
  type ConnectedWallet,
} from "@privy-io/react-auth";
import { stringToHex } from "viem";
import type { Address, Hex } from "viem";
import {
  getSmartAccountsEnvironment,
  toMetaMaskSmartAccount,
  Implementation,
} from "@metamask/smart-accounts-kit";
import { CHAIN_ID, publicClient } from "@/lib/chain";

export type Wire7702Auth = {
  chainId: Hex;
  address: Address;
  nonce: Hex;
  yParity: Hex;
  r: Hex;
  s: Hex;
};

export type UnsignedDelegation = {
  delegator: Address;
  delegate: Address;
  authority: Hex;
  caveats: { enforcer: Address; terms: Hex; args: Hex }[];
  salt: Hex;
  signature: Hex;
};

// SHIM 1: deep bigint -> decimal string.
const debigint = (v: unknown): unknown =>
  typeof v === "bigint"
    ? v.toString()
    : Array.isArray(v)
      ? v.map(debigint)
      : v && typeof v === "object"
        ? Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, debigint(x)]))
        : v;

export function useRemit() {
  const { ready, authenticated, user, login, logout } = usePrivy();
  const { wallets, ready: walletsReady } = useWallets();
  const { signAuthorization } = useSign7702Authorization();

  const embeddedWallet: ConnectedWallet | undefined = useMemo(
    () => wallets.find((w) => w.walletClientType === "privy" || w.walletClientType === "privy-v2"),
    [wallets],
  );
  const address = embeddedWallet?.address as Address | undefined;

  // --- EIP-7702 authorization (A_user adopts the Stateless7702 delegator code) ---
  const sign7702 = useCallback(async (): Promise<Wire7702Auth> => {
    if (!embeddedWallet || !address) throw new Error("embedded wallet not ready");
    const env = getSmartAccountsEnvironment(CHAIN_ID);
    const impl = env.implementations.EIP7702StatelessDeleGatorImpl as Address;
    let nonce = 0;
    try {
      nonce = await publicClient.getTransactionCount({ address });
    } catch {
      // fresh embedded wallet -> nonce 0
    }
    const auth = await signAuthorization({ contractAddress: impl, chainId: CHAIN_ID, nonce }, { address });
    return {
      chainId: ("0x" + CHAIN_ID.toString(16)) as Hex,
      address: impl,
      nonce: ("0x" + nonce.toString(16)) as Hex,
      yParity: ("0x" + (auth.yParity ?? 0).toString(16)) as Hex,
      r: auth.r as Hex,
      s: auth.s as Hex,
    };
  }, [embeddedWallet, address, signAuthorization]);

  // --- Onboard proof: personal_sign("remit-onboard:v1:<did>") with the embedded key.
  // Proves to the server that THIS Privy login holds THIS wallet's key; the DID in
  // the message makes the signature useless to any other login (no replay). ---
  const signOnboardProof = useCallback(
    async (did: string): Promise<Hex> => {
      if (!embeddedWallet || !address) throw new Error("embedded wallet not ready");
      const provider = await embeddedWallet.getEthereumProvider();
      // MUST stay byte-for-byte in sync with onboardProofMessage() in
      // packages/server/src/api/routes.ts (server recovers against the same string).
      // personal_sign of stringToHex(s) and viem hashMessage(s) hash identical bytes.
      return (await provider.request({
        method: "personal_sign",
        params: [stringToHex(`remit-onboard:v1:${did}`), address],
      })) as Hex;
    },
    [embeddedWallet, address],
  );

  // --- EIP-712 ERC-7710 root delegation (the card's authority grant) ---
  const signDelegation = useCallback(
    async (delegation: UnsignedDelegation): Promise<Hex> => {
      if (!embeddedWallet || !address) throw new Error("embedded wallet not ready");
      const account = await toViemAccount({ wallet: embeddedWallet });

      const domainTypeFor = (d: Record<string, unknown>) =>
        (
          [
            ["name", "string"],
            ["version", "string"],
            ["chainId", "uint256"],
            ["verifyingContract", "address"],
            ["salt", "bytes32"],
          ] as const
        )
          .filter(([k]) => d[k] !== undefined)
          .map(([name, type]) => ({ name, type }));

      const rpcSafeAccount = {
        ...account,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        signTypedData: async (params: any) => {
          const provider = await embeddedWallet.getEthereumProvider();
          const types = params.types.EIP712Domain
            ? params.types
            : { EIP712Domain: domainTypeFor(params.domain ?? {}), ...params.types };
          const v4 = JSON.stringify({
            domain: debigint(params.domain ?? {}),
            types,
            primaryType: params.primaryType,
            message: debigint(params.message),
          });
          return (await provider.request({
            method: "eth_signTypedData_v4",
            params: [account.address, v4],
          })) as Hex;
        },
      } as typeof account;

      const smartAccount = await toMetaMaskSmartAccount({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        client: publicClient as any,
        implementation: Implementation.Stateless7702,
        address,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        signer: { account: rpcSafeAccount as any },
      });

      // sign the exact struct the server prepared (salt/caveats fixed there).
      const { signature: _drop, ...unsigned } = delegation;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return await smartAccount.signDelegation({ delegation: unsigned as any, chainId: CHAIN_ID });
    },
    [embeddedWallet, address],
  );

  return {
    ready,
    authenticated,
    user,
    login,
    logout,
    address,
    /** true only when the wallet PROVIDER is initialized (signing before this throws) */
    embeddedReady: walletsReady && !!address,
    sign7702,
    signOnboardProof,
    signDelegation,
  };
}
