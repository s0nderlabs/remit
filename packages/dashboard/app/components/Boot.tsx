"use client";

// Boot: the loading layer. The wordmark rises in once; the seal ring beneath
// it draws with REAL boot progress (Privy init -> wallet -> probe), closing
// exactly when the app is ready. The layer then blurs out over the already-
// mounted screen underneath - a handoff, not a swap. Same seal vocabulary as
// a live card's status glyph: boot finishes when the seal closes.

import { motion } from "motion/react";

export function Boot({
  progress,
  note,
  slow,
  onReset,
}: {
  progress: number; // 0..1, stepped by the boot gates (never decreases)
  note: string;
  slow?: boolean;
  onReset?: () => void;
}) {
  return (
    <motion.div
      className="boot"
      initial={{ opacity: 1 }}
      exit={{ opacity: 0, scale: 1.035, filter: "blur(10px)", transition: { duration: 0.5, ease: [0.16, 1, 0.3, 1] } }}
      data-testid="boot"
    >
      <motion.span
        className="bootmark"
        initial={{ opacity: 0, y: 14, filter: "blur(8px)" }}
        animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
        transition={{ type: "spring", stiffness: 90, damping: 20 }}
      >
        remit
      </motion.span>
      <motion.svg
        className="bootseal"
        viewBox="0 0 20 20"
        aria-hidden
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.5, delay: 0.25 }}
      >
        <circle className="track" cx="10" cy="10" r="8" pathLength="1" />
        <circle className="arc" cx="10" cy="10" r="8" pathLength="1" style={{ strokeDashoffset: 1 - progress }} />
        <circle className="core" cx="10" cy="10" r="3" style={{ opacity: progress >= 1 ? 1 : 0 }} />
      </motion.svg>
      <motion.span
        className="bootnote"
        // the note swaps as gates pass; key re-runs the rise so each step lands softly
        key={note}
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, delay: 0.15 }}
      >
        {note}
      </motion.span>
      {slow && (
        <div className="bootstuck" data-testid="boot-stuck">
          <p>Still going · the session on this device may be wedged.</p>
          <div className="row" style={{ justifyContent: "center" }}>
            <button onClick={() => window.location.reload()}>Reload</button>
            {onReset && (
              <button onClick={onReset} data-testid="boot-reset">
                Sign Out and Start Over
              </button>
            )}
          </div>
        </div>
      )}
    </motion.div>
  );
}
