// Typed refusals (the agent-facing vocabulary, locked Jun 6) + infra errors.
// A RefusalError is a VALID ANSWER ("no, because X"), not a failure: MCP tools
// return it as structured JSON so agents can explain themselves to their users.

export const REFUSAL_CODES = [
  "over_period_limit",
  "over_lifetime_limit",
  "per_tx_exceeded",
  "merchant_not_allowed",
  "card_frozen",
  "card_expired",
  "card_revoked",
  "card_not_found",
  "uses_exhausted",
  "exceeds_parent_terms",
  "subcards_disabled",
  "not_your_subcard",
  "target_not_allowed",
  "method_not_allowed",
  "spender_not_allowed",
  "token_not_allowed",
  "per_trade_exceeded",
  "price_exceeds_max",
  "no_fiat_card",
  "invalid_terms",
] as const;

export type RefusalCode = (typeof REFUSAL_CODES)[number];

export class RefusalError extends Error {
  readonly code: RefusalCode;
  /** Machine-readable context, e.g. { field: "period.amount", remaining: "3.20" }. */
  readonly detail: Record<string, string | number | boolean> | undefined;

  constructor(code: RefusalCode, message: string, detail?: RefusalError["detail"]) {
    super(message);
    this.name = "RefusalError";
    this.code = code;
    this.detail = detail;
  }

  toJSON() {
    return { status: "refused", code: this.code, message: this.message, ...(this.detail ? { detail: this.detail } : {}) };
  }
}

/** Infra/protocol failure (relayer, RPC, store): NOT an agent-facing refusal. */
export class EngineError extends Error {
  readonly stage: string;
  constructor(stage: string, message: string, readonly cause?: unknown) {
    super(message);
    this.name = "EngineError";
    this.stage = stage;
  }
}
