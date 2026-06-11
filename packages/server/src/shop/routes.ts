// Demo merchant: "s0nder supply co.", a generic web shop that happens to accept the
// test-mode Visa. Checkout matches the entered card against the linked Issuing cards
// (reveal + compare, server-side only) and fires a REAL test-mode authorization, so
// the webhook authorizes it against the card's budget like any other charge.
//
// Secret hygiene: the entered PAN never leaves the handler. Not logged, not echoed;
// responses carry last4 at most.

import { Hono } from "hono";
import { envInt, type AppDeps } from "../deps";
import { createHash, timingSafeEqual } from "node:crypto";
import { RateLimiter, clientIp } from "../ratelimit";
import { recentFiatDecision } from "../stripe/decisions";

/** Constant-time string equality (hash both sides so length differences don't leak). */
const credentialsEqual = (a: string, b: string): boolean =>
  timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());

export const SHOP_MERCHANT = "s0nder supply co.";

// demo pricing: cents-scale so a settled purchase (price + ~0.011 USDC relayer fee)
// stays affordable on a lightly-funded demo wallet. render-rig is the decline beat:
// priced over any demo card's budget but UNDER the test Issuing balance, so the
// decline comes from OUR webhook (over_period_limit), not Stripe's balance check.
export const SHOP_PRODUCTS = [
  { id: "espresso", name: "double espresso", priceCents: 2 },
  { id: "keycaps", name: "artisan keycap set", priceCents: 5 },
  { id: "render-rig", name: "render rig (refurb)", priceCents: 4900 },
];

// integer math (no float division): the money discipline everywhere else is decimal
// strings, and this keeps cents exact at any magnitude
const dollars = (cents: number): string => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;

export function shopRoutes(deps: AppDeps): Hono {
  const app = new Hono();
  // checkout is unauthenticated (it's a shop): per-IP ceiling against PAN guessing
  const checkoutLimit = new RateLimiter(envInt("REMIT_SHOP_RATE_LIMIT", 20), 60_000);

  app.get("/shop/products", (c) =>
    c.json({
      merchant: SHOP_MERCHANT,
      products: SHOP_PRODUCTS.map((p) => ({ id: p.id, name: p.name, price: dollars(p.priceCents) })),
    }),
  );

  app.post("/shop/checkout", async (c) => {
    if (!deps.stripe) return c.json({ error: "shop disabled" }, 503);
    if (!checkoutLimit.allow(clientIp(c), Date.now())) return c.json({ error: "too many requests" }, 429);

    let body: {
      product_id?: unknown;
      card?: { number?: unknown; exp_month?: unknown; exp_year?: unknown; cvc?: unknown } | null;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "malformed body" }, 400);
    }
    const card = body.card;
    if (
      typeof body.product_id !== "string" ||
      !card ||
      typeof card !== "object" ||
      typeof card.number !== "string" ||
      (typeof card.exp_month !== "string" && typeof card.exp_month !== "number") ||
      (typeof card.exp_year !== "string" && typeof card.exp_year !== "number") ||
      typeof card.cvc !== "string"
    ) {
      return c.json({ error: "malformed body" }, 400);
    }
    const product = SHOP_PRODUCTS.find((p) => p.id === body.product_id);
    if (!product) return c.json({ error: "unknown product" }, 404);

    const number = card.number.replace(/[\s-]/g, ""); // digits only
    const expMonth = Number(card.exp_month);
    let expYear = Number(card.exp_year);
    if (!/^\d{12,19}$/.test(number) || !Number.isInteger(expMonth) || !Number.isInteger(expYear)) {
      return c.json({ error: "malformed card" }, 400);
    }
    if (expYear < 100) expYear += 2000; // accept 2-digit years

    // cheap-key match first (last4 + expiry from the non-revealed list), then reveal
    // ONLY the candidate(s): never one reveal call per active card per attempt
    const last4 = number.slice(-4);
    const candidates = (await deps.stripe.listActiveCardSummaries()).filter(
      (s) => s.last4 === last4 && Number(s.exp_month) === expMonth && Number(s.exp_year) === expYear,
    );
    let match: { cardId: string; last4: string } | null = null;
    for (const cand of candidates) {
      const det = await deps.stripe.getCardDetails(cand.id, { reveal: true });
      // constant-time over the full credential tuple: string === short-circuits on
      // the first differing byte, a (weak) timing oracle on matched-prefix length
      if (credentialsEqual(`${det.number}|${det.exp_month}|${det.exp_year}|${det.cvc}`, `${number}|${expMonth}|${expYear}|${card.cvc}`)) {
        match = { cardId: cand.id, last4: det.last4 };
        break;
      }
    }
    if (!match) return c.json({ approved: false, reason: "card_not_recognized" });

    const auth = await deps.stripe.createTestAuthorization({
      cardId: match.cardId,
      amountCents: product.priceCents,
      merchantName: SHOP_MERCHANT,
    });
    // the in-process webhook cached its budget decision during the round-trip
    const decision = recentFiatDecision(auth.id);
    return c.json({
      approved: auth.approved,
      reason: decision?.reason ?? auth.decline_reason ?? (auth.approved ? "approved" : "declined"),
      authorization_id: auth.id,
      product: { id: product.id, name: product.name, price: dollars(product.priceCents) },
      last4: match.last4,
    });
  });

  return app;
}
