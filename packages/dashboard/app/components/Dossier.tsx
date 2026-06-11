"use client";

// The dossier: ONE slab carrying the whole cockpit. Top zone = dossier head
// (name + statusword + verbs, the money block, the 3-stat band) | the card
// bay (carousel of root cards + the ghost "issue a new card" row). Bottom
// zone = the 30-day barcode, the compact charge list, and two accordion rows
// whose sheets overlay upward so the fold never moves. Selecting a card in
// the bay swaps the ENTIRE dossier with a stagger (the head and bottom zones
// remount keyed by card_id — rise+fade, ~25ms per section).
// All v1 state machines (connect / freeze / revoke) are preserved verbatim.

import { useCallback, useEffect, useRef, useState } from "react";
import { api, type CardState, type TreeNode } from "@/lib/api";
import type { useRemit } from "../useRemit";
import { CardHero } from "./CardHero";
import { ConnectOverlay } from "./ConnectOverlay";
import { RevokeButton, TermsGrid, allowance, caveatCount, perTradeEnforces } from "./Authority";
import { ChargeList, feedStats, type FeedRow } from "./Activity";
import { SubRows } from "./SubCards";
import {
  Barcode,
  IconRevoke,
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
  bayLabel = "your cards",
}: {
  node: TreeNode | null; // the selected card + its direct children
  kAgent?: string;
  kmap: Map<string, string>;
  feed: FeedRow[];
  remit: Remit;
  refresh: () => void | Promise<void>;
  roots: TreeNode[]; // the bay: root cards (card pages pass just [node])
  currentId?: string | null;
  onSelect?: (cardId: string) => void; // carousel selection (home only)
  onIssue?: () => void; // the ghost row — the ONLY create affordance
  bayLabel?: string;
}) {
  const card = node?.card ?? null;
  const dead = card ? isDead(card.status) : false;
  const heroId = card?.card_id ?? "";

  // Connect state lives here so the verb can open the credential overlay —
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

  return (
    <main className={`slab${dead ? " dead" : ""}`}>
      <div className="topzone">
        {card ? (
          <DossierHead
            key={card.card_id} // remount per card: the stagger + per-card odometer
            card={card}
            node={node!}
            feed={feed}
            remit={remit}
            refresh={refresh}
            onConnect={connect}
          />
        ) : (
          <section className="dhead">
            <div className="dr">
              <h1>no cards yet</h1>
              <p style={{ marginTop: 10, fontSize: 12.5, color: "var(--label)", maxWidth: 380 }}>
                issue your first card and hand it to an agent · scoped, revocable, dead on revoke
              </p>
            </div>
          </section>
        )}
        <Bay
          roots={roots}
          currentId={currentId ?? heroId}
          kmap={kmap}
          kAgent={kAgent}
          onSelect={onSelect}
          onIssue={onIssue}
          label={bayLabel}
        />
      </div>

      <BottomZone key={heroId || "empty"} card={card} node={node} kmap={kmap} kAgent={kAgent} feed={feed} />

      {card && connectOpen && connectUrl && (
        <ConnectOverlay card={card} url={connectUrl} onRotate={rotate} rotating={rotating} onClose={closeConnect} />
      )}
    </main>
  );
}

// ---------------------------------------------------------------------------
// (left) the dossier head: name row + verbs, the money block, the stat band
// ---------------------------------------------------------------------------

