"use client";

// Authority helpers + controls. allowance() reads the live budget, TermsGrid =
// the delegation term sheet (now living inside the foot accordion's sheet),
// RevokeButton = the proven v1 revoke state machine wearing the vpill skin,
// ConnectChips = the per-harness install affordances.

import { useState } from "react";
import { api, type CardState } from "@/lib/api";
import type { useRemit } from "../useRemit";
import { IconRevoke, isDead, shortHex } from "./ui";
import { DangerModal, type DangerPhase } from "./Confirm";

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
// Two grouped stacks of quiet rows · what the card can do (scope) left, how
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
    : "Never";
  const rails = [t.pay ? "x402 + Fiat" : null, ct ? "Execute" : null].filter(Boolean).join(" · ") || "None";

  const row = (label: string, value: React.ReactNode, opts?: { title?: string; mono?: boolean }) => (
    <div className="trow" title={opts?.title}>
      <span className="tl">{label}</span>
      <span className={`tv${opts?.mono ? " code" : ""}`}>{value}</span>
    </div>
  );

  return (
    <div className="termsheet">
      <div className="tcol">
        {row("Rails", rails)}
        {t.pay && row("Per-Charge Cap", t.perTxMax ? `$${t.perTxMax}` : "Uncapped")}
        {t.pay &&
          row("Merchants", t.merchants?.length ? `${t.merchants.length} locked` : "Any merchant", {
            title: t.merchants?.join("\n"),
          })}
        {t.pay?.lifetime && row("Lifetime Cap", `$${t.pay.lifetime.amount}`)}
        {ct &&
          row(
            "Contracts",
            <>
              {shortHex(ct.targets[0])}
              {ct.targets.length > 1 && <span className="w"> +{ct.targets.length - 1}</span>}
            </>,
            { title: ct.targets.join("\n"), mono: true },
          )}
        {ct &&
          row(
            "Methods",
            <>
              {methodName(ct.selectors[0])}
              {ct.selectors.length > 1 && <span className="w"> +{ct.selectors.length - 1}</span>}
            </>,
            { title: ct.selectors.join("\n"), mono: true },
          )}
        {ct &&
          row(
            "Token Allowance",
            ct.tokens?.length ? (
              <>
                {ct.tokens.length}
                <span className="w"> allowed</span>
              </>
            ) : (
              "Any in scope"
            ),
            { title: ct.tokens?.join("\n") },
          )}
        {ct &&
          row(
            "Per-Trade Max",
            ct.perTradeMax ? `$${ct.perTradeMax}${perTradeEnforces(ct) ? "" : " · dormant (no USDC in scope)"}` : "Uncapped",
          )}
      </div>
      <div className="tcol">
        {row("Expires", expires)}
        {row("Uses Left", card.uses_remaining !== null ? card.uses_remaining : "Unlimited")}
        {row("Sub-Cards", t.subcards === false ? "Not allowed" : "Allowed")}
        {row("Delegate", agentAddress ? shortHex(agentAddress) : "·", { title: agentAddress, mono: true })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Revoke: top-level cards sign an admin leaf with the embedded wallet (on-chain
// disableDelegation via the relayer, gasless); sub-cards die server-side instantly.
// Logic identical to v1; the confirm/busy/done staircase now walks the shared
// destructive-action modal. The component stays mounted when the card dies so
// the done state survives the status flip behind the scrim.
// ---------------------------------------------------------------------------

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
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<DangerPhase>("confirm");
  const [stage, setStage] = useState<"signing" | "submitting">("signing");
  const [tx, setTx] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function go() {
    setErr(null);
    try {
      setPhase("busy");
      setStage(isSub ? "submitting" : "signing");
      const prep = await api.prepareRevoke(cardId);
      if (!("prepare_id" in prep)) {
        setPhase("done");
        await onDone();
        return;
      }
      const signature = await signDelegation(prep.delegation);
      setStage("submitting");
      const fin = await api.finalizeRevoke(cardId, prep.prepare_id, signature);
      setTx(fin.tx);
      setPhase("done");
      await onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  }

  return (
    <>
      <button
        className="vpill danger"
        disabled={!revocable || (!isSub && !embeddedReady)}
        onClick={() => setOpen(true)}
        data-testid="revoke"
        title={isSub ? "Revoke · server-side kill, instant" : "Revoke · on-chain disableDelegation, signed by your embedded wallet"}
      >
        <IconRevoke size={13} />
        Revoke
      </button>
      <DangerModal
        open={open}
        phase={phase}
        prefix="revoke"
        title={isSub ? "Revoke this sub-card?" : "Revoke this card?"}
        body={
          isSub
            ? "The sub-card and every card carved beneath it die instantly. The agent holding it loses authority for good."
            : "Permanently revokes the delegation on-chain. Every sub-card carved from it dies with it: the whole subtree, one transaction."
        }
        confirmLabel="Yes, Revoke"
        busyNote={stage === "signing" ? "Signing with your wallet…" : isSub ? "Killing server-side…" : "Submitting on-chain…"}
        doneTitle="Card Revoked"
        doneNote={
          <>
            Revoked ✓ The authority is dead.{" "}
            {tx && (
              <a href={`https://basescan.org/tx/${tx}`} target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>
                {shortHex(tx, 10, 0)}
              </a>
            )}
          </>
        }
        errorNote={err ? `Revoke failed: ${err}` : undefined}
        onConfirm={go}
        onClose={() => {
          setOpen(false);
          setPhase("confirm");
        }}
      />
    </>
  );
}

/** Bookkeeping removal for a DEAD card: the tree row, its sub-cards and its
 * charge history leave the dashboard. The server refuses anything alive. */
export function DeleteButton({
  cardId,
  hasKids,
  onDone,
}: {
  cardId: string;
  hasKids: boolean;
  onDone: () => Promise<void> | void;
}) {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<DangerPhase>("confirm");
  const [err, setErr] = useState<string | null>(null);

  async function go() {
    setErr(null);
    try {
      setPhase("busy");
      await api.deleteCard(cardId);
      setPhase("done");
      await onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  }

  return (
    <>
      <button
        className="vpill danger stay"
        onClick={() => setOpen(true)}
        data-testid="delete-card"
        title="Remove this dead card from the dashboard"
      >
        <IconTrash />
        Delete Card
      </button>
      <DangerModal
        open={open}
        phase={phase}
        prefix="delete"
        title="Delete this card?"
        body={
          hasKids
            ? "The authority is already dead on-chain. This removes the card, its sub-cards and their charge history from your dashboard for good."
            : "The authority is already dead on-chain. This removes the card and its charge history from your dashboard for good."
        }
        confirmLabel="Yes, Delete"
        busyNote="Removing…"
        busyHint="Bookkeeping only · nothing to wait for on-chain"
        doneTitle="Card Deleted"
        doneNote="Gone. The books are clean."
        errorNote={err ? `Delete failed: ${err}` : undefined}
        onConfirm={go}
        onClose={() => {
          setOpen(false);
          setPhase("confirm");
        }}
      />
    </>
  );
}

function IconTrash() {
  return (
    <svg viewBox="0 0 14 14" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M1.8 3.8h10.4M5.4 3.8V2.6a1 1 0 0 1 1-1h1.2a1 1 0 0 1 1 1v1.2M3.2 3.8l.6 7.6a1.2 1.2 0 0 0 1.2 1.1h4a1.2 1.2 0 0 0 1.2-1.1l.6-7.6" />
      <path d="M5.8 6.4v3.4M8.2 6.4v3.4" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Connect chips: per-harness install affordances for the card URL (#25).
// Rendered inside the connect overlay; the URL is the credential · every
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
      {copied ? "Copied ✓" : label}
    </button>
  );
}

function IconCopy() {
  return (
    <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="4.5" y="4.5" width="8" height="8" rx="2" />
      <path d="M9.5 3V2.5a1.5 1.5 0 0 0-1.5-1.5H3A1.5 1.5 0 0 0 1.5 2.5V8A1.5 1.5 0 0 0 3 9.5h.5" />
    </svg>
  );
}

function IconCheck() {
  return (
    <svg viewBox="0 0 12 10" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M1.5 5.5l3 3 6-7" />
    </svg>
  );
}

function IconOpen() {
  return (
    <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4.5 2H2.2A1.2 1.2 0 0 0 1 3.2v6.6A1.2 1.2 0 0 0 2.2 11h6.6A1.2 1.2 0 0 0 10 9.8V7.5" />
      <path d="M7 1h4v4M11 1L5.5 6.5" />
    </svg>
  );
}

/** The credential surface: a quiet inset box, the copy action riding inside it. */
export function UrlBox({ url, testid }: { url: string; testid?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="ovurl">
      <span className="u" data-testid={testid}>
        {url}
      </span>
      <button
        className={`ovcopy${copied ? " done" : ""}`}
        aria-label="Copy URL"
        title="Copy URL"
        onClick={async () => {
          await navigator.clipboard.writeText(url);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? <IconCheck /> : <IconCopy />}
      </button>
    </div>
  );
}

export function ConnectChips({ url, cardName }: { url: string; cardName: string }) {
  const [done, setDone] = useState<string | null>(null);
  const slug = cardName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "card";
  const name = `remit-${slug}`;
  const cli = `claude mcp add --transport http ${name} ${url}`;
  const codex = `codex mcp add ${name} --url ${url}`;
  // openclaw defaults HTTP servers to SSE when the transport flag is omitted · keep it explicit
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

  const copy = (key: string, text: string) => async () => {
    await navigator.clipboard.writeText(text);
    setDone(key);
    setTimeout(() => setDone((k) => (k === key ? null : k)), 1500);
  };
  const harnesses: { key: string; label: string; title: string; glyph: "copy" | "open"; act: () => void }[] = [
    { key: "cc", label: "Claude Code", title: "Copy the claude mcp add command", glyph: "copy", act: () => void copy("cc", cli)() },
    { key: "cai", label: "claude.ai", title: "Open a prefilled connector dialog", glyph: "open", act: () => void window.open(claudeAiLink, "_blank", "noopener") },
    { key: "cdx", label: "Codex", title: "Copy the codex mcp add command", glyph: "copy", act: () => void copy("cdx", codex)() },
    { key: "cur", label: "Cursor", title: "Open Cursor's install prompt", glyph: "open", act: () => void (window.location.href = cursorLink) },
    { key: "vsc", label: "VS Code", title: "Open VS Code's install prompt", glyph: "open", act: () => void (window.location.href = vscodeLink) },
    { key: "ocl", label: "OpenClaw", title: "Copy the openclaw mcp add command", glyph: "copy", act: () => void copy("ocl", openclaw)() },
    { key: "json", label: "JSON", title: "Copy mcpServers JSON for any other client", glyph: "copy", act: () => void copy("json", json)() },
  ];

  return (
    <div data-testid="connect-panel">
      <div className="hlabel">Add to Your Agent</div>
      <div className="hgrid">
        {harnesses.map((h) => (
          <button key={h.key} className={`hrow${done === h.key ? " done" : ""}`} title={h.title} onClick={h.act}>
            <span>{h.label}</span>
            {done === h.key ? <IconCheck /> : h.glyph === "copy" ? <IconCopy /> : <IconOpen />}
          </button>
        ))}
      </div>
      <p className="bchint">An arrow opens that harness prefilled · the rest copy an install command (JSON fits any other client)</p>
    </div>
  );
}
