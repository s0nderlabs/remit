// Dashboard API client. AUTH: every call carries the user's Privy access token; the
// server verifies it against the app JWKS and scopes every route to the authenticated
// user (no shared admin token in the browser, ever). IDENTITY: the Privy embedded
// wallet address is the userId (one user row per wallet, bound to the Privy DID at
// onboard), and issuance is CLIENT-signed (onboard -> prepare -> sign -> finalize).

import { getAccessToken } from "@privy-io/react-auth";

const BASE = process.env.NEXT_PUBLIC_REMIT_API ?? "http://localhost:4070/api";

type Hex = `0x${string}`;
type Wire7702Auth = { chainId: Hex; address: Hex; nonce: Hex; yParity: Hex; r: Hex; s: Hex };
export type WireDelegation = {
  delegator: Hex;
  delegate: Hex;
  authority: Hex;
  caveats: { enforcer: Hex; terms: Hex; args: Hex }[];
  salt: Hex;
  signature: Hex;
};

// Nothing in the boot path may await forever: a wedged token refresh (stale
// session on iOS Safari, in-app browsers) or a stalled connection must surface
// as an error the UI can show, never an infinite "Loading…".
const TOKEN_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 20_000;

async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const gate = new Promise<never>((_, reject) => {
    t = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
  });
  try {
    return await Promise.race([p, gate]);
  } finally {
    clearTimeout(t);
  }
}

/** AbortSignal.timeout where it exists; a hand-rolled controller for older WebKit */
function timeoutSignal(ms: number): AbortSignal | undefined {
  if (typeof AbortSignal !== "undefined" && "timeout" in AbortSignal) return AbortSignal.timeout(ms);
  if (typeof AbortController === "undefined") return undefined;
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(new DOMException("request timed out", "TimeoutError")), ms);
  return ctl.signal;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  // refreshes if near expiry; null when logged out
  const token = await withTimeout(getAccessToken(), TOKEN_TIMEOUT_MS, "session token");
  if (!token) throw new Error("not signed in");
  const signal = init?.signal ?? timeoutSignal(REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      signal,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...init?.headers,
      },
      cache: "no-store",
    });
  } catch (e) {
    if (e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError")) {
      throw new Error("request timed out");
    }
    throw e;
  }
  // a non-JSON ERROR body (edge/proxy HTML on 502/503) falls back to the status
  // line; a malformed or cut-off body on a 2xx must SURFACE, never return null-as-T
  let body: { message?: string; error?: string } | null = null;
  try {
    body = (await res.json()) as { message?: string; error?: string } | null;
  } catch (e) {
    if (res.ok) {
      if (e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError")) {
        throw new Error("request timed out");
      }
      throw new Error("malformed response body");
    }
  }
  if (!res.ok) throw new Error(body?.message ?? body?.error ?? `http ${res.status}`);
  return body as T;
}

export type ContractTermsInput = {
  targets: string[];
  selectors: string[];
  /** ERC-20 tokens the card may grant allowances on (#42). Unioned into targets server-side. */
  tokens?: string[];
  /** per-allowance USDC ceiling (#42). */
  perTradeMax?: string;
};

export type CardTermsInput = {
  pay?: { period?: { amount: string; seconds: number }; lifetime?: { amount: string } };
  /** contract scope: enables the agent's `execute` tool surface (swaps, approvals, calls). */
  contract?: ContractTermsInput;
  expiry?: number;
  maxUses?: number;
  perTxMax?: string;
  merchants?: string[];
  subcards?: boolean;
};

/** A resolved entity in a compiled draft: a human label + provenance for an address the
 * user reviews instead of raw hex (#43). */
export type CompileLabel = {
  query: string;
  address: string;
  label: string;
  kind: "token" | "protocol" | "verified_contract" | "raw_address";
  source: "registry" | "basescan" | "user_input";
  decimals?: number;
};

export type CompileResult = {
  draft: CardTermsInput | null;
  labels: CompileLabel[];
  warnings: string[];
};

export type CardState = {
  card_id: string;
  name: string;
  status: string;
  terms: CardTermsInput;
  remaining_this_period: string | null;
  remaining_lifetime: string | null;
  period_resets_at: number | null;
  expires_at: number | null;
  uses_remaining: number | null;
  subcards: string[];
  parent_card_id?: string | null;
  created_at?: number;
};

export type TreeNode = { card: CardState; children: TreeNode[] };

export type Charge = {
  id: string;
  kind: string;
  to: string | null;
  amount: string;
  fee: string;
  status: string;
  tx: string | null;
  memo: string | null;
  at: number;
};

