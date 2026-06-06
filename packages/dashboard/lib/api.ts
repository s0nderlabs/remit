// Dashboard API client. AUTH (dev): the admin token gates the API (single-user dev);
// IDENTITY: the Privy embedded wallet address is the userId (one user row per wallet),
// and issuance is CLIENT-signed (onboard -> prepare -> sign in browser -> finalize).
// Production would verify a Privy session server-side instead of the shared admin token.

const BASE = process.env.NEXT_PUBLIC_REMIT_API ?? "http://localhost:4070/api";
const TOKEN = process.env.NEXT_PUBLIC_REMIT_ADMIN_TOKEN ?? "";

type Hex = `0x${string}`;
type Wire7702Auth = { chainId: Hex; address: Hex; nonce: Hex; yParity: Hex; r: Hex; s: Hex };
type WireDelegation = {
  delegator: Hex;
  delegate: Hex;
  authority: Hex;
  caveats: { enforcer: Hex; terms: Hex; args: Hex }[];
  salt: Hex;
  signature: Hex;
};

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
      ...init?.headers,
    },
    cache: "no-store",
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.message ?? body.error ?? `http ${res.status}`);
  return body as T;
}

export type CardTermsInput = {
  pay?: { period?: { amount: string; seconds: number }; lifetime?: { amount: string } };
  expiry?: number;
  maxUses?: number;
  perTxMax?: string;
  merchants?: string[];
  subcards?: boolean;
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

export const api = {
  // --- Privy lane: onboard + client-signed issuance ---
  onboard: (address: string, auth7702: Wire7702Auth) =>
    call<{ user_id: string; address: string; revocation_nonce: string; has_auth7702: boolean }>("/onboard", {
      method: "POST",
      body: JSON.stringify({ address, auth7702 }),
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

  // --- reads + server-side controls (scoped to the embedded-wallet userId) ---
  tree: (userId: string) => call<{ tree: TreeNode[] }>(`/tree?userId=${encodeURIComponent(userId)}`),
  card: (id: string) => call<CardState & { charges: Charge[]; k_agent_address: string }>(`/cards/${id}`),
  url: (id: string) => call<{ card_url: string }>(`/cards/${id}/url`),
  rotate: (id: string) => call<{ card_url: string }>(`/cards/${id}/rotate`, { method: "POST" }),
  freeze: (id: string) => call<{ status: string }>(`/cards/${id}/freeze`, { method: "POST" }),
  unfreeze: (id: string) => call<{ status: string }>(`/cards/${id}/unfreeze`, { method: "POST" }),

  // revoke/nuke are on-chain USER-signed ops (need a funded A_user). The dev lane signs
  // them with the server key; the Privy lane will sign client-side (wired separately).
  revoke: (id: string) => call<{ status: string; tx: string | null }>(`/cards/${id}/revoke`, { method: "POST" }),
  nuke: (userId: string) =>
    call<{ status: string; tx: string | null; new_nonce: string }>("/nuke", {
      method: "POST",
      body: JSON.stringify({ userId }),
    }),
};
