// Demo shop tests: the REAL app over a live socket, with a FAKE StripeClient injected.
// Covers the catalog, the card-match path (no PAN echo), the no-stripe 503, and the
// per-IP checkout limiter.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { KeyedMutex, Store, type Relayer } from "@remit/engine";
import { createApp } from "../src/app";
import type { AppDeps } from "../src/deps";
import { SHOP_MERCHANT } from "../src/shop/routes";

// obviously-fake test PAN (Stripe Issuing test range shape)
const FAKE_PAN = "4000000000000005";

class FakeStripe {
  authCalls: Array<{ cardId: string; amountCents: number; merchantName: string }> = [];
  async listActiveCardIds() {
    return ["ic_demo_1"];
  }
  async listActiveCardSummaries() {
    return [{ id: "ic_demo_1", last4: FAKE_PAN.slice(-4), exp_month: 12, exp_year: 2030 }];
  }
  async getCardDetails(id: string, _opts?: { reveal?: boolean }) {
    return {
      id,
      last4: FAKE_PAN.slice(-4),
      exp_month: 12,
      exp_year: 2030,
      brand: "Visa",
      status: "active",
      number: FAKE_PAN,
      cvc: "123",
      cardholder_name: "remit agent",
      metadata: {} as Record<string, string>,
    };
  }
  async createTestAuthorization(args: { cardId: string; amountCents: number; merchantName: string }) {
    this.authCalls.push(args);
    return { id: `iauth_${this.authCalls.length}`, approved: true, status: "closed", amount: args.amountCents, currency: "usd" };
  }
  async findCardForRemitCard(_id: string) {
    return null;
  }
}

function makeDeps(stripe: FakeStripe | null): AppDeps {
  return {
    store: new Store(":memory:"),
    relayer: {} as unknown as Relayer,
    userSigner: null,
    adminToken: null,
    verifyPrivyToken: null,
    spendMutex: new KeyedMutex(),
    stripe,
  } as unknown as AppDeps;
}

let server: ReturnType<typeof Bun.serve>;
let base: string;
let bare: ReturnType<typeof Bun.serve>; // no stripe client -> shop disabled
let bareBase: string;
let fake: FakeStripe;

beforeAll(() => {
  process.env.REMIT_MASTER_KEY = "e".repeat(64);
  // limiter keys on a stable in-process ip (no XFF trust)
  process.env.REMIT_TRUST_PROXY_HOPS = "0";
  fake = new FakeStripe();
  server = Bun.serve({ port: 0, fetch: createApp(makeDeps(fake)).fetch });
  base = `http://localhost:${server.port}`;
  bare = Bun.serve({ port: 0, fetch: createApp(makeDeps(null)).fetch });
  bareBase = `http://localhost:${bare.port}`;
});

afterAll(() => {
  server.stop(true);
  bare.stop(true);
  delete process.env.REMIT_TRUST_PROXY_HOPS;
});

const goodCard = { number: "4000 0000 0000 0005", exp_month: "12", exp_year: "30", cvc: "123" };

async function checkout(b: string, body: unknown): Promise<Response> {
  return fetch(`${b}/shop/checkout`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("shop", () => {
  test("products list: merchant + dollar prices", async () => {
    const res = await fetch(`${base}/shop/products`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { merchant: string; products: Array<{ id: string; name: string; price: string }> };
    expect(body.merchant).toBe(SHOP_MERCHANT);
    expect(body.products.length).toBe(6);
    expect(body.products.find((p) => p.id === "espresso")!.price).toBe("0.05");
    expect(body.products.find((p) => p.id === "stand")!.price).toBe("4.90");
  });

  test("checkout with the matching card: approved, correct amount + merchant on the authorization", async () => {
    // spaced PAN + 2-digit year must still match
    const res = await checkout(base, { product_id: "espresso", card: goodCard });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.approved).toBe(true);
    expect(body.reason).toBe("approved"); // no cached decision in this fake -> generic reason
    expect(body.last4).toBe("0005");
    expect((body.product as { price: string }).price).toBe("0.05");
    const call = fake.authCalls[fake.authCalls.length - 1]!;
    expect(call.cardId).toBe("ic_demo_1");
    expect(call.amountCents).toBe(5);
    expect(call.merchantName).toBe(SHOP_MERCHANT);
  });

  test("wrong number: card_not_recognized, no authorization created, PAN never echoed", async () => {
    const before = fake.authCalls.length;
    const res = await checkout(base, { product_id: "espresso", card: { ...goodCard, number: "4242424242424242" } });
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text) as Record<string, unknown>;
    expect(body.approved).toBe(false);
    expect(body.reason).toBe("card_not_recognized");
    expect(fake.authCalls.length).toBe(before);
    expect(text).not.toContain("4242424242424242");
  });

  test("unknown product 404; malformed body/card 400", async () => {
    expect((await checkout(base, { product_id: "yacht", card: goodCard })).status).toBe(404);
    expect((await checkout(base, { product_id: "espresso", card: { number: 123 } })).status).toBe(400);
    expect((await checkout(base, { product_id: "espresso" })).status).toBe(400);
    expect((await checkout(base, { product_id: "espresso", card: { ...goodCard, exp_year: "soon" } })).status).toBe(400);
  });

  test("no stripe client wired: 503 shop disabled", async () => {
    const res = await checkout(bareBase, { product_id: "espresso", card: goodCard });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe("shop disabled");
  });

  // LAST: burns the shared per-IP window
  test("checkout rate limit: 429 within the 20/min window", async () => {
    let got429 = false;
    for (let i = 0; i < 25; i++) {
      // non-matching PAN so no authorizations pile up
      const res = await checkout(base, { product_id: "keycaps", card: { ...goodCard, number: "4111111111111111" } });
      if (res.status === 429) {
        got429 = true;
        break;
      }
      expect(res.status).toBe(200);
    }
    expect(got429).toBe(true);
  });
});
