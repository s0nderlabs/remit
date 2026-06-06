// Public, client-side-safe identifiers + chain constants for the harness.
// App ID + Client ID are PUBLIC (Privy client credentials, not the app secret).
// The app secret is never present in this client-only harness.
import type { Address, Hex } from "viem";

// Privy Dev environment app + client id (both public-safe).
export const PRIVY_APP_ID = "cmq14zjut00040cjv4fgj82vd";
export const PRIVY_CLIENT_ID = "client-WY6aErb7JSTTnL52yVH5tufA1xn1nLNvN1oBwKrNMEyfF";

// Base mainnet (chainId 8453) — the day-1 Stateless7702 validation target.
export const CHAIN_ID = 8453 as const;
export const BASE_RPC = "https://mainnet.base.org";

// DelegationManager (same address on Base + Base Sepolia), verified Jun 5 2026.
export const DELEGATION_MANAGER =
  "0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3" as Address;

// Throwaway delegate for the root delegation in step 3 (public info; holds nothing).
export const THROWAWAY_DELEGATE =
  "0x5117715db9A94F66E56Cb564728615842DC07bba" as Address;

// EIP-7702 authorization nonce we sign with. A fresh embedded wallet should be 0;
// step 2 also fetches the live on-chain nonce from BASE_RPC and signs with that.
export const AUTH_NONCE_DEFAULT = 0;

// DelegationManager EIP-712 domain (name/version from the kit runtime, see README).
export const DELEGATION_DOMAIN_NAME = "DelegationManager";
export const DELEGATION_DOMAIN_VERSION = "1";

export type { Address, Hex };
