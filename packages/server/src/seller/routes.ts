// Demo seller: a tiny x402-protected resource whose 402 challenge points at OUR
// facilitator. Spec-exact v2 headers via @x402/core codecs. The "content" is a small
// premium dataset the demo agent buys.
//
// Flow: GET /demo/premium-data
//   no PAYMENT-SIGNATURE  -> 402 + PAYMENT-REQUIRED header (+ JSON body for humans)
//   with PAYMENT-SIGNATURE -> verify + settle via the facilitator -> 200 + content
//                             + PAYMENT-RESPONSE header

import { Hono } from "hono";
import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from "@x402/core/http";
import { CHAINS, caip2For } from "@remit/engine";
import type { AppDeps } from "../deps";

const PRICE_ATOMS = "10000"; // 0.01 USDC

export function sellerRoutes(deps: AppDeps, facilitatorBase: () => string): Hono {
  const app = new Hono();

  const payTo = () => process.env.REMIT_SELLER_PAYTO ?? "0xAc36D18d2315c8c1F6e93B9074D3C25e2DC14127";

  const requirement = () => ({
    scheme: "exact",
    network: caip2For(8453),
    amount: PRICE_ATOMS,
    asset: CHAINS[8453].usdc,
    payTo: payTo(),
    maxTimeoutSeconds: 120,
    extra: {
      assetTransferMethod: "erc7710",
      // USDC EIP-712 domain on Base MAINNET (never hardcode client-side; read from here)
      name: "USD Coin",
      version: "2",
    },
  });

  app.get("/demo/premium-data", async (c) => {
    const url = new URL(c.req.url).origin + "/demo/premium-data";
    const sigHeader = c.req.header("payment-signature") ?? c.req.header("PAYMENT-SIGNATURE");

    if (!sigHeader) {
      const paymentRequired = {
        x402Version: 2 as const,
        resource: { url, description: "remit demo: premium agent dataset", mimeType: "application/json" },
        accepts: [requirement()],
      };
      c.header("PAYMENT-REQUIRED", encodePaymentRequiredHeader(paymentRequired as never));
      return c.json({ error: "payment required", accepts: [requirement()] }, 402);
    }

    let paymentPayload: unknown;
    try {
      paymentPayload = decodePaymentSignatureHeader(sigHeader);
    } catch {
      return c.json({ error: "malformed PAYMENT-SIGNATURE header" }, 400);
    }

    // verify + settle through OUR facilitator (same process, real HTTP semantics preserved)
    const fac = facilitatorBase();
    const verifyRes = await fetch(`${fac}/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ x402Version: 2, paymentPayload, paymentRequirements: requirement() }),
    });
    const verdict = (await verifyRes.json()) as { isValid: boolean; invalidReason?: string };
    if (!verdict.isValid) {
      return c.json({ error: `payment invalid: ${verdict.invalidReason}` }, 402);
    }

    const settleRes = await fetch(`${fac}/settle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ x402Version: 2, paymentPayload, paymentRequirements: requirement() }),
    });
    const settlement = (await settleRes.json()) as {
      success: boolean;
      transaction: string;
      errorMessage?: string;
      extensions?: Record<string, unknown>;
    };
    if (!settlement.success) {
      return c.json({ error: `settlement failed: ${settlement.errorMessage}` }, 402);
    }

    c.header("PAYMENT-RESPONSE", encodePaymentResponseHeader(settlement as never));
    return c.json({
      dataset: "premium-agent-dataset-v1",
      rows: [
        { pair: "ETH/USDC", signal: "accumulate", confidence: 0.83 },
        { pair: "BASE/USDC", signal: "hold", confidence: 0.61 },
      ],
      paid_tx: settlement.transaction,
    });
  });

  return app;
}
