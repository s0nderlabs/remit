"use client";

// Sub-cards as list rows: silk thumbnail, name + PAN, status, cap narrowing
// downward. Rows navigate to the card's own cockpit. Cascade truth in the footer.

import Link from "next/link";
import type { TreeNode } from "@/lib/api";
import { Guilloche, fmtUsd, isDead, panGroups, periodLabel } from "./ui";
import { allowance } from "./Authority";

function rowClass(status: string): string {
  if (status === "frozen") return "srow frozen";
  if (isDead(status)) return "srow dead";
  return "srow";
}

export function SubRows({
  node,
  kmap,
  onIssue,
}: {
  node: TreeNode;
  kmap: Map<string, string>;
  onIssue?: () => void;
}) {
  return (
    <>
      <div className="subrows">
        {node.children.map((kid) => {
          const c = kid.card;
          const capAmt = c.terms.pay?.period?.amount ?? c.terms.pay?.lifetime?.amount ?? null;
          const per = c.terms.pay?.period ? ` / ${periodLabel(c.terms.pay.period.seconds)}` : "";
          const ct = c.terms.contract;
          const capLine = capAmt
            ? `≤ $${capAmt}${per}`
            : ct
              ? `execute${ct.perTradeMax ? ` · ≤ $${ct.perTradeMax}/trade` : ""}`
              : "unmetered";
          const { spent } = allowance(c);
          const dead = isDead(c.status);
          return (
            <Link key={c.card_id} href={`/card/${c.card_id}`} className={rowClass(c.status)}>
              <span className="thumb">
                <Guilloche width={64} height={14} strands={5} amp={4.5} />
              </span>
              <span>
                <span className="nm">{c.name}</span>
                <span className="pan">{panGroups(kmap.get(c.card_id) ?? c.card_id).join(" ")}</span>
              </span>
              <span className="st">
                <b />
                {c.status}
              </span>
              <span className="capb">
                <span className="c1">{capLine}</span>
                <span className="c2">
                  {dead || spent === null || spent === 0 ? (
                    "no spend"
                  ) : (
                    <>
                      <span className="data">{fmtUsd(spent)}</span> spent
                    </>
                  )}
                </span>
              </span>
              <span className="chev">
                <svg width="7" height="11" viewBox="0 0 7 11" fill="none">
                  <path d="M1 1l5 4.5L1 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
            </Link>
          );
        })}
        {onIssue && (
          <button className="srow ghostrow" onClick={onIssue} data-testid="nav-issue">
            <span className="ghostthumb" />
            <span className="ghostlabel">+ Issue card</span>
          </button>
        )}
      </div>
      <div className="cascade">
        <span className="data">ERC-7710</span> redelegation · revoke root, the tree dies (
        <span className="data">NonceEnforcer</span> cascade)
      </div>
    </>
  );
}
