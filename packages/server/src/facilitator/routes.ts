// THE FIRST erc7710 x402 facilitator (verified claim: as of Jun 6 2026, no shipped
// facilitator settles the spec'd erc7710 assetTransferMethod — 1Shot's own hosted
// /supported returns {"kinds":[]}). REST per x402: POST /verify, POST /settle,
// GET /supported. Settlement rail: the 1Shot Public Relayer (gasless, USDC fee).
//
// Portability rule: fetch + WebCrypto only in this module's own logic.

import { Hono } from "hono";
import {
  caip2For,
  settleX402,
  verifyX402,
  EngineError,
  type X402PayloadBody,
  type X402Requirement,
} from "@remit/engine";
import type { AppDeps } from "../deps";

const X402_VERSION = 2;

type WireRequest = {
  x402Version?: number;
  paymentPayload?: {
    x402Version?: number;
    accepted?: X402Requirement;
    payload?: Record<string, unknown>;
  };
  paymentRequirements?: X402Requirement;
};

function extract(body: WireRequest): { payload: X402PayloadBody; req: X402Requirement } | { error: string } {
  const req = body.paymentRequirements ?? body.paymentPayload?.accepted;
  const raw = body.paymentPayload?.payload;
  if (!req) return { error: "missing paymentRequirements" };
  if (!raw) return { error: "missing paymentPayload.payload" };
  const { delegationManager, permissionContext, delegator } = raw as Record<string, string>;
  if (!delegationManager || !permissionContext || !delegator) {
    return { error: "payload must carry {delegationManager, permissionContext, delegator}" };
  }
  return {
    payload: {
      delegationManager: delegationManager as never,
      permissionContext: permissionContext as never,
      delegator: delegator as never,
    },
    req,
  };
}

export function facilitatorRoutes(deps: AppDeps): Hono {
  const app = new Hono();
  const settleDeps = () => ({
    relayer: deps.relayer,
    feeJitter: deps.spendOverrides?.feeJitter,
    confirmViaChain: deps.spendOverrides?.confirmViaChain,
    codeCheck: deps.spendOverrides?.codeCheck,
  });

  app.get("/supported", (c) =>
    c.json({
      kinds: [
        {
          x402Version: X402_VERSION,
          scheme: "exact",
          network: caip2For(8453),
          extra: {
            assetTransferMethods: ["erc7710"],
            rail: "1shot-public-relayer",
            feeToken: "USDC",
            note: "settles ERC-7710 delegation payments via relayer.1shotapi.com; leaf delegate must be the relayer target",
          },
        },
      ],
      extensions: [],
      signers: {},
    }),
  );

  app.post("/verify", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as WireRequest;
    const parsed = extract(body);
    if ("error" in parsed) return c.json({ isValid: false, invalidReason: parsed.error }, 400);
    try {
      const result = await verifyX402(settleDeps(), parsed.payload, parsed.req);
      return c.json(result);
    } catch (e) {
      return c.json({ isValid: false, invalidReason: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  app.post("/settle", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as WireRequest;
    const parsed = extract(body);
    if ("error" in parsed) {
      return c.json({ success: false, errorReason: "invalid_request", errorMessage: parsed.error, transaction: "", network: "" }, 400);
    }
    try {
      const result = await settleX402(settleDeps(), parsed.payload, parsed.req);
      return c.json({
        success: true,
        transaction: result.txHash ?? "",
        network: parsed.req.network,
        payer: result.payer,
        extensions: { feeAtoms: result.feeAtoms.toString() },
      });
    } catch (e) {
      const message = e instanceof EngineError ? `${e.stage}: ${e.message}` : e instanceof Error ? e.message : String(e);
      return c.json({ success: false, errorReason: "settle_failed", errorMessage: message, transaction: "", network: parsed.req.network }, 502);
    }
  });

  return app;
}
