// Public, client-safe constants + a read-only Base mainnet client. The Privy App ID
// and Client ID are PUBLIC client credentials (never the app secret). Base mainnet
// (8453) is THE chain (locked). Defaults match the live "remit" Privy app.

import { createPublicClient, http, type Address } from "viem";
import { base } from "viem/chains";

export const PRIVY_APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? "cmq14zjut00040cjv4fgj82vd";
export const PRIVY_CLIENT_ID =
  process.env.NEXT_PUBLIC_PRIVY_CLIENT_ID ?? "client-WY6aErb7JSTTnL52yVH5tufA1xn1nLNvN1oBwKrNMEyfF";

export const CHAIN_ID = 8453 as const;
export const BASE_RPC = process.env.NEXT_PUBLIC_BASE_RPC ?? "https://mainnet.base.org";

// DelegationManager (same on Base + Base Sepolia), verified Jun 5 2026.
export const DELEGATION_MANAGER = "0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3" as Address;

// Base mainnet USDC. Lowercase on purpose: consumers compare it against
// user-supplied token lists case-insensitively.
export const USDC_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" as Address;

export const publicClient = createPublicClient({ chain: base, transport: http(BASE_RPC) });
