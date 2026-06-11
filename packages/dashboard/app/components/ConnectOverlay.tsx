"use client";

// The credential overlay: "Connect agent" opens a scrim + centered floating
// panel (same language as the avatar menu) holding the card URL, the
// per-harness install chips, and the claude.ai hint. The page never moves;
// the card keeps its flip as pure object delight. Esc / scrim / ✕ close it.

import { useEffect } from "react";
import type { CardState } from "@/lib/api";
import { ConnectChips } from "./Authority";

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
    <div className="ovwrap" onClick={onClose}>
      <div className="overlay" role="dialog" aria-modal="true" aria-label="connect an agent" onClick={(e) => e.stopPropagation()}>
        <div className="ovhead">
          <div>
            <span className="lbl">connect an agent</span>
            <h2 className="ovtitle">{card.name}</h2>
          </div>
          <button className="closex" onClick={onClose} aria-label="close">
            ✕
          </button>
        </div>
        <div className="ovurl" data-testid="card-url">
          {url}
        </div>
        <ConnectChips url={url} cardName={card.name} onRotate={onRotate} busy={rotating} />
        <p className="ovnote">
          the url is the credential · anyone holding it can spend within this card's terms · rotate it if it leaks
        </p>
      </div>
    </div>
  );
}
