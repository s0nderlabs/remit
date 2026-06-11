"use client";

// Shared visual primitives: the silk guilloche, the dot-matrix chip, odometer
// count-up, daily-spend bars, status pills, formatting helpers.

import { useEffect, useId, useMemo, useRef, useState } from "react";

// ---------- formatting ----------

/** "1247.5" -> ["1,247", "50"] (whole, cents) for the big tabular figure */
export function splitAmount(v: string | number | null | undefined): [string, string] {
  const n = typeof v === "string" ? parseFloat(v) : (v ?? 0);
  if (!isFinite(n)) return ["0", "00"];
  let whole = Math.floor(Math.abs(n));
  let cents = Math.round((Math.abs(n) - whole) * 100);
  if (cents === 100) {
    // .995+ rounds up to the next dollar — carry, or we'd render "$9.100"
    whole += 1;
    cents = 0;
  }
  return [`${n < 0 ? "-" : ""}${whole.toLocaleString("en-US")}`, cents.toString().padStart(2, "0")];
}

export function fmtUsd(v: string | number | null | undefined): string {
  const [w, c] = splitAmount(v);
  return `$${w}.${c}`;
}

export function shortHex(s: string | null | undefined, head = 6, tail = 4): string {
  if (!s) return "";
  return s.length <= head + tail + 1 ? s : `${s.slice(0, head)}…${s.slice(-tail)}`;
}

/** derive the card "PAN": four 4-hex groups from a 0x address/id */
export function panGroups(hex: string | null | undefined): string[] {
  const h = (hex ?? "").replace(/^0x/i, "").toLowerCase().padEnd(16, "0");
  return [`0x${h.slice(0, 4)}`, h.slice(4, 8), h.slice(8, 12), h.slice(12, 16)];
}

export function fmtClock(unixSec: number): string {
  return new Date(unixSec * 1000).toLocaleTimeString("en-GB", { hour12: false });
}

export function fmtCountdown(unixSec: number | null): string {
  if (!unixSec) return "·";
  const d = unixSec * 1000 - Date.now();
  if (d <= 0) return "now";
  const days = Math.floor(d / 86400000);
  const hours = Math.floor((d % 86400000) / 3600000);
  if (days > 0) return `${days}d ${String(hours).padStart(2, "0")}h`;
  const mins = Math.floor((d % 3600000) / 60000);
  return `${hours}h ${String(mins).padStart(2, "0")}m`;
}

export function periodLabel(seconds: number | undefined): string {
  if (!seconds) return "";
  if (seconds <= 86400) return "day";
  if (seconds <= 604800) return "wk";
  return "mo";
}

// ---------- count-up (the live-data theater) ----------

const easeOut = (t: number) => 1 - Math.pow(2, -10 * t);

// The full odometer sweep plays once per session (the first dashboard entry) so the
// daily driver stays calm afterwards; a "#demo" hash replays the full choreography
// on every view for filming (hash, not ?query — Privy strips query params).
let theaterDone = false;
const demoMode = () => typeof window !== "undefined" && window.location.hash.includes("demo");
const theaterActive = () => demoMode() || !theaterDone;

/** odometer: full sweep on the first data landing of the session, quick tweens after */
export function useCountUp(target: number, mountMs = 1400, updateMs = 450): number {
  const sweepRef = useRef(theaterActive());
  const sweptRef = useRef(false);
  const [value, setValue] = useState(sweepRef.current ? 0 : target);
  const fromRef = useRef(sweepRef.current ? 0 : target);
  useEffect(() => {
    // the session's theater window closes shortly after this view settles
    const t = setTimeout(() => {
      if (!demoMode()) theaterDone = true;
    }, 3000);
    return () => clearTimeout(t);
  }, []);
  useEffect(() => {
    if (typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setValue(target);
      fromRef.current = target;
      return;
    }
    const from = fromRef.current;
    if (from === target) return;
    // the first nonzero target is the headline moment: full sweep when the
    // theater is open, instant snap when it already played this session
    const firstReal = !sweptRef.current;
    if (firstReal) sweptRef.current = true;
    const dur = firstReal ? (sweepRef.current ? mountMs : 0) : updateMs;
    if (dur === 0) {
      setValue(target);
      fromRef.current = target;
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / dur);
      const v = from + (target - from) * easeOut(p);
      setValue(v);
      if (p < 1) raf = requestAnimationFrame(tick);
      else fromRef.current = target;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, mountMs, updateMs]);
  return value;
}

// ---------- silk guilloche ----------
// The spectrum lives ONLY here: every accent strand carries one shared horizontal
// gradient (the silk ramp) at .55; counter-woven ink strands stay slate at .08.

const SPECTRUM = ["#FFB23E", "#FF5C8A", "#E14FD7", "#7A5CFF", "#2D9FF7"];

function guillochePaths(W: number, H: number, n: number, amp: number) {
  const out: { d: string; accent: boolean }[] = [];
  for (let f = 0; f < 2; f++) {
    for (let i = 0; i < n; i++) {
      const ph = (i / n) * Math.PI * 2;
      const a = amp * (0.55 + 0.45 * Math.sin(i * 1.7));
      const dir = f === 0 ? 1 : -1;
      let d = "";
      for (let x = 0; x <= W; x += 8) {
        const y = H / 2 + dir * Math.sin(x / 46 + ph) * a + Math.sin(x / 130 + ph * 2) * a * 0.5;
        d += (x === 0 ? "M" : "L") + x.toFixed(1) + "," + y.toFixed(1);
      }
      out.push({ d, accent: f === 0 });
    }
  }
  return out;
}