function DossierHead({
  card,
  node,
  feed,
  remit,
  refresh,
  onConnect,
}: {
  card: CardState;
  node: TreeNode;
  feed: FeedRow[];
  remit: Remit;
  refresh: () => void | Promise<void>;
  onConnect?: () => Promise<void>;
}) {
  const dead = isDead(card.status);
  const frozen = card.status === "frozen";
  const { cap, remaining, spent, spentPct } = allowance(card);
  const ct = card.terms.contract;
  const metered = cap !== null; // a pay budget governs this card
  const ptLive = ct ? perTradeEnforces(ct) : false;

  const [busy, setBusy] = useState(false);
  const [revealing, setRevealing] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
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
  // the connect reveal is read-only — it must not lock freeze/revoke (nor they it)
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

  // the 3-stat band
  const { today, total30, count, okCount } = feedStats(feed);
  const blocked = count - okCount;
  const liveSubs = node.children.filter((c) => !isDead(c.card.status)).length;
  const spentVal = useCountUp(dead ? 0 : (spent ?? total30));
  const [sw, sc] = splitAmount(spentVal);
  const countVal = Math.round(useCountUp(count));
  const subsVal = Math.round(useCountUp(liveSubs));

  return (
    <section className="dhead">
      {/* (1) name row */}
      <div className="dr namerow">
        <div className="cardid">
          <h1>{card.name}</h1>
          <StatusPill status={card.status} />
        </div>
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
              <button className="vpill danger" disabled>
                <IconRevoke size={13} />
                revoke
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
              <RevokeButton
                cardId={card.card_id}
                isSub={!!card.parent_card_id}
                revocable={!dead}
                signDelegation={remit.signDelegation}
                embeddedReady={remit.embeddedReady}
                onDone={refresh}
              />
            </>
          )}
        </div>
      </div>
      {msg && <p className="err" style={{ marginTop: 8 }}>{msg}</p>}

      {/* (2) the money */}
      <div className="dr d2 money num">
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
      </div>

      {/* (3) stats band */}
      <div className="dr d3 stats num">
        <div className="kpi">
          <span className="lbl">{spent !== null ? "spent this period" : "spent · 30 days"}</span>
          <div className="fig2">
            <span className="cur">$</span>
            <span className="int">{sw}</span>
            <span className="dec">.{sc}</span>
          </div>
          <div className="foot">{dead ? "authority dead" : `+${fmtUsd(today)} today`}</div>
        </div>
        <div className="kpi">
          <span className="lbl">charges</span>
          <div className="fig2">
            <span className="int">{countVal}</span>
          </div>
          <div className="foot">
            {count === 0 ? (dead ? "none recorded" : "none yet") : blocked > 0 ? `${blocked} blocked` : "all settled"}
          </div>
        </div>
        <div className="kpi">
          <span className="lbl">live sub-cards</span>
          <div className="fig2">
            <span className="int">{subsVal}</span>
          </div>
          <div className="foot">
            {dead
              ? "tree is empty"
              : card.terms.subcards === false
                ? "not permitted by terms"
                : liveSubs > 0
                  ? "drawing from this scope"
                  : "none drawing yet"}
          </div>
        </div>
      </div>
    </section>
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
// (right) the card bay: the carousel of root cards — cards ARE the navigation.
// One full card visible, the next peeking at the right edge; scroll-snap +
// dots; the dashed ghost row below is the ONLY create affordance.
// ---------------------------------------------------------------------------

