"use client";

// The card object, two-sided. Front = the essentials only (wordmark, ticking
// chip, PAN, holder). The back is sparse and honest, like a real card: the
// magstripe, a signature strip, two quiet facts, the brand line. No secrets
// live on the card · the credential opens in the connect overlay, so the flip
// is pure object delight. Hovering a live card sets the silk band flowing.
// Physical states are quiet now: frozen = frost + a corner tag, dead =
// grayscale + a corner tag. No stamps.

import { useRef, useState } from "react";
import type { CardState, FiatCard } from "@/lib/api";
import { capWord, ChipDots, Guilloche, IconSnowflake, isDead, panGroups, shortHex } from "./ui";

export function CardHero({
  card,
  holder,
  agentAddress,
  fiat,
  fiatPending = false,
  flipped,
  onFlip,
}: {
  card: CardState;
  holder?: string;
  agentAddress?: string;
  fiat?: FiatCard | null; // the linked test-mode Visa · real PAN/exp on the face, cvc on the back
  fiatPending?: boolean; // credential fetch in flight · hold placeholder dots, never flash the hex PAN
  flipped: boolean;
  onFlip: () => void;
}) {
  const flipRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState(false);
  const dead = isDead(card.status);
  const frozen = card.status === "frozen";
  const stateClass = dead ? "cardstate-dead" : frozen ? "cardstate-frozen" : "cardstate-active";

  // a fiat-linked card wears its REAL credentials (test-mode Visa); a card whose
  // credential fetch is still in flight holds quiet dots (no hex-then-Visa
  // flash); only a settled UNLINKED card falls back to the hex pseudo-PAN
  const visa = fiat?.linked && fiat.number ? fiat : null;
  const pan = visa
    ? (visa.number!.replace(/\s+/g, "").match(/.{1,4}/g) ?? [])
    : fiatPending
      ? ["••••", "••••", "••••", "••••"]
      : panGroups(agentAddress ?? card.card_id);
  const exp = visa ? `${String(visa.exp_month).padStart(2, "0")}/${String(visa.exp_year).slice(-2)}` : null;
  const brand = visa ? capWord(visa.brand ?? "Visa") : null;

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
          title={flipped ? "Flip to Front" : "Flip the Card"}
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
                    Frozen
                  </span>
                )}
                {dead && <span className="ctag dead">{capWord(card.status)}</span>}
              </div>
              <ChipDots />
              <div className="num">
                {pan.map((g, i) => (
                  <span key={i}>{g}</span>
                ))}
                {brand && <span className="brandmark">{brand}</span>}
              </div>
              <div className="holderline">
                <span className="hname">{holder ?? card.name}</span>
                {exp && <span className="hexp">{exp}</span>}
              </div>
            </div>
            <div className="frost" />
          </div>

          <div className="card face back">
            <div className="bstrip" />
            <div className="backin">
              <span className="siglabel">Authorized Delegate</span>
              <div className="sigstrip">
                <span className="signame">{holder ?? card.name}</span>
                {visa?.cvc && (
                  <span className="sigcvc num" title="CVC">
                    {visa.cvc}
                  </span>
                )}
              </div>
              <span className="bfacts data">
                Base · mainnet{agentAddress ? ` · ${shortHex(agentAddress)}` : ""}
                {brand ? ` · ${brand} test mode` : ""}
              </span>
              <p className="backhint">
                {dead
                  ? "This card's authority is gone."
                  : visa
                    ? "The Visa is real (test mode) · every charge it makes still answers to this card's on-chain budget."
                    : "No secrets on this card · connecting an agent reveals the credential."}
              </p>
              <div className="bfoot">
                <span className="bwm">remit</span>
                <span className="bnote">Authority, lent not given.</span>
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
