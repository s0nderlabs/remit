// Core domain types. CardTerms is the terms_json vocabulary (capability spec v1,
// locked Jun 6: additive evolution expected). Amount fields are USDC decimal STRINGS.

import type { Address, Hex } from "viem";

// ---------------------------------------------------------------------------
// Terms (what the user composes / a parent agent attenuates)
// ---------------------------------------------------------------------------

export type PayTerms = {
  /** Recurring cap: amount per fixed window (erc20PeriodTransfer; windows reset at startDate + k*seconds). */
  period?: { amount: string; seconds: number };
  /** Cumulative lifetime ceiling (erc20TransferAmount). Stacks with period. */
  lifetime?: { amount: string };
};

export type ContractTerms = {
  /** Allowed call targets. USDC is unioned in automatically (fee leg must pass). */
  targets: Address[];
  /** Allowed method signatures, human-readable ("approve(address,uint256)"). transfer() unioned in. */
  selectors: string[];
  /** Tokens this card may grant ERC-20 allowances on (approve / increaseAllowance).
   * When present, allowance calls must target a listed token; listed tokens are
   * unioned into targets (+ approve into selectors) at validation. Every allowance
   * call is also pinned on-chain (exact spender + amount) regardless of this list. */
  tokens?: Address[];
  /** Per-allowance ceiling on USDC approvals (USDC decimal string). v1 caps the
   * settlement token only; non-USDC allowances still get exact-amount pins. */
  perTradeMax?: string;
};

export type CardTerms = {
  pay?: PayTerms;
  /** Contract scope: enables the `execute` tool surface. The composer's swap pill compiles to this. */
  contract?: ContractTerms;
  /** Unix seconds. Card dies on-chain after this (timestamp enforcer). */
  expiry?: number;
  /** Total number of redemptions (limitedCalls). */
  maxUses?: number;
  /** Per-charge ceiling. CARVE-LAYER policy (no on-chain enforcer; leaf maxAmount + server refusal). */
  perTxMax?: string;
  /** Recipient whitelist. CARVE-LAYER policy v1 (root pins collide with the fee leg, Phase-B-proven). */
  merchants?: Address[];
  /** May this card mint sub-cards? Default true. */
  subcards?: boolean;
};

// ---------------------------------------------------------------------------
// Compiled output (compiler.ts)
// ---------------------------------------------------------------------------

export type WireCaveat = { enforcer: Address; terms: Hex; args: Hex };

export type CardKind = "pay" | "contract" | "composite";

export type OrGroupInfo = {
  /** groupIndex for a pay-mode redemption. */
  payIndex: bigint;
  /** groupIndex for a contract-mode redemption. */
  contractIndex: bigint;
  /** caveat count per group (caveatArgs.length MUST equal the selected group's size). */
  sizes: number[];
  /** position of the LogicalOrWrapper caveat within rootCaveats (its args mutate per redemption). */
  caveatPosition: number;
};

export type CarvePolicy = {
  perTxMaxAtoms: bigint | null;
  merchants: Address[] | null;
};

export type CompiledCard = {
  kind: CardKind;
  /** Root caveat set, ready to embed in the root delegation. For composite cards the
   * OR-wrapper caveat carries PLACEHOLDER args; spend injects per-redemption args. */
  rootCaveats: WireCaveat[];
  orGroups: OrGroupInfo | null;
  carvePolicy: CarvePolicy;
  /** The erc20PeriodTransfer startDate baked into the root (period windows reset at
   * startDate + k*seconds). Persist it: the store's window math MUST anchor here. */
  periodStartDate: number | null;
  /** Echo of the validated terms that produced this compile. */
  terms: CardTerms;
};

// ---------------------------------------------------------------------------
// Wire shapes (relayer)
// ---------------------------------------------------------------------------

export type WireDelegation = {
  delegate: Address;
  delegator: Address;
  authority: Hex;
  caveats: WireCaveat[];
  salt: Hex;
  signature: Hex;
};

export type WireExecution = { target: Address; value: string; data: Hex };

export type Wire7702Auth = {
  chainId: Hex;
  address: Address;
  nonce: Hex;
  yParity: Hex;
  r: Hex;
  s: Hex;
};

// ---------------------------------------------------------------------------
// Receipts + live state (tool-facing)
// ---------------------------------------------------------------------------

export type Receipt = {
  /** "settlement_unconfirmed": x402 content served but the seller echoed no on-chain proof */
  status: "confirmed" | "pending" | "failed" | "settlement_unconfirmed";
  tx: Hex | null;
  to: Address;
  amount: string;
  fee: string;
  remaining_this_period: string | null;
  memo?: string;
};

export type CardState = {
  card_id: string;
  name: string;
  status: "issued" | "active" | "frozen" | "revoked" | "nuked" | "expired";
  terms: CardTerms;
  remaining_this_period: string | null;
  remaining_lifetime: string | null;
  period_resets_at: number | null;
  expires_at: number | null;
  uses_remaining: number | null;
  subcards: string[];
};
