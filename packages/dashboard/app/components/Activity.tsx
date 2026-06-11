"use client";

// Activity: the tree-wide charge feed (crypto + fiat, one budget) with card
// attribution, the period metrics row, and the 30-day daily-spend bars.

import { useMemo } from "react";
import type { CardState, Charge } from "@/lib/api";
import { allowance } from "./Authority";
import { DailyBars, fmtClock, fmtUsd, shortHex } from "./ui";

const OK_STATUSES = new Set(["settled", "succeeded", "ok", "confirmed", "paid"]);

export type FeedRow = { ch: Charge; cardName: string };

export function railLabel(kind: string): string {
  if (kind.includes("fiat") || kind.includes("visa") || kind.includes("stripe")) return "fiat";
  if (kind.includes("x402") || kind.includes("pay") || kind.includes("transfer")) return "x402";
  return kind;
}

/** "May 28 · Jun 27" from the live period anchors; null when unmetered */
export function periodWindow(card: CardState | null): string | null {
  if (!card?.period_resets_at || !card.terms.pay?.period?.seconds) return null;
  const end = new Date(card.period_resets_at * 1000);
  const start = new Date((card.period_resets_at - card.terms.pay.period.seconds) * 1000);
  const f = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `${f(start)} · ${f(end)}`;
}

function feedStats(feed: FeedRow[]) {
  const ok = feed.filter((r) => OK_STATUSES.has(r.ch.status));
  const okCount = ok.length;
  // one convention everywhere: spend = amount + fee, so the headline, the
  // today delta, and the daily bars all reconcile
  const cost = (r: FeedRow) => (parseFloat(r.ch.amount) || 0) + (parseFloat(r.ch.fee) || 0);
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const dayStart = Math.floor(midnight.getTime() / 1000);
  const today = ok.reduce((s, r) => (r.ch.at >= dayStart ? s + cost(r) : s), 0);
  const total30 = ok.reduce((s, r) => s + cost(r), 0);
  // daily buckets, last 30 days — the variance is the information
  const now = Math.floor(Date.now() / 1000);
  const buckets = new Array(30).fill(0);
  for (const r of ok) {
    const age = Math.floor((now - r.ch.at) / 86400);
    if (age >= 0 && age < 30) buckets[29 - age] += cost(r);
  }
  return { today, total30, count: feed.length, okCount, buckets };
}

export function MetricsRow({
  card,
  feed,
  liveSubs,
}: {
  card: CardState | null;
  feed: FeedRow[];
  liveSubs: number;
}) {
  const { today, total30, count, okCount, buckets } = useMemo(() => feedStats(feed), [feed]);
  const spent = card ? allowance(card).spent : null;
  const blocked = count - okCount;
  return (
    <>
      <div className="metrics">
        <div className="mcell">
          <div className="lbl">{spent !== null ? "Spent this period" : "Spent · 30 days"}</div>
          <div className="mv">{fmtUsd(spent ?? total30)}</div>
          <div className="ms">
            <span className="data">+{fmtUsd(today)}</span> today
          </div>
        </div>
        <div className="mcell">
          <div className="lbl">Charges</div>
          <div className="mv">{count}</div>
          <div className="ms">
            {count === 0 ? (
              "none yet"
            ) : blocked > 0 ? (
              <>
                <span className="data">{blocked}</span> blocked
              </>
            ) : (
              "all settled"
            )}
          </div>
        </div>
        <div className="mcell">
          <div className="lbl">Live sub-cards</div>
          <div className="mv">{liveSubs}</div>
          <div className="ms">{liveSubs > 0 ? "drawing from this scope" : "none drawing yet"}</div>
        </div>
      </div>
      {/* the chart earns its place once there's history; until then, nothing */}
      {okCount >= 5 && (
        <div className="dailychart">
          <span className="lbl">Daily spend · 30d</span>
          <DailyBars values={buckets} width={560} height={64} />
        </div>
      )}
    </>
  );
}

export function ChargesTable({ rows }: { rows: FeedRow[] }) {
  return (
    <div className="table">
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>To</th>
            <th>Card</th>
            <th>Rail</th>
            <th style={{ textAlign: "right" }}>Amount</th>
            <th>Status</th>
            <th style={{ textAlign: "right" }}>Receipt</th>
          </tr>
        </thead>
        <tbody data-testid="charges">
          {rows.length === 0 && (
            <tr>
              <td colSpan={7} className="time">
                no charges yet · connect an agent and let it spend
              </td>
            </tr>
          )}
          {rows.map(({ ch, cardName }) => {
            const ok = OK_STATUSES.has(ch.status);
            return (
              <tr key={ch.id} className={ok ? undefined : "blockedrow"}>
                <td className="time">{fmtClock(ch.at)}</td>
                <td className="who">{ch.memo || (ch.to ? shortHex(ch.to, 8, 4) : railLabel(ch.kind))}</td>
                <td className="crd">{cardName}</td>
                <td>
                  <span className="railpill">{railLabel(ch.kind)}</span>
                </td>
                <td className="amt">{ok ? `−${fmtUsd(ch.amount)}` : fmtUsd(ch.amount)}</td>
                <td className="stt">{ok ? "OK" : ch.status}</td>
                <td className="txh">
                  {ch.tx ? (
                    <a href={`https://basescan.org/tx/${ch.tx}`} target="_blank" rel="noreferrer">
                      {shortHex(ch.tx, 6, 4)}
                    </a>
                  ) : (
                    <span>·</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
