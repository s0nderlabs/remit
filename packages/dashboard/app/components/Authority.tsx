"use client";

// Authority helpers + controls. allowance() reads the live budget, TermsGrid =
// the delegation term sheet (now living inside the foot accordion's sheet),
// RevokeButton = the proven v1 revoke state machine wearing the vpill skin,
// ConnectChips = the per-harness install affordances.

import { useState } from "react";
import { api, type CardState } from "@/lib/api";
import type { useRemit } from "../useRemit";
import { IconRevoke, isDead, shortHex } from "./ui";

type Remit = ReturnType<typeof useRemit>;

export function caveatCount(card: CardState): number {
  const t = card.terms;
  let n = 0;
  if (t.pay?.period) n++;
  if (t.pay?.lifetime) n++;
  if (t.expiry) n++;
  if (t.maxUses) n++;
  if (t.perTxMax) n++;
  if (t.merchants?.length) n++;
  if (t.subcards !== undefined) n++;
  if (t.contract) {
    n++; // targets + methods scope
    if (t.contract.tokens?.length) n++;
    if (t.contract.perTradeMax) n++;
  }
  return n;
}

// v1 enforces the per-trade cap on USDC allowances only (Base mainnet USDC); a card
// whose scope can't grant a USDC allowance carries the cap as dormant config, so the
// headline figure must not present it as a live ceiling.
const USDC_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const APPROVE_SIG = "approve(address,uint256)";
export function perTradeEnforces(ct: NonNullable<CardState["terms"]["contract"]>): boolean {
  if (!ct.perTradeMax) return false;
  if (!ct.selectors.includes(APPROVE_SIG)) return false;
  return !ct.tokens || ct.tokens.some((t) => t.toLowerCase() === USDC_BASE);
}

export function allowance(card: CardState) {
  const capStr = card.terms.pay?.period?.amount ?? card.terms.pay?.lifetime?.amount ?? null;
  const remainingStr = card.remaining_this_period ?? card.remaining_lifetime;
  const cap = capStr ? parseFloat(capStr) : null;
  const remaining = remainingStr !== null && remainingStr !== undefined ? parseFloat(remainingStr) : null;
  const spent = cap !== null && remaining !== null ? Math.max(0, cap - remaining) : null;
  const spentPct = cap && spent !== null ? Math.min(100, (spent / cap) * 100) : 0;
  return { cap, remaining, spent, spentPct };
}

// ---------------------------------------------------------------------------
// TermsGrid: the delegation term sheet (inside the foot accordion's sheet).
// Two grouped stacks of quiet rows — what the card can do (scope) left, how
// long it lives and who holds it (lifecycle + enforcement) right. Values
// humanized: "uncapped", "any merchant", "unlimited", real dates.
// ---------------------------------------------------------------------------

/** "approve(address,uint256)" -> "approve()"; raw 0x selectors stay short hex */
function methodName(sig: string): string {
  if (sig.startsWith("0x")) return shortHex(sig, 6, 0);
  const paren = sig.indexOf("(");
  return paren === -1 ? sig : `${sig.slice(0, paren)}()`;
}

