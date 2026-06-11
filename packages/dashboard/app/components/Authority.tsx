"use client";

// Authority controls. StageAuthority = the block beside the card, read top to
// bottom like a statement: label + status, the money figure, the fact line,
// the fuel-gauge bar (REMAINING allowance — it drains as the agent spends),
// the countdown at the bar's end, verbs last. TermsGrid = the delegation term
// sheet in the Overview view, truthful to BOTH lanes (pay and execute). All
// control logic is the proven v1 state machines, re-skinned.

import { useState } from "react";
import { api, type CardState } from "@/lib/api";
import type { useRemit } from "../useRemit";
import { IconRevoke, IconSnowflake, StatusPill, fmtCountdown, isDead, periodLabel, shortHex, splitAmount, useCountUp } from "./ui";

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

export function StageAuthority({
  card,
  remit,
  refresh,
  subcardCount = 0,
  onConnect,
}: {
  card: CardState;
  remit: Remit;
  refresh: () => void | Promise<void>;
  subcardCount?: number;
  onConnect?: () => Promise<void>; // opens the credential overlay
}) {
  const dead = isDead(card.status);
  const frozen = card.status === "frozen";
  const { cap, remaining, spentPct } = allowance(card);
  const ct = card.terms.contract;
  const metered = cap !== null; // a pay budget governs this card

  const animated = useCountUp(dead ? 0 : (remaining ?? 0));
  const [whole, cents] = splitAmount(animated);
  const [ptWhole, ptCents] = splitAmount(ct?.perTradeMax ?? 0);
  const ptLive = ct ? perTradeEnforces(ct) : false;

  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const act = (fn: () => Promise<unknown>, label: string) => async () => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setMsg(`${label} failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setBusy(false);
    }
  };

  // label above the figure: what IS this number
  const plabel = card.terms.pay?.period ? periodLabel(card.terms.pay.period.seconds) : null;
  const label = metered
    ? plabel === "day"
      ? "Remaining today"
      : plabel === "wk"
        ? "Remaining this week"
        : plabel === "mo"
          ? "Remaining this month"
          : "Remaining · lifetime"
    : ct
      ? ptLive
        ? "Per-trade ceiling"
        : "Execute scope"
      : "Remaining";

  // one fact rides the sub-line; an active card with no sub-cards needs none —
  // the Connect agent button below IS the affordance
  const fact = dead
    ? "authority gone on-chain · this card can never spend again"
    : frozen
      ? "spends refuse while frozen · sub-cards inherit the freeze"
      : subcardCount > 0
        ? `${subcardCount} sub-card${subcardCount === 1 ? "" : "s"} drawing from this scope`
        : null;

  const countdown = card.period_resets_at
    ? { label: "resets in", at: card.period_resets_at }
    : card.expires_at
      ? { label: "expires in", at: card.expires_at }
      : null;

  // the bar is a fuel gauge: full when untouched, draining toward empty
  const leftPct = Math.max(0, 100 - spentPct);

  return (
    <div className={`stageauth panel${dead ? " dead-page" : ""}`}>
      <div className="authhead">
        <span className="authlabel">{label}</span>
        <span className="authstate">
          <StatusPill status={card.status} />
          {!metered && countdown && (
            <span className="cdown">
              {countdown.label} <span className="data">{fmtCountdown(countdown.at)}</span>
            </span>
          )}
        </span>
      </div>

      <div className="bigfig">
        {metered ? (
          <span className="amt" data-testid="remaining">
            <em>$</em>
            {whole}
            <i>.{cents}</i>
          </span>
        ) : ptLive ? (
          <span className="amt">
            <em>$</em>
            {ptWhole}
            <i>.{ptCents}</i>
          </span>
        ) : ct ? (
          <span className="amt">{ct.targets.length}</span>
        ) : (
          <span className="amt" data-testid="remaining">
            <em>$</em>
            {whole}
            <i>.{cents}</i>
          </span>
        )}
      </div>

      <div className="of">
        {metered ? (
          <>
            of <span className="data">${cap.toLocaleString("en-US", { minimumFractionDigits: 2 })}</span>
            {card.terms.pay?.period ? ` / ${periodLabel(card.terms.pay.period.seconds)}` : " lifetime"}
          </>
        ) : ct && ptLive ? (
          <>
            per trade · <span className="data">{ct.targets.length}</span> contract{ct.targets.length === 1 ? "" : "s"} /{" "}
            <span className="data">{ct.selectors.length}</span> method{ct.selectors.length === 1 ? "" : "s"}
          </>
        ) : ct ? (
          <>
            contract{ct.targets.length === 1 ? "" : "s"} in scope · <span className="data">{ct.selectors.length}</span>{" "}
            method{ct.selectors.length === 1 ? "" : "s"}
          </>
        ) : (
          <>unmetered</>
        )}
        {fact && <span className="fact"> · {fact}</span>}
      </div>

      {metered && ct && (
        <div className="lane2">
          + execute · <span className="data">{ct.targets.length}</span> contract{ct.targets.length === 1 ? "" : "s"} /{" "}
          <span className="data">{ct.selectors.length}</span> method{ct.selectors.length === 1 ? "" : "s"}
        </div>
      )}

      {metered && (
        <>
          <div className="bar">
            <i style={{ width: dead ? "0%" : leftPct > 0 ? `max(${leftPct}%, 4px)` : "0%" }} />
          </div>
          {countdown && (
            <div className="barmeta">
              <span>
                {countdown.label} <span className="data">{fmtCountdown(countdown.at)}</span>
              </span>
            </div>
          )}
        </>
      )}

      <div className="actions">
        {!dead && onConnect && (
          <button className="primary" disabled={busy} onClick={act(onConnect, "reveal url")} data-testid="reveal-url">
            Connect agent
          </button>
        )}
        {card.status === "active" && (
          <button
            className="iconbtn"
            disabled={busy}
            onClick={act(() => api.freeze(card.card_id), "freeze")}
            data-testid="freeze"
            title="freeze card"
            aria-label="freeze card"
          >
            <IconSnowflake />
          </button>
        )}
        {card.status === "frozen" && (
          <button
            className="iconbtn on"
            disabled={busy}
            onClick={act(() => api.unfreeze(card.card_id), "unfreeze")}
            data-testid="unfreeze"
            title="unfreeze card"
            aria-label="unfreeze card"
          >
            <IconSnowflake />
          </button>
        )}
        <RevokeButton
          cardId={card.card_id}
          isSub={!!card.parent_card_id}
          revocable={!dead}
          signDelegation={remit.signDelegation}
          embeddedReady={remit.embeddedReady}
          onDone={refresh}
        />
      </div>

      {msg && (
        <p className="err" style={{ marginTop: 10 }}>
          {msg}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// TermsGrid: the delegation term sheet (Overview panel). Two grouped stacks of
// quiet rows — what the card can do (scope) left, how long it lives and who
// holds it (lifecycle + enforcement) right. Values humanized: "uncapped",
// "any merchant", "unlimited", real dates. Mono is reserved for hex.
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
        {row("Rails", rails)}
        {t.pay && row("Per-charge cap", t.perTxMax ? `$${t.perTxMax}` : "uncapped")}
        {t.pay &&
          row("Merchants", t.merchants?.length ? `${t.merchants.length} locked` : "any merchant", {
            title: t.merchants?.join("\n"),
          })}
        {t.pay?.lifetime && row("Lifetime cap", `$${t.pay.lifetime.amount}`)}
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
            "Token allowance",
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
            "Per-trade max",
            ct.perTradeMax ? `$${ct.perTradeMax}${perTradeEnforces(ct) ? "" : " · dormant (no usdc in scope)"}` : "uncapped",
          )}
      </div>
      <div className="tcol">
        {row("Expires", expires)}
        {row("Uses left", card.uses_remaining !== null ? card.uses_remaining : "unlimited")}
        {row("Sub-cards", t.subcards === false ? "not allowed" : "allowed")}
        {row("Delegate", agentAddress ? shortHex(agentAddress) : "·", { title: agentAddress, mono: true })}
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
      <span className="note" style={{ alignSelf: "center", fontSize: 12, color: "var(--body)" }} data-testid="revoke-done">
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
      <span className="note" style={{ alignSelf: "center", fontSize: 12, color: "var(--body)" }} data-testid="revoke-busy">
        {phase === "signing" ? "signing with your wallet…" : isSub ? "killing server-side…" : "submitting on-chain…"}
      </span>
    );
  }
  if (phase === "confirm") {
    return (
      <span style={{ display: "inline-flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <span className="err" style={{ fontSize: 12 }}>
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
        className="iconbtn danger"
        disabled={!isSub && !embeddedReady}
        onClick={() => setPhase("confirm")}
        data-testid="revoke"
        title={isSub ? "revoke · server-side kill, instant" : "revoke · on-chain disableDelegation, signed by your embedded wallet"}
        aria-label="revoke card"
      >
        <IconRevoke />
      </button>
      {err && <span className="err" style={{ fontSize: 12 }}>revoke failed: {err}</span>}
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
  const json = JSON.stringify({ mcpServers: { [name]: { type: "http", url } } }, null, 2);
  const cursorLink = `cursor://anysphere.cursor-deeplink/mcp/install?name=${encodeURIComponent(name)}&config=${
    typeof window === "undefined" ? "" : btoa(JSON.stringify({ url }))
  }`;
  return (
    <div data-testid="connect-panel">
      <div className="bchips">
        <CopyButton text={url} label="copy url" />
        <CopyButton text={cli} label="claude code" />
        <button onClick={() => { window.location.href = cursorLink; }}>cursor</button>
        <CopyButton text={json} label="json" />
        {onRotate && (
          <button onClick={onRotate} disabled={busy} data-testid="rotate-url" title="invalidate this URL and mint a new one">
            rotate
          </button>
        )}
      </div>
      <p className="bchint">claude.ai web: settings → connectors → add custom connector → paste the url.</p>
    </div>
  );
}
