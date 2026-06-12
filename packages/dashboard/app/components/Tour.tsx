"use client";

// The live tour: a spotlight that glides across the REAL dashboard chrome,
// one cutout at a time, a floating tip riding beside it. Run over the
// specimen card (a local-only stand-in, never on-chain) so a zero-card
// wallet still has true anatomy to point at. The overlay swallows every
// page interaction; only the tip's own controls are live. The cutout is a
// rounded rect whose giant box-shadow paints the scrim, so the highlighted
// chrome stays fully crisp and visible.

import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";

export type TourStep = {
  key: string;
  target: string; // CSS selector for the chrome being explained
  title: string;
  body: string;
};

const PAD = 10; // breathing room around the target inside the cutout
const TIP_W = 296;

export function Tour({
  steps,
  onDone,
  onIssue,
}: {
  steps: TourStep[];
  onDone: () => void; // skip or finish without issuing
  onIssue: () => void; // the final call to action
}) {
  const [i, setI] = useState(0);
  const [box, setBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const step = steps[i];
  const last = i === steps.length - 1;

  const measure = useCallback(() => {
    const el = document.querySelector(step.target);
    if (!el) {
      setBox(null);
      return;
    }
    const r = el.getBoundingClientRect();
    setBox({ x: r.left - PAD, y: r.top - PAD, w: r.width + PAD * 2, h: r.height + PAD * 2 });
  }, [step.target]);

  useEffect(() => {
    const el = document.querySelector(step.target);
    if (!el) {
      // a target can be absent (responsive layout) · skip it rather than strand the tour
      if (last) onDone();
      else setI((n) => n + 1);
      return;
    }
    el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    measure();
    const settle = setTimeout(measure, 380); // after the smooth scroll lands
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      clearTimeout(settle);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [measure, step.target, last, onDone]);

  if (!box) return null;

  // tip placement: below the cutout when there's room, else above · clamped to the viewport
  const vw = typeof window !== "undefined" ? window.innerWidth : 1440;
  const vh = typeof window !== "undefined" ? window.innerHeight : 900;
  const below = box.y + box.h + 220 < vh;
  const tipLeft = Math.min(Math.max(box.x, 12), vw - TIP_W - 12);
  const tipStyle: React.CSSProperties = below
    ? { left: tipLeft, top: box.y + box.h + 14 }
    : { left: tipLeft, bottom: vh - box.y + 14 };

  return (
    <div className="tour" data-testid="tour">
      <motion.div
        className="tourcut"
        initial={false}
        animate={{ left: box.x, top: box.y, width: box.w, height: box.h }}
        transition={{ type: "spring", stiffness: 380, damping: 36 }}
      />
      {/* mode="wait": the tip is position:fixed with a per-step anchor, so a
          cross-fade would show two cards at different anchors mid-swap */}
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={step.key}
          className="tourtip"
          style={tipStyle}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0, transition: { duration: 0.3, ease: [0.22, 1, 0.36, 1] } }}
          exit={{ opacity: 0, y: -5, transition: { duration: 0.15, ease: "easeOut" } }}
        >
          <div className="tourtitle">{step.title}</div>
          <p className="tourbody">{step.body}</p>
          <div className="tourfoot">
            <span className="frsteps" aria-hidden>
              {steps.map((s, n) => (
                <i key={s.key} className={n === i ? "on" : undefined} />
              ))}
            </span>
            <button className="tourghost" onClick={onDone} data-testid="tour-skip">
              Skip
            </button>
            {last ? (
              <button className="dbtn" onClick={onIssue} data-testid="tour-issue">
                Issue Your First Card
              </button>
            ) : (
              <button className="dbtn" onClick={() => setI(i + 1)} data-testid="tour-next">
                Next
              </button>
            )}
          </div>
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
