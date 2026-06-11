"use client";

// Home: Privy login -> embedded wallet -> onboard (silent 7702) -> the stage.
// Rail = nav + cards; stage = the card and its authority, views swap below.
// All v1 flows preserved (testids intact).

import { useCallback, useEffect, useRef, useState } from "react";
import { api, type TreeNode, type CardTermsInput, type CompileLabel, type CompileResult } from "@/lib/api";
import { useRemit } from "./useRemit";
import { Cockpit, SecHead } from "./components/Shell";
import { TermsGrid, caveatCount } from "./components/Authority";
import { SubRows } from "./components/SubCards";
import { ChargesTable, MetricsRow, periodWindow, type FeedRow } from "./components/Activity";
import { isDead, shortHex } from "./components/ui";

export default function Home() {
  const remit = useRemit();
  const { ready, authenticated, user, address, login, logout, sign7702, signOnboardProof, embeddedReady } = remit;
  const did = user?.id;

  const [onboarded, setOnboarded] = useState(false);
  const [probed, setProbed] = useState(false);
  const [onboarding, setOnboarding] = useState(false);
  const [onboardErr, setOnboardErr] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const onboardingRef = useRef(false);
  const prevDidRef = useRef<string | undefined>(undefined);

  // Re-arm onboarding whenever the Privy identity changes (logout, or switching to a
  // different account in the SAME tab — the Home component instance and its state
  // persist across login transitions, so stale onboarded=true would otherwise gate the
  // new DID out and every /api call would 403 in a loop). Runs before the onboard effect.
  useEffect(() => {
    if (prevDidRef.current !== undefined && prevDidRef.current !== did) {
      setOnboarded(false);
      setProbed(false);
      setOnboardErr(null);
      onboardingRef.current = false;
    }
    prevDidRef.current = did;
  }, [did]);

  // Returning-user fast path: if a cheap authed read succeeds, the server already
  // knows this wallet — skip the 7702 + proof ceremony (and its interstitial)
  // entirely. Only when the probe fails (server doesn't know the wallet yet) does
  // the full onboard run below.
  useEffect(() => {
    if (!authenticated || !address || !did || onboarded || probed) return;
    let live = true;
    (async () => {
      try {
        await api.cards();
        if (live) setOnboarded(true);
      } catch {
        // unknown wallet (or transient failure) — fall through to the ceremony
      } finally {
        if (live) setProbed(true);
      }
    })();
    return () => {
      live = false;
    };
  }, [authenticated, address, did, onboarded, probed]);

  // Auto-onboard once the embedded wallet is ready: sign the 7702 authorization
  // (silent, grants nothing) + the onboard proof (binds the wallet to this Privy
  // login server-side) and register the wallet. Runs once; retryNonce re-arms it
  // after a failure.
  useEffect(() => {
    if (!probed || !authenticated || !address || !did || !embeddedReady || onboarded || onboardingRef.current) return;
    onboardingRef.current = true;
    setOnboarding(true);
    (async () => {
      try {
        const auth = await sign7702();
        const proof = await signOnboardProof(did);
        await api.onboard(address, auth, proof);
        setOnboarded(true);
        setOnboardErr(null);
      } catch (e) {
        setOnboardErr(e instanceof Error ? e.message : String(e));
        onboardingRef.current = false; // allow a retry
      } finally {
        setOnboarding(false);
      }
    })();
  }, [probed, authenticated, address, did, embeddedReady, onboarded, sign7702, signOnboardProof, retryNonce]);

  if (!ready) return <Centered note="loading…" />;
  if (!authenticated) return <Login onLogin={login} />;

  if (!address) return <Centered note="creating your embedded wallet…" />;
  if (!onboarded && !probed) return <Centered note="loading…" />;
  if (!onboarded) {
    return (
      <main className="narrow" data-testid="onboarding">
        <div className="panel" style={{ textAlign: "center", padding: 40 }}>
          <span className="pill live" style={{ marginBottom: 16 }}>
            <b />
            {onboarding ? "Activating" : "Activation pending"}
          </span>
          <p style={{ color: "var(--body)", fontSize: 13, marginTop: 14 }}>
            {onboarding
              ? "signing your 7702 authorization · silent, grants nothing on its own"
              : "waiting for your embedded wallet"}
          </p>
          {onboardErr && (
            <p className="err" style={{ marginTop: 12 }}>
              onboard failed: {onboardErr}{" "}
              <button
                style={{ marginLeft: 8 }}
                onClick={() => {
                  onboardingRef.current = false;
                  setOnboardErr(null);
                  setRetryNonce((n) => n + 1);
                }}
              >
                retry
              </button>
            </p>
          )}
        </div>
      </main>
    );
  }

  return <Dashboard remit={remit} address={address} onLogout={logout} />;
}

