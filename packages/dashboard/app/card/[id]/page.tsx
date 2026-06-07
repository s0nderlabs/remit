"use client";

// Card detail: live meters, charge feed, bearer URL (re-view + rotate), connect
// snippets, controls (freeze + client-signed on-chain revoke).

import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { api, type CardState, type Charge } from "@/lib/api";
import { useRemit } from "../../useRemit";

type Detail = CardState & { charges: Charge[]; k_agent_address: string };

export default function CardPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const remit = useRemit();
  const [card, setCard] = useState<Detail | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setCard(await api.card(id));
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  }, [id]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [refresh]);

  if (!card) return <div className="mono">loading… {msg && <span className="err">{msg}</span>}</div>;

  const act = (fn: () => Promise<unknown>, label: string) => async () => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      setMsg(`${label} ✓`);
      await refresh();
    } catch (e) {
      setMsg(`${label} failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <p>
        <Link href="/">← tree</Link>
      </p>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>
          {card.name} <span className={`chip ${card.status}`} data-testid="card-status">{card.status}</span>
        </h2>
        <span className="mono">agent key {card.k_agent_address.slice(0, 10)}… (bare EOA, holds nothing)</span>
      </div>

      <div className="panel" style={{ marginTop: 10 }}>
        <div className="row" style={{ gap: 28 }}>
          <span data-testid="remaining">
            remaining this period: <b>{card.remaining_this_period ?? "—"}</b>
            {card.terms.pay?.period ? ` / ${card.terms.pay.period.amount}` : ""}
          </span>
          {card.remaining_lifetime !== null && <span>lifetime left: <b>{card.remaining_lifetime}</b></span>}
          {card.period_resets_at && <span>resets {new Date(card.period_resets_at * 1000).toLocaleString()}</span>}
          {card.expires_at && <span>expires {new Date(card.expires_at * 1000).toLocaleString()}</span>}
          {card.uses_remaining !== null && <span>uses left: {card.uses_remaining}</span>}
        </div>
      </div>

      <h2>controls</h2>
      <div className="panel row">
        {card.status === "active" && (
          <button className="ghost" disabled={busy} onClick={act(() => api.freeze(card.card_id), "freeze")} data-testid="freeze">
            freeze
          </button>
        )}
        {card.status === "frozen" && (
          <button className="ghost" disabled={busy} onClick={act(() => api.unfreeze(card.card_id), "unfreeze")} data-testid="unfreeze">
            unfreeze
          </button>
        )}
        {/* always mounted: the post-revoke refresh flips status to "revoked", and a
            conditional mount would wipe the "revoked ✓ <tx>" proof link (component
            state) the instant it appears. The revocable gate lives inside. */}
        <RevokeButton
          cardId={card.card_id}
          isSub={!!card.parent_card_id}
          revocable={card.status === "active" || card.status === "frozen"}
          signDelegation={remit.signDelegation}
          embeddedReady={remit.embeddedReady}
          onDone={refresh}
        />
        <button className="ghost" disabled={busy} onClick={act(async () => setUrl((await api.url(card.card_id)).card_url), "reveal url")} data-testid="reveal-url">
          view connection URL
        </button>
        <button className="ghost" disabled={busy} onClick={act(async () => setUrl((await api.rotate(card.card_id)).card_url), "rotate url")} data-testid="rotate-url">
          rotate URL
        </button>
      </div>
      {url && (
        <>
          <div className="urlbox" style={{ marginTop: 8 }} data-testid="card-url">{url}</div>
          <ConnectPanel url={url} cardName={card.name} />
        </>
      )}
      {msg && <p className="mono">{msg}</p>}

      <h2>charges (crypto + visa, one budget)</h2>
      <div className="panel" style={{ padding: 0 }}>
        <table>
          <thead>
            <tr>
              <th>kind</th><th>amount</th><th>fee</th><th>to</th><th>status</th><th>tx</th><th>memo</th><th>when</th>
            </tr>
          </thead>
          <tbody data-testid="charges">
            {card.charges.length === 0 && (
              <tr><td colSpan={8} className="mono">no charges yet</td></tr>
            )}
            {card.charges.map((ch) => (
              <tr key={ch.id}>
                <td>{ch.kind}</td>
                <td>{ch.amount}</td>
                <td>{ch.fee}</td>
                <td className="mono">{ch.to ? `${ch.to.slice(0, 8)}…` : "—"}</td>
                <td>{ch.status}</td>
                <td>
                  {ch.tx ? (
                    <a href={`https://basescan.org/tx/${ch.tx}`} target="_blank" rel="noreferrer">
                      {ch.tx.slice(0, 10)}…
                    </a>
                  ) : ("—")}
                </td>
                <td className="mono">{ch.memo ?? ""}</td>
                <td className="mono">{new Date(ch.at * 1000).toLocaleTimeString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {card.subcards.length > 0 && (
        <>
          <h2>sub-cards</h2>
          <div className="panel">
            {card.subcards.map((s) => (
              <div key={s}>
                <Link href={`/card/${s}`}>{s}</Link>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Revoke: top-level cards sign an admin leaf with the embedded wallet (on-chain
// disableDelegation via the relayer, gasless); sub-cards die server-side instantly.
// ---------------------------------------------------------------------------

type RevokePhase = "idle" | "confirm" | "signing" | "submitting" | "done" | "error";

function RevokeButton({
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
  signDelegation: ReturnType<typeof useRemit>["signDelegation"];
  embeddedReady: boolean;
  onDone: () => Promise<void> | void;
}) {
  const [phase, setPhase] = useState<RevokePhase>("idle");
  const [tx, setTx] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // already dead and nothing to show: render nothing (the parent keeps us mounted so a
  // just-completed revoke's tx link survives the status refresh)
  if (!revocable && phase !== "done") return null;

  async function go() {
    setErr(null);
    try {
      // sub-cards are killed server-side in prepare — no wallet signature is requested,
      // so never show "signing with your wallet…" for them
      setPhase(isSub ? "submitting" : "signing");
      const prep = await api.prepareRevoke(cardId);
      if (!("prepare_id" in prep)) {
        // sub-card: the server killed it instantly, nothing to sign
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
      <span className="mono" data-testid="revoke-done">
        revoked ✓{" "}
        {tx && (
          <a href={`https://basescan.org/tx/${tx}`} target="_blank" rel="noreferrer">
            {tx.slice(0, 10)}…
          </a>
        )}
      </span>
    );
  }
  if (phase === "signing" || phase === "submitting") {
    return (
      <span className="mono" data-testid="revoke-busy">
        {phase === "signing" ? "signing with your wallet…" : isSub ? "killing server-side…" : "submitting on-chain…"}
      </span>
    );
  }
  if (phase === "confirm") {
    return (
      <span className="row" style={{ gap: 8 }}>
        <span className="mono err">
          {isSub ? "kill this sub-card (and its descendants)?" : "permanently revoke on-chain (kills the whole subtree)?"}
        </span>
        <button className="ghost" onClick={go} data-testid="revoke-confirm">
          yes, revoke
        </button>
        <button className="ghost" onClick={() => setPhase("idle")}>cancel</button>
      </span>
    );
  }
  return (
    <span className="row" style={{ gap: 8 }}>
      <button
        className="ghost"
        disabled={!isSub && !embeddedReady}
        onClick={() => setPhase("confirm")}
        data-testid="revoke"
        title={isSub ? "server-side kill, instant" : "on-chain disableDelegation, signed by your embedded wallet"}
      >
        revoke
      </button>
      {err && <span className="err mono">revoke failed: {err}</span>}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Connect panel: per-harness install affordances for the card URL (#25).
// The URL is the credential — every snippet embeds it; treat them all as secrets.
// ---------------------------------------------------------------------------

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="ghost"
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

function ConnectPanel({ url, cardName }: { url: string; cardName: string }) {
  const slug = cardName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "card";
  const name = `remit-${slug}`;
  const cli = `claude mcp add --transport http ${name} ${url}`;
  const json = JSON.stringify({ mcpServers: { [name]: { type: "http", url } } }, null, 2);
  const cursorLink = `cursor://anysphere.cursor-deeplink/mcp/install?name=${encodeURIComponent(name)}&config=${
    typeof window === "undefined" ? "" : btoa(JSON.stringify({ url }))
  }`;
  return (
    <div className="panel" style={{ marginTop: 8 }} data-testid="connect-panel">
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <span className="mono" style={{ color: "#888" }}>connect your agent:</span>
        <CopyButton text={url} label="copy URL" />
        <CopyButton text={cli} label="Claude Code (CLI)" />
        <button className="ghost" onClick={() => { window.location.href = cursorLink; }}>
          Cursor (one-click)
        </button>
        <CopyButton text={json} label="JSON (any client)" />
      </div>
      <p className="mono" style={{ color: "#666", marginBottom: 0 }}>
        claude.ai web: Settings → Connectors → add custom connector → paste the URL.
        header-capable clients can also use the bearer lane: <code>/mcp</code> +
        Authorization: Bearer &lt;secret&gt;.
      </p>
    </div>
  );
}
