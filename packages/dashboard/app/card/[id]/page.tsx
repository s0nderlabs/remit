"use client";

// Card detail: the same slab language, scoped to one card. A single dossier ·
// no carousel, no create affordance; the back link rides the floating chrome.

import { use, useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api, type CardState, type Charge, type TreeNode } from "@/lib/api";
import { useRemit } from "../../useRemit";
import { Cockpit } from "../../components/Shell";
import { Dossier } from "../../components/Dossier";
import type { FeedRow } from "../../components/Activity";

type Detail = CardState & { charges: Charge[]; k_agent_address: string };

export default function CardPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const remit = useRemit();
  const { address, logout } = remit;
  const [card, setCard] = useState<Detail | null>(null);
  const [kids, setKids] = useState<Detail[]>([]);
  const [msg, setMsg] = useState<string | null>(null);

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
          Loading… {msg && <span className="err">{msg}</span>}
        </span>
      </main>
    );
  }

  // synthesize the tree node + feed from the per-card details
  const node: TreeNode = { card, children: kids.map((k) => ({ card: k, children: [] })) };
  const kmap = new Map<string, string>([
    [card.card_id, card.k_agent_address],
    ...kids.map((k): [string, string] => [k.card_id, k.k_agent_address]),
  ]);
  const feed: FeedRow[] = [
    ...card.charges.map((ch) => ({ ch, cardName: card.name })),
    ...kids.flatMap((k) => k.charges.map((ch) => ({ ch, cardName: k.name }))),
  ].sort((a, b) => b.ch.at - a.ch.at);

  return (
    <Cockpit
      back={{ href: "/", label: "Dashboard" }}
      remit={remit}
      refresh={refresh}
      onLogout={logout}
      address={address}
    >
      {/* the page h1 lives invisibly in the test contract: status surfaces here */}
      <h1 data-testid="card-status" data-status={card.status} style={{ position: "absolute", left: -9999, top: 0 }}>
        {card.name}
      </h1>

      {msg && (
        <p className="err" style={{ margin: "0 8px 10px" }}>
          {msg}
        </p>
      )}

      <Dossier
        node={node}
        kAgent={card.k_agent_address}
        kmap={kmap}
        feed={feed}
        remit={remit}
        refresh={refresh}
        roots={[node]}
        currentId={card.card_id}
        onDeleted={() => router.replace("/")}
      />
    </Cockpit>
  );
}
