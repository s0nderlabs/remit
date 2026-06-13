// The NL -> CardTerms compiler. Venice is the NL brain ONLY: it turns the user's request
// into a PLAN of named entities + numeric params. Every address resolution and the final
// CardTerms assembly is deterministic server code keyed off the trusted resolvers, so a
// model-supplied address can never reach a draft (address-poisoning surface = zero).
//
// Output is always a DRAFT: it prefills the composer, the user reviews labeled entities
// (never raw hex), then signs through the normal issuance flow. The compiler never issues.
//
// v1 wall: native-ETH value (buy-NFT-for-0.1-ETH style clauses) is NOT expressible — the
// contract lane is value:0 (deferred to v2). Such clauses come back as warnings, not terms.

import { isAddress, type Address } from "viem";
import { validateTerms, usdcToAtoms, type CardTerms, RefusalError } from "@remit/engine";
import { APPROVE_SIG } from "@remit/engine";

/** Same shape money.ts accepts: decimal dollars, max 6 decimals. Model-emitted
 * amounts are screened through this before any comparison so a garbled value can
 * never win a tightest-cap selection via NaN. */
const USD_AMOUNT_RE = /^\d+(?:\.\d{1,6})?$/;
import type { ChatFn } from "./client";
import { extractJson } from "./client";
import type { ResolvedEntity, Resolvers } from "./resolvers";

// ---------------------------------------------------------------------------
// The plan the model emits (named entities + numbers; NEVER trusted for addresses)
// ---------------------------------------------------------------------------

type PlanPeriod = { amount: string; unit: "day" | "week" | "month" };
type Plan = {
  pay?: { period?: PlanPeriod | null; lifetime?: { amount: string } | null; perTx?: string | null } | null;
  expiryDays?: number | null;
  maxUses?: number | null;
  merchants?: string[] | null; // names OR raw addresses
  swaps?: Array<{ protocol: string; sell?: string | null; buy?: string | null; perTradeMax?: string | null }> | null;
  contracts?: Array<{ target: string; methods: string[] }> | null; // user-named contract addresses
  subcards?: boolean | null;
  unsupported?: string[] | null;
};

const UNIT_SECONDS: Record<PlanPeriod["unit"], number> = { day: 86400, week: 604800, month: 2592000 };

export type CompileResult = {
  /** the prefilled draft, or null if nothing expressible survived */
  draft: CardTerms | null;
  /** every resolved entity, for a labeled (non-hex) review UI */
  labels: ResolvedEntity[];
  /** clauses we could not express (unresolved names, v2 features) — shown to the user */
  warnings: string[];
};

const SYSTEM_PROMPT = `You translate a natural-language spending-card request into a STRICT JSON plan.
You do NOT output blockchain addresses unless the user typed one verbatim. You name tokens
and protocols by NAME; the server resolves names to verified addresses itself.

Output ONLY a JSON object with this shape (omit fields that don't apply):
{
  "pay": { "period": {"amount":"10","unit":"week"} , "lifetime": {"amount":"100"}, "perTx": "5" },
  "expiryDays": 30,
  "maxUses": 5,
  "merchants": ["0x...", "merchant name"],
  "swaps": [
    {"protocol":"Uniswap","sell":"USDC","buy":"WETH","perTradeMax":"50"},
    {"protocol":"Aave","sell":"USDC"}
  ],
  "contracts": [ {"target":"0x...","methods":["approve(address,uint256)"]} ],
  "subcards": true,
  "unsupported": ["a clause you TRULY cannot express, e.g. spending native ETH or buying NFTs"]
}
Rules:
- Amounts are decimal strings in the token's units (USDC dollars).
- "period.unit" is one of day | week | month.
- "swaps" scopes interactions with a KNOWN protocol. The known protocols are exactly:
  Uniswap (token swaps) and Aave (supply / lend / deposit, withdraw, borrow, repay). Put EVERY
  known-protocol action here, one entry each, even when the user asks for several at once:
    * swap / trade X to Y    -> {"protocol":"Uniswap","sell":"X","buy":"Y"}  (sell = token spent)
    * supply / lend / deposit X -> {"protocol":"Aave","sell":"X"}            (sell = token supplied)
  Use the protocol's real name. The server scopes that protocol's allowed methods itself.
  Uniswap and Aave are SUPPORTED — NEVER put them, or a swap/supply on them, in "unsupported".
- If the user states a per-trade or per-swap cap, ALWAYS set "perTradeMax" to that amount on the
  swap entry (decimal string). The server enforces it when the spent ("sell") token is USDC and, when
  the sell token is not USDC, drops it with a warning so the user is told it could not be applied.
- Use "contracts" ONLY when the user gives an explicit contract address (0x...).
- If the user restricts payments to a payee NAMED in words (e.g. "my coffee shop") rather than an
  address, still list that name in "merchants"; the server tells the user it cannot lock to a name
  without the payee's 0x address.
- Put a clause in "unsupported" ONLY when it needs spending native ETH (value), buying/minting NFTs,
  bridging to another chain, staking, or a protocol that is NOT Uniswap or Aave. A known protocol is
  never unsupported.
- Capture EVERY limit the user states — period, lifetime, per-payment / per-tx (perTx), expiry,
  max uses, merchant, per-trade cap. Never drop one they asked for. At the same time, do NOT ADD a
  limit they did not state (no default perTx, expiry, or maxUses). Include all stated limits, invent none.
- Return RAW JSON only — no prose, no markdown code fences.`;

