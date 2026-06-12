"use client";

// Home: Privy login -> embedded wallet -> onboard (silent 7702) -> the dossier.
// One slab carries everything; the card bay's carousel selects which root card
// the dossier reads; the ghost row opens the issue modal (a card being born).
// All v1 flows preserved (testids intact).

import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { api, type TreeNode, type CardTermsInput, type CompileLabel, type CompileResult } from "@/lib/api";
import { useRemit } from "./useRemit";
import { Cockpit } from "./components/Shell";
import { Dossier, bayAggregate } from "./components/Dossier";
import { ConnectChips, UrlBox } from "./components/Authority";
import { Select } from "./components/Select";
import type { FeedRow } from "./components/Activity";
import { ChipDots, Guilloche, isDead, periodLabel, shortHex } from "./components/ui";

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

  // Boot watchdog: if a pre-dashboard screen still shows after this long, the
  // session is wedged (Privy init, a stale session's token refresh, the wallet
  // iframe · all seen on iOS Safari / in-app browsers). Surface recovery
  // actions instead of an infinite spinner. Re-arms on every boot-gate
  // transition so a NORMAL step (fresh login, wallet landing) never inherits
  // a stale 12s clock and flashes the recovery panel instantly.
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setSlow(false);
    const t = setTimeout(() => setSlow(true), 12_000);
    return () => clearTimeout(t);
  }, [ready, authenticated, address, probed, onboarded]);
  const reset = useCallback(async () => {
    try {
      // a wedged SDK can also hang logout · bound it
      await Promise.race([logout(), new Promise((r) => setTimeout(r, 2500))]);
    } catch {
      // a failed sign-out still proceeds to the storage sweep
    }
    try {
      for (const k of Object.keys(localStorage)) if (k.startsWith("privy:")) localStorage.removeItem(k);
    } catch {
      // storage unavailable (private mode) · the reload is still the reset
    }
    window.location.reload();
  }, [logout]);

  // Re-arm onboarding whenever the Privy identity changes (logout, or switching to a
  // different account in the SAME tab · the Home component instance and its state
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
  // knows this wallet · skip the 7702 + proof ceremony (and its interstitial)
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
        // unknown wallet (or transient failure) · fall through to the ceremony
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

  if (!ready) return <Centered note="Loading…" slow={slow} onReset={reset} />;
  if (!authenticated) return <Login onLogin={login} />;

  if (!address) return <Centered note="Creating your embedded wallet…" slow={slow} onReset={reset} />;
  if (!onboarded && !probed) return <Centered note="Loading…" slow={slow} onReset={reset} />;
  if (!onboarded) {
    return (
      <main className="narrow" data-testid="onboarding">
        <div className="panel" style={{ textAlign: "center", padding: 40 }}>
          <span className="pill live" style={{ marginBottom: 16 }}>
            <b />
            {onboarding ? "Activating" : "Activation Pending"}
          </span>
          <p style={{ color: "var(--body)", fontSize: 13, marginTop: 14 }}>
            {onboarding
              ? "Signing your 7702 authorization · silent, grants nothing on its own"
              : "Waiting for your embedded wallet"}
          </p>
          {onboardErr && (
            <p className="err" style={{ marginTop: 12 }}>
              Onboard failed: {onboardErr}{" "}
              <button
                style={{ marginLeft: 8 }}
                onClick={() => {
                  onboardingRef.current = false;
                  setOnboardErr(null);
                  setRetryNonce((n) => n + 1);
                }}
              >
                Retry
              </button>
            </p>
          )}
        </div>
      </main>
    );
  }

  return <Dashboard remit={remit} address={address} onLogout={logout} />;
}

function Centered({ note, slow, onReset }: { note: string; slow?: boolean; onReset?: () => void }) {
  return (
    <main className="narrow" style={{ textAlign: "center" }}>
      <span style={{ color: "var(--body)", fontSize: 13 }}>{note}</span>
      {slow && (
        <div className="bootstuck" data-testid="boot-stuck">
          <p>Still going · the session on this device may be wedged.</p>
          <div className="row" style={{ justifyContent: "center" }}>
            <button onClick={() => window.location.reload()}>Reload</button>
            {onReset && (
              <button onClick={onReset} data-testid="boot-reset">
                Sign Out and Start Over
              </button>
            )}
          </div>
        </div>
      )}
    </main>
  );
}

