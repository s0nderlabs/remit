"use client";

// The destructive-action modal. Every irreversible verb (revoke, nuke) walks
// the same staircase: confirm -> busy -> done | error, inside one floating
// panel. The phases crossfade in place; the scrim and panel are motion-driven.
// Rendered through a portal to <body>: callers often live inside motion-
// transformed ancestors (filter/transform create containing blocks that would
// trap position:fixed and pin the scrim to the caller's box).
// Testids follow the verb: `${prefix}-confirm`, `${prefix}-busy`, `${prefix}-done`.

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";

export type DangerPhase = "confirm" | "busy" | "done" | "error";

const panelIn = {
  initial: { opacity: 0, y: 22, scale: 0.96 },
  animate: { opacity: 1, y: 0, scale: 1, transition: { type: "spring", stiffness: 380, damping: 30 } },
  exit: { opacity: 0, y: 12, scale: 0.97, transition: { duration: 0.16, ease: "easeIn" } },
} as const;

const phaseSwap = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.22, ease: [0.16, 1, 0.3, 1] } },
  exit: { opacity: 0, y: -8, transition: { duration: 0.14, ease: "easeIn" } },
} as const;

export function DangerModal({
  open,
  phase,
  title,
  body,
  confirmLabel,
  busyNote,
  busyHint = "on-chain authority takes a moment",
  doneTitle = "done",
  doneNote,
  errorNote,
  onConfirm,
  onClose,
  prefix,
}: {
  open: boolean;
  phase: DangerPhase;
  title: string;
  body: React.ReactNode;
  confirmLabel: string;
  busyNote: React.ReactNode;
  /** the quiet line beside the spinner · override for verbs that never touch the chain */
  busyHint?: string;
  doneTitle?: string;
  doneNote: React.ReactNode;
  errorNote?: React.ReactNode;
  onConfirm: () => void;
  onClose: () => void;
  prefix: string; // "revoke" | "nuke" · drives the testids
}) {
  // portal target exists only client-side
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Escape closes, except mid-flight; the page behind never scrolls
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && phase !== "busy") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, phase, onClose]);

  if (!mounted) return null;
  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          className="cscrim"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: { duration: 0.18 } }}
          onClick={(e) => {
            if (e.target === e.currentTarget && phase !== "busy") onClose();
          }}
        >
          <motion.div className="confirm" role="alertdialog" aria-modal="true" aria-label={title} {...panelIn}>
            <div className={`cicon${phase === "done" ? " ok" : ""}`} aria-hidden>
              <AnimatePresence mode="wait" initial={false}>
                {phase === "done" ? (
                  <motion.svg
                    key="ok"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    initial={{ scale: 0.6, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1, transition: { type: "spring", stiffness: 420, damping: 22 } }}
                  >
                    <motion.path
                      d="M5 12.5l4.6 4.5L19 7.5"
                      initial={{ pathLength: 0 }}
                      animate={{ pathLength: 1, transition: { duration: 0.4, ease: "easeOut", delay: 0.08 } }}
                    />
                  </motion.svg>
                ) : (
                  <motion.svg
                    key="warn"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    initial={{ scale: 0.8, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1, transition: { duration: 0.2 } }}
                  >
                    <circle cx="12" cy="12" r="8.5" />
                    <path d="M6 6l12 12" />
                  </motion.svg>
                )}
              </AnimatePresence>
            </div>

            <AnimatePresence mode="wait" initial={false}>
              {phase === "confirm" && (
                <motion.div key="confirm" {...phaseSwap}>
                  <h3>{title}</h3>
                  <p>{body}</p>
                  <div className="cbtns">
                    <button className="mghost" onClick={onClose}>
                      cancel
                    </button>
                    <button className="cdanger" onClick={onConfirm} data-testid={`${prefix}-confirm`}>
                      {confirmLabel}
                    </button>
                  </div>
                </motion.div>
              )}
              {phase === "busy" && (
                <motion.div key="busy" {...phaseSwap}>
                  <h3>{title}</h3>
                  <p data-testid={`${prefix}-busy`}>{busyNote}</p>
                  <div className="cspinrow">
                    <span className="cspin" aria-hidden />
                    <span className="cspinlbl">{busyHint}</span>
                  </div>
                </motion.div>
              )}
              {phase === "done" && (
                <motion.div key="done" {...phaseSwap}>
                  <h3>{doneTitle}</h3>
                  <p data-testid={`${prefix}-done`}>{doneNote}</p>
                  <div className="cbtns">
                    <button className="dbtn" onClick={onClose}>
                      close
                    </button>
                  </div>
                </motion.div>
              )}
              {phase === "error" && (
                <motion.div key="error" {...phaseSwap}>
                  <h3>{title}</h3>
                  <p className="err">{errorNote}</p>
                  <div className="cbtns">
                    <button className="mghost" onClick={onClose}>
                      close
                    </button>
                    <button className="cdanger" onClick={onConfirm}>
                      try again
                    </button>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