export function Guilloche({
  width,
  height,
  strands = 13,
  amp = 26,
  accentOpacity = 0.55,
  inkOpacity = 0.08,
}: {
  width: number;
  height: number;
  strands?: number;
  amp?: number;
  accentOpacity?: number;
  inkOpacity?: number;
}) {
  const gid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const paths = useMemo(() => guillochePaths(width, height, strands, amp), [width, height, strands, amp]);
  return (
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
      <defs>
        <linearGradient id={`silk${gid}`} x1="0" y1="0" x2="1" y2="0">
          {SPECTRUM.map((c, i) => (
            <stop key={c} offset={(i / (SPECTRUM.length - 1)).toFixed(2)} stopColor={c} />
          ))}
        </linearGradient>
      </defs>
      {paths.map((p, i) => (
        <path
          key={i}
          d={p.d}
          fill="none"
          stroke={p.accent ? `url(#silk${gid})` : "#141417"}
          strokeWidth={0.7}
          opacity={p.accent ? accentOpacity : inkOpacity}
        />
      ))}
    </svg>
  );
}

// ---------- verb icons (the quiet actions beside Connect agent) ----------

export function IconSnowflake({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden>
      <path d="M12 3v18M4.2 7.5l15.6 9M19.8 7.5l-15.6 9" />
      <path d="M12 3l-2.2 2.2M12 3l2.2 2.2M12 21l-2.2-2.2M12 21l2.2-2.2" />
    </svg>
  );
}

export function IconRevoke({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M6 6l12 12" />
    </svg>
  );
}

// ---------- dot-matrix chip ----------
// Animated: the chip "ticks" like data moving through it — each beat one base
// dot rests while two transient dots light up. Deterministic per frame, slow,
// and disabled under prefers-reduced-motion.

const CHIP_ON = [1, 2, 3, 8, 12, 15, 19, 22, 23, 24, 25];
const CHIP_SET = new Set(CHIP_ON);

export function ChipDots() {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const t = setInterval(() => setFrame((f) => (f + 1) % 308), 850);
    return () => clearInterval(t);
  }, []);
  const resting = CHIP_ON[frame % CHIP_ON.length];
  const lit = [(frame * 5 + 6) % 28, (frame * 11 + 17) % 28];
  return (
    <div className="chipdots" aria-hidden>
      {Array.from({ length: 28 }, (_, i) => {
        const on = (CHIP_SET.has(i) && i !== resting) || lit.includes(i);
        return <i key={i} className={on ? "a" : undefined} />;
      })}
    </div>
  );
}

// ---------- the barcode histogram ----------
// Micro-bars at whisper volume; the scrubber owns all focus (a 1px ink line +
// bold numeral tooltip). Single hue, no gridlines, no legend — the qclay chart.

export function Barcode({
  values,
  labels,
  width = 560,
  height = 64,
}: {
  values: number[];
  labels: string[];
  width?: number;
  height?: number;
}) {
  const [pick, setPick] = useState<number | null>(null);
  const max = Math.max(...values, 1e-9);
  const n = values.length;
  const gap = 3;
  const bw = Math.max(1.6, (width - gap * (n - 1)) / n);
  const step = bw + gap;
  return (
    <div
      className="barcode"
      onMouseLeave={() => setPick(null)}
      onMouseMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        const i = Math.round(((e.clientX - r.left) / r.width) * (n - 1));
        setPick(Math.max(0, Math.min(n - 1, i)));
      }}
    >
      <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden>
        {values.map((v, i) => {
          // zero days still print a 3px tick — the barcode texture is the point
          const h = v > 0 ? Math.max(5, (v / max) * (height - 16)) : 3;
          return (
            <rect
              key={i}
              x={(i * step).toFixed(1)}
              y={(height - h).toFixed(1)}
              width={bw.toFixed(1)}
              height={h.toFixed(1)}
              rx={1}
              className={i === pick ? "bk on" : "bk"}
            />
          );
        })}
        {pick !== null && (
          <line
            x1={(pick * step + bw / 2).toFixed(1)}
            x2={(pick * step + bw / 2).toFixed(1)}
            y1={0}
            y2={height}
            className="bkline"
          />
        )}
      </svg>
      {pick !== null && (
        <div className="bktip" style={{ left: `${(((pick * step + bw / 2) / width) * 100).toFixed(1)}%` }}>
          <b>{fmtUsd(values[pick])}</b>
          <span>{labels[pick]}</span>
        </div>
      )}
    </div>
  );
}

// ---------- status ----------

export type CardStatus = "active" | "frozen" | "revoked" | "expired" | "nuked" | string;

export const isDead = (s: CardStatus) => s !== "active" && s !== "frozen";

/** lowercase status word with a state dot — quieter than a pill, reads like a fact */
export function StatusPill({ status }: { status: CardStatus }) {
  const tone = status === "active" ? "live" : status === "frozen" ? "frozen" : "dead";
  return (
    <span className={`statusword ${tone}`} data-testid="status-pill">
      <b />
      {status}
    </span>
  );
}