function Centered({ note }: { note: string }) {
  return (
    <main className="narrow" style={{ textAlign: "center" }}>
      <span style={{ color: "var(--body)", fontSize: 13 }}>{note}</span>
    </main>
  );
}

function Login({ onLogin }: { onLogin: () => void }) {
  return (
    <main className="narrow" style={{ textAlign: "center", paddingTop: 140 }}>
      <h1 className="rv" style={{ animationDelay: ".08s", fontSize: 32 }}>
        remit
      </h1>
      <p className="rv serif" style={{ animationDelay: ".16s", fontSize: 18, color: "var(--body)", marginTop: 6 }}>
        authority, lent not given.
      </p>
      <p className="rv" style={{ animationDelay: ".24s", color: "var(--body)", fontSize: 13, margin: "18px 0 26px" }}>
        scoped, revocable spending cards for your agents · email or Google · no seed phrase
      </p>
      <span className="rv" style={{ animationDelay: ".32s", display: "inline-block" }}>
        <button className="primary" onClick={onLogin} data-testid="login">
          Sign in
        </button>
      </span>
    </main>
  );
}

// ---------------------------------------------------------------------------

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "subcards", label: "Sub-cards" },
  { id: "activity", label: "Activity" },
];

function Dashboard({
  remit,
  address,
  onLogout,
}: {
  remit: ReturnType<typeof useRemit>;
  address: string;
  onLogout: () => void;
}) {
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [kAgent, setKAgent] = useState<string | undefined>(undefined);
  const [kmap, setKmap] = useState<Map<string, string>>(new Map());
  const [feed, setFeed] = useState<FeedRow[]>([]);
  const [view, setView] = useState("overview");
  const [issueOpen, setIssueOpen] = useState(false);

  // hero = the first live root (or the first root at all)
  const heroNode = tree.find((n) => !isDead(n.card.status)) ?? tree[0] ?? null;

  const refresh = useCallback(async () => {
    try {
      const { tree } = await api.tree(address);
      setTree(tree);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [address]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [refresh]);

  // Detail poll: the hero card + its direct sub-cards, merged into one attributed
  // feed (the ledger answers "who spent this"). Same 3s cadence as the tree.
  const heroId = heroNode?.card.card_id ?? "";
  const idsKey = heroNode
    ? [heroNode.card.card_id, ...heroNode.children.map((c) => c.card.card_id)].join(",")
    : "";

  // When the HERO itself changes (revoke/nuke demotes it, or a new root takes
  // over), drop the old hero's feed immediately — never show the previous
  // card's spend and delegate attributed to the new one while the load runs.
  useEffect(() => {
    setFeed([]);
    setKAgent(undefined);
    setKmap(new Map());
  }, [heroId]);
  useEffect(() => {
    if (!idsKey) {
      setFeed([]);
      setKAgent(undefined);
      setKmap(new Map());
      return;
    }
    const ids = idsKey.split(",");
    let live = true;
    const load = async () => {
      const ds = await Promise.all(ids.map((id) => api.card(id).catch(() => null)));
      if (!live) return;
      const km = new Map<string, string>();
      const rows: FeedRow[] = [];
      ds.forEach((d, i) => {
        if (!d) return;
        km.set(ids[i], d.k_agent_address);
        for (const ch of d.charges) rows.push({ ch, cardName: d.name });
      });
      rows.sort((a, b) => b.ch.at - a.ch.at);
      setKAgent(ds[0]?.k_agent_address);
      setKmap(km);
      setFeed(rows);
    };
    load();
    const t = setInterval(load, 3000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [idsKey]);

  const liveSubs = heroNode ? heroNode.children.filter((c) => !isDead(c.card.status)).length : 0;
  const window_ = periodWindow(heroNode?.card ?? null);
  const openIssue = () => setIssueOpen(true);

  return (
    <Cockpit
      card={heroNode?.card ?? null}
      kAgent={kAgent}
      roots={tree}
      currentId={heroNode?.card.card_id ?? null}
      remit={remit}
      refresh={refresh}
      onLogout={onLogout}
      address={address}
      subcardCount={liveSubs}
      tabs={TABS}
      view={view}
      onView={setView}
      onIssue={openIssue}
      nukeable={tree.some((n) => n.card.status === "active" || n.card.status === "frozen")}
    >
      {error && (
        <p className="err" style={{ marginTop: 20 }}>
          api error: {error}
        </p>
      )}

      {(issueOpen || !heroNode) && (
        <section className="sec panel issuebox">
          <div className="phead">
            <h2>{heroNode ? "Issue a card" : "Issue your first card"}</h2>
            <div className="r">
              client-signed · the URL is the credential
              {heroNode && (
                <button className="closex" onClick={() => setIssueOpen(false)} aria-label="close">
                  ✕
                </button>
              )}
            </div>
          </div>
          <Composer remit={remit} address={address} onIssued={refresh} />
        </section>
      )}

      {heroNode && view === "overview" && (
        <>
          <section className="sec panel">
            <SecHead title="This period" right={window_ ?? "all time"} />
            <MetricsRow card={heroNode.card} feed={feed} liveSubs={liveSubs} />
          </section>
          <section className="sec panel">
            <SecHead title="Delegation terms" right={`${caveatCount(heroNode.card)} terms on this card`} />
            <TermsGrid card={heroNode.card} agentAddress={kAgent} />
          </section>
        </>
      )}

      {heroNode && view === "subcards" && (
        <section className="sec panel">
          <SecHead title="Sub-cards" right="caps narrow downward" />
          <SubRows node={heroNode} kmap={kmap} onIssue={openIssue} />
        </section>
      )}

      {heroNode && view === "activity" && (
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

// ---------------------------------------------------------------------------
// Composer: client-signed issuance (prepare -> sign -> finalize), v1 logic.
// Two ways in, one draft: describe the card in plain English (the Venice
// compile box prefills the fields) or set the spec-sheet rows by hand —
// card / pay / execute. Either way the user reviews every field and signs.
// ---------------------------------------------------------------------------

const PERIODS = [86400, 604800, 2592000];
const closestPeriod = (s: number) => PERIODS.reduce((a, b) => (Math.abs(b - s) < Math.abs(a - s) ? b : a));
const splitList = (s: string) =>
  s
    .split(/[,\n]/)
    .map((x) => x.trim())
    .filter(Boolean);
/** split a comma list, but never inside parentheses — method signatures carry commas */
const splitSelectors = (s: string): string[] => {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    if ((ch === "," || ch === "\n") && depth === 0) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
};

function Composer({
  remit,
  address,
  onIssued,
}: {
  remit: ReturnType<typeof useRemit>;
  address: string;
  onIssued: () => void;
}) {
  // card
  const [name, setName] = useState("agent card");
  const [expiryDays, setExpiryDays] = useState(30);
  const [maxUses, setMaxUses] = useState("");
  const [subcards, setSubcards] = useState(true);
  // pay lane
  const [amount, setAmount] = useState("25");
  const [period, setPeriod] = useState(604800);
  const [lifetime, setLifetime] = useState("");
  const [perTx, setPerTx] = useState("");
  const [merchants, setMerchants] = useState("");
  // execute lane (#42)
  const [targets, setTargets] = useState("");
  const [selectors, setSelectors] = useState("");
  const [tokens, setTokens] = useState("");
  const [perTrade, setPerTrade] = useState("");

  const [draftN, setDraftN] = useState(0); // bumps on every applied draft (re-runs the flash)
  const [busy, setBusy] = useState(false);
  const [issuedUrl, setIssuedUrl] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  function buildTerms(): CardTermsInput {
    const pay: NonNullable<CardTermsInput["pay"]> = {};
    if (amount.trim() && parseFloat(amount) > 0) pay.period = { amount: amount.trim(), seconds: period };
    if (lifetime.trim()) pay.lifetime = { amount: lifetime.trim() };
    const tg = splitList(targets);
    const sel = splitSelectors(selectors);
    const tk = splitList(tokens);
    const contract =
      tg.length && sel.length
        ? {
            targets: tg,
            selectors: sel,
            ...(tk.length ? { tokens: tk } : {}),
            ...(perTrade.trim() ? { perTradeMax: perTrade.trim() } : {}),
          }
        : undefined;
    const uses = parseInt(maxUses, 10);
    return {
      ...(pay.period || pay.lifetime ? { pay } : {}),
      ...(contract ? { contract } : {}),
      expiry: Math.floor(Date.now() / 1000) + expiryDays * 86400,
      subcards,
      ...(Number.isFinite(uses) && uses >= 1 ? { maxUses: uses } : {}),
      ...(perTx.trim() ? { perTxMax: perTx.trim() } : {}),
      ...(merchants.trim() ? { merchants: splitList(merchants) } : {}),
    };
  }

  /** prefill every field from a compiled draft — the user still reviews + signs */
  function applyDraft(r: CompileResult) {
    const d = r.draft;
    if (!d) return;
    if (d.pay?.period) {
      setAmount(d.pay.period.amount);
      setPeriod(closestPeriod(d.pay.period.seconds));
    } else {
      setAmount("");
    }
    setLifetime(d.pay?.lifetime?.amount ?? "");
    setPerTx(d.perTxMax ?? "");
    setMerchants((d.merchants ?? []).join(", "));
    if (d.expiry) setExpiryDays(Math.max(1, Math.round((d.expiry - Date.now() / 1000) / 86400)));
    setMaxUses(d.maxUses ? String(d.maxUses) : "");
    if (d.subcards !== undefined) setSubcards(d.subcards);
    setTargets((d.contract?.targets ?? []).join(", "));
    setSelectors((d.contract?.selectors ?? []).join(", "));
    setTokens((d.contract?.tokens ?? []).join(", "));
    setPerTrade(d.contract?.perTradeMax ?? "");
    setDraftN((n) => n + 1);
  }

  async function issue() {
    setErr(null);
    setIssuedUrl(null);
    // a half-filled execute scope must not silently vanish from the signed terms
    const hasTargets = splitList(targets).length > 0;
    const hasSelectors = splitSelectors(selectors).length > 0;
    if (hasTargets !== hasSelectors) {
      setErr("the execute scope needs both contracts and methods · fill both or clear both");
      return;
    }
    // tokens/per-trade live inside the contract block; without a scope they'd be
    // silently dropped from the signed terms
    if ((splitList(tokens).length > 0 || perTrade.trim()) && !hasTargets) {
      setErr("a token allowance needs a contract scope · add contracts and methods, or clear the token fields");
      return;
    }
    const terms = buildTerms();
    if (!terms.pay && !terms.contract) {
      setErr("give the card a pay budget or a contract scope · an empty card can do nothing");
      return;
    }
    setBusy(true);
    try {
      // 1) server compiles caveats + mints K_agent, returns the UNSIGNED delegation
      const prep = await api.prepareCard(name, terms, address);
      // 2) the embedded wallet signs it in the browser (the issuance ceremony)
      const signature = await remit.signDelegation(prep.delegation);
      // 3) server attaches the signature + persists the card
      const res = await api.finalizeCard(prep.prepare_id, signature);
      setIssuedUrl(res.card_url);
      onIssued();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const field = (label: string, el: React.ReactNode) => (
    <div className="field">
      <label>{label}</label>
      {el}
    </div>
  );

  return (
    <>
      <CompileBox onDraft={applyDraft} />
      <div className="ordiv">
        <span>or set the terms yourself</span>
      </div>
      <div className={`composer2${draftN ? " flash" : ""}`} key={draftN}>
        <div className="crow">
          <span className="cgroup">card</span>
          {field("Name", <input value={name} onChange={(e) => setName(e.target.value)} style={{ width: 150 }} data-testid="composer-name" />)}
          {field(
            "Expires · days",
            <input type="number" value={expiryDays} onChange={(e) => setExpiryDays(Number(e.target.value))} style={{ width: 72 }} />,
          )}
          {field(
            "Max uses",
            <input value={maxUses} onChange={(e) => setMaxUses(e.target.value)} placeholder="∞" style={{ width: 72 }} data-testid="composer-maxuses" />,
          )}
          {field(
            "Sub-cards",
            <select value={subcards ? "yes" : "no"} onChange={(e) => setSubcards(e.target.value === "yes")}>
              <option value="yes">allowed</option>
              <option value="no">no</option>
            </select>,
          )}
        </div>

        <div className="crow">
          <span className="cgroup">pay · usdc</span>
          {field(
            "Budget",
            <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="none" style={{ width: 92 }} data-testid="composer-amount" />,
          )}
          {field(
            "Per",
            <select value={period} onChange={(e) => setPeriod(Number(e.target.value))}>
              <option value={86400}>day</option>
              <option value={604800}>week</option>
              <option value={2592000}>30 days</option>
            </select>,
          )}
          {field(
            "Lifetime cap",
            <input value={lifetime} onChange={(e) => setLifetime(e.target.value)} placeholder="none" style={{ width: 92 }} data-testid="composer-lifetime" />,
          )}
          {field("Per-charge max", <input value={perTx} onChange={(e) => setPerTx(e.target.value)} placeholder="none" style={{ width: 92 }} />)}
          {field(
            "Merchant lock",
            <input value={merchants} onChange={(e) => setMerchants(e.target.value)} placeholder="0x…, 0x…" style={{ width: 170 }} />,
          )}
        </div>

        <div className="crow">
          <span className="cgroup">execute · contracts</span>
          {field(
            "Contracts",
            <input className="wide" value={targets} onChange={(e) => setTargets(e.target.value)} placeholder="0x…, 0x…" data-testid="composer-targets" />,
          )}
          {field(
            "Methods",
            <input
              className="wide"
              value={selectors}
              onChange={(e) => setSelectors(e.target.value)}
              placeholder="approve(address,uint256), …"
              data-testid="composer-selectors"
            />,
          )}
          {field(
            "Tokens · allowance",
            <input value={tokens} onChange={(e) => setTokens(e.target.value)} placeholder="0x… · optional" style={{ width: 136 }} data-testid="composer-tokens" />,
          )}
          {field(
            "Per-trade max",
            <input value={perTrade} onChange={(e) => setPerTrade(e.target.value)} placeholder="none" style={{ width: 92 }} data-testid="composer-pertrademax" />,
          )}
        </div>

        <div className="cfoot">
          <p className="chint">leave pay empty for an execute-only card · leave contracts empty for a pay-only card</p>
          <button className="primary" onClick={issue} disabled={busy} data-testid="composer-issue">
            {busy ? "signing…" : "Issue card"}
          </button>
        </div>
      </div>
      {err && <p className="err" style={{ marginTop: 12 }}>{err}</p>}
      {issuedUrl && (
        <div style={{ marginTop: 16, maxWidth: 560 }}>
          <div className="ok" style={{ marginBottom: 8 }}>
            card issued · hand this URL to your agent (it IS the credential):
          </div>
          <div className="urlbox" data-testid="issued-url">
            {issuedUrl}
          </div>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// CompileBox: describe the card in plain English; Venice drafts a plan, the
// server resolves every name against its verified registry (the model never
// supplies addresses), and the draft prefills the composer (#43). Never issues.
// ---------------------------------------------------------------------------

function CompileBox({ onDraft }: { onDraft: (r: CompileResult) => void }) {
  const [intent, setIntent] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [labels, setLabels] = useState<CompileLabel[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [drafted, setDrafted] = useState(false);

  async function go() {
    if (!intent.trim() || busy) return;
    setBusy(true);
    setErr(null);
    setDrafted(false);
    setLabels([]);
    setWarnings([]);
    try {
      const r = await api.compile(intent.trim());
      setLabels(r.labels);
      setWarnings(r.warnings);
      if (r.draft) {
        onDraft(r);
        setDrafted(true);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="compilebox">
      <div className="cbtop">
        <span className="lbl">Describe the card</span>
        <span className="cbven">venice drafts · you sign</span>
      </div>
      <div className="cbrow">
        <textarea
          value={intent}
          rows={2}
          maxLength={2000}
          placeholder="$25 a week for api calls, can swap usdc to weth on uniswap up to $50 per trade, expires in 30 days"
          onChange={(e) => setIntent(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) go();
          }}
          data-testid="compile-intent"
        />
        <button className="primary" onClick={go} disabled={busy || !intent.trim()} data-testid="compile-go">
          {busy ? "drafting…" : "Draft terms"}
        </button>
      </div>
      {err && (
        <p className="err" style={{ marginTop: 10 }}>
          {err}
        </p>
      )}
      {drafted && (
        <p className="ok" style={{ marginTop: 10 }}>
          draft applied below · review every term before signing
        </p>
      )}
      {labels.length > 0 && (
        <div className="lblchips" data-testid="compile-labels">
          {labels.map((l) => (
            <span key={`${l.address}-${l.label}`} className="lblchip" title={`${l.address} · ${l.source}`}>
              <i className={`lk ${l.kind}`} />
              {l.label}
              <span className="data">{shortHex(l.address)}</span>
            </span>
          ))}
        </div>
      )}
      {warnings.length > 0 && (
        <ul className="warnlist" data-testid="compile-warnings">
          {warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      )}
      <p className="cbnote">addresses resolve from a verified registry or your own text · the model never supplies them</p>
    </div>
  );
}

// The wallet-level nuke verb lives in the avatar menu (Shell.tsx · NukeItem).