/** Run the NL -> plan -> resolve -> assemble pipeline. `chat` is injectable (tests fake it).
 * Retries ONCE when the first pass fails to parse or garbles a name (the model occasionally
 * corrupts a token like "uniswap" -> a junk string; a clean re-roll usually fixes it). The
 * retry never relaxes the safety boundary — addresses still come only from resolvers/user. */
export async function compileIntent(
  intent: string,
  deps: { chat: ChatFn; resolvers: Resolvers; now?: () => number },
): Promise<CompileResult> {
  const now = deps.now ? deps.now() : Math.floor(Date.now() / 1000);

  const attempt = async (): Promise<CompileResult> => {
    const raw = await deps.chat([
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: intent },
    ]);
    const plan = extractJson(raw) as Plan; // throws on no JSON; caught below for the retry
    return assemble(plan, intent, deps.resolvers, now);
  };

  // a resolution-failure warning ("couldn't resolve protocol/token") signals a garbled
  // name worth one re-roll; a clean unsupported-only result is NOT retried.
  const garbled = (r: CompileResult) => r.warnings.some((w) => w.includes("couldn't resolve"));

  let first: CompileResult | null = null;
  try {
    first = await attempt();
    if (!garbled(first)) return first;
  } catch (e) {
    // the chat client already retries transient timeouts internally; if a timeout still
    // surfaces here the upstream is genuinely unavailable, so don't burn a second full
    // retry cycle (which would blow past the dashboard's compile budget) — surface it.
    if (e instanceof Error && /no response within/.test(e.message)) {
      throw new RefusalError("invalid_terms", `the compiler is busy right now (model did not respond): ${e.message}`);
    }
    // otherwise a parse/garble failure: fall through to the single retry
  }
  try {
    const second = await attempt();
    // prefer whichever produced a draft; else the one with fewer warnings
    if (!first) return second;
    if (second.draft && !first.draft) return second;
    if (!second.draft && first.draft) return first;
    return second.warnings.length <= first.warnings.length ? second : first;
  } catch (e) {
    if (first) return first;
    throw new RefusalError("invalid_terms", `could not parse a plan from the model: ${e instanceof Error ? e.message : e}`);
  }
}

// Addresses the user literally typed in their request — the ONLY raw addresses we trust
// besides resolver output. A plan address absent from this set was invented by the model.
function userTypedAddresses(intent: string): Set<string> {
  const out = new Set<string>();
  for (const m of intent.matchAll(/0x[0-9a-fA-F]{40}/g)) out.add(m[0]!.toLowerCase());
  return out;
}