function Bay({
  roots,
  currentId,
  kmap,
  kAgent,
  onSelect,
  onIssue,
  label,
}: {
  roots: TreeNode[];
  currentId?: string | null;
  kmap: Map<string, string>;
  kAgent?: string;
  onSelect?: (cardId: string) => void;
  onIssue?: () => void;
  label: string;
}) {
  const carRef = useRef<HTMLDivElement>(null);
  const idx = Math.max(0, roots.findIndex((n) => n.card.card_id === currentId));
  const [flipped, setFlipped] = useState(false);
  useEffect(() => setFlipped(false), [currentId]);

  const step = () => {
    const car = carRef.current;
    if (!car || car.children.length < 2) return 382;
    const a = car.children[0] as HTMLElement;
    const b = car.children[1] as HTMLElement;
    return b.offsetLeft - a.offsetLeft || 382;
  };
  const goTo = (i: number) => {
    const reduced =
      typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    carRef.current?.scrollTo({ left: i * step(), behavior: reduced ? "auto" : "smooth" });
  };

  // hash/initial position: land on the selected card without theater
  const placed = useRef(false);
  useEffect(() => {
    if (placed.current || !carRef.current || roots.length === 0) return;
    placed.current = true;
    if (idx > 0) carRef.current.scrollLeft = idx * step();
  }, [idx, roots.length]);

  const onScroll = () => {
    if (!onSelect || !carRef.current) return;
    const i = Math.max(0, Math.min(roots.length - 1, Math.round(carRef.current.scrollLeft / step())));
    if (roots[i] && roots[i].card.card_id !== currentId) onSelect(roots[i].card.card_id);
  };

  return (
    <aside className="bay">
      <div className="baylbl">
        <span className="lbl">{label}</span>
        {roots.length > 0 && <span className="n num">· {roots.length}</span>}
      </div>
      {roots.length > 0 ? (
        <>
          <div className="car" ref={carRef} onScroll={onScroll}>
            {roots.map((n, i) => {
              const active = i === idx;
              return (
                <div
                  key={n.card.card_id}
                  className={`slide${active ? "" : " off"}${isDead(n.card.status) ? " dead" : ""}`}
                  data-testid={`nav-${n.card.name}`}
                  onClickCapture={
                    active || !onSelect
                      ? undefined
                      : (e) => {
                          e.stopPropagation();
                          e.preventDefault();
                          goTo(i);
                        }
                  }
                >
                  <CardHero
                    card={n.card}
                    holder={n.card.name}
                    agentAddress={kmap.get(n.card.card_id) ?? (active ? kAgent : undefined)}
                    flipped={active && flipped}
                    onFlip={() => active && setFlipped((f) => !f)}
                  />
                </div>
              );
            })}
          </div>
          {roots.length > 1 && (
            <div className="cdots">
              {roots.map((n, i) => (
                <button
                  key={n.card.card_id}
                  className={`cdot${i === idx ? " on" : ""}`}
                  onClick={() => goTo(i)}
                  aria-label={`show ${n.card.name}`}
                />
              ))}
            </div>
          )}
          <div className="bayagg num">{bayAggregate(roots)}</div>
        </>
      ) : (
        <div className="bayempty">the bay is empty · your first card appears here</div>
      )}
      {onIssue && (
        <button className="ghostnew" onClick={onIssue} data-testid="issue-open" aria-haspopup="dialog">
          <svg viewBox="0 0 24 24" fill="none" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
            <path d="M12 5v14M5 12h14" />
          </svg>
          issue a new card
        </button>
      )}
    </aside>
  );
}

