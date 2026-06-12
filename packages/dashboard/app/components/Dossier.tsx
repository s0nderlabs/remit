"use client";

// The dossier, centered-hero edition (the Apple Card grammar). One vertical
// axis: name + status on top → the card deck (a stack: the active card front
// and center, the next card peeking out behind its right edge · the + at the
// deck's edge issues) → the balance, big and centered → the gauge → one
// whisper caption → the static verb row.
// Below, the full-width paned zone: activity / delegation terms / sub-cards
// behind a quiet segmented toggle. Card swaps animate ONLY the per-card
// readings (name, money, caption, open pane) with a short in-place fade;
// the verbs, tabs and carousel chrome never move.
// All v1 state machines (connect / freeze / revoke) are preserved verbatim.

import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, type Variants } from "motion/react";
import { api, type CardState, type FiatCard, type TreeNode } from "@/lib/api";
import type { useRemit } from "../useRemit";
import { CardHero } from "./CardHero";
import { ConnectOverlay } from "./ConnectOverlay";
import { DeleteButton, RevokeButton, TermsGrid, allowance, caveatCount, perTradeEnforces } from "./Authority";
import { ChargeList, feedStats, type FeedRow } from "./Activity";
import { SubRows } from "./SubCards";
import {
  Barcode,
  IconSnowflake,
  StatusPill,
  fmtCountdown,
  fmtUsd,
  isDead,
  periodLabel,
  splitAmount,
  useCountUp,
} from "./ui";

type Remit = ReturnType<typeof useRemit>;
type Tab = "activity" | "terms" | "subs";

// the swap choreography, kept quiet: old and new content occupy the same
// grid cell and CROSS-FADE · no mode="wait", so there is never a blank frame
// between them. ONE move for every swap (card swipe and tab switch alike):
// a small rise + fade in place. The deck's own slide already says which way
// the cards went; the readings don't chase it sideways.
const swapEase = [0.22, 1, 0.36, 1] as const;
const zoneVariants: Variants = {
  enter: { opacity: 0, y: 8 },
  center: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.3, ease: swapEase, staggerChildren: 0.03 },
  },
  exit: { opacity: 0, y: -5, transition: { duration: 0.18, ease: "easeOut" } },
};

const rowVariants: Variants = {
  enter: { opacity: 0, y: 6 },
  center: { opacity: 1, y: 0, transition: { duration: 0.3, ease: swapEase } },
};

