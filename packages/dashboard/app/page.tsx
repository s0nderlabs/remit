"use client";

// Home: Privy login -> embedded wallet -> onboard (silent 7702) -> composer (client-
// signed issuance) -> THE TREE. Minimal pixels, full functionality.

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { api, type TreeNode, type CardTermsInput } from "@/lib/api";
import { useRemit } from "./useRemit";

export default function Home() {
  const remit = useRemit();
  const { ready, authenticated, user, address, login, logout, sign7702, signOnboardProof, embeddedReady } = remit;
  const did = user?.id;

  const [onboarded, setOnboarded] = useState(false);
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
      setOnboardErr(null);
      onboardingRef.current = false;
    }
    prevDidRef.current = did;
  }, [did]);

  // Auto-onboard once the embedded wallet is ready: sign the 7702 authorization
  // (silent, grants nothing) + the onboard proof (binds the wallet to this Privy
  // login server-side) and register the wallet. Runs once; retryNonce re-arms it
  // after a failure.
  useEffect(() => {
    if (!authenticated || !address || !did || !embeddedReady || onboarded || onboardingRef.current) return;
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
  }, [authenticated, address, did, embeddedReady, onboarded, sign7702, signOnboardProof, retryNonce]);

  if (!ready) return <div className="mono">loading…</div>;
  if (!authenticated) return <Login onLogin={login} />;

  return (
    <>
      <AccountBar address={address} onboarded={onboarded} onLogout={logout} />
      {!address && <div className="panel mono">creating your embedded wallet…</div>}
      {address && !onboarded && (
        <div className="panel mono" data-testid="onboarding">
          {onboarding ? "activating your account (signing 7702 authorization)…" : "activation pending"}
          {onboardErr && (
            <p className="err">
              onboard failed: {onboardErr}{" "}
              <button
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
      )}
      {address && onboarded && <Dashboard remit={remit} address={address} />}
    </>
  );
}

function Login({ onLogin }: { onLogin: () => void }) {
  return (
    <div className="panel" style={{ textAlign: "center", padding: 40 }}>
      <h2>sign in to remit</h2>
      <p className="mono" style={{ color: "#666" }}>
        email or Google · we provision your embedded wallet · no seed phrase
      </p>
      <button onClick={onLogin} data-testid="login">
        sign in
      </button>
    </div>
  );
}

function AccountBar({
  address,
  onboarded,
  onLogout,
}: {
  address?: string;
  onboarded: boolean;
  onLogout: () => void;
}) {
  return (
    <div className="row" style={{ justifyContent: "space-between", marginBottom: 16 }}>
      <span className="mono" data-testid="account">
        {address ? `${address.slice(0, 6)}…${address.slice(-4)}` : "—"}{" "}
        <span className={`chip ${onboarded ? "active" : "frozen"}`}>{onboarded ? "active" : "activating"}</span>
      </span>
      <button onClick={onLogout}>logout</button>
    </div>
  );
}

function Dashboard({ remit, address }: { remit: ReturnType<typeof useRemit>; address: string }) {
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <>
      <Composer remit={remit} address={address} onIssued={refresh} />
      <h2>card tree</h2>
      {error && <div className="err">api error: {error}</div>}
      {tree.length === 0 && !error && <div className="mono">no cards yet — issue one above</div>}
      {tree.map((n) => (
        <Node key={n.card.card_id} node={n} />
      ))}
      {/* Nuke stays MOUNTED after a successful nuke: its phase="done" + basescan tx link
          (the cascade-revoke proof on screen) live in component state, and unmounting on
          the post-nuke refresh (no live cards left -> gate false) would wipe them ~1s
          after success. The has-live gate moves INSIDE the component instead. */}
      {tree.length > 0 && (
        <Nuke
          remit={remit}
          onNuked={refresh}
          hasLive={tree.some((n) => n.card.status === "active" || n.card.status === "frozen")}
        />
      )}
    </>
  );
}

function pct(remaining: string | null, cap?: string): number {
  if (remaining === null || !cap) return 100;
  const r = parseFloat(remaining);
  const c = parseFloat(cap);
  return c > 0 ? Math.max(0, Math.min(100, (r / c) * 100)) : 0;
}

function Node({ node }: { node: TreeNode }) {
  const c = node.card;
  const cap = c.terms.pay?.period?.amount ?? c.terms.pay?.lifetime?.amount;
  const remaining = c.remaining_this_period ?? c.remaining_lifetime;
  const dead = c.status !== "active" && c.status !== "frozen";
  return (
    <div className={`node${dead ? " dead" : ""}`}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <span>
          <Link href={`/card/${c.card_id}`}>{c.name}</Link>{" "}
          <span className={`chip ${c.status}`}>{c.status}</span>
        </span>
        <span className="mono">{remaining !== null && cap ? `${remaining} / ${cap} USDC` : "—"}</span>
      </div>
      <div className="meter">
        <div
          style={{ width: `${dead ? 0 : pct(remaining, cap)}%`, background: c.status === "frozen" ? "var(--amber)" : undefined }}
        />
      </div>
      {node.children.length > 0 && (
        <div className="kids">
          {node.children.map((k) => (
            <Node key={k.card.card_id} node={k} />
          ))}
        </div>
      )}
    </div>
  );
}