export function TermsGrid({ card, agentAddress }: { card: CardState; agentAddress?: string }) {
  const t = card.terms;
  const ct = t.contract;
  const expires = card.expires_at
    ? `${new Date(card.expires_at * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}${
        !isDead(card.status) && card.expires_at * 1000 > Date.now()
          ? ` · ${Math.max(1, Math.ceil((card.expires_at * 1000 - Date.now()) / 86400000))}d left`
          : ""
      }`
    : "never";
  const rails = [t.pay ? "x402 + fiat" : null, ct ? "execute" : null].filter(Boolean).join(" · ") || "none";

  const row = (label: string, value: React.ReactNode, opts?: { title?: string; mono?: boolean }) => (
    <div className="trow" title={opts?.title}>
      <span className="tl">{label}</span>
      <span className={`tv${opts?.mono ? " code" : ""}`}>{value}</span>
    </div>
  );

  return (
    <div className="termsheet">
      <div className="tcol">
        {row("rails", rails)}
        {t.pay && row("per-charge cap", t.perTxMax ? `$${t.perTxMax}` : "uncapped")}
        {t.pay &&
          row("merchants", t.merchants?.length ? `${t.merchants.length} locked` : "any merchant", {
            title: t.merchants?.join("\n"),
          })}
        {t.pay?.lifetime && row("lifetime cap", `$${t.pay.lifetime.amount}`)}
        {ct &&
          row(
            "contracts",
            <>
              {shortHex(ct.targets[0])}
              {ct.targets.length > 1 && <span className="w"> +{ct.targets.length - 1}</span>}
            </>,
            { title: ct.targets.join("\n"), mono: true },
          )}
        {ct &&
          row(
            "methods",
            <>
              {methodName(ct.selectors[0])}
              {ct.selectors.length > 1 && <span className="w"> +{ct.selectors.length - 1}</span>}
            </>,
            { title: ct.selectors.join("\n"), mono: true },
          )}
        {ct &&
          row(
            "token allowance",
            ct.tokens?.length ? (
              <>
                {ct.tokens.length}
                <span className="w"> allowed</span>
              </>
            ) : (
              "any in scope"
            ),
            { title: ct.tokens?.join("\n") },
          )}
        {ct &&
          row(
            "per-trade max",
            ct.perTradeMax ? `$${ct.perTradeMax}${perTradeEnforces(ct) ? "" : " · dormant (no usdc in scope)"}` : "uncapped",
          )}
      </div>
      <div className="tcol">
        {row("expires", expires)}
        {row("uses left", card.uses_remaining !== null ? card.uses_remaining : "unlimited")}
        {row("sub-cards", t.subcards === false ? "not allowed" : "allowed")}
        {row("delegate", agentAddress ? shortHex(agentAddress) : "·", { title: agentAddress, mono: true })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Revoke: top-level cards sign an admin leaf with the embedded wallet (on-chain
// disableDelegation via the relayer, gasless); sub-cards die server-side instantly.
// Logic identical to v1; presentation re-skinned.
// ---------------------------------------------------------------------------

type RevokePhase = "idle" | "confirm" | "signing" | "submitting" | "done" | "error";

export function RevokeButton({
  cardId,
  isSub,
  revocable,
  signDelegation,
  embeddedReady,
  onDone,
}: {
  cardId: string;
  isSub: boolean;
  revocable: boolean;
  signDelegation: Remit["signDelegation"];
  embeddedReady: boolean;
  onDone: () => Promise<void> | void;
}) {
  const [phase, setPhase] = useState<RevokePhase>("idle");
  const [tx, setTx] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  if (!revocable && phase !== "done") return null;

  async function go() {
    setErr(null);
    try {
      setPhase(isSub ? "submitting" : "signing");
      const prep = await api.prepareRevoke(cardId);
      if (!("prepare_id" in prep)) {
        setPhase("done");
        await onDone();
        return;
      }
      const signature = await signDelegation(prep.delegation);
      setPhase("submitting");
      const fin = await api.finalizeRevoke(cardId, prep.prepare_id, signature);
      setTx(fin.tx);
      setPhase("done");
      await onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  }

  if (phase === "done") {
    return (
      <span className="verbnote" data-testid="revoke-done">
        revoked ✓{" "}
        {tx && (
          <a href={`https://basescan.org/tx/${tx}`} target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>
            {shortHex(tx, 10, 0)}
          </a>
        )}
      </span>
    );
  }
  if (phase === "signing" || phase === "submitting") {
    return (
      <span className="verbnote" data-testid="revoke-busy">
        {phase === "signing" ? "signing with your wallet…" : isSub ? "killing server-side…" : "submitting on-chain…"}
      </span>
    );
  }
  if (phase === "confirm") {
    return (
      <span style={{ display: "inline-flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <span className="verbnote err">
          {isSub ? "kill this sub-card (and its descendants)?" : "permanently revoke on-chain (kills the whole subtree)?"}
        </span>
        <button className="danger-ghost" onClick={go} data-testid="revoke-confirm">
          yes, revoke
        </button>
        <button onClick={() => setPhase("idle")}>cancel</button>
      </span>
    );
  }
  return (
    <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
      <button
        className="vpill danger"
        disabled={!isSub && !embeddedReady}
        onClick={() => setPhase("confirm")}
        data-testid="revoke"
        title={isSub ? "revoke · server-side kill, instant" : "revoke · on-chain disableDelegation, signed by your embedded wallet"}
      >
        <IconRevoke size={13} />
        revoke
      </button>
      {err && <span className="verbnote err">revoke failed: {err}</span>}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Connect chips: per-harness install affordances for the card URL (#25).
// Rendered inside the connect overlay; the URL is the credential — every
// snippet embeds it; treat them all as secrets.
// ---------------------------------------------------------------------------

export function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? "copied ✓" : label}
    </button>
  );
}

export function ConnectChips({
  url,
  cardName,
  onRotate,
  busy,
}: {
  url: string;
  cardName: string;
  onRotate?: () => void;
  busy?: boolean;
}) {
  const slug = cardName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "card";
  const name = `remit-${slug}`;
  const cli = `claude mcp add --transport http ${name} ${url}`;
  const codex = `codex mcp add ${name} --url ${url}`;
  // openclaw defaults HTTP servers to SSE when the transport flag is omitted — keep it explicit
  const openclaw = `openclaw mcp add ${name} --url ${url} --transport streamable-http`;
  const json = JSON.stringify({ mcpServers: { [name]: { type: "http", url } } }, null, 2);
  const cursorLink = `cursor://anysphere.cursor-deeplink/mcp/install?name=${encodeURIComponent(name)}&config=${
    typeof window === "undefined" ? "" : btoa(JSON.stringify({ url }))
  }`;
  // documented prefill deep link (claude.com/docs/connectors/building/directory-vs-custom);
  // the dialog opens prefilled, the user just presses Add
  const claudeAiLink = `https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=${encodeURIComponent(name)}&connectorUrl=${encodeURIComponent(url)}`;
  // protocol-handler form: the WHOLE server config (name included) as one URL-encoded JSON
  const vscodeLink = `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name, type: "http", url }))}`;
  return (
    <div data-testid="connect-panel">
      <div className="bchips">
        <CopyButton text={url} label="copy url" />
        <CopyButton text={cli} label="claude code" />
        <button onClick={() => { window.open(claudeAiLink, "_blank", "noopener"); }}>claude.ai</button>
        <CopyButton text={codex} label="codex" />
        <button onClick={() => { window.location.href = cursorLink; }}>cursor</button>
        <button onClick={() => { window.location.href = vscodeLink; }}>vs code</button>
        <CopyButton text={openclaw} label="openclaw" />
        <CopyButton text={json} label="json" />
        {onRotate && (
          <button onClick={onRotate} disabled={busy} data-testid="rotate-url" title="invalidate this URL and mint a new one">
            rotate
          </button>
        )}
      </div>
      <p className="bchint">claude.ai opens a prefilled connector dialog · codex/openclaw copy install commands · json fits most other clients.</p>
    </div>
  );
}
