"use client";

// The dossier, centered-hero edition (the Apple Card grammar). One vertical
// axis: name + status on top → the card deck (a stack: the active card front
// and center, the next card peeking out behind its right edge · just enough
// to say "there's more" · with the ghost "issue" card riding the tail) → the
// balance, big and centered → the gauge → one quiet inline stats line → the
// static verb row.
// Below, the full-width paned zone: activity / delegation terms / sub-cards
// behind a quiet segmented toggle. Card swaps animate ONLY the per-card
// readings (name, money, stats line, open pane) with a short in-place fade;
// the verbs, tabs and carousel chrome never move.
// All v1 state machines (connect / freeze / revoke) are preserved verbatim.

import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, type Variants } from "motion/react";
import { api, type CardState, type TreeNode } from "@/lib/api";
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

// the swap choreography, kept quiet: a short drift toward the swipe (custom =
// ±1) or a small rise for tab switches (custom = 0), plain easing, no blur,
// no overshoot. mode="wait" keeps everything in normal flow: the old content
// fades exactly where it stands, then the new settles in.
const swapEase = [0.22, 1, 0.36, 1] as const;
const zoneVariants: Variants = {
  enter: (d: number) => (d === 0 ? { opacity: 0, y: 8 } : { opacity: 0, x: 16 * d }),
  center: {
    opacity: 1,
    x: 0,
    y: 0,
    transition: { duration: 0.26, ease: swapEase, staggerChildren: 0.03 },
  },
  exit: (d: number) =>
    d === 0
      ? { opacity: 0, y: -5, transition: { duration: 0.1, ease: "easeIn" } }
      : { opacity: 0, x: -10 * d, transition: { duration: 0.1, ease: "easeIn" } },
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

  // swipe direction drives the swap choreography: which way the content drifts
  const idx = Math.max(0, roots.findIndex((n) => n.card.card_id === heroId));
  const prevIdxRef = useRef(idx);
  const dir = idx >= prevIdxRef.current ? 1 : -1;
  useEffect(() => {
    prevIdxRef.current = idx;
  }, [idx]);

  // the bottom pane toggle survives card swaps (compare terms across cards)
  const [tab, setTab] = useState<Tab>("activity");
  // a pane swap caused by the TAB rises in place; caused by the CARD it drifts
  const prevHeroRef = useRef(heroId);
  const paneDir = heroId !== prevHeroRef.current ? dir : 0;
  useEffect(() => {
    prevHeroRef.current = heroId;
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

  // the pane toggle row (counts ride as quiet subs)
  const { count } = feedStats(feed);
  const kids = node?.children ?? [];
  const liveKids = kids.filter((c) => !isDead(c.card.status)).length;
  const tabs: { key: Tab; label: string; sub: string; disabled?: boolean }[] = [
    { key: "activity", label: "activity", sub: count > 0 ? `· ${count}` : "" },
    { key: "terms", label: "delegation terms", sub: card ? `· ${caveatCount(card)}` : "", disabled: !card },
    {
      key: "subs",
      label: "sub-cards",
      sub: kids.length > 0 ? `· ${liveKids} live` : "",
      disabled: !card,
    },
  ];

  return (
    <main className={`deck${dead ? " dead" : ""}`}>
      <section className="hero">
        {card && (
          <div className="heroid-wrap">
            <AnimatePresence mode="wait" custom={dir} initial={false}>
              <motion.div
                key={card.card_id}
                className="heroid"
                custom={dir}
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
          onSelect={onSelect}
          onIssue={onIssue}
        />

        {card ? (
          <>
            <AnimatePresence mode="wait" custom={dir} initial={false}>
              <HeadBody key={card.card_id} dir={dir} card={card} node={node!} feed={feed} />
            </AnimatePresence>

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
            <h1>no cards yet</h1>
            <p>issue your first card and hand it to an agent · scoped, revocable, dead on revoke</p>
          </div>
        )}
      </section>

      <div className="bottom">
        <div className="tabrow" role="tablist" aria-label="card details">
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
              {t.sub && <span className="n num">{t.sub}</span>}
            </button>
          ))}
        </div>
        <div className="tabbody">
          <AnimatePresence mode="wait" custom={paneDir} initial={false}>
            <motion.div
              key={`${heroId || "empty"}:${tab}`}
              className="pane"
              custom={paneDir}
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
// peek, or the dots; the + button beside the dots issues a new card.
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
  onSelect,
  onIssue,
}: {
  roots: TreeNode[];
  currentId?: string | null;
  kmap: Map<string, string>;
  kAgent?: string;
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
    return <div className="bayempty">the bay is empty · your first card appears here</div>;
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
                flipped={active && flipped}
                onFlip={() => active && setFlipped((f) => !f)}
              />
            </motion.div>
          );
        })}
      </div>
      {(roots.length > 1 || onIssue) && (
        <div className="cdots">
          {roots.length > 1 &&
            roots.map((n, i) => (
              <button
                key={n.card.card_id}
                className={`cdot${i === idx ? " on" : ""}`}
                onClick={() => goTo(i)}
                aria-label={`show ${n.card.name}`}
              />
            ))}
          {onIssue && (
            <button
              className="cplus"
              onClick={onIssue}
              data-testid="issue-open"
              aria-haspopup="dialog"
              aria-label="issue a new card"
              title="issue a new card"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
                <path d="M12 5v14M5 12h14" />
              </svg>
            </button>
          )}
        </div>
      )}
      <div className="agg num">{bayAggregate(roots)}</div>
    </div>
  );
}