function Composer({
  remit,
  address,
  onIssued,
}: {
  remit: ReturnType<typeof useRemit>;
  address: string;
  onIssued: () => void;
}) {
  const [name, setName] = useState("agent card");
  const [amount, setAmount] = useState("25");
  const [period, setPeriod] = useState(604800);
  const [expiryDays, setExpiryDays] = useState(30);
  const [perTx, setPerTx] = useState("");
  const [merchants, setMerchants] = useState("");
  const [subcards, setSubcards] = useState(true);
  const [busy, setBusy] = useState(false);
  const [issuedUrl, setIssuedUrl] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function issue() {
    setBusy(true);
    setErr(null);
    setIssuedUrl(null);
    try {
      const terms: CardTermsInput = {
        pay: { period: { amount, seconds: period } },
        expiry: Math.floor(Date.now() / 1000) + expiryDays * 86400,
        subcards,
        ...(perTx ? { perTxMax: perTx } : {}),
        ...(merchants.trim()
          ? { merchants: merchants.split(",").map((m) => m.trim()).filter(Boolean) }
          : {}),
      };
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

  return (
    <>
      <h2>issue a card</h2>
      <div className="panel">
        <div className="row">
          <label>
            name<br />
            <input value={name} onChange={(e) => setName(e.target.value)} data-testid="composer-name" />
          </label>
          <label>
            budget (USDC)<br />
            <input value={amount} onChange={(e) => setAmount(e.target.value)} style={{ width: 90 }} data-testid="composer-amount" />
          </label>
          <label>
            per<br />
            <select value={period} onChange={(e) => setPeriod(Number(e.target.value))}>
              <option value={86400}>day</option>
              <option value={604800}>week</option>
              <option value={2592000}>30 days</option>
            </select>
          </label>
          <label>
            expires in (days)<br />
            <input type="number" value={expiryDays} onChange={(e) => setExpiryDays(Number(e.target.value))} style={{ width: 70 }} />
          </label>
          <label>
            per-charge max (opt)<br />
            <input value={perTx} onChange={(e) => setPerTx(e.target.value)} placeholder="—" style={{ width: 90 }} />
          </label>
          <label>
            merchant lock (opt, comma)<br />
            <input value={merchants} onChange={(e) => setMerchants(e.target.value)} placeholder="0x…, 0x…" style={{ width: 220 }} />
          </label>
          <label>
            sub-cards<br />
            <input type="checkbox" checked={subcards} onChange={(e) => setSubcards(e.target.checked)} />
          </label>
          <button onClick={issue} disabled={busy} data-testid="composer-issue">
            {busy ? "signing…" : "issue card"}
          </button>
        </div>
        {err && <p className="err">{err}</p>}
        {issuedUrl && (
          <div style={{ marginTop: 12 }}>
            <div className="ok">card issued — hand this URL to your agent (it IS the credential):</div>
            <div className="urlbox" data-testid="issued-url">{issuedUrl}</div>
          </div>
        )}
      </div>
    </>
  );
}

// Cascade revoke (NonceEnforcer bump): ONE on-chain tx kills every card + sub-card
// bound to the old nonce. The embedded wallet signs the admin leaf in the browser;
// the relayer executes it gaslessly (the fee comes from A_user's USDC).
function Nuke({
  remit,
  onNuked,
  hasLive,
}: {
  remit: ReturnType<typeof useRemit>;
  onNuked: () => void;
  hasLive: boolean;
}) {
  const [phase, setPhase] = useState<"idle" | "confirm" | "signing" | "submitting" | "done" | "error">("idle");
  const [tx, setTx] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // nothing live to nuke and no success to show: render nothing (the parent keeps us
  // mounted so a just-completed nuke's proof link survives the tree refresh)
  if (!hasLive && phase !== "done") return null;

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
      onNuked();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  }

  return (
    <>
      <h2>nuke</h2>
      <div className="panel">
        <div className="row" style={{ gap: 10 }}>
          {phase === "done" ? (
            <span className="mono" data-testid="nuke-done">
              nuked ✓ every card is dead.{" "}
              {tx && (
                <a href={`https://basescan.org/tx/${tx}`} target="_blank" rel="noreferrer">
                  {tx.slice(0, 10)}…
                </a>
              )}
            </span>
          ) : phase === "signing" || phase === "submitting" ? (
            <span className="mono" data-testid="nuke-busy">
              {phase === "signing" ? "signing with your wallet…" : "one tx, killing the whole tree…"}
            </span>
          ) : phase === "confirm" ? (
            <>
              <span className="err mono">kill EVERY card and sub-card, permanently, on-chain?</span>
              <button className="ghost" onClick={go} data-testid="nuke-confirm">yes, nuke everything</button>
              <button className="ghost" onClick={() => setPhase("idle")}>cancel</button>
            </>
          ) : (
            <>
              <button
                className="ghost"
                disabled={!remit.embeddedReady}
                onClick={() => setPhase("confirm")}
                data-testid="nuke"
              >
                nuke all cards
              </button>
              <span className="mono" style={{ color: "#666" }}>
                cascade revoke: one on-chain tx (NonceEnforcer bump) kills the entire tree
              </span>
            </>
          )}
        </div>
        {err && <p className="err mono">nuke failed: {err}</p>}
      </div>
    </>
  );
}
