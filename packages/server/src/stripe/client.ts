// Minimal Stripe REST client for the Issuing test-mode lane: fetch + form encoding,
// no SDK (same posture as the relayer/Venice clients: the trust boundary is our own
// schema, not the transport). TEST-MODE-ONLY by design: makeStripeClient refuses any
// key that isn't sk_test_/rk_test_, so the fiat leg can never touch live issuing.

import { EngineError } from "@remit/engine";

const STRIPE_BASE = "https://api.stripe.com";
const STRIPE_VERSION = "2025-03-31.basil";
// short TTL: a re-pointed metadata mapping (the drill/demo does this) must not serve
// a stale Issuing card for minutes
const CARD_CACHE_TTL_MS = 60 * 1000;

export type IssuingCardDetails = {
  id: string;
  last4: string;
  exp_month: number;
  exp_year: number;
  brand: string;
  status: string;
  /** full PAN/CVC only when revealed (test mode allows expand) */
  number?: string;
  cvc?: string;
  cardholder_name: string | null;
  metadata: Record<string, string>;
};

export type IssuingAuthorization = {
  id: string;
  approved: boolean;
  status: string;
  amount: number;
  currency: string;
  /** Stripe's OWN decline reason (request_history), e.g. insufficient_funds when the
   * test Issuing balance pre-declines before our webhook is ever consulted; null when
   * approved. Webhook declines surface as "webhook_declined" here, but callers prefer
   * the local decision cache (the real refusal code) when it has an entry. */
  decline_reason: string | null;
};

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

type RawIssuingCard = {
  id: string;
  last4: string;
  exp_month: number;
  exp_year: number;
  brand: string;
  status: string;
  number?: string;
  cvc?: string;
  cardholder?: { name?: string | null } | null;
  metadata?: Record<string, string>;
};

export class StripeClient {
  private readonly key: string;
  private readonly fetchFn: FetchFn;
  /** remit_card_id -> { Issuing card id, listed-at } (re-list on miss or staleness) */
  private cardIdCache = new Map<string, { icId: string; at: number }>();

  constructor(key: string, fetchFn: FetchFn = (url, init) => globalThis.fetch(url, init)) {
    this.key = key;
    this.fetchFn = fetchFn;
  }

  /** Form-encoded request; bracket keys (merchant_data[name], expand[]) pass literally.
   * Non-2xx -> EngineError carrying the body's error.message (else the status line). */
  private async request<T>(method: "GET" | "POST", path: string, params?: URLSearchParams): Promise<T> {
    const query = method === "GET" && params && [...params].length ? `?${params.toString()}` : "";
    const res = await this.fetchFn(`${STRIPE_BASE}${path}${query}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.key}`,
        "Stripe-Version": STRIPE_VERSION,
        ...(method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      },
      body: method === "POST" ? (params ?? new URLSearchParams()).toString() : undefined,
    });
    const text = await res.text();
    if (!res.ok) {
      let message = `${res.status} ${res.statusText}`;
      try {
        const body = JSON.parse(text) as { error?: { message?: string } };
        if (body.error?.message) message = body.error.message;
      } catch {
        // non-JSON error body: keep the status line
      }
      throw new EngineError("stripe", message);
    }
    return JSON.parse(text) as T;
  }

  private async listActiveCards(): Promise<RawIssuingCard[]> {
    const params = new URLSearchParams();
    params.set("status", "active");
    params.set("limit", "100");
    const res = await this.request<{ data?: RawIssuingCard[] }>("GET", "/v1/issuing/cards", params);
    return res.data ?? [];
  }

  async listActiveCardIds(): Promise<string[]> {
    return (await this.listActiveCards()).map((c) => c.id);
  }

  /** Active-card summaries WITHOUT revealing PAN/cvc: the shop's cheap match key. */
  async listActiveCardSummaries(): Promise<Array<{ id: string; last4: string; exp_month: number; exp_year: number }>> {
    return (await this.listActiveCards()).map((c) => ({
      id: c.id,
      last4: c.last4,
      exp_month: c.exp_month,
      exp_year: c.exp_year,
    }));
  }

  /** Resolve the Issuing card carrying metadata.remit_card_id = remitCardId.
   * Hits are cached 5 min; a miss re-lists once (a just-created card must be findable). */
  async findCardForRemitCard(remitCardId: string): Promise<string | null> {
    const cached = this.cardIdCache.get(remitCardId);
    if (cached && Date.now() - cached.at < CARD_CACHE_TTL_MS) return cached.icId;
    const cards = await this.listActiveCards();
    const now = Date.now();
    // full rebuild: entries for re-pointed or deactivated cards must not survive a re-list
    this.cardIdCache.clear();
    for (const card of cards) {
      const rid = card.metadata?.remit_card_id;
      if (rid) this.cardIdCache.set(rid, { icId: card.id, at: now });
    }
    return this.cardIdCache.get(remitCardId)?.icId ?? null;
  }

  /** reveal=true expands number + cvc (test mode allows this; live mode would refuse). */
  async getCardDetails(icId: string, opts?: { reveal?: boolean }): Promise<IssuingCardDetails> {
    const params = new URLSearchParams();
    if (opts?.reveal) {
      params.append("expand[]", "number");
      params.append("expand[]", "cvc");
    }
    const card = await this.request<RawIssuingCard>("GET", `/v1/issuing/cards/${icId}`, params);
    return {
      id: card.id,
      last4: card.last4,
      exp_month: card.exp_month,
      exp_year: card.exp_year,
      brand: card.brand,
      status: card.status,
      ...(card.number !== undefined ? { number: card.number } : {}),
      ...(card.cvc !== undefined ? { cvc: card.cvc } : {}),
      cardholder_name: card.cardholder?.name ?? null,
      metadata: card.metadata ?? {},
    };
  }

  /** Test-helper authorization: fires the real-time auth webhook end-to-end (the demo
   * shop's purchase trigger). Test mode only: the path does not exist on live keys. */
  async createTestAuthorization(args: {
    cardId: string;
    amountCents: number;
    merchantName: string;
  }): Promise<IssuingAuthorization> {
    const params = new URLSearchParams();
    params.set("card", args.cardId);
    params.set("amount", String(args.amountCents));
    params.set("currency", "usd");
    params.set("merchant_data[name]", args.merchantName);
    const raw = await this.request<
      Omit<IssuingAuthorization, "decline_reason"> & {
        request_history?: Array<{ reason?: string | null }>;
      }
    >("POST", "/v1/test_helpers/issuing/authorizations", params);
    return {
      id: raw.id,
      approved: raw.approved,
      status: raw.status,
      amount: raw.amount,
      currency: raw.currency,
      decline_reason: raw.approved ? null : (raw.request_history?.[0]?.reason ?? null),
    };
  }
}

/** Wire-up seam: null when STRIPE_SECRET_KEY is unset OR not a test-mode key (the fiat
 * leg is test-mode-only by design; a live-looking key disables the lane loudly). */
export function makeStripeClient(env: NodeJS.ProcessEnv = process.env): StripeClient | null {
  const key = env.STRIPE_SECRET_KEY;
  if (!key) return null;
  if (!/^(sk|rk)_test_/.test(key)) {
    console.error("[stripe] STRIPE_SECRET_KEY is not a test-mode key (sk_test_/rk_test_); fiat lane disabled (test-mode-only by design)");
    return null;
  }
  return new StripeClient(key);
}
