"use client";

// Card detail: live meters, charge feed, bearer URL (re-view + rotate), controls.

import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { api, type CardState, type Charge } from "@/lib/api";

type Detail = CardState & { charges: Charge[]; k_agent_address: string };

export default function CardPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
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
        {!card.parent_card_id && (card.status === "active" || card.status === "frozen") && (
          <span className="mono" style={{ color: "#888" }} data-testid="revoke-gated">
            revoke on-chain — signed by your embedded wallet, needs a funded A_user (wired next)
          </span>
        )}
        <button className="ghost" disabled={busy} onClick={act(async () => setUrl((await api.url(card.card_id)).card_url), "reveal url")} data-testid="reveal-url">
          view connection URL
        </button>
        <button className="ghost" disabled={busy} onClick={act(async () => setUrl((await api.rotate(card.card_id)).card_url), "rotate url")} data-testid="rotate-url">
          rotate URL
        </button>
      </div>
      {url && <div className="urlbox" style={{ marginTop: 8 }} data-testid="card-url">{url}</div>}
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