/** "2 live · $30.00 / wk delegated" · the quiet aggregate under the dots */
function bayAggregate(roots: TreeNode[]): string {
  const live = roots.filter((n) => !isDead(n.card.status));
  if (live.length === 0) return "no live cards";
  const cards = `${live.length} live`;
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
          setMsg(`reveal url failed: ${e instanceof Error ? e.message : e}`);
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
              connect agent
            </button>
            <button className="vpill" disabled>
              <IconSnowflake size={13} />
              freeze
            </button>
          </>
        ) : (
          <>
            {reveal && (
              <button className="vpill primary" disabled={revealing} onClick={reveal} data-testid="reveal-url">
                <IconConnect />
                connect agent
              </button>
            )}
            {card.status === "active" && (
              <button
                className="vpill"
                disabled={busy}
                onClick={act(() => api.freeze(card.card_id), "freeze")}
                data-testid="freeze"
                title="freeze this card"
              >
                <IconSnowflake size={13} />
                freeze
              </button>
            )}
            {frozen && (
              <button
                className="vpill iced"
                disabled={busy}
                onClick={act(() => api.unfreeze(card.card_id), "unfreeze")}
                data-testid="unfreeze"
                title="unfreeze this card"
              >
                <IconSnowflake size={13} />
                unfreeze
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
// the per-card readings: the balance (big, centered), the gauge, and one
// quiet inline stats line · remounted per card for the odometer
// ---------------------------------------------------------------------------

function HeadBody({
  dir,
  card,
  node,
  feed,
}: {
  dir: number;
  card: CardState;
  node: TreeNode;
  feed: FeedRow[];
}) {
  const dead = isDead(card.status);
  const frozen = card.status === "frozen";
  const { cap, remaining, spent, spentPct } = allowance(card);
  const ct = card.terms.contract;
  const metered = cap !== null; // a pay budget governs this card
  const ptLive = ct ? perTradeEnforces(ct) : false;

  // label above the figure: what IS this number
  const plabel = card.terms.pay?.period ? periodLabel(card.terms.pay.period.seconds) : null;
  const label = metered
    ? plabel === "day"
      ? "remaining today"
      : plabel === "wk"
        ? "remaining this week"
        : plabel === "mo"
          ? "remaining this month"
          : "remaining · lifetime"
    : ct
      ? ptLive
        ? "per-trade ceiling"
        : "execute scope"
      : "remaining";

  // the headline figure: a dead card shows its cap, ghosted (the epitaph state)
  const figTarget = dead ? (cap ?? 0) : metered ? (remaining ?? 0) : ptLive ? parseFloat(ct?.perTradeMax ?? "0") : (remaining ?? 0);
  const animated = useCountUp(figTarget);
  const [whole, cents] = splitAmount(animated);

  const ofcap = metered ? (
    <>
      of ${cap.toLocaleString("en-US", { minimumFractionDigits: 2 })}
      {card.terms.pay?.period ? ` / ${periodLabel(card.terms.pay.period.seconds)}` : " lifetime"}
      {ct && <> · + execute · {ct.targets.length} contract{ct.targets.length === 1 ? "" : "s"}</>}
    </>
  ) : ct && ptLive ? (
    <>
      per trade · {ct.targets.length} contract{ct.targets.length === 1 ? "" : "s"} / {ct.selectors.length} method
      {ct.selectors.length === 1 ? "" : "s"}
    </>
  ) : ct ? (
    <>
      contract{ct.targets.length === 1 ? "" : "s"} in scope · {ct.selectors.length} method{ct.selectors.length === 1 ? "" : "s"}
    </>
  ) : (
    <>unmetered</>
  );

  // the gauge is a fuel gauge: full when untouched, draining toward empty
  const leftPct = Math.max(0, 100 - spentPct);
  const pctLabel = dead ? "" : leftPct >= 100 ? "100%" : `${(Math.round(leftPct * 10) / 10).toFixed(1)}%`;

  // the line riding the gauge's end: countdown for the living, epitaph for the dead
  const resets = dead
    ? card.status === "expired" && card.expires_at
      ? `expired ${new Date(card.expires_at * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" }).toLowerCase()}`
      : `${card.status} · authority dead on-chain`
    : frozen
      ? "frozen · spends refuse until unfrozen"
      : card.period_resets_at
        ? `resets in ${fmtCountdown(card.period_resets_at)}`
        : card.expires_at
          ? `expires in ${fmtCountdown(card.expires_at)}`
          : "no expiry";

  // the inline stats line (the old 3-up KPI band, compressed to a whisper)
  const { today, total30, count, okCount } = feedStats(feed);
  const blocked = count - okCount;
  const liveSubs = node.children.filter((c) => !isDead(c.card.status)).length;
  const spentShown = dead ? 0 : (spent ?? total30);
  const statSpent = `${fmtUsd(spentShown)} spent ${spent !== null ? "this period" : "in 30 days"}${dead ? "" : today > 0 ? ` (+${fmtUsd(today)} today)` : ""}`;
  const statCharges =
    count === 0 ? (dead ? "no charges recorded" : "no charges yet") : `${count} charge${count === 1 ? "" : "s"}${blocked > 0 ? `, ${blocked} blocked` : ", all settled"}`;
  const statSubs = dead
    ? "tree is empty"
    : card.terms.subcards === false
      ? "sub-cards not permitted"
      : `${liveSubs} sub-card${liveSubs === 1 ? "" : "s"} live`;

  return (
    <motion.div className="dbody" custom={dir} variants={zoneVariants} initial="enter" animate="center" exit="exit">
      <motion.div className="money num" variants={rowVariants}>
        <span className="lbl">{label}</span>
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
          <span className="ofcap">{ofcap}</span>
        </div>
        <div className="gaugerow">
          {metered ? (
            <div className="gauge">
              <div className="fill" style={{ width: dead ? "0%" : `${leftPct}%` }}>
                {pctLabel && <span className="pct num">{pctLabel}</span>}
              </div>
            </div>
          ) : (
            <div className="gauge">
              <div className="fill" style={{ width: dead ? "0%" : "100%", background: "var(--hairline)" }} />
            </div>
          )}
          <div className="resets">{resets}</div>
        </div>
      </motion.div>

      <motion.div className="statline num" variants={rowVariants}>
        <span>{statSpent}</span>
        <i />
        <span>{statCharges}</span>
        <i />
        <span>{statSubs}</span>
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
    ? "no activity yet · issue a card to begin"
    : dead
      ? `no activity · authority ${card.status}`
      : "no charges yet · connect an agent and let it spend";

  return (
    <>
      <motion.div className="dr chartblock" variants={rowVariants}>
        <div className="chead">
          <div>
            <h2>daily spend</h2>
            <span className="sub">last 30 days</span>
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
          ? "enforcement ended · the delegation is dead on-chain"
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
            ? "terms on this card don't permit sub-cards"
            : dead
              ? "none carved before revoke · the tree is empty"
              : "none yet · the agent holding this card carves them itself: connect it, then ask it to issue a sub-card (the issue_subcard tool) · caps only narrow downward, and they appear here"}
        </div>
      )}
    </motion.div>
  );
}
