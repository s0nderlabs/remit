"use client";

// The credential overlay: "Connect agent" opens a scrim + centered floating
// panel (same language as the avatar menu) holding the card URL, the
// per-harness install chips, and the claude.ai hint. The page never moves;
// the card keeps its flip as pure object delight. Esc / scrim / ✕ close it.
// Mount/unmount rides AnimatePresence at the call site.

import { useEffect } from "react";
import { motion } from "motion/react";
import type { CardState } from "@/lib/api";
import { ConnectChips, UrlBox } from "./Authority";
import { IconClose } from "./ui";

export function ConnectOverlay({
  card,
  url,
  onRotate,
  rotating,
  onClose,
}: {
  card: CardState;
  url: string;
  onRotate?: () => void;
  rotating?: boolean;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  return (
    <motion.div
      className="ovwrap"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.18 } }}
      onClick={onClose}
    >
      <motion.div
        className="overlay"
        role="dialog"
        aria-modal="true"
        aria-label="Connect an Agent"
        initial={{ opacity: 0, y: 22, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1, transition: { type: "spring", stiffness: 380, damping: 30 } }}
        exit={{ opacity: 0, y: 12, scale: 0.98, transition: { duration: 0.16 } }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="ovhead">
          <div>
            <span className="lbl">Connect an Agent</span>
            <h2 className="ovtitle">{card.name}</h2>
          </div>
          <button className="closex" onClick={onClose} aria-label="Close">
            <IconClose />
          </button>
        </div>
        <UrlBox url={url} testid="card-url" />
        <ConnectChips url={url} cardName={card.name} />
        <div className="ovfoot">
          <p className="ovnote">
            The URL is the credential · anyone holding it can spend within this card's terms · rotate it if it leaks
          </p>
          {onRotate && (
            <button className="ovrotate" onClick={onRotate} disabled={rotating} data-testid="rotate-url" title="Invalidate this URL and mint a new one">
              {rotating ? "Rotating…" : "Rotate URL"}
            </button>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}