export function Dossier({
  node,
  kAgent,
  kmap,
  feed,
  remit,
  refresh,
  roots,
  currentId,
  onSelect,
  onIssue,
  onDeleted,
}: {
  node: TreeNode | null; // the selected card + its direct children
  kAgent?: string;
  kmap: Map<string, string>;
  feed: FeedRow[];
  remit: Remit;
  refresh: () => void | Promise<void>;
  roots: TreeNode[]; // the deck: root cards (card pages pass just [node])
  currentId?: string | null;
  onSelect?: (cardId: string) => void; // deck selection (home only)
  onIssue?: () => void; // the + beside the dots: the ONLY create affordance
  onDeleted?: () => void | Promise<void>; // after a dead card is deleted (card pages navigate home)
}) {
  const card = node?.card ?? null;
  const dead = card ? isDead(card.status) : false;
  const heroId = card?.card_id ?? "";

  // the bottom pane toggle survives card swaps (compare terms across cards)
  const [tab, setTab] = useState<Tab>("activity");

  // the linked test-mode Visa per card (owner view) · fetched once per card,
  // cached for the session so swapping back never flickers the PAN
  const [fiatMap, setFiatMap] = useState<Map<string, FiatCard>>(new Map());
  useEffect(() => {
    if (!heroId || fiatMap.has(heroId)) return;
    let live = true;
    api
      .fiatCard(heroId)
      .then((f) => {
        if (live) setFiatMap((m) => new Map(m).set(heroId, f));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
    // fiatMap intentionally not a dep: the has() guard already de-dupes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [heroId]);

  // Connect state lives here so the verb can open the credential overlay ·
  // the page never moves. Switching cards drops the previous credential.
  const [connectUrl, setConnectUrl] = useState<string | null>(null);
  const [connectOpen, setConnectOpen] = useState(false);
  const [rotating, setRotating] = useState(false);
  const heroRef = useRef(heroId);
  useEffect(() => {
    heroRef.current = heroId;
    setConnectOpen(false);
    setConnectUrl(null);
  }, [heroId]);
  const closeConnect = useCallback(() => setConnectOpen(false), []);

  // A credential resolving after the user swiped to another card must be
  // dropped, or the overlay would title itself with card B while exposing
  // card A's live URL.
  const connect = heroId
    ? async () => {
        const id = heroId;
        const url = (await api.url(id)).card_url;
        if (heroRef.current !== id) return;
        setConnectUrl(url);
        setConnectOpen(true);
      }
    : undefined;
  const rotate = heroId
    ? async () => {
        const id = heroId;
        setRotating(true);
        try {
          const url = (await api.rotate(id)).card_url;
          if (heroRef.current !== id) return;
          setConnectUrl(url);
        } catch (e) {
          console.error("rotate failed", e);
        } finally {
          setRotating(false);
        }
      }
    : undefined;

  // the pane toggle row · labels only: the panes carry their own numbers
  const kids = node?.children ?? [];
  const tabs: { key: Tab; label: string; disabled?: boolean }[] = [
    { key: "activity", label: "Activity" },
    { key: "terms", label: "Delegation Terms", disabled: !card },
    { key: "subs", label: "Sub-Cards", disabled: !card },
  ];

  return (
    <main className={`deck${dead ? " dead" : ""}`}>
      <section className="hero">
        {card && (
          <div className="heroid-wrap">
            <AnimatePresence initial={false}>
              <motion.div
                key={card.card_id}
                className="heroid"
                variants={zoneVariants}
                initial="enter"
                animate="center"
                exit="exit"
              >
                <h1>{card.name}</h1>
                <StatusPill status={card.status} />
              </motion.div>
            </AnimatePresence>
          </div>
        )}

        <Carousel
          roots={roots}
          currentId={currentId ?? heroId}
          kmap={kmap}
          kAgent={kAgent}
          fiatMap={fiatMap}
          onSelect={onSelect}
          onIssue={onIssue}
        />

        {card ? (
          <>
            <div className="dbody-wrap">
              <AnimatePresence initial={false}>
                <HeadBody key={card.card_id} card={card} />
              </AnimatePresence>
            </div>

            <Verbs
              card={card}
              hasKids={kids.length > 0}
              remit={remit}
              refresh={refresh}
              onConnect={connect}
              onDeleted={onDeleted}
            />
          </>
        ) : (
          <div className="heroempty">
            <h1>No Cards Yet</h1>
            <p>Issue your first card and hand it to an agent · scoped, revocable, dead on revoke</p>
          </div>
        )}
      </section>

      <div className="bottom">
        <div className="tabrow" role="tablist" aria-label="Card details">
          {tabs.map((t) => (
            <button
              key={t.key}
              role="tab"
              aria-selected={tab === t.key}
              className={`tabbtn${tab === t.key ? " on" : ""}`}
              disabled={t.disabled}
              onClick={() => setTab(t.key)}
              data-testid={`pane-${t.key}`}
            >
              {tab === t.key && (
                <motion.span
                  layoutId="paneind"
                  className="tabind"
                  transition={{ type: "spring", stiffness: 560, damping: 44 }}
                />
              )}
              <span className="t">{t.label}</span>
            </button>
          ))}
        </div>
        <div className="tabbody">
          <AnimatePresence initial={false}>
            <motion.div
              key={`${heroId || "empty"}:${tab}`}
              className="pane"
              variants={zoneVariants}
              initial="enter"
              animate="center"
              exit="exit"
            >
              {tab === "activity" && <ActivityPane card={card} feed={feed} />}
              {tab === "terms" && card && <TermsPane card={card} kAgent={kAgent} />}
              {tab === "subs" && card && node && <SubsPane card={card} node={node} kmap={kmap} />}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>

      <AnimatePresence>
        {card && connectOpen && connectUrl && (
          <ConnectOverlay
            key="connect"
            card={card}
            url={connectUrl}
            onRotate={rotate}
            rotating={rotating}
            onClose={closeConnect}
          />
        )}
      </AnimatePresence>
    </main>
  );
}

// ---------------------------------------------------------------------------
// the deck: a stack, not a strip. The active card sits front and center; the
// NEXT card peeks out behind its right edge · one uniform sliver, just enough
// to say "there's more". Passed cards tuck away invisibly to the left.
// Navigate by dragging the active card, swiping the trackpad, clicking the
// peek, or the dots; the + floating at the deck's right edge ("another card
// could live here") issues a new card.
// ---------------------------------------------------------------------------

// the pose for a slide at distance d from the active card
function deckPose(d: number) {
  if (d === 0) return { x: 0, scale: 1, opacity: 1 };
  if (d < 0) return { x: -20, scale: 0.94, opacity: 0 }; // passed: tucked away left
  if (d === 1) return { x: 26, scale: 0.94, opacity: 1 }; // the peek
  return { x: 40, scale: 0.94, opacity: 0 }; // the deep tail waits just beyond
}

function Carousel({
  roots,
  currentId,
  kmap,
  kAgent,
  fiatMap,
  onSelect,
  onIssue,
}: {
  roots: TreeNode[];
  currentId?: string | null;
  kmap: Map<string, string>;
  kAgent?: string;
  fiatMap?: Map<string, FiatCard>;
  onSelect?: (cardId: string) => void;
  onIssue?: () => void;
}) {
  const idx = Math.max(0, roots.findIndex((n) => n.card.card_id === currentId));
  const [flipped, setFlipped] = useState(false);
  useEffect(() => setFlipped(false), [currentId]);
  // a drag must not leak its release as a click (which would flip the card)
  const dragged = useRef(false);
  // trackpad swipes arrive as a wheel stream: one step per gesture
  const wheelLock = useRef(0);
  const stackRef = useRef<HTMLDivElement>(null);

  const goTo = (i: number) => {
    if (!onSelect || i < 0 || i >= roots.length) return;
    if (roots[i].card.card_id !== currentId) onSelect(roots[i].card.card_id);
  };

  // React attaches wheel listeners passively, so a JSX onWheel can't
  // preventDefault · and without it the swipe rubber-bands the whole page.
  // A native non-passive listener lets the deck consume horizontal swipes.
  const navRef = useRef<(dx: number) => void>(() => {});
  navRef.current = (dx: number) => goTo(idx + (dx > 0 ? 1 : -1));
  // deps include roots.length: on first mount the deck may render empty
  // (data still loading), and the listener must attach once .stack appears
  const canWheel = !!onSelect;
  const hasStack = roots.length > 0;
  useEffect(() => {
    const el = stackRef.current;
    if (!el || !canWheel) return;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return; // vertical scrolls pass through
      e.preventDefault();
      const now = performance.now();
      if (Math.abs(e.deltaX) < 24 || now - wheelLock.current < 450) return;
      wheelLock.current = now;
      navRef.current(e.deltaX);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [canWheel, hasStack]);

  if (roots.length === 0) {
    return <div className="bayempty">The bay is empty · your first card appears here</div>;
  }

  return (
    <div className="bay">
      <div className="stack" ref={stackRef}>
        {roots.map((n, i) => {
          const d = i - idx;
          const active = d === 0;
          return (
            <motion.div
              key={n.card.card_id}
              className={`slide${active ? "" : " off"}${isDead(n.card.status) ? " dead" : ""}`}
              style={{
                zIndex: roots.length - Math.abs(d),
                pointerEvents: d < 0 || d > 1 ? "none" : undefined,
              }}
              initial={false}
              animate={deckPose(d)}
              transition={{ duration: 0.42, ease: swapEase }}
              drag={active && onSelect ? "x" : false}
              dragConstraints={{ left: 0, right: 0 }}
              dragElastic={0.14}
              onDragStart={() => {
                dragged.current = true;
              }}
              onDragEnd={(_, info) => {
                if (info.offset.x < -56 || info.velocity.x < -420) goTo(idx + 1);
                else if (info.offset.x > 56 || info.velocity.x > 420) goTo(idx - 1);
                // the click this drag releases fires after dragend · swallow it, then re-arm
                setTimeout(() => {
                  dragged.current = false;
                }, 0);
              }}
              onClickCapture={
                active
                  ? (e) => {
                      if (dragged.current) {
                        e.stopPropagation();
                        e.preventDefault();
                      }
                    }
                  : !onSelect
                    ? undefined
                    : (e) => {
                        e.stopPropagation();
                        e.preventDefault();
                        goTo(i);
                      }
              }
              data-testid={`nav-${n.card.name}`}
            >
              <CardHero
                card={n.card}
                holder={n.card.name}
                agentAddress={kmap.get(n.card.card_id) ?? (active ? kAgent : undefined)}
                fiat={fiatMap?.get(n.card.card_id)}
                fiatPending={active && !isDead(n.card.status) && !fiatMap?.has(n.card.card_id)}
                flipped={active && flipped}
                onFlip={() => active && setFlipped((f) => !f)}
              />
            </motion.div>
          );
        })}
        {onIssue && (
          <button
            className="deckplus"
            onClick={onIssue}
            data-testid="issue-open"
            aria-haspopup="dialog"
            aria-label="Issue a new card"
            title="Issue a new card"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
        )}
      </div>
      {roots.length > 1 && (
        <div className="cdots">
          {roots.map((n, i) => (
            <button
              key={n.card.card_id}
              className={`cdot${i === idx ? " on" : ""}`}
              onClick={() => goTo(i)}
              aria-label={`Show ${n.card.name}`}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** "2 live cards · $30.00 / wk delegated" · the wallet aggregate (profile menu) */
export function bayAggregate(roots: TreeNode[]): string {
  const live = roots.filter((n) => !isDead(n.card.status));
  if (live.length === 0) return "No live cards";
  const cards = `${live.length} live card${live.length === 1 ? "" : "s"}`;
  let sum = 0;
  const periods = new Set<string>();
  for (const n of live) {
    const p = n.card.terms.pay?.period;
    const l = n.card.terms.pay?.lifetime;
    if (p) {
      sum += parseFloat(p.amount) || 0;
      periods.add(periodLabel(p.seconds));
    } else if (l) {
      sum += parseFloat(l.amount) || 0;
      periods.add("lifetime");
    }
  }
  if (sum === 0) return cards;
  const suffix = periods.size === 1 ? (periods.has("lifetime") ? " lifetime" : ` / ${[...periods][0]}`) : "";
  return `${cards} · ${fmtUsd(sum)}${suffix} delegated`;
}

// ---------------------------------------------------------------------------
// the static instrument panel: same verbs for every card, never remounts ·
// only its props (status, handlers) follow the selection
// ---------------------------------------------------------------------------

function Verbs({
  card,
  hasKids,
  remit,
  refresh,
  onConnect,
  onDeleted,
}: {
  card: CardState;
  hasKids: boolean;
  remit: Remit;
  refresh: () => void | Promise<void>;
  onConnect?: () => Promise<void>;
  onDeleted?: () => void | Promise<void>;
}) {
  const dead = isDead(card.status);
  const frozen = card.status === "frozen";
  const [busy, setBusy] = useState(false);
  const [revealing, setRevealing] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  // a verb error belongs to the card it fired on, not the next selection
  useEffect(() => setMsg(null), [card.card_id]);

  const act = (fn: () => Promise<unknown>, label: string) => async () => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setMsg(`${label} failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setBusy(false);
    }
  };
  // the connect reveal is read-only · it must not lock freeze/revoke (nor they it)
  const reveal = onConnect
    ? async () => {
        setRevealing(true);
        setMsg(null);
        try {
          await onConnect();
        } catch (e) {
          setMsg(`Reveal URL failed: ${e instanceof Error ? e.message : e}`);
        } finally {
          setRevealing(false);
        }
      }
    : undefined;

  return (
    <div className="verbcol">
      <div className="verbs">
        {dead ? (
          <>
            <button className="vpill primary" disabled>
              <IconConnect />
              Connect Agent
            </button>
            <button className="vpill" disabled>
              <IconSnowflake size={13} />
              Freeze
            </button>
          </>
        ) : (
          <>
            {reveal && (
              <button className="vpill primary" disabled={revealing} onClick={reveal} data-testid="reveal-url">
                <IconConnect />
                Connect Agent
              </button>
            )}
            {card.status === "active" && (
              <button
                className="vpill"
                disabled={busy}
                onClick={act(() => api.freeze(card.card_id), "Freeze")}
                data-testid="freeze"
                title="Freeze this card"
              >
                <IconSnowflake size={13} />
                Freeze
              </button>
            )}
            {frozen && (
              <button
                className="vpill iced"
                disabled={busy}
                onClick={act(() => api.unfreeze(card.card_id), "Unfreeze")}
                data-testid="unfreeze"
                title="Unfreeze this card"
              >
                <IconSnowflake size={13} />
                Unfreeze
              </button>
            )}
          </>
        )}
        {/* outside the dead/live fork so the instance (and its open modal) survives the status flip */}
        <RevokeButton
          cardId={card.card_id}
          isSub={!!card.parent_card_id}
          revocable={!dead}
          signDelegation={remit.signDelegation}
          embeddedReady={remit.embeddedReady}
          onDone={refresh}
        />
        {/* a dead card's one remaining verb: leave the books */}
        {dead && <DeleteButton cardId={card.card_id} hasKids={hasKids} onDone={onDeleted ?? refresh} />}
      </div>
      {msg && <p className="err verbmsg">{msg}</p>}
    </div>
  );
}

function IconConnect() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M10 14l8.5-8.5M13 5h6v6" />
      <path d="M19 14.5V18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h3.5" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// the per-card readings: the balance (big, centered), the gauge, and ONE
// whisper caption · the old label, % pill and 3-fact stats band all
// collapsed into it. Remounted per card for the odometer.
// ---------------------------------------------------------------------------

function HeadBody({ card }: { card: CardState }) {
  const dead = isDead(card.status);
  const frozen = card.status === "frozen";
  const { cap, remaining, spentPct } = allowance(card);
  const ct = card.terms.contract;
  const metered = cap !== null; // a pay budget governs this card
  const ptLive = ct ? perTradeEnforces(ct) : false;

  // the headline figure: a dead card shows its cap, ghosted (the epitaph state)
  const figTarget = dead ? (cap ?? 0) : metered ? (remaining ?? 0) : ptLive ? parseFloat(ct?.perTradeMax ?? "0") : (remaining ?? 0);
  const animated = useCountUp(figTarget);
  const [whole, cents] = splitAmount(animated);

  // what the figure means · the caption's first clause
  const plabel = card.terms.pay?.period ? periodLabel(card.terms.pay.period.seconds) : null;
  const span = plabel === "day" ? "today" : plabel === "wk" ? "this week" : plabel === "mo" ? "this month" : "lifetime";
  const scope = metered
    ? `of $${cap.toLocaleString("en-US", { minimumFractionDigits: 2 })} ${span}${
        ct ? ` · + execute · ${ct.targets.length} contract${ct.targets.length === 1 ? "" : "s"}` : ""
      }`
    : ct && ptLive
      ? `per trade · ${ct.targets.length} contract${ct.targets.length === 1 ? "" : "s"} / ${ct.selectors.length} method${ct.selectors.length === 1 ? "" : "s"}`
      : ct
        ? `contract${ct.targets.length === 1 ? "" : "s"} in scope · ${ct.selectors.length} method${ct.selectors.length === 1 ? "" : "s"}`
        : "unmetered";

  // when it changes · countdown for the living, epitaph for the dead
  const when = dead
    ? card.status === "expired" && card.expires_at
      ? `expired ${new Date(card.expires_at * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`
      : `${card.status} · authority dead on-chain`
    : frozen
      ? "frozen · spends refuse until unfrozen"
      : card.period_resets_at
        ? `resets in ${fmtCountdown(card.period_resets_at)}`
        : card.expires_at
          ? `expires in ${fmtCountdown(card.expires_at)}`
          : "no expiry";

  // the gauge is a fuel gauge: full when untouched, draining toward empty
  const leftPct = Math.max(0, 100 - spentPct);

  return (
    <motion.div className="dbody" variants={zoneVariants} initial="enter" animate="center" exit="exit">
      <motion.div className="money num" variants={rowVariants}>
        <div className="fig">
          {metered || ptLive || !ct ? (
            <span data-testid="remaining">
              <span className="cur">$</span>
              <span className="int">{whole}</span>
              <span className="dec">.{cents}</span>
            </span>
          ) : (
            <span>
              <span className="int">{ct.targets.length}</span>
            </span>
          )}
        </div>
        <div className="gaugerow">
          <div className="gauge">
            <div
              className="fill"
              style={
                metered
                  ? { width: dead ? "0%" : `${leftPct}%` }
                  : { width: dead ? "0%" : "100%", background: "var(--hairline)" }
              }
            />
          </div>
        </div>
        <div className="caption">
          {scope} · {when}
        </div>
      </motion.div>
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// the bottom panes: activity / delegation terms / sub-cards, one at a time
// ---------------------------------------------------------------------------

function ActivityPane({ card, feed }: { card: CardState | null; feed: FeedRow[] }) {
  const { bins, binLabels, dayLabels } = feedStats(feed);
  const dead = card ? isDead(card.status) : false;
  const empty = !card
    ? "No activity yet · issue a card to begin"
    : dead
      ? `No activity · authority ${card.status}`
      : "No charges yet · connect an agent and let it spend";

  return (
    <>
      <motion.div className="dr chartblock" variants={rowVariants}>
        <div className="chead">
          <div>
            <h2>Daily Spend</h2>
            <span className="sub">Last 30 days</span>
          </div>
          <span className="range num">
            {dayLabels[0]} – {dayLabels[29]}
          </span>
        </div>
        <Barcode values={bins} labels={binLabels} width={1200} height={86} />
        <div className="axisrow num">
          {[0, 7, 14, 21, 29].map((d) => (
            <span key={d} style={d === 0 || d === 29 ? undefined : { left: `${((d + 0.5) / 30) * 100}%` }}>
              {dayLabels[d]}
            </span>
          ))}
        </div>
      </motion.div>
      <motion.div className="dr listwrap" variants={rowVariants}>
        <ChargeList rows={feed} empty={empty} />
      </motion.div>
    </>
  );
}

function TermsPane({ card, kAgent }: { card: CardState; kAgent?: string }) {
  const dead = isDead(card.status);
  return (
    <motion.div className="dr panein" variants={rowVariants}>
      <p className="panenote">
        {dead
          ? "Enforcement ended · the delegation is dead on-chain"
          : `${caveatCount(card)} caveats enforced on-chain · nothing here is a promise, it's the authority itself`}
      </p>
      <TermsGrid card={card} agentAddress={kAgent} />
    </motion.div>
  );
}

function SubsPane({ card, node, kmap }: { card: CardState; node: TreeNode; kmap: Map<string, string> }) {
  const dead = isDead(card.status);
  const allowed = card.terms.subcards !== false;
  const kids = node.children;

  return (
    <motion.div className="dr panein" variants={rowVariants}>
      {allowed && kids.length > 0 ? (
        <SubRows node={node} kmap={kmap} />
      ) : (
        <div className="subnote">
          {!allowed
            ? "Terms on this card don't permit sub-cards"
            : dead
              ? "None carved before revoke · the tree is empty"
              : "None yet · the agent holding this card carves them itself: connect it, then ask it to issue a sub-card (the issue_subcard tool) · caps only narrow downward, and they appear here"}
        </div>
      )}
    </motion.div>
  );
}
