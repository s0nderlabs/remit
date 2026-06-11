"use client";

// Activity: the tree-wide charge feed (crypto + fiat, one budget) with card
// attribution · the compact dossier list and the 30-day daily-spend stats.

import type { Charge } from "@/lib/api";
import { fmtUsd, shortHex } from "./ui";

const OK_STATUSES = new Set(["settled", "succeeded", "ok", "confirmed", "paid"]);

export type FeedRow = { ch: Charge; cardName: string };

export const chargeOk = (ch: Charge) => OK_STATUSES.has(ch.status);

export function railLabel(kind: string): string {
  if (kind.includes("fiat") || kind.includes("visa") || kind.includes("stripe")) return "fiat";
  if (kind.includes("x402") || kind.includes("pay") || kind.includes("transfer")) return "x402";
  return kind;
}

// raw hex anywhere in a memo reads like a register dump · shorten every run in place
const HEXISH = /0x[0-9a-fA-F]{10,}/g;
export function tidyMemo(s: string): string {
  return s.replace(HEXISH, (m) => shortHex(m, 6, 4));
}

/** "jun 9 · 14:32" · the charge row's quiet timestamp */
export function fmtWhen(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  const day = d.toLocaleDateString("en-US", { month: "short", day: "numeric" }).toLowerCase();
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
  return `${day} · ${time}`;
}

export function feedStats(feed: FeedRow[]) {
  const ok = feed.filter((r) => chargeOk(r.ch));
  const okCount = ok.length;
  // one convention everywhere: spend = amount + fee, so the headline, the
  // today delta, and the daily bars all reconcile
  const cost = (r: FeedRow) => (parseFloat(r.ch.amount) || 0) + (parseFloat(r.ch.fee) || 0);
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const dayStart = Math.floor(midnight.getTime() / 1000);
  const today = ok.reduce((s, r) => (r.ch.at >= dayStart ? s + cost(r) : s), 0);
  const total30 = ok.reduce((s, r) => s + cost(r), 0);
  const now = Math.floor(Date.now() / 1000);
  const dayLabels = Array.from({ length: 30 }, (_, i) =>
    new Date((now - (29 - i) * 86400) * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" }).toLowerCase(),
  );
  // the barcode strip wants finer grain: 4-hour bins, 180 across the 30 days
  const bins = new Array(180).fill(0);
  for (const r of ok) {
    const age = now - r.ch.at;
    if (age >= 0 && age < 30 * 86400) {
      const idx = 179 - Math.floor(age / 14400);
      if (idx >= 0 && idx < 180) bins[idx] += cost(r);
    }
  }
  const binLabels = bins.map((_, i) => dayLabels[Math.min(29, Math.floor(i / 6))]);
  return { today, total30, count: feed.length, okCount, dayLabels, bins, binLabels };
}

// The compact charge list: dossier rows (time · name+card · rail · amount ·
// state · receipt), scrolling inside the slab so the fold never moves.

export function ChargeList({ rows, empty }: { rows: FeedRow[]; empty: string }) {
  return (
    <div className="alist num" data-testid="charges">
      {rows.length === 0 && <div className="aempty">{empty}</div>}
      {rows.map(({ ch, cardName }) => {
        const ok = chargeOk(ch);
        return (
          <div className="arow" key={ch.id}>
            <span className="a-time">{fmtWhen(ch.at)}</span>
            <span>
              <div className="a-name">{ch.memo ? tidyMemo(ch.memo) : ch.to ? shortHex(ch.to, 8, 4) : railLabel(ch.kind)}</div>
              <div className="a-sub">{cardName}</div>
            </span>
            <span>
              <span className="railchip">{railLabel(ch.kind)}</span>
            </span>
            <span className="a-amt">
              <span className="cur">$</span>
              {fmtUsd(ch.amount).slice(1)}
            </span>
            <span className={`a-state${ok ? "" : " blocked"}`}>
              <span className="gdot" />
              {ok ? "settled" : ch.status}
            </span>
            <span className="a-rcpt">
              {ch.tx ? (
                <a href={`https://basescan.org/tx/${ch.tx}`} target="_blank" rel="noreferrer">
                  {shortHex(ch.tx, 6, 4)}
                </a>
              ) : (
                <span>·</span>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}