/** the linked test-mode Visa (owner view) · linked:false when no fiat lane */
export type FiatCard = {
  linked: boolean;
  brand?: string;
  last4?: string;
  exp_month?: number;
  exp_year?: number;
  number?: string | null;
  cvc?: string | null;
  cardholder_name?: string | null;
};

export const api = {
  // --- Privy lane: onboard + client-signed issuance ---
  // proof = personal_sign("remit-onboard:v1:<did>") · binds the wallet to THIS login
  onboard: (address: string, auth7702: Wire7702Auth, proof: Hex) =>
    call<{ user_id: string; address: string; revocation_nonce: string; has_auth7702: boolean }>("/onboard", {
      method: "POST",
      body: JSON.stringify({ address, auth7702, proof }),
    }),
  prepareCard: (name: string, terms: CardTermsInput, userAddress: string) =>
    call<{ prepare_id: string; chain_id: number; k_agent_address: string; delegation: WireDelegation }>("/cards/prepare", {
      method: "POST",
      body: JSON.stringify({ name, terms, userAddress }),
    }),
  finalizeCard: (prepareId: string, signature: string) =>
    call<{ card_id: string; card_url: string; terms: CardTermsInput }>("/cards/finalize", {
      method: "POST",
      body: JSON.stringify({ prepare_id: prepareId, signature }),
    }),

  // --- Venice NL compiler: free-text intent -> DRAFT CardTerms (#43; never issues) ---
  compile: (intent: string) =>
    call<CompileResult>("/cards/compile", { method: "POST", body: JSON.stringify({ intent }) }),

  // --- reads + server-side controls (scoped to the embedded-wallet userId) ---
  tree: (userId: string) => call<{ tree: TreeNode[] }>(`/tree?userId=${encodeURIComponent(userId)}`),
  cards: () => call<CardState[]>("/cards"),
  card: (id: string) => call<CardState & { charges: Charge[]; k_agent_address: string }>(`/cards/${id}`),
  url: (id: string) => call<{ card_url: string }>(`/cards/${id}/url`),
  fiatCard: (id: string) => call<FiatCard>(`/cards/${id}/fiat`),
  rotate: (id: string) => call<{ card_url: string }>(`/cards/${id}/rotate`, { method: "POST" }),
  freeze: (id: string) => call<{ status: string }>(`/cards/${id}/freeze`, { method: "POST" }),
  unfreeze: (id: string) => call<{ status: string }>(`/cards/${id}/unfreeze`, { method: "POST" }),
  // bookkeeping removal of a DEAD card + its subtree (server refuses live cards)
  deleteCard: (id: string) => call<{ deleted: boolean; removed: number }>(`/cards/${id}`, { method: "DELETE" }),

  // --- on-chain USER-signed ops: the embedded wallet signs an admin leaf in the
  // browser (prepare -> signDelegation -> finalize). Sub-card revokes come back
  // immediately from prepare (server-side kill, nothing to sign). ---
  prepareRevoke: (id: string) =>
    call<
      | { prepare_id: string; chain_id: number; kind: "revoke"; delegation: WireDelegation }
      | { status: "revoked"; onchain: false }
    >(`/cards/${id}/revoke/prepare`, { method: "POST", body: "{}" }),
  finalizeRevoke: (id: string, prepareId: string, signature: string) =>
    call<{ status: string; tx: string | null }>(`/cards/${id}/revoke/finalize`, {
      method: "POST",
      body: JSON.stringify({ prepare_id: prepareId, signature }),
    }),
  prepareNuke: () =>
    call<{ prepare_id: string; chain_id: number; kind: "nuke"; delegation: WireDelegation }>("/nuke/prepare", {
      method: "POST",
      body: "{}",
    }),
  finalizeNuke: (prepareId: string, signature: string) =>
    call<{ status: string; tx: string | null; new_nonce: string }>("/nuke/finalize", {
      method: "POST",
      body: JSON.stringify({ prepare_id: prepareId, signature }),
    }),

  // --- OAuth consent (the /connect card-picker page) ---
  oauthRequest: (id: string) =>
    call<{
      request_id: string;
      client_name: string | null;
      redirect_host: string;
      scope: string | null;
      expires_at: number;
    }>(`/oauth/request?id=${encodeURIComponent(id)}`),
  oauthApprove: (requestId: string, cardId: string) =>
    call<{ redirect_to: string }>("/oauth/approve", {
      method: "POST",
      body: JSON.stringify({ request_id: requestId, card_id: cardId }),
    }),
  oauthDeny: (requestId: string) =>
    call<{ redirect_to: string }>("/oauth/deny", {
      method: "POST",
      body: JSON.stringify({ request_id: requestId }),
    }),
};
