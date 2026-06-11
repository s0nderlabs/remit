"use client";

// The card object, two-sided. Front = the essentials only (wordmark, ticking
// chip, PAN, holder). The back is sparse and honest, like a real card: the
// magstripe, a signature strip, two quiet facts, the brand line. No secrets
// live on the card · the credential opens in the connect overlay, so the flip
// is pure object delight. Hovering a live card sets the silk band flowing.
// Physical states are quiet now: frozen = frost + a corner tag, dead =
// grayscale + a corner tag. No stamps.

import { useRef, useState } from "react";
import type { CardState } from "@/lib/api";
import { ChipDots, Guilloche, IconSnowflake, isDead, panGroups, shortHex } from "./ui";

export function CardHero({
  card,
  holder,
  agentAddress,
  flipped,
  onFlip,
}: {
  card: CardState;
  holder?: string;
  agentAddress?: string;
  flipped: boolean;
  onFlip: () => void;
}) {
  const flipRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState(false);
  const dead = isDead(card.status);
  const frozen = card.status === "frozen";
  const stateClass = dead ? "cardstate-dead" : frozen ? "cardstate-frozen" : "cardstate-active";

  const pan = panGroups(agentAddress ?? card.card_id);

  const onMove = (e: React.MouseEvent) => {
    const el = flipRef.current;
    if (!el || flipped || dead || frozen) return;
    const r = el.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width - 0.5;
    const y = (e.clientY - r.top) / r.height - 0.5;
    el.style.transform = `rotateY(${x * 5}deg) rotateX(${-y * 5}deg)`;
  };
  const onLeave = () => {
    setHover(false);
    if (flipRef.current && !flipped) flipRef.current.style.transform = "";
  };
  const flip = () => {
    // the inline tilt transform would override the class flip · clear it first
    if (flipRef.current) flipRef.current.style.transform = "";
    onFlip();
  };

  return (
    <div
      className={`cardwrap ${stateClass}`}
      onMouseMove={onMove}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={onLeave}
    >
      <div className="cardbox">
        <div
          className={`cardflip${flipped ? " flipped" : ""}`}
          ref={flipRef}
          onClick={flip}
          data-testid="card-hero"
          title={flipped ? "flip to front" : "flip the card"}
        >
          <div className="card face front">
            <div className="band">
              <Guilloche width={472} height={88} animate={hover && !dead && !frozen && !flipped} />
            </div>
            <div className="inner">
              <div className="row1">
                <span className="wm">remit</span>
                {frozen && (
                  <span className="ctag frozen">
                    <IconSnowflake size={10} />
                    frozen
                  </span>
                )}
                {dead && <span className="ctag dead">{card.status}</span>}
              </div>
              <ChipDots />
              <div className="num">
                {pan.map((g, i) => (
                  <span key={i}>{g}</span>
                ))}
              </div>
              <div className="holderline">{holder ?? card.name}</div>
            </div>
            <div className="frost" />
          </div>

          <div className="card face back">
            <div className="bstrip" />
            <div className="backin">
              <span className="siglabel">authorized delegate</span>
              <div className="sigstrip">
                <span className="signame">{holder ?? card.name}</span>
              </div>
              <span className="bfacts data">
                base · mainnet{agentAddress ? ` · ${shortHex(agentAddress)}` : ""}
              </span>
              <p className="backhint">
                {dead ? "this card's authority is gone." : "no secrets on this card · connecting an agent reveals the credential."}
              </p>
              <div className="bfoot">
                <span className="bwm">remit</span>
                <span className="bnote">authority, lent not given.</span>
              </div>
            </div>
            <div className="bband">
              <Guilloche width={472} height={56} strands={7} amp={10} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
