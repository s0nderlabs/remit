// Per-card MCP server: the tool list IS the capability surface (locked pattern).
// A pay-only card never sees `execute`; sub-cards-off never sees issue/revoke_subcard.
// Stateless: a fresh McpServer per request (cheap; no session state to corrupt).
//
// Typed refusals come back as isError:true + structured JSON so agents can explain
// themselves ("over_period_limit, remaining 3.20, resets at ...") instead of crashing.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { encodeFunctionData, parseAbi, toFunctionSelector, type Address, type Hex } from "viem";
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from "@x402/core/http";
import {
  EngineError,
  RefusalError,
  agentRevokeSubcard,
  atomsToUsdc,
  buildX402Payload,
  canonicalSelector,
  cardState,
  declaredContractScope,
  finalizeX402Charge,
  issueSubCard,
  parseAtoms,
  requirementMatchesRail,
  spend,
  usdcToAtoms,
  type CardRow,
  type CardTerms,
  type SpendDeps,
  type WireExecution,
  type X402Requirement,
} from "@remit/engine";
import type { AppDeps } from "../deps";
import { spendDeps, spendKey } from "../deps";
import { recentFiatDecision } from "../stripe/decisions";

const SERVER_INFO = { name: "remit", version: "0.14.0" };

// Surfaced to clients at initialize. Claude Code's tool search (default-on since mid-2026)
// keys discovery on this text and truncates at 2KB: keep it a compact routing guide.
const INSTRUCTIONS = [
  "remit is the agent's spending card: a scoped, revocable spending authority granted by the card owner. The connection itself is the card; it holds no funds of its own and every action is checked against the card's terms (per-payment cap, period budget, expiry, allowlists).",
  "Tools: `card` reports status, terms and remaining budget (check it before the first spend). `pay` sends USDC to a recipient or settles an x402 payment requirement. `paid_fetch` fetches an HTTP resource and pays its 402 challenge automatically. `execute` calls an allowlisted contract within the card's contract terms. `issue_subcard` mints a narrower child card for a sub-agent and returns its connection URL (treat it as a secret). `revoke_subcard` kills a child card and its descendants instantly. On fiat-linked cards, `fiat_pay` buys over Visa rails (simulated, test mode) from the same budget and `card_credentials` reveals the linked test Visa for merchant checkouts.",
  "A frozen card still answers `card` but refuses spends. Refusals name the violated term; read the message before retrying.",
].join("\n\n");

// ---------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function refused(e: RefusalError): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(e.toJSON(), null, 2) }], isError: true };
}

function failed(message: string): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ status: "error", message }, null, 2) }],
    isError: true,
  };
}

async function run(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return ok(await fn());
  } catch (e) {
    if (e instanceof RefusalError) return refused(e);
    if (e instanceof EngineError) return failed(`${e.stage}: ${e.message}`);
    return failed(e instanceof Error ? e.message : String(e));
  }
}

// ---------------------------------------------------------------------------
// The card URL minting (the server's public base for sub-card URLs)
// ---------------------------------------------------------------------------

