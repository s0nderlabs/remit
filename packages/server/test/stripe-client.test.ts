// Stripe REST client tests: a fake fetch captures every request (zero network).
// Form encoding, headers, error mapping, the test-mode-only key gate, and the
// remit-card lookup cache.

import { describe, expect, test } from "bun:test";
import { EngineError } from "@remit/engine";
import { StripeClient, makeStripeClient } from "../src/stripe/client";

// key prefixes composed at runtime so no real-looking secret appears in this file
const TEST_KEY = ["sk", "test", "remitclient"].join("_");
const RESTRICTED_TEST_KEY = ["rk", "test", "remitclient"].join("_");
const NON_TEST_KEY = ["sk", "live", "notarealkey"].join("_");

type Captured = { url: string; init?: RequestInit };

function fakeFetch(responses: Array<{ status?: number; body: unknown }>) {
  const calls: Captured[] = [];
  let i = 0;
  const fn = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    const r = responses[Math.min(i, responses.length - 1)]!;
    i++;
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  };
  return { calls, fn };
}

const rawCard = (id: string, remitCardId?: string) => ({
  id,
  last4: "4242",
  exp_month: 4,
  exp_year: 2030,
  brand: "Visa",
  status: "active",
  cardholder: { name: "remit demo" },
  metadata: remitCardId ? { remit_card_id: remitCardId } : {},
});

describe("request shape", () => {
  test("createTestAuthorization: form-encoded POST with bracket keys + auth/version headers", async () => {
    const { calls, fn } = fakeFetch([
      { body: { id: "iauth_t1", approved: true, status: "closed", amount: 250, currency: "usd" } },
    ]);
    const client = new StripeClient(TEST_KEY, fn);
    const auth = await client.createTestAuthorization({ cardId: "ic_1", amountCents: 250, merchantName: "Bean & Gone" });
    expect(auth).toEqual({ id: "iauth_t1", approved: true, status: "closed", amount: 250, currency: "usd", decline_reason: null });

    const req = calls[0]!;
    expect(req.url).toBe("https://api.stripe.com/v1/test_helpers/issuing/authorizations");
    expect(req.init?.method).toBe("POST");
    const headers = req.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${TEST_KEY}`);
    expect(headers["Stripe-Version"]).toBe("2025-03-31.basil");
    expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    const form = new URLSearchParams(req.init?.body as string);
    expect(form.get("card")).toBe("ic_1");
    expect(form.get("amount")).toBe("250");
    expect(form.get("currency")).toBe("usd");
    expect(form.get("merchant_data[name]")).toBe("Bean & Gone");
  });

  test("getCardDetails: reveal expands number+cvc in the query; plain read omits them", async () => {
    const revealed = { ...rawCard("ic_2", "rc_2"), number: "4242424242424242", cvc: "123" };
    const { calls, fn } = fakeFetch([{ body: revealed }, { body: rawCard("ic_2", "rc_2") }]);
    const client = new StripeClient(TEST_KEY, fn);

    const full = await client.getCardDetails("ic_2", { reveal: true });
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/v1/issuing/cards/ic_2");
    expect(url.searchParams.getAll("expand[]")).toEqual(["number", "cvc"]);
    expect(full.number).toBe("4242424242424242");
    expect(full.cvc).toBe("123");
    expect(full.cardholder_name).toBe("remit demo");
    expect(full.metadata).toEqual({ remit_card_id: "rc_2" });

    const plain = await client.getCardDetails("ic_2");
    expect(new URL(calls[1]!.url).search).toBe("");
    expect(plain.number).toBeUndefined();
    expect(plain.cvc).toBeUndefined();
  });

  test("non-2xx maps to EngineError carrying the body's error.message", async () => {
    const { fn } = fakeFetch([{ status: 402, body: { error: { message: "test account has no funds" } } }]);
    const client = new StripeClient(TEST_KEY, fn);
    await expect(client.listActiveCardIds()).rejects.toThrow(EngineError);
    await expect(client.listActiveCardIds()).rejects.toThrow("test account has no funds");
  });

  test("non-JSON error body falls back to the status line", async () => {
    const fn = async () => new Response("upstream burp", { status: 503, statusText: "Service Unavailable" });
    const client = new StripeClient(TEST_KEY, fn);
    await expect(client.listActiveCardIds()).rejects.toThrow("503");
  });
});

describe("makeStripeClient gate", () => {
  test("missing key -> null; non-test key -> null; sk_test_/rk_test_ -> client", () => {
    expect(makeStripeClient({} as NodeJS.ProcessEnv)).toBeNull();
    expect(makeStripeClient({ STRIPE_SECRET_KEY: NON_TEST_KEY } as NodeJS.ProcessEnv)).toBeNull();
    expect(makeStripeClient({ STRIPE_SECRET_KEY: TEST_KEY } as NodeJS.ProcessEnv)).toBeInstanceOf(StripeClient);
    expect(makeStripeClient({ STRIPE_SECRET_KEY: RESTRICTED_TEST_KEY } as NodeJS.ProcessEnv)).toBeInstanceOf(StripeClient);
  });
});

describe("card listing + lookup cache", () => {
  test("listActiveCardIds queries status=active&limit=100 and returns ids", async () => {
    const { calls, fn } = fakeFetch([{ body: { data: [rawCard("ic_a", "rc_a"), rawCard("ic_b")] } }]);
    const client = new StripeClient(TEST_KEY, fn);
    expect(await client.listActiveCardIds()).toEqual(["ic_a", "ic_b"]);
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/v1/issuing/cards");
    expect(url.searchParams.get("status")).toBe("active");
    expect(url.searchParams.get("limit")).toBe("100");
  });

  test("findCardForRemitCard caches hits: second call issues no list fetch", async () => {
    const { calls, fn } = fakeFetch([{ body: { data: [rawCard("ic_a", "rc_a"), rawCard("ic_b")] } }]);
    const client = new StripeClient(TEST_KEY, fn);
    expect(await client.findCardForRemitCard("rc_a")).toBe("ic_a");
    expect(calls.length).toBe(1);
    expect(await client.findCardForRemitCard("rc_a")).toBe("ic_a");
    expect(calls.length).toBe(1); // cache hit, no re-list
    // unknown mapping re-lists (a just-created card must be findable) and stays null
    expect(await client.findCardForRemitCard("rc_missing")).toBeNull();
    expect(calls.length).toBe(2);
  });
});