/** "2 cards live · $30.00 / wk delegated" — the quiet aggregate under the dots */
function bayAggregate(roots: TreeNode[]): string {
  const live = roots.filter((n) => !isDead(n.card.status));
  if (live.length === 0) return "no live cards";
  const cards = `${live.length} card${live.length === 1 ? "" : "s"} live`;
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
// the bottom zone: barcode chart, the charge list, and the accordion foot
// ---------------------------------------------------------------------------

function BottomZone({
  card,
  node,
  kmap,
  kAgent,
  feed,
}: {
  card: CardState | null;
  node: TreeNode | null;
  kmap: Map<string, string>;
  kAgent?: string;
  feed: FeedRow[];
}) {
  const { bins, binLabels, dayLabels } = feedStats(feed);
  const dead = card ? isDead(card.status) : false;
  const empty = !card
    ? "no activity yet · issue a card to begin"
    : dead
      ? `no activity · authority ${card.status}`
      : "no charges yet · connect an agent and let it spend";

  return (
    <div className="bottomzone">
      <div className="dr d4 chartblock">
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
      </div>

      <div className="dr d5" style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        <ChargeList rows={feed} empty={empty} />
      </div>

      {card && node && <Foot card={card} node={node} kmap={kmap} kAgent={kAgent} />}
    </div>
  );
}

// the foot accordions: delegation terms + sub-cards, sheets overlay upward

function Foot({ card, node, kmap, kAgent }: { card: CardState; node: TreeNode; kmap: Map<string, string>; kAgent?: string }) {
  const [open, setOpen] = useState<"terms" | "subs" | null>(null);
  const footRef = useRef<HTMLDivElement>(null);

  // click anywhere else (or Escape) closes the sheet — the mock's grammar
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (footRef.current && !footRef.current.contains(e.target as Node)) setOpen(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(null);
    };
    document.addEventListener("click", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const dead = isDead(card.status);
  const allowed = card.terms.subcards !== false;
  const kids = node.children;
  const liveKids = kids.filter((c) => !isDead(c.card.status)).length;
  const deadKids = kids.length - liveKids;

  const chev = (
    <svg className="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M6 9l6 6 6-6" />
    </svg>
  );

  const subN = !allowed
    ? "· not allowed"
    : kids.length === 0
      ? dead
        ? "· tree dead"
        : "· none yet"
      : `· ${liveKids} live${deadKids > 0 ? ` · ${deadKids} revoked` : ""}`;
  const subSum = !allowed
    ? "terms on this card don't permit sub-cards"
    : dead
      ? kids.length
        ? "the tree died with the card"
        : "none carved before revoke · the tree is empty"
      : `${liveKids} live · caps narrow downward, revoke cascades`;

  return (
    <div className="dr d6 foot" ref={footRef}>
      <div className={`accrow${open === "terms" ? " open" : ""}`}>
        <button className="ahead2" aria-expanded={open === "terms"} onClick={() => setOpen(open === "terms" ? null : "terms")}>
          <span className="t">delegation terms</span>
          <span className="n num">· {caveatCount(card)}</span>
          <span className="asum num">{termsSummary(card)}</span>
          {chev}
        </button>
        <div className="sheet" onClick={(e) => e.stopPropagation()}>
          <button className="sheethead" onClick={() => setOpen(null)}>
            <span className="t">delegation terms</span>
            <span className="n num">· {dead ? "enforcement ended" : `${caveatCount(card)} caveats enforced on-chain`}</span>
            {chev}
          </button>
          <TermsGrid card={card} agentAddress={kAgent} />
        </div>
      </div>

      <div className={`accrow${open === "subs" ? " open" : ""}`}>
        <button className="ahead2" aria-expanded={open === "subs"} onClick={() => setOpen(open === "subs" ? null : "subs")}>
          <span className="t">sub-cards</span>
          <span className="n num">{subN}</span>
          <span className="asum num">{subSum}</span>
          {chev}
        </button>
        <div className="sheet" onClick={(e) => e.stopPropagation()}>
          <button className="sheethead" onClick={() => setOpen(null)}>
            <span className="t">sub-cards</span>
            <span className="n num">{allowed ? `· allowed ${subN}` : "· not allowed"}</span>
            {chev}
          </button>
          {allowed && kids.length > 0 ? (
            <SubRows node={node} kmap={kmap} />
          ) : (
            <div className="subnote">
              {!allowed
                ? "terms on this card don't permit sub-cards"
                : dead
                  ? "none carved before revoke · the tree is empty"
                  : "none yet · agents carve sub-cards over mcp (issue_subcard) · caps narrow downward"}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** "x402 + fiat · uncapped per charge · any merchant · 26d left" */
function termsSummary(card: CardState): string {
  const t = card.terms;
  const parts: string[] = [];
  parts.push([t.pay ? "x402 + fiat" : null, t.contract ? "execute" : null].filter(Boolean).join(" · ") || "no rails");
  if (t.pay) parts.push(t.perTxMax ? `$${t.perTxMax} per charge` : "uncapped per charge");
  if (t.pay) parts.push(t.merchants?.length ? `${t.merchants.length} merchants` : "any merchant");
  if (isDead(card.status)) {
    parts.push("enforcement ended");
  } else if (card.expires_at) {
    const days = Math.max(0, Math.ceil((card.expires_at * 1000 - Date.now()) / 86400000));
    parts.push(`${days}d left`);
  }
  return parts.join(" · ");
}