export async function assemble(
  plan: Plan,
  intent: string,
  resolvers: Resolvers,
  now: number,
): Promise<CompileResult> {
  const warnings: string[] = [];
  const labels: ResolvedEntity[] = [];
  const typed = userTypedAddresses(intent);
  const draft: CardTerms = {};

  // --- pay ---
  if (plan.pay) {
    const pay: NonNullable<CardTerms["pay"]> = {};
    if (plan.pay.period && plan.pay.period.amount) {
      const seconds = UNIT_SECONDS[plan.pay.period.unit];
      if (seconds) pay.period = { amount: String(plan.pay.period.amount), seconds };
      else warnings.push(`unrecognized period unit "${plan.pay.period.unit}"`);
    }
    if (plan.pay.lifetime?.amount) pay.lifetime = { amount: String(plan.pay.lifetime.amount) };
    if (pay.period || pay.lifetime) draft.pay = pay;
    if (plan.pay.perTx) draft.perTxMax = String(plan.pay.perTx);
  }

  // --- expiry / maxUses / subcards ---
  if (typeof plan.expiryDays === "number" && plan.expiryDays > 0) {
    draft.expiry = now + Math.floor(plan.expiryDays * 86400);
  }
  if (typeof plan.maxUses === "number" && plan.maxUses >= 1) draft.maxUses = Math.floor(plan.maxUses);
  if (typeof plan.subcards === "boolean") draft.subcards = plan.subcards;

  // --- merchants (pay recipients): addresses only; names can't be safely resolved ---
  if (plan.merchants?.length) {
    const merchants: Address[] = [];
    for (const m of plan.merchants) {
      if (isAddress(m)) {
        if (!typed.has(m.toLowerCase())) {
          warnings.push(`ignored a merchant address the request didn't contain (${m.slice(0, 10)}...)`);
          continue;
        }
        merchants.push(m as Address);
        const v = await resolvers.verifiedContract(m);
        labels.push(v ?? { query: m, address: m as Address, label: "merchant", kind: "raw_address", source: "user_input" });
      } else {
        warnings.push(`couldn't resolve merchant "${m}" to an address — add its address to lock to it`);
      }
    }
    if (merchants.length) draft.merchants = merchants;
  }

  // --- swaps + explicit contracts merge into ONE contract scope ---
  const targets = new Set<string>();
  const selectors = new Set<string>();
  const tokens = new Set<string>();
  let perTradeMax: string | undefined;
  let haveContract = false;

  const usdcAddr = resolvers.token("USDC")?.address.toLowerCase();
  for (const swap of plan.swaps ?? []) {
    const proto = resolvers.protocol(swap.protocol);
    if (!proto) {
      warnings.push(`couldn't resolve protocol "${swap.protocol}" — only known protocols can be scoped`);
      continue;
    }
    haveContract = true;
    targets.add(proto.entity.address.toLowerCase());
    labels.push(proto.entity);
    for (const s of proto.selectors) selectors.add(s);
    selectors.add(APPROVE_SIG);
    // the SELL token is the one approved/spent; resolve both legs for labels
    let sellIsUsdc = false;
    for (const leg of [swap.sell, swap.buy]) {
      if (!leg) continue;
      const tok = resolvers.token(leg);
      if (!tok) {
        warnings.push(`couldn't resolve token "${leg}" — only listed tokens can be scoped`);
        continue;
      }
      targets.add(tok.address.toLowerCase());
      labels.push(tok);
      if (leg === swap.sell) {
        tokens.add(tok.address.toLowerCase());
        if (tok.address.toLowerCase() === usdcAddr) sellIsUsdc = true;
      }
    }
    if (swap.perTradeMax) {
      const cap = String(swap.perTradeMax).trim();
      if (!USD_AMOUNT_RE.test(cap)) {
        warnings.push(`ignored unparseable per-trade max "${swap.perTradeMax}"`);
      } else if (!sellIsUsdc) {
        // the engine's per-trade gate enforces on USDC allowances only (v1); a cap on a
        // non-USDC sell leg would show in the review UI without ever enforcing
        warnings.push(`dropped the ${cap} per-trade cap: v1 enforces per-trade caps on USDC sell legs only`);
      } else if (perTradeMax === undefined || usdcToAtoms(cap) < usdcToAtoms(perTradeMax)) {
        perTradeMax = cap;
      }
    }
  }

  for (const ct of plan.contracts ?? []) {
    if (!isAddress(ct.target) || !typed.has(ct.target.toLowerCase())) {
      warnings.push(`ignored a contract clause with no user-supplied address`);
      continue;
    }
    if (!ct.methods?.length) {
      warnings.push(`contract ${ct.target.slice(0, 10)}... had no methods to scope`);
      continue;
    }
    haveContract = true;
    targets.add(ct.target.toLowerCase());
    for (const s of ct.methods) selectors.add(s);
    const v = await resolvers.verifiedContract(ct.target);
    labels.push(v ?? { query: ct.target, address: ct.target as Address, label: "contract", kind: "raw_address", source: "user_input" });
  }

  if (haveContract && targets.size && selectors.size) {
    draft.contract = {
      targets: [...targets] as Address[],
      selectors: [...selectors],
      ...(tokens.size ? { tokens: [...tokens] as Address[] } : {}),
      ...(perTradeMax !== undefined ? { perTradeMax } : {}),
    };
  }

  for (const u of plan.unsupported ?? []) {
    warnings.push(`not expressible in v1 (needs native-value/NFT support, coming later): "${u}"`);
  }

  // nothing expressible -> no draft, only warnings
  if (!draft.pay && !draft.contract) {
    return { draft: null, labels, warnings: warnings.length ? warnings : ["couldn't turn this request into any card terms"] };
  }

  // validate the assembled draft; an invalid one is surfaced as a warning, not thrown,
  // so the user still sees the labels + what went wrong (the composer stays editable)
  try {
    validateTerms(draft, now);
  } catch (e) {
    const msg = e instanceof RefusalError ? e.message : String(e);
    return { draft: null, labels, warnings: [...warnings, `the drafted terms didn't validate: ${msg}`] };
  }

  // dedupe labels by address (a token can appear as both a target and a swap leg)
  const seen = new Set<string>();
  const dedupedLabels = labels.filter((l) => {
    const k = l.address.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  return { draft, labels: dedupedLabels, warnings };
}