function Login({ onLogin }: { onLogin: () => void }) {
  return (
    <main className="narrow" style={{ textAlign: "center", paddingTop: 140 }}>
      <h1 className="rv" style={{ animationDelay: ".08s", fontSize: 32 }}>
        remit
      </h1>
      <p className="rv serif" style={{ animationDelay: ".16s", fontSize: 16, marginTop: 6 }}>
        Authority, lent not given.
      </p>
      <p className="rv" style={{ animationDelay: ".24s", color: "var(--body)", fontSize: 13, margin: "18px 0 26px" }}>
        Scoped, revocable spending cards for your agents · email or Google · no seed phrase
      </p>
      <span className="rv" style={{ animationDelay: ".32s", display: "inline-block" }}>
        <button className="primary" onClick={onLogin} data-testid="login">
          Sign In
        </button>
      </span>
    </main>
  );
}

// ---------------------------------------------------------------------------

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
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [kAgent, setKAgent] = useState<string | undefined>(undefined);
  const [kmap, setKmap] = useState<Map<string, string>>(new Map());
  const [feed, setFeed] = useState<FeedRow[]>([]);
  const [selId, setSelId] = useState<string | null>(null);
  const [issueOpen, setIssueOpen] = useState(false);

  // hero = the carousel's selection; defaults to the first live root
  const heroNode =
    (selId ? tree.find((n) => n.card.card_id === selId) : undefined) ??
    tree.find((n) => !isDead(n.card.status)) ??
    tree[0] ??
    null;

  const refresh = useCallback(async () => {
    try {
      const { tree } = await api.tree(address);
      setTree(tree);
      setError(null);
      setLoaded(true);
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

  // When the HERO itself changes (carousel selection, revoke/nuke demotes it, or
  // a new root takes over), drop the old hero's feed immediately · never show the
  // previous card's spend and delegate attributed to the new one while the load runs.
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

  // first-run: no cards yet · the modal IS the front door
  const modalOpen = issueOpen || (loaded && tree.length === 0);

  return (
    <Cockpit
      remit={remit}
      refresh={refresh}
      onLogout={onLogout}
      address={address}
      nukeable={tree.some((n) => n.card.status === "active" || n.card.status === "frozen")}
      aggregate={loaded ? bayAggregate(tree) : undefined}
    >
      {error && (
        <p className="err" style={{ margin: "0 8px 10px" }}>
          API error: {error}
        </p>
      )}

      <Dossier
        node={heroNode}
        kAgent={kAgent}
        kmap={kmap}
        feed={feed}
        remit={remit}
        refresh={refresh}
        roots={tree}
        currentId={heroId || null}
        onSelect={setSelId}
        onIssue={() => setIssueOpen(true)}
        onDeleted={() => {
          // the selection must not keep pointing at a deleted card
          setSelId(null);
          return refresh();
        }}
      />

      <AnimatePresence>
        {modalOpen && (
          <IssueModal
            key="issue"
            remit={remit}
            address={address}
            firstCard={tree.length === 0}
            onIssued={() => {
              // refresh fills the tree; pin the modal open so the first-run path
              // doesn't unmount it before the URL handoff is read
              setIssueOpen(true);
              return refresh();
            }}
            onClose={tree.length > 0 ? () => setIssueOpen(false) : undefined}
          />
        )}
      </AnimatePresence>
    </Cockpit>
  );
}

// ---------------------------------------------------------------------------
// IssueModal: "a card being born". The plain-language textarea compiles via
// Venice (api.compile) into a draft; the terms chips populate and a miniature
// card face materializes; "review + sign" runs the EXISTING client-signed
// issuance ceremony (prepare -> sign -> finalize). "edit terms yourself"
// expands the full composer field set. After issue, the URL handoff renders
// in place. All composer-* testids and the v1 guards preserved.
// ---------------------------------------------------------------------------

const PERIODS = [86400, 604800, 2592000];
const closestPeriod = (s: number) => PERIODS.reduce((a, b) => (Math.abs(b - s) < Math.abs(a - s) ? b : a));
const splitList = (s: string) =>
  s
    .split(/[,\n]/)
    .map((x) => x.trim())
    .filter(Boolean);
/** split a comma list, but never inside parentheses · method signatures carry commas */
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

const periodWord = (s: number) => (s <= 86400 ? "a day" : s <= 604800 ? "a week" : "per 30 days");

function IssueModal({
  remit,
  address,
  firstCard,
  onIssued,
  onClose,
}: {
  remit: ReturnType<typeof useRemit>;
  address: string;
  firstCard: boolean;
  onIssued: () => void;
  onClose?: () => void; // absent on first-run: the modal is the only door
}) {
  // card
  const [name, setName] = useState("Agent Card");
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

  // compile (Venice drafts · you sign)
  const [intent, setIntent] = useState("");
  const [compiling, setCompiling] = useState(false);
  const [compileErr, setCompileErr] = useState<string | null>(null);
  const [labels, setLabels] = useState<CompileLabel[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);

  const [draftN, setDraftN] = useState(0); // bumps on every applied draft (re-runs the flash + chips)
  const [editOpen, setEditOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [issuedUrl, setIssuedUrl] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Escape closes (when closable) + the page behind never scrolls
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && onClose) onClose();
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

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

  /** prefill every field from a compiled draft · the user still reviews + signs */
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

  async function compile() {
    if (!intent.trim() || compiling) return;
    setCompiling(true);
    setCompileErr(null);
    setLabels([]);
    setWarnings([]);
    try {
      const r = await api.compile(intent.trim());
      setLabels(r.labels);
      setWarnings(r.warnings);
      if (r.draft) applyDraft(r);
    } catch (e) {
      setCompileErr(e instanceof Error ? e.message : String(e));
    } finally {
      setCompiling(false);
    }
  }

  async function issue() {
    setErr(null);
    setIssuedUrl(null);
    // a half-filled execute scope must not silently vanish from the signed terms
    const hasTargets = splitList(targets).length > 0;
    const hasSelectors = splitSelectors(selectors).length > 0;
    if (hasTargets !== hasSelectors) {
      setErr("The execute scope needs both contracts and methods · fill both or clear both");
      return;
    }
    // tokens/per-trade live inside the contract block; without a scope they'd be
    // silently dropped from the signed terms
    if ((splitList(tokens).length > 0 || perTrade.trim()) && !hasTargets) {
      setErr("A token allowance needs a contract scope · add contracts and methods, or clear the token fields");
      return;
    }
    const terms = buildTerms();
    if (!terms.pay && !terms.contract) {
      setErr("Give the card a pay budget or a contract scope · an empty card can do nothing");
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

  // the miniature card face + chips materialize once terms exist
  const drafted = draftN > 0;
  const filled = drafted || editOpen;
  const tg = splitList(targets);
  const capLine = [
    amount.trim() && parseFloat(amount) > 0
      ? `$${amount.trim()} / ${periodLabel(period)}`
      : lifetime.trim()
        ? `$${lifetime.trim()} lifetime`
        : tg.length
          ? "Execute only"
          : "",
    merchants.trim() ? `${splitList(merchants).length} merchants` : "Any merchant",
  ]
    .filter(Boolean)
    .join(" · ");
  const chips: string[] = [];
  if (amount.trim() && parseFloat(amount) > 0) chips.push(`$${amount.trim()} ${periodWord(period)}`);
  if (lifetime.trim()) chips.push(`$${lifetime.trim()} lifetime`);
  if (perTx.trim()) chips.push(`≤ $${perTx.trim()} per charge`);
  chips.push(merchants.trim() ? `${splitList(merchants).length} merchants` : "Any merchant");
  chips.push(
    `Expires ${new Date(Date.now() + expiryDays * 86400000).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`,
  );
  if (tg.length) chips.push(`${tg.length} contract${tg.length === 1 ? "" : "s"} in scope`);
  if (perTrade.trim()) chips.push(`≤ $${perTrade.trim()} per trade`);
  chips.push(subcards ? "Sub-cards allowed" : "No sub-cards");

  const field = (label: string, el: React.ReactNode) => (
    <div className="field">
      <label>{label}</label>
      {el}
    </div>
  );

  return (
    <motion.div
      className="mscrim"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.18 } }}
      onClick={(e) => {
        if (e.target === e.currentTarget && onClose) onClose();
      }}
    >
      <motion.div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Issue a New Card"
        initial={{ opacity: 0, y: 26, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1, transition: { type: "spring", stiffness: 360, damping: 30 } }}
        exit={{ opacity: 0, y: 14, scale: 0.98, transition: { duration: 0.16 } }}
      >
        <div className="mhead">
          <div>
            <div className="mtitle">{firstCard ? "Issue Your First Card" : "Issue a New Card"}</div>
            <div className="msub">Plain language, compiled to on-chain caveats · client-signed, the URL is the credential</div>
          </div>
          {onClose && (
            <button className="closex" onClick={onClose} aria-label="Close">
              ✕
            </button>
          )}
        </div>

        {issuedUrl ? (
          <div style={{ marginTop: 18 }}>
            <div className="ok" style={{ marginBottom: 8 }}>
              Card issued · hand this URL to your agent (it is the credential):
            </div>
            <UrlBox url={issuedUrl} testid="issued-url" />
            <ConnectChips url={issuedUrl} cardName={name} />
            <div className="mfoot">
              <button className="dbtn" onClick={() => onClose?.()}>
                Done
              </button>
            </div>
          </div>
        ) : (
          <>
            <textarea
              className="dtext"
              value={intent}
              maxLength={2000}
              // the modal's first focusable thing: keyboard users land here, not behind the scrim
              autoFocus
              disabled={compiling}
              placeholder='Describe the card · "$5 a week for research APIs, any merchant, expires in 30 days"'
              onChange={(e) => setIntent(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) compile();
              }}
              data-testid="compile-intent"
            />
            {compiling && (
              <div className="draftbar" role="progressbar" aria-label="Venice is drafting">
                <i />
              </div>
            )}
            <div className="drow">
              <span className="mhint">
                {compiling
                  ? "Venice is reading your intent · compiling it to on-chain terms…"
                  : "Venice drafts · you review the compiled terms before anything is signed"}
              </span>
              <button
                className={`dbtn${drafted && !compiling ? " quiet" : ""}`}
                onClick={compile}
                disabled={compiling || !intent.trim()}
                data-testid="compile-go"
              >
                {compiling && <span className="bspin" aria-hidden />}
                {compiling ? "Drafting…" : "Draft Terms"}
              </button>
            </div>
            {compileErr && (
              <p className="err" style={{ marginTop: 10 }}>
                {compileErr}
              </p>
            )}

            {/* a card being born */}
            <div className="born">
              <div className={`minicard${filled ? " fill" : ""}`}>
                <div className="mc-mark">remit</div>
                <div className="mc-chip">
                  <ChipDots />
                </div>
                <div className="mc-pan">0x••••&nbsp;&nbsp;••••&nbsp;&nbsp;••••</div>
                <div className="mc-name">{name || "Agent Card"}</div>
                <div className="mc-cap num">{capLine}</div>
                <div className="mc-band">
                  {/* the silk flows while the draft materializes · the card coming alive */}
                  <Guilloche width={520} height={64} strands={9} amp={14} animate={filled || compiling} />
                </div>
              </div>
              {filled && <TermChips key={`${draftN}-${editOpen}`} items={chips} />}
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
                <div className="vnotes" data-testid="compile-warnings">
                  <div className="vh">
                    <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden>
                      <path d="M6 1.2 11 10H1z" strokeLinejoin="round" />
                      <path d="M6 4.6v2.6M6 8.9v.1" />
                    </svg>
                    Venice adjusted the draft · review before signing
                  </div>
                  <ul>
                    {warnings.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                </div>
              )}
              {drafted && (
                <p className="cbnote">Addresses resolve from a verified registry or your own text · the model never supplies them</p>
              )}
            </div>

            <button className="ordiv" onClick={() => setEditOpen((v) => !v)}>
              <span>{editOpen ? "Hide the Term Sheet" : "Edit Terms Yourself"}</span>
            </button>

            <AnimatePresence initial={false}>
              {editOpen && (
                <motion.div
                  key="termsheet"
                  initial={{ height: 0, opacity: 0 }}
                  animate={{
                    height: "auto",
                    opacity: 1,
                    transition: { height: { duration: 0.36, ease: [0.22, 1, 0.36, 1] }, opacity: { duration: 0.28, delay: 0.08 } },
                  }}
                  exit={{
                    height: 0,
                    opacity: 0,
                    transition: { height: { duration: 0.28, ease: [0.22, 1, 0.36, 1] }, opacity: { duration: 0.14 } },
                  }}
                  style={{ overflow: "hidden" }}
                >
                  <div className={`composer2${draftN ? " flash" : ""}`} key={draftN}>
                <div className="csec">
                  <div className="cseclbl">Card</div>
                  <div className="csecrow">
                    {field("Name", <input value={name} onChange={(e) => setName(e.target.value)} style={{ width: 150 }} data-testid="composer-name" />)}
                    {field(
                      "Expires · Days",
                      <input type="number" value={expiryDays} onChange={(e) => setExpiryDays(Number(e.target.value))} style={{ width: 72 }} />,
                    )}
                    {field(
                      "Max Uses",
                      <input value={maxUses} onChange={(e) => setMaxUses(e.target.value)} placeholder="∞" style={{ width: 72 }} data-testid="composer-maxuses" />,
                    )}
                    {field(
                      "Sub-Cards",
                      <Select
                        value={subcards ? "yes" : "no"}
                        options={[
                          { value: "yes", label: "Allowed" },
                          { value: "no", label: "No" },
                        ]}
                        onChange={(v) => setSubcards(v === "yes")}
                        width={104}
                      />,
                    )}
                  </div>
                </div>

                <div className="csec">
                  <div className="cseclbl">Pay · USDC</div>
                  <div className="csecrow">
                    {field(
                      "Budget",
                      <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="None" style={{ width: 92 }} data-testid="composer-amount" />,
                    )}
                    {field(
                      "Per",
                      <Select
                        value={String(period)}
                        options={[
                          { value: "86400", label: "Day" },
                          { value: "604800", label: "Week" },
                          { value: "2592000", label: "30 Days" },
                        ]}
                        onChange={(v) => setPeriod(Number(v))}
                        width={104}
                      />,
                    )}
                    {field(
                      "Lifetime Cap",
                      <input value={lifetime} onChange={(e) => setLifetime(e.target.value)} placeholder="None" style={{ width: 92 }} data-testid="composer-lifetime" />,
                    )}
                    {field("Per-Charge Max", <input value={perTx} onChange={(e) => setPerTx(e.target.value)} placeholder="None" style={{ width: 92 }} />)}
                    {field(
                      "Merchant Lock",
                      <input value={merchants} onChange={(e) => setMerchants(e.target.value)} placeholder="0x…, 0x…" style={{ width: 170 }} />,
                    )}
                  </div>
                </div>

                <div className="csec">
                  <div className="cseclbl">Execute · Contracts</div>
                  <div className="csecrow">
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
                      "Tokens · Allowance",
                      <input value={tokens} onChange={(e) => setTokens(e.target.value)} placeholder="0x… · optional" style={{ width: 136 }} data-testid="composer-tokens" />,
                    )}
                    {field(
                      "Per-Trade Max",
                      <input value={perTrade} onChange={(e) => setPerTrade(e.target.value)} placeholder="None" style={{ width: 92 }} data-testid="composer-pertrademax" />,
                    )}
                  </div>
                </div>
                <p className="chint">Leave pay empty for an execute-only card · leave contracts empty for a pay-only card</p>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {err && (
              <p className="err" style={{ marginTop: 12 }}>
                {err}
              </p>
            )}

            <div className="mfoot">
              {onClose && (
                <button className="mghost" onClick={onClose}>
                  Cancel
                </button>
              )}
              <button className="dbtn" onClick={issue} disabled={busy} data-testid="composer-issue">
                {busy ? "Signing…" : "Review + Sign"}
              </button>
            </div>
          </>
        )}
      </motion.div>
    </motion.div>
  );
}

// chips stagger in as the draft lands · mount with .in applied a frame later
function TermChips({ items }: { items: string[] }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setArmed(true));
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <div className="tchips num">
      {items.map((s, i) => (
        <span key={`${s}-${i}`} className={armed ? "in" : ""} style={{ transitionDelay: armed ? `${120 + i * 110}ms` : "0ms" }}>
          {s}
        </span>
      ))}
    </div>
  );
}
