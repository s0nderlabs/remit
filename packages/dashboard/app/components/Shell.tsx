"use client";

// The shell. A floating glass pill carries the chrome: wordmark, the view
// segments (the one control that always felt right), network + avatar. The
// stage below sits on a porcelain canvas: the card object with its wallet of
// minis beneath, the authority panel beside it, content panels after.

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api, type CardState, type TreeNode } from "@/lib/api";
import type { useRemit } from "../useRemit";
import { CardHero } from "./CardHero";
import { StageAuthority } from "./Authority";
import { ConnectOverlay } from "./ConnectOverlay";
import { Guilloche, isDead, shortHex } from "./ui";

type Remit = ReturnType<typeof useRemit>;

export function Cockpit({
  card,
  kAgent,
  roots,
  currentId,
  back,
  remit,
  refresh,
  onLogout,
  address,
  subcardCount = 0,
  tabs,
  view,
  onView,
  onIssue,
  nukeable = false,
  children,
}: {
  card: CardState | null;
  kAgent?: string;
  roots?: TreeNode[]; // root cards: the mini rack under the hero card
  currentId?: string | null;
  back?: { href: string; label: string };
  remit: Remit;
  refresh: () => void | Promise<void>;
  onLogout?: () => void;
  address?: string;
  subcardCount?: number;
  tabs?: { id: string; label: string }[];
  view?: string;
  onView?: (id: string) => void;
  onIssue?: () => void; // the ghost "+" mini in the rack
  nukeable?: boolean; // wallet has live cards: the nuke verb shows in the avatar menu
  children: React.ReactNode;
}) {
  // Connect state lives here so the verb (in StageAuthority) can open the
  // credential overlay — the page never moves, the card keeps its flip.
  const [flipped, setFlipped] = useState(false);
  const [connectUrl, setConnectUrl] = useState<string | null>(null);
  const [connectOpen, setConnectOpen] = useState(false);
  const [rotating, setRotating] = useState(false);
  const cardId = card?.card_id;

  useEffect(() => {
    // switching cards: face front again, drop the previous card's credential
    setFlipped(false);
    setConnectOpen(false);
    setConnectUrl(null);
  }, [cardId]);

  // stable identity: the overlay's Escape/scroll-lock effect depends on it,
  // and a fresh arrow each 3s poll would churn the listener
  const closeConnect = useCallback(() => setConnectOpen(false), []);

  const connect = cardId
    ? async () => {
        setConnectUrl((await api.url(cardId)).card_url);
        setConnectOpen(true);
      }
    : undefined;

  const rotate = cardId
    ? async () => {
        setRotating(true);
        try {
          setConnectUrl((await api.rotate(cardId)).card_url);
        } catch (e) {
          console.error("rotate failed", e);
        } finally {
          setRotating(false);
        }
      }
    : undefined;

  return (
    <div className="frame">
      <div className="navwrap">
        <header className="navbar">
          <Link className="brand" href="/">
            remit
          </Link>
          {card && tabs && onView ? (
            <div className="toggle">
              {tabs.map((t) => (
                <button
                  key={t.id}
                  className={`tog${view === t.id ? " active" : ""}`}
                  onClick={() => onView(t.id)}
                  data-testid={`tab-${t.id}`}
                >
                  {t.label}
                </button>
              ))}
            </div>
          ) : (
            <span />
          )}
          <div className="navright">
            <span className="net">
              <b />
              base · mainnet
            </span>
            <ProfileMenu address={address} onLogout={onLogout} remit={remit} refresh={refresh} nukeable={nukeable} />
          </div>
        </header>
      </div>

      <main className="stage">
        <div className="stagein">
          {back && (
            <Link className="backlink" href={back.href}>
              ← {back.label}
            </Link>
          )}

          <section className="hero">
            {card ? (
              <>
                <div className="cardside">
                  <CardHero
                    card={card}
                    holder={card.name}
                    agentAddress={kAgent}
                    flipped={flipped}
                    onFlip={() => setFlipped((f) => !f)}
                  />
                  {(roots ?? []).length > 0 && <MiniRack roots={roots!} currentId={currentId} onIssue={onIssue} />}
                </div>
                <StageAuthority
                  key={card.card_id} // per-card odometer: never tween between two cards' balances
                  card={card}
                  remit={remit}
                  refresh={refresh}
                  subcardCount={subcardCount}
                  onConnect={connect}
                />
              </>
            ) : (
              <div className="ghostcard">
                <span>No cards yet</span>
                <p>Issue your first card below, then hand it to an agent.</p>
              </div>
            )}
          </section>

          <div className="content">{children}</div>
        </div>
      </main>

      {card && connectOpen && connectUrl && (
        <ConnectOverlay card={card} url={connectUrl} onRotate={rotate} rotating={rotating} onClose={closeConnect} />
      )}
    </div>
  );
}