export function cardUrl(secret: string): string {
  const base = process.env.REMIT_PUBLIC_MCP_BASE ?? `http://localhost:${process.env.PORT ?? 4070}`;
  return `${base}/c/${secret}/mcp`;
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

export function buildMcpServer(deps: AppDeps, card: CardRow): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });
  const sd: SpendDeps = spendDeps(deps);
  const now = () => Math.floor(Date.now() / 1000);
  // serialize money-moving sections per card TREE: concurrent spends of the same
  // budget must validate one-at-a-time or both can pass a read-then-write check.
  // The tree-root key is constant for this card (no reparenting): resolve it once.
  const treeKey = spendKey(deps.store, card.id);
  const locked = <T>(fn: () => Promise<T>): Promise<T> => deps.spendMutex.run(treeKey, fn);

  // ---- card (always) ----
  server.registerTool(
    "card",
    {
      title: "Card status",
      description:
        "Your spending card's terms and live state: remaining budget this period, lifetime remaining, expiry, recent charges, sub-cards. Call this first to learn what you can spend.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () =>
      run(async () => {
        const state = cardState(sd.store, card.id, now());
        const charges = sd.store.listCharges(card.id, 10).map((c) => ({
          amount: (Number(c.amount_atoms) / 1e6).toFixed(6),
          fee: (Number(c.fee_atoms) / 1e6).toFixed(6),
          to: c.to_addr,
          status: c.status,
          tx: c.tx_hash,
          memo: c.memo,
          at: c.created_at,
        }));
        return { ...state, recent_charges: charges };
      }),
  );

  // ---- pay (cards with a pay capability) ----
  if (card.terms.pay) {
    server.registerTool(
      "pay",
      {
        title: "Pay USDC",
        description:
          "Send USDC on Base to a recipient address, within this card's limits. Blocks until the payment confirms on-chain (seconds). Refusals are typed (over_period_limit, merchant_not_allowed, ...) — relay them honestly to your user. Use idempotency_key to make retries safe.",
        inputSchema: {
          to: z.string().regex(/^0x[0-9a-fA-F]{40}$/).describe("recipient address"),
          amount: z.string().regex(/^\d+(\.\d{1,6})?$/).describe("USDC amount, decimal string, e.g. \"1.50\""),
          memo: z.string().max(280).optional().describe("what this payment is for"),
          idempotency_key: z.string().max(128).optional().describe("same key -> same charge (safe retries)"),
        },
        annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
      },
      async (args: { to: string; amount: string; memo?: string; idempotency_key?: string }) =>
        run(() =>
          locked(() =>
            spend(sd, card.id, {
              kind: "pay",
              mode: "pay",
              to: args.to as Address,
              amountAtoms: usdcToAtoms(args.amount),
              memo: args.memo,
              idempotencyKey: args.idempotency_key,
            }),
          ),
        ),
    );
  }

  // ---- paid_fetch (cards with pay: the zero-x402-knowledge purchase tool) ----
  if (card.terms.pay) {
    server.registerTool(
      "paid_fetch",
      {
        title: "Fetch a paid resource",
        description:
          "Fetch a URL; if it answers 402 (x402 payment required), pay it from this card automatically and return the content. Use max_price to cap what you're willing to pay (refusal: price_exceeds_max). You need zero payment knowledge — the card handles the whole handshake.",
        inputSchema: {
          url: z.string().url().describe("the resource URL"),
          max_price: z.string().regex(/^\d+(\.\d{1,6})?$/).optional().describe("max USDC you allow for this fetch"),
        },
        annotations: { destructiveHint: true, openWorldHint: true },
      },
      async (args: { url: string; max_price?: string }) =>
        run(async () => {
          ssrfGuard(args.url);
          const first = await fetch(args.url, { redirect: "manual" });
          if (first.status !== 402) {
            return { paid: false, status: first.status, content: truncate(await first.text()) };
          }

          // parse the challenge: PAYMENT-REQUIRED header first, JSON body fallback
          let accepts: X402Requirement[] = [];
          const prHeader = first.headers.get("PAYMENT-REQUIRED") ?? first.headers.get("payment-required");
          if (prHeader) {
            accepts = (decodePaymentRequiredHeader(prHeader) as { accepts: X402Requirement[] }).accepts ?? [];
          } else {
            const body = (await first.json().catch(() => ({}))) as { accepts?: X402Requirement[] };
            accepts = body.accepts ?? [];
          }
          const req = accepts.find((r) => requirementMatchesRail(r) === null);
          if (!req) {
            throw new RefusalError(
              "invalid_terms",
              "no compatible payment option (this card pays exact/eip155:8453/USDC via erc7710)",
              { offered: accepts.map((a) => `${a.scheme}/${a.network}`).join(",") || "none" },
            );
          }
          if (args.max_price !== undefined && parseAtoms(req.amount) > usdcToAtoms(args.max_price)) {
            throw new RefusalError("price_exceeds_max", `resource costs ${atomsToUsdc(parseAtoms(req.amount))} USDC, above your max_price`, {
              price: atomsToUsdc(parseAtoms(req.amount)),
              max_price: args.max_price,
            });
          }

          // the budget check + charge reservation inside buildX402Payload must be
          // serialized with other spends of this card tree
          const { body: payload, chargeId, amountAtoms } = await locked(() => buildX402Payload(sd, card.id, req));
          const envelope = { x402Version: 2, accepted: req, payload };
          // From here the reservation is live: ANY throw before finalizeX402Charge would
          // leave the charge stuck 'pending', permanently holding budget (x402 rows are
          // invisible to the relayer reconcile sweep). A thrown retry fetch (DNS reset,
          // seller down between the 402 and the retry) must release it.
          let retry: Response;
          try {
            retry = await fetch(args.url, {
              headers: { "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(envelope as never) },
              redirect: "manual",
            });
          } catch (e) {
            finalizeX402Charge(sd.store, chargeId, "failed");
            throw new EngineError("x402", `paid retry fetch failed: ${e instanceof Error ? e.message : String(e)}`);
          }
          if (!retry.ok) {
            finalizeX402Charge(sd.store, chargeId, "failed");
            const detail = truncate(await retry.text().catch(() => ""), 500);
            throw new EngineError("x402", `seller rejected the payment (http ${retry.status}): ${detail}`);
          }

          let tx: string | null = null;
          let feeAtoms = 0n;
          const respHeader = retry.headers.get("PAYMENT-RESPONSE") ?? retry.headers.get("payment-response");
          if (respHeader) {
            try {
              const settled = decodePaymentResponseHeader(respHeader) as {
                transaction?: string;
                extensions?: { feeAtoms?: string };
              };
              tx = settled.transaction ?? null;
              feeAtoms = settled.extensions?.feeAtoms ? BigInt(settled.extensions.feeAtoms) : 0n;
            } catch {
              // malformed receipt header: treat as no receipt (settlement_unconfirmed),
              // never leak the reservation over a decode error
            }
          }
          finalizeX402Charge(sd.store, chargeId, { txHash: (tx as `0x${string}`) ?? null, feeAtoms });

          // Honesty: a settlement is only "confirmed" if the seller echoed a tx in
          // PAYMENT-RESPONSE. A bare 200 with no receipt means the seller served the
          // content but didn't prove on-chain settlement — report it as such (the
          // server-side budget is still reserved either way).
          const status = tx ? "confirmed" : "settlement_unconfirmed";
          const state = cardState(sd.store, card.id, now());
          return {
            paid: true,
            content: truncate(await retry.text()),
            receipt: {
              status,
              tx,
              amount: atomsToUsdc(amountAtoms),
              fee: atomsToUsdc(feeAtoms),
              remaining_this_period: state?.remaining_this_period ?? null,
            },
          };
        }),
    );
  }

  // ---- fiat leg (pay cards with a Stripe client wired; the Visa side is SIMULATED
  //      via test-mode Issuing, locked) ----
  if (card.terms.pay && deps.stripe) {
    const stripe = deps.stripe;

    server.registerTool(
      "fiat_pay",
      {
        title: "Pay by Visa (test mode)",
        description:
          "Make a Visa purchase with this card's linked virtual card (the fiat leg is SIMULATED: Stripe test-mode Issuing, no real merchant). The purchase is authorized in real time against the SAME budget as your crypto spends; declines carry a reason (over_period_limit, card_frozen, ...). When on-chain settlement is enabled, the approved charge settles as a real USDC transfer and the receipt carries the tx.",
        inputSchema: {
          amount: z.string().regex(/^\d+(\.\d{1,2})?$/).describe('USD amount, decimal string, e.g. "4.20"'),
          merchant: z.string().min(1).max(80).optional().describe('merchant name on the authorization (default "remit demo merchant")'),
        },
        annotations: { destructiveHint: true, openWorldHint: false },
      },
      async (args: { amount: string; merchant?: string }) =>
        run(async () => {
          // every delegation IS a card: mint the linked test Visa on first need
          const ic = await stripe.ensureCardForRemitCard(card.id);
          if (!ic) throw new RefusalError("no_fiat_card", "no test-mode Visa could be linked to this card (no cardholder on the stripe account)");
          const merchantName = args.merchant ?? "remit demo merchant";
          // USD cents (schema caps at 2 decimals, so the atoms division is exact)
          const amountCents = Number(usdcToAtoms(args.amount) / 10_000n);
          const auth = await stripe.createTestAuthorization({ cardId: ic, amountCents, merchantName });
          // the in-process webhook decided + cached during the authorization round-trip;
          // null = a DIFFERENT environment sharing this Stripe account answered instead
          const decision = recentFiatDecision(auth.id);

          let settlement: { status: string; tx?: string | null } | undefined;
          if (auth.approved && deps.fiatSettler) {
            // the webhook inserted the charge row pending; the settlement executor
            // drives that SAME row to confirmed (real USDC transfer, tx hash) or
            // settlement_unconfirmed (terminal problem; the card freezes). Poll it.
            settlement = { status: "pending" };
            const started = Date.now();
            const deadline = started + 25_000;
            for (;;) {
              const row = sd.store.chargeByIdempotency(card.id, `stripe-${auth.id}`);
              if (row && (row.status === "confirmed" || row.status === "settlement_unconfirmed")) {
                settlement = { status: row.status, tx: row.tx_hash };
                break;
              }
              // decided by another environment sharing this stripe account: no local
              // row will ever appear, so stop waiting after a grace beat
              if (!row && !decision && Date.now() - started > 3_000) break;
              if (Date.now() >= deadline) break;
              await new Promise((r) => setTimeout(r, 1_000));
            }
          }

          const state = cardState(sd.store, card.id, now());
          return {
            approved: auth.approved,
            reason: decision?.reason ?? auth.decline_reason ?? (auth.approved ? "in_budget" : "declined_upstream"),
            amount: args.amount,
            merchant: merchantName,
            authorization_id: auth.id,
            remaining_this_period: state?.remaining_this_period ?? null,
            ...(settlement ? { settlement } : {}),
            ...(decision
              ? {}
              : { note: "decision detail unavailable: the authorization was answered by a different environment sharing this stripe account" }),
          };
        }),
    );

    server.registerTool(
      "card_credentials",
      {
        title: "Card credentials (test Visa)",
        description:
          "Reveal the linked test-mode virtual Visa credentials (number, expiry, cvc) so you can check out at a merchant yourself. Treat them as secrets. Every charge made with them still authorizes in real time against this card's budget.",
        inputSchema: {},
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async () =>
        run(async () => {
          // every delegation IS a card: mint the linked test Visa on first need
          const ic = await stripe.ensureCardForRemitCard(card.id);
          if (!ic) throw new RefusalError("no_fiat_card", "no test-mode Visa could be linked to this card (no cardholder on the stripe account)");
          const det = await stripe.getCardDetails(ic, { reveal: true });
          return {
            brand: det.brand,
            number: det.number,
            exp_month: det.exp_month,
            exp_year: det.exp_year,
            cvc: det.cvc,
            cardholder_name: det.cardholder_name,
            last4: det.last4,
            note: "stripe test-mode card: works only against this stripe account's test environment",
          };
        }),
    );
  }

  // ---- execute (cards with contract scope ONLY) ----
  if (card.terms.contract) {
    server.registerTool(
      "execute",
      {
        title: "Execute scoped contract calls",
        description:
          "Run one or more contract calls allowed by this card's scope, atomically in one redemption (e.g. approve + swap). Targets and methods outside the card's scope are refused. Pass simple calls as method + args (the server encodes calldata); pass complex calls (tuple/array/multicall args, e.g. Uniswap exactInputSingle) as raw `data` (the 4-byte selector is still checked against the allowlist). ERC-20 allowance calls (approve/increaseAllowance) are extra-gated: the spender must be in the card's scope, the token must be on the card's token list (when one is set), USDC allowances respect perTradeMax (per_trade_exceeded), and every allowance is pinned on-chain to the exact spender + amount you requested. Calls carry no native ETH value (value is 0).",
        inputSchema: {
          calls: z
            .array(
              z.object({
                target: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
                method: z.string().optional().describe('human signature, e.g. "approve(address,uint256)". Omit when passing raw `data`.'),
                args: z
                  .array(z.union([z.string(), z.number(), z.boolean()]))
                  .optional()
                  .describe("positional args for `method`; uint256 as decimal strings. Flat scalars only; for tuple/array/bytes args use `data`."),
                data: z
                  .string()
                  .regex(/^0x([0-9a-fA-F]{2}){4,}$/)
                  .optional()
                  .describe("raw ABI-encoded calldata (whole-byte, >= 4-byte selector) for complex methods. Selector is checked against the card's allowlist. Use instead of method + args."),
              }),
            )
            .min(1)
            .max(5),
          memo: z.string().max(280).optional(),
          idempotency_key: z.string().max(128).optional(),
        },
        annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
      },
      async (args: { calls: Array<{ target: string; method?: string; args?: Array<string | number | boolean>; data?: string }>; memo?: string; idempotency_key?: string }) =>
        run(() =>
          locked(() => {
            const executions = args.calls.map((call) => encodeScopedCall(card.terms, call));
            return spend(sd, card.id, {
              kind: "execute",
              mode: "contract",
              workExecutions: executions,
              memo: args.memo,
              idempotencyKey: args.idempotency_key,
            });
          }),
        ),
    );
  }

  // ---- sub-cards ----
  if (card.terms.subcards !== false) {
    server.registerTool(
      "issue_subcard",
      {
        title: "Issue a sub-card",
        description:
          "Mint a tighter child card for a sub-agent. Terms must fit inside this card's (exceeds_parent_terms names the violating field); omitted money terms inherit this card's remaining budget. Returns the sub-card's connection URL — hand it to the sub-agent; treat it as a secret.",
        inputSchema: {
          name: z.string().min(1).max(80).describe("label shown in the owner's dashboard"),
          terms: z
            .object({
              pay: z
                .object({
                  period: z.object({ amount: z.string(), seconds: z.number().int().min(60) }).optional(),
                  lifetime: z.object({ amount: z.string() }).optional(),
                })
                .optional(),
              contract: z
                .object({
                  targets: z.array(z.string().regex(/^0x[0-9a-fA-F]{40}$/)).min(1),
                  selectors: z.array(z.string()).min(1),
                  tokens: z
                    .array(z.string().regex(/^0x[0-9a-fA-F]{40}$/))
                    .min(1)
                    .optional()
                    .describe("ERC-20 tokens the child may grant allowances on; must be a subset of this card's list when one is set"),
                  perTradeMax: z.string().optional().describe("per-allowance USDC ceiling for the child; <= this card's"),
                })
                .optional()
                .describe("contract scope for the child; targets AND selectors must be a SUBSET of this card's"),
              expiry: z.number().int().optional(),
              maxUses: z.number().int().min(1).optional(),
              perTxMax: z.string().optional(),
              merchants: z.array(z.string().regex(/^0x[0-9a-fA-F]{40}$/)).optional(),
              subcards: z.boolean().optional(),
            })
            .describe("child terms; every field must be <= this card's"),
        },
        annotations: { openWorldHint: false },
      },
      async (args: { name: string; terms: unknown }) =>
        run(async () => {
          const issued = await issueSubCard({ store: sd.store }, {
            parentCardId: card.id,
            name: args.name,
            terms: args.terms as CardTerms, // zod validated the shape; engine re-validates semantics
          });
          // eager mint, fire-and-forget: the sub-card is a two-rail card from birth
          if (deps.stripe) void deps.stripe.ensureCardForRemitCard(issued.cardId).catch(() => {});
          return { card_id: issued.cardId, card_url: cardUrl(issued.secret), terms: issued.terms };
        }),
    );

    server.registerTool(
      "revoke_subcard",
      {
        title: "Revoke a sub-card",
        description:
          "Kill a sub-card you issued (and its descendants): the server stops honoring it instantly and its URL dies. Descendants only — not_your_subcard otherwise.",
        inputSchema: {
          card_id: z.string().describe("the sub-card's id (from issue_subcard or card)"),
        },
        annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
      },
      async (args: { card_id: string }) =>
        run(async () => {
          agentRevokeSubcard(sd.store, card.id, args.card_id);
          return { status: "revoked", card_id: args.card_id };
        }),
    );
  }

  return server;
}

// ---------------------------------------------------------------------------
// execute encoding: structured call -> calldata, scope-checked for typed refusals
// (the chain enforces the same scope again via the leaf + root caveats)
// ---------------------------------------------------------------------------

function encodeScopedCall(
  terms: CardTerms,
  call: { target: string; method?: string; args?: Array<string | number | boolean>; data?: string },
): WireExecution {
  // Validate against the DECLARED scope (NOT the fee-safe one that unions in USDC +
  // transfer for the fee leg) so a card scoped to e.g. Uniswap can't call USDC.transfer.
  // Declared selectors are already canonical (validateTerms normalizes at issue time).
  const scope = declaredContractScope(terms.contract!);
  if (!scope.targets.some((t) => t.toLowerCase() === call.target.toLowerCase())) {
    throw new RefusalError("target_not_allowed", `target ${call.target} is outside the card's scope`, {
      target: call.target,
    });
  }
  if (call.data !== undefined && (call.method !== undefined || call.args !== undefined)) {
    throw new RefusalError("invalid_terms", "pass either method + args or raw data, not both");
  }
  let data: Hex;
  if (call.data !== undefined) {
    // raw calldata path (tuple/array/multicall args): enforce the method allowlist via
    // the canonical 4-byte selector. The on-chain allowedMethods enforcer checks it again.
    const selector = call.data.slice(0, 10).toLowerCase();
    const allowed = scope.selectors.some((s) => {
      try {
        return toFunctionSelector(canonicalSelector(s)).toLowerCase() === selector;
      } catch {
        return false;
      }
    });
    if (!allowed) {
      throw new RefusalError("method_not_allowed", `selector ${selector} is outside the card's scope`, { selector });
    }
    data = call.data as Hex;
  } else {
    if (!call.method) {
      throw new RefusalError("invalid_terms", "each call needs either method + args or raw data");
    }
    // canonicalize the requested method so "withdraw(uint)" matches a stored "withdraw(uint256)"
    const wanted = canonicalSelector(call.method);
    const sig = scope.selectors.find((s) => s === wanted);
    if (!sig) {
      throw new RefusalError("method_not_allowed", `method ${call.method} is outside the card's scope`, {
        method: call.method,
      });
    }
    try {
      // dynamic signature string -> viem's template-literal abi type collapses; runtime is fine
      const abi = parseAbi([`function ${sig}`] as never) as import("viem").Abi;
      const functionName = sig.slice(0, sig.indexOf("("));
      data = encodeFunctionData({
        abi,
        functionName,
        args: (call.args ?? []).map(coerceAbiArg) as never,
      });
    } catch (e) {
      throw new RefusalError("invalid_terms", `could not encode ${call.method}: ${e instanceof Error ? e.message : e}`);
    }
  }
  // Contract calls carry no native ETH value: the carved leaf's FunctionCall scope
  // caps value at 0 on-chain (SDK default), so payable-with-value is a v2 item.
  return { target: call.target as Address, value: "0", data };
}

function coerceAbiArg(v: string | number | boolean): unknown {
  if (typeof v === "string" && /^\d+$/.test(v)) return BigInt(v); // uint as decimal string
  return v;
}

// ---------------------------------------------------------------------------
// paid_fetch helpers
// ---------------------------------------------------------------------------

function truncate(s: string, max = 50_000): string {
  return s.length > max ? s.slice(0, max) + `\n...[truncated ${s.length - max} chars]` : s;
}

function parseIpv4(s: string): number[] | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : -1));
  if (nums.some((n) => n < 0 || n > 255)) return null;
  return nums;
}

