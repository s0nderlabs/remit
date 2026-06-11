// The trusted resolver toolkit: name -> address resolution from authoritative sources
// ONLY (the curated registry + an optional Basescan verified-contract lookup). NEVER
// from open-web search. Every resolution carries a human LABEL so the draft can show
// "Uniswap V3 SwapRouter02 (verified)" / "USDC" instead of a hex string a human can't
// check. Unknown names resolve to null (the compiler refuses honestly), not a guess.

import { isAddress, type Address } from "viem";
import { findProtocol, findProtocolByAddress, findToken, findTokenByAddress } from "./registry";

export type ResolvedEntity = {
  /** what the user wrote */
  query: string;
  address: Address;
  /** human label for the draft UI */
  label: string;
  kind: "token" | "protocol" | "verified_contract" | "raw_address";
  /** how we know this address (provenance, surfaced in the draft) */
  source: "registry" | "basescan" | "user_input";
  /** token decimals, when known */
  decimals?: number;
};

export type Resolvers = {
  token: (name: string) => ResolvedEntity | null;
  protocol: (name: string) => { entity: ResolvedEntity; selectors: string[] } | null;
  /** verified-contract lookup for an ADDRESS the user typed (confirms + labels it). Async. */
  verifiedContract: (address: string) => Promise<ResolvedEntity | null>;
};

export function registryResolvers(opts?: { basescanLookup?: (address: Address) => Promise<string | null> }): Resolvers {
  return {
    token(name: string) {
      const t = findToken(name);
      if (!t) return null;
      return { query: name, address: t.address, label: t.symbol, kind: "token", source: "registry", decimals: t.decimals };
    },
    protocol(name: string) {
      const p = findProtocol(name);
      if (!p) return null;
      return {
        entity: { query: name, address: p.address, label: p.label, kind: "protocol", source: "registry" },
        selectors: p.selectors,
      };
    },
    async verifiedContract(address: string) {
      if (!isAddress(address)) return null;
      const addr = address as Address;
      // a known registry address resolves to its rich label without a network call
      const tok = findTokenByAddress(addr);
      if (tok) return { query: address, address: addr, label: tok.symbol, kind: "token", source: "registry", decimals: tok.decimals };
      const proto = findProtocolByAddress(addr);
      if (proto) return { query: address, address: addr, label: proto.label, kind: "protocol", source: "registry" };
      // otherwise consult the block explorer's verified-contract name (trusted: it only
      // CONFIRMS + labels an address the user supplied, never turns a name into an address)
      if (opts?.basescanLookup) {
        const name = await opts.basescanLookup(addr);
        if (name) return { query: address, address: addr, label: `${name} (verified)`, kind: "verified_contract", source: "basescan" };
      }
      return null;
    },
  };
}

/** Basescan verified-contract name lookup (Etherscan V2 multichain API, chainid 8453).
 * Returns the ContractName for a verified contract, or null if unverified / no key. */
export function basescanLookup(apiKey: string | undefined): (address: Address) => Promise<string | null> {
  return async (address: Address) => {
    if (!apiKey) return null;
    try {
      const url = `https://api.etherscan.io/v2/api?chainid=8453&module=contract&action=getsourcecode&address=${address}&apikey=${apiKey}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
      const json = (await res.json()) as { status?: string; result?: Array<{ ContractName?: string; ABI?: string }> };
      const row = json.result?.[0];
      if (!row || !row.ContractName || row.ABI === "Contract source code not verified") return null;
      return row.ContractName;
    } catch {
      return null;
    }
  };
}