// The wallet: every root card as a miniature card object, the current one
// lifted; the ghost "+" mini issues a new one. Cards ARE the navigation.

function MiniRack({
  roots,
  currentId,
  onIssue,
}: {
  roots: TreeNode[];
  currentId?: string | null;
  onIssue?: () => void;
}) {
  return (
    <div className="minirack" aria-label="your cards">
      {roots.map((n) => {
        const dead = isDead(n.card.status);
        const frozen = n.card.status === "frozen";
        return (
          <Link
            key={n.card.card_id}
            href={`/card/${n.card.card_id}`}
            className={`mini${n.card.card_id === currentId ? " on" : ""}${dead ? " gone" : frozen ? " iced" : ""}`}
            data-testid={`nav-${n.card.name}`}
            title={n.card.name}
          >
            <span className="minicard">
              <Guilloche width={76} height={16} strands={5} amp={4.5} />
            </span>
            <span className="mininame">{n.card.name}</span>
          </Link>
        );
      })}
      {onIssue && (
        <button className="mini miniplus" onClick={onIssue} title="issue a new card" data-testid="issue-open">
          <span className="minicard">+</span>
          <span className="mininame">new card</span>
        </button>
      )}
    </div>
  );
}

// Avatar menu (top right): account identity, sign out, and the wallet-level
// danger verb — nuke lives here because it kills EVERY card, not one.

function ProfileMenu({
  address,
  onLogout,
  remit,
  refresh,
  nukeable,
}: {
  address?: string;
  onLogout?: () => void;
  remit: Remit;
  refresh: () => void | Promise<void>;
  nukeable: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="profile">
      <button className="avatarbtn" onClick={() => setOpen((v) => !v)} aria-label="account" data-testid="profile">
        <span className="avatar" />
      </button>
      {open && (
        <>
          <div className="scrim" onClick={() => setOpen(false)} />
          <div className="promenu">
            <div className="prowho">
              <span className="avatar" />
              <span className="em">{address ? shortHex(address, 6, 4) : ""}</span>
            </div>
            {onLogout && (
              <button
                className="proitem"
                onClick={() => {
                  setOpen(false);
                  onLogout();
                }}
                data-testid="logout"
              >
                sign out
              </button>
            )}
            {nukeable && <NukeItem remit={remit} onNuked={refresh} />}
          </div>
        </>
      )}
    </div>
  );
}

// Cascade revoke (NonceEnforcer bump): ONE on-chain tx kills every card and
// sub-card this wallet ever issued. Same client-signed flow as v1.

type NukePhase = "idle" | "confirm" | "signing" | "submitting" | "done" | "error";

function NukeItem({ remit, onNuked }: { remit: Remit; onNuked: () => void | Promise<void> }) {
  const [phase, setPhase] = useState<NukePhase>("idle");
  const [tx, setTx] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function go() {
    setErr(null);
    try {
      setPhase("signing");
      const prep = await api.prepareNuke();
      const signature = await remit.signDelegation(prep.delegation);
      setPhase("submitting");
      const fin = await api.finalizeNuke(prep.prepare_id, signature);
      setTx(fin.tx);
      setPhase("done");
      await onNuked();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  }

  return (
    <div className="prodanger">
      {phase === "done" ? (
        <p className="pronote" data-testid="nuke-done">
          nuked ✓ every card is dead.{" "}
          {tx && (
            <a href={`https://basescan.org/tx/${tx}`} target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>
              {tx.slice(0, 10)}…
            </a>
          )}
        </p>
      ) : phase === "signing" || phase === "submitting" ? (
        <p className="pronote" data-testid="nuke-busy">
          {phase === "signing" ? "signing with your wallet…" : "one tx, killing the whole tree…"}
        </p>
      ) : phase === "confirm" ? (
        <>
          <p className="pronote err">kill EVERY card and sub-card, permanently, on-chain?</p>
          <div className="prorow">
            <button className="danger-ghost" onClick={go} data-testid="nuke-confirm">
              yes, nuke
            </button>
            <button onClick={() => setPhase("idle")}>cancel</button>
          </div>
        </>
      ) : (
        <>
          <button
            className="proitem danger"
            disabled={!remit.embeddedReady}
            onClick={() => setPhase("confirm")}
            data-testid="nuke"
          >
            nuke all cards
          </button>
          <p className="pronote">one on-chain tx revokes every card + sub-card this wallet ever issued</p>
        </>
      )}
      {err && <p className="pronote err">nuke failed: {err}</p>}
    </div>
  );
}

// Panel header: the title row inside a surface — sentence case, quiet meta right.

export function SecHead({ title, right }: { title: string; right?: React.ReactNode }) {
  return (
    <div className="phead">
      <h2>{title}</h2>
      {right && <div className="r">{right}</div>}
    </div>
  );
}