function ipv4IsPrivate(o: number[]): boolean {
  const a = o[0]!;
  const b = o[1]!;
  return (
    a === 0 || // 0.0.0.0/8 "this host"
    a === 127 || // loopback
    a === 10 || // RFC1918
    (a === 192 && b === 168) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 169 && b === 254) || // link-local incl. 169.254.169.254 cloud metadata
    (a === 100 && b >= 64 && b <= 127) // CGNAT 100.64/10
  );
}

/** Expand an IPv6 literal (no brackets) to its 8 16-bit groups, handling :: and an
 * embedded dotted-quad IPv4 tail (e.g. ::ffff:127.0.0.1). Returns null if malformed. */
function expandIpv6(input: string): number[] | null {
  let s = input.toLowerCase();
  const dot = s.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dot) {
    const v4 = parseIpv4(dot[1]!);
    if (!v4) return null;
    const g1 = ((v4[0]! << 8) | v4[1]!).toString(16);
    const g2 = ((v4[2]! << 8) | v4[3]!).toString(16);
    s = s.slice(0, dot.index) + g1 + ":" + g2;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const groups = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    for (const g of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  if (halves.length === 1) {
    const g = groups(s);
    return g && g.length === 8 ? g : null;
  }
  const head = groups(halves[0]!);
  const tail = groups(halves[1]!);
  if (!head || !tail) return null;
  const fill = 8 - head.length - tail.length;
  if (fill < 0) return null;
  return [...head, ...new Array(fill).fill(0), ...tail];
}

function ipv6IsPrivate(h: number[]): boolean {
  // ::/128 unspecified and ::1/128 loopback
  if (h.slice(0, 7).every((x) => x === 0) && (h[7] === 0 || h[7] === 1)) return true;
  if ((h[0]! & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((h[0]! & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
  // IPv4-mapped ::ffff:a.b.c.d and IPv4-compatible ::a.b.c.d -> classify the embedded v4
  if (h.slice(0, 5).every((x) => x === 0) && (h[5] === 0xffff || h[5] === 0)) {
    return ipv4IsPrivate([h[6]! >> 8, h[6]! & 0xff, h[7]! >> 8, h[7]! & 0xff]);
  }
  return false;
}

/** True for any host that resolves to a loopback/private/link-local/ULA/metadata target.
 * The WHATWG URL parser canonicalizes numeric IPv4 forms (decimal/octal/hex) to dotted
 * decimal, so url.hostname is already normalized before we get here. */
function hostIsPrivate(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h.endsWith(".internal") || h.endsWith(".local")) return true;
  if (h.startsWith("[") && h.endsWith("]")) {
    const v6 = expandIpv6(h.slice(1, -1));
    return v6 ? ipv6IsPrivate(v6) : true; // unparseable bracketed literal: fail safe
  }
  const v4 = parseIpv4(h);
  if (v4) return ipv4IsPrivate(v4);
  return false; // a regular DNS name (DNS-rebinding is out of scope for this guard)
}

/** SSRF guard on agent-supplied URLs: https only (or http to allowed dev hosts),
 * no private/loopback/link-local targets unless REMIT_PAID_FETCH_ALLOW_LOCAL=1 (dev). */
function ssrfGuard(rawUrl: string): void {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new RefusalError("invalid_terms", "malformed URL");
  }
  const allowLocal = process.env.REMIT_PAID_FETCH_ALLOW_LOCAL === "1";
  if (url.protocol !== "https:" && !(allowLocal && url.protocol === "http:")) {
    throw new RefusalError("invalid_terms", "only https URLs are fetchable");
  }
  if (hostIsPrivate(url.hostname) && !allowLocal) {
    throw new RefusalError("invalid_terms", "private-network URLs are not fetchable");
  }
}
