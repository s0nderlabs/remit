// Trusted resolver data for the NL compiler. Every address here is verified on Base
// mainnet (eth_getCode + symbol() probe, Jun 10 2026). The compiler resolves names ->
// addresses ONLY from this table (or a Basescan verified-contract lookup, or an address
// the user typed verbatim). The model NEVER supplies an address: a draft carrying any
// address not traceable to a trusted source is rejected. This is the safety boundary —
// a human can't eyeball-check a hex string, so a poisoned name->address resolution would
// silently misroute funds the moment the user signs.

import type { Address } from "viem";

export type TokenEntry = { symbol: string; address: Address; decimals: number; aliases?: string[] };
export type ProtocolEntry = {
  key: string;
  label: string;
  address: Address;
  /** human-readable methods this protocol exposes that a card might scope */
  selectors: string[];
  aliases?: string[];
};

// Curated Base-mainnet token list (symbols confirmed via on-chain symbol() reads).
export const TOKENS: TokenEntry[] = [
  { symbol: "USDC", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6, aliases: ["usd coin", "usdc.e"] },
  { symbol: "WETH", address: "0x4200000000000000000000000000000000000006", decimals: 18, aliases: ["weth", "wrapped eth", "wrapped ether", "eth"] },
  { symbol: "DAI", address: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", decimals: 18, aliases: ["dai stablecoin"] },
  { symbol: "cbETH", address: "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22", decimals: 18, aliases: ["coinbase wrapped staked eth"] },
  { symbol: "USDbC", address: "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA", decimals: 6, aliases: ["bridged usdc", "usd base coin"] },
  { symbol: "cbBTC", address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", decimals: 8, aliases: ["coinbase wrapped btc", "btc", "bitcoin"] },
];

// Uniswap V3 SwapRouter02 single/multi-hop entrypoints (Base). The swap selectors a
// swap card scopes; the settlement-token approve is handled by the token list + pins.
const UNI_SWAP_SELECTORS = [
  "exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))",
  "exactInput((bytes,address,uint256,uint256))",
  "exactOutputSingle((address,address,uint24,address,uint256,uint256,uint160))",
  "exactOutput((bytes,address,uint256,uint256))",
];

export const PROTOCOLS: ProtocolEntry[] = [
  {
    key: "uniswap",
    label: "Uniswap V3 SwapRouter02",
    address: "0x2626664c2603336E57B271c5C0b26F421741e481",
    selectors: UNI_SWAP_SELECTORS,
    aliases: ["uniswap", "uniswap v3", "uni", "swaprouter02", "uniswap router"],
  },
  {
    key: "aave",
    label: "Aave V3 Pool",
    address: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
    selectors: [
      "supply(address,uint256,address,uint16)",
      "withdraw(address,uint256,address)",
      "borrow(address,uint256,uint256,uint16,address)",
      "repay(address,uint256,uint256,address)",
    ],
    aliases: ["aave", "aave v3", "aave pool", "lending"],
  },
];

const norm = (s: string) => s.trim().toLowerCase();

export function findToken(name: string): TokenEntry | null {
  const n = norm(name);
  return (
    TOKENS.find((t) => norm(t.symbol) === n) ??
    TOKENS.find((t) => (t.aliases ?? []).some((a) => norm(a) === n)) ??
    null
  );
}

export function findTokenByAddress(address: string): TokenEntry | null {
  const a = norm(address);
  return TOKENS.find((t) => norm(t.address) === a) ?? null;
}

export function findProtocol(name: string): ProtocolEntry | null {
  const n = norm(name);
  return (
    PROTOCOLS.find((p) => p.key === n || norm(p.label) === n) ??
    PROTOCOLS.find((p) => (p.aliases ?? []).some((a) => norm(a) === n)) ??
    null
  );
}

export function findProtocolByAddress(address: string): ProtocolEntry | null {
  const a = norm(address);
  return PROTOCOLS.find((p) => norm(p.address) === a) ?? null;
}
