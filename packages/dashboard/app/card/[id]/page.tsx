"use client";

// Card detail: the same shell, scoped to one card. THIS card on the stage with
// its authority; its terms, sub-cards, and attributed charge feed swap below.

import { use, useCallback, useEffect, useRef, useState } from "react";
import { api, type CardState, type Charge, type TreeNode } from "@/lib/api";
import { useRemit } from "../../useRemit";
import { Cockpit, SecHead } from "../../components/Shell";
import { TermsGrid, caveatCount } from "../../components/Authority";
import { SubRows } from "../../components/SubCards";
import { ChargesTable, MetricsRow, periodWindow, type FeedRow } from "../../components/Activity";

type Detail = CardState & { charges: Charge[]; k_agent_address: string };

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "subcards", label: "Sub-cards" },
  { id: "activity", label: "Activity" },
];

export default function CardPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const remit = useRemit();
  const { address, logout } = remit;
  const [card, setCard] = useState<Detail | null>(null);
  const [kids, setKids] = useState<Detail[]>([]);
  const [roots, setRoots] = useState<TreeNode[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [view, setView] = useState("overview");

  // the topbar card rack: root cards, fetched once the wallet is known
  useEffect(() => {
    if (!address) return;
    let live = true;
    api
      .tree(address)
      .then(({ tree }) => {
        if (live) setRoots(tree);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [address]);

  // Sibling navigation (/card/A -> /card/B) reuses this component instance:
  // drop A's data immediately and refuse any of A's still-in-flight responses,
  // or B's URL would briefly show A's authority and charges.
  const idRef = useRef(id);
  useEffect(() => {
    if (idRef.current !== id) {
      setCard(null);
      setKids([]);
      setMsg(null);
    }
    idRef.current = id;
  }, [id]);

  const refresh = useCallback(async () => {
    const want = id;
    try {
      const d = await api.card(want);
      const ks = await Promise.all(d.subcards.map((kid) => api.card(kid).catch(() => null)));
      if (idRef.current !== want) return; // stale response for a previous card
      setCard(d);
      setKids(ks.filter((k): k is Detail => k !== null));
      setMsg(null);
    } catch (e) {
      if (idRef.current === want) setMsg(e instanceof Error ? e.message : String(e));
    }
  }, [id]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [refresh]);

  if (!card) {
    return (
      <main className="narrow" style={{ textAlign: "center" }}>
        <span style={{ color: "var(--body)", fontSize: 13 }}>
          loading… {msg && <span className="err">{msg}</span>}
        </span>
      </main>
    );
  }

  // synthesize the tree node + feed from the per-card details
  const node: TreeNode = { card, children: kids.map((k) => ({ card: k, children: [] })) };
  const kmap = new Map<string, string>(kids.map((k) => [k.card_id, k.k_agent_address]));
  const feed: FeedRow[] = [
    ...card.charges.map((ch) => ({ ch, cardName: card.name })),
    ...kids.flatMap((k) => k.charges.map((ch) => ({ ch, cardName: k.name }))),
  ].sort((a, b) => b.ch.at - a.ch.at);
  const liveSubs = kids.filter((k) => k.status === "active" || k.status === "frozen").length;
  const window_ = periodWindow(card);

  return (
    <Cockpit
      card={card}
      kAgent={card.k_agent_address}
      roots={roots}
      currentId={card.card_id}
      back={{ href: "/", label: "dashboard" }}
      remit={remit}
      refresh={refresh}
      onLogout={logout}
      address={address}
      subcardCount={liveSubs}
      tabs={TABS}
      view={view}
      onView={setView}
    >
      {msg && (
        <p className="err" style={{ marginTop: 20 }}>
          {msg}
        </p>
      )}

      {/* the page h1 lives invisibly in the test contract: status surfaces here */}
      <h1 data-testid="card-status" data-status={card.status} style={{ position: "absolute", left: -9999, top: 0 }}>
        {card.name}
      </h1>

      {view === "overview" && (
        <>
          <section className="sec panel">
            <SecHead
              title={card.parent_card_id ? "Sub-card · this period" : "This period"}
              right={window_ ?? "all time"}
            />
            <MetricsRow card={card} feed={feed} liveSubs={liveSubs} />
          </section>
          <section className="sec panel">
            <SecHead title="Delegation terms" right={`${caveatCount(card)} terms on this card`} />
            <TermsGrid card={card} agentAddress={card.k_agent_address} />
          </section>
        </>
      )}

      {view === "subcards" && (
        <section className="sec panel">
          <SecHead title="Sub-cards" right="caps narrow downward" />
          {node.children.length > 0 ? (
            <SubRows node={node} kmap={kmap} />
          ) : (
            <p style={{ marginTop: 16, fontSize: 12.5, color: "var(--label)" }}>
              none yet · agents issue sub-cards over MCP (<span className="data" style={{ fontSize: 11.5 }}>issue_subcard</span>),
              caps narrow downward
            </p>
          )}
        </section>
      )}

      {view === "activity" && (
        <section className="sec panel">
          <SecHead
            title="Activity"
            right={
              <span className="pill live">
                <b />
                live
              </span>
            }
          />
          <ChargesTable rows={feed} />
        </section>
      )}
    </Cockpit>
  );
}
