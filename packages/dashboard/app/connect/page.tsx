"use client";

// /connect: the OAuth consent page (THE card picker). The API's /authorize endpoint
// 302s the agent's browser here with ?request=<id>; the user signs in with the
// EXISTING Privy session, picks WHICH card to grant, and we bounce back to the
// client's redirect_uri with the authorization code. The agent ends up holding a
// short-lived card-scoped token, never a raw card secret.

import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { api, type CardState } from "@/lib/api";
import { CopyButton } from "../components/Authority";
import { capWord, IconCheck } from "../components/ui";
import { useRemit } from "../useRemit";

// inset surface for data strings (auth code / redirect host) · rides theme tokens
const inset: React.CSSProperties = {
  margin: "8px 0",
  padding: "10px 12px",
  background: "var(--float)",
  border: "1px solid var(--hairline)",
  borderLeft: "3px solid var(--accent)",
  borderRadius: 8,
  color: "var(--ink)",
  wordBreak: "break-all",
};
const help: React.CSSProperties = { color: "var(--label)", fontSize: 12, lineHeight: 1.5 };
const body: React.CSSProperties = { color: "var(--body)", lineHeight: 1.5 };

export default function ConnectPage() {
  return (
    <main className="narrow">
      <Suspense fallback={<div className="panel" style={{ color: "var(--body)" }}>Loading…</div>}>
        <Consent />
      </Suspense>
    </main>
  );
}

type RequestInfo = {
  request_id: string;
  client_name: string | null;
  redirect_host: string;
  scope: string | null;
  expires_at: number;
};

// The post-approve state. Some clients never receive the browser redirect: OpenClaw
// registers a loopback redirect_uri but runs no listener there (login --code is its only
// completion route), and headless Hermes can't reach a local browser port at all. So the
// success screen always SHOWS the authorization code; the redirect is an enhancement,
// not the only carrier. The code is single-use, PKCE-bound and short-lived, so rendering
// it to the user who just approved grants nothing the redirect URL didn't already carry.
type Granted = {
  redirectTo: string;
  code: string | null;
  loopback: boolean; // http://localhost|127.0.0.1|[::1] target: the redirect may land on a dead port
  client: string | null;
  restored?: boolean; // re-shown after the user navigated back: never auto-redirect again
};

// URL.hostname always returns IPv6 bracketed, so "[::1]" is the only v6 spelling to match
const LOOPBACK = ["localhost", "127.0.0.1", "[::1]"];

function parseGrant(redirectTo: string, client: string | null): Granted {
  // regex, not new URL().searchParams: must survive custom-scheme URIs (cursor://) too
  const m = redirectTo.match(/[?&]code=([^&#]+)/);
  let code: string | null = null;
  if (m) {
    try {
      code = decodeURIComponent(m[1]);
    } catch {
      code = m[1];
    }
  }
  let loopback = false;
  try {
    const u = new URL(redirectTo);
    loopback = u.protocol === "http:" && LOOPBACK.includes(u.hostname);
  } catch {
    // unparseable custom scheme: treat as app-handled, auto-redirect is fine
  }
  return { redirectTo, code, loopback, client };
}

const grantKey = (requestId: string) => `remit-grant-${requestId}`;

function Consent() {
  const params = useSearchParams();
  const requestId = params.get("request");
  const { ready, authenticated, login } = useRemit();

  const [info, setInfo] = useState<RequestInfo | null>(null);
  const [cards, setCards] = useState<CardState[] | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [phase, setPhase] = useState<"idle" | "submitting" | "redirecting">("idle");
  const [granted, setGranted] = useState<Granted | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // back-button recovery: if the redirect navigated to a dead loopback port and the user
  // came back, re-show the success screen (and its code) instead of a stale consent form.
  useEffect(() => {
    if (!requestId) return;
    const raw = sessionStorage.getItem(grantKey(requestId));
    if (!raw) return;
    try {
      const saved = JSON.parse(raw) as Granted & { exp: number };
      if (saved.exp > Date.now()) setGranted({ ...saved, restored: true });
      else sessionStorage.removeItem(grantKey(requestId));
    } catch {
      sessionStorage.removeItem(grantKey(requestId));
    }
  }, [requestId]);

  // auto-redirect ONLY for https/custom-scheme targets (those always resolve somewhere).
  // Loopback targets never auto-redirect: whether a listener is actually running there is
  // unknowable from here (OpenClaw and headless Hermes run none, and a client may omit or
  // mislabel its DCR client_name), so the user keeps the code screen and continues by
  // button. Restored grants (back-button after a dead redirect) never re-fire either.
  useEffect(() => {
    if (!granted || granted.loopback || granted.restored) return;
    const t = setTimeout(() => {
      window.location.href = granted.redirectTo;
    }, 1500);
    return () => clearTimeout(t);
  }, [granted]);

  useEffect(() => {
    if (!authenticated || !requestId) return;
    (async () => {
      try {
        const [i, cs] = await Promise.all([api.oauthRequest(requestId), api.cards()]);
        setInfo(i);
        // only live cards are grantable; frozen still answers (spends refuse until unfrozen)
        setCards(cs.filter((c) => c.status === "active" || c.status === "frozen"));
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [authenticated, requestId]);

  const approve = useCallback(async () => {
    if (!requestId || !picked) return;
    setPhase("submitting");
    setErr(null);
    try {
      const { redirect_to } = await api.oauthApprove(requestId, picked);
      const g = parseGrant(redirect_to, info?.client_name ?? null);
      // codes live ~120s server-side; keep the recovery copy a touch shorter
      try {
        sessionStorage.setItem(grantKey(requestId), JSON.stringify({ ...g, exp: Date.now() + 110_000 }));
      } catch {
        // storage full/blocked: the in-memory screen still shows the code
      }
      setGranted(g);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setPhase("idle");
    }
  }, [requestId, picked, info]);

  const deny = useCallback(async () => {
    if (!requestId) return;
    setPhase("submitting");
    setErr(null);
    try {
      const { redirect_to } = await api.oauthDeny(requestId);
      setPhase("redirecting");
      window.location.href = redirect_to;
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setPhase("idle");
    }
  }, [requestId]);

  if (!requestId) {
    return <div className="panel" style={body}>Missing the request parameter · start the connection from your agent.</div>;
  }
  if (granted) {
    const openclaw = /openclaw/i.test(granted.client ?? "");
    return (
      <div className="panel" data-testid="granted">
        <h1>Card Granted</h1>
        {granted.code ? (
          <>
            <p style={body}>
              {openclaw
                ? "Your agent is waiting in the terminal · give it this code:"
                : granted.loopback
                  ? "Press Continue if your agent is listening locally · or give it this code if it asked for one:"
                  : "Returning you to the app · if it asks for a code, use this one:"}
            </p>
            <p className="mono" data-testid="auth-code" style={{ ...inset, userSelect: "all" }}>
              {granted.code}
            </p>
            <div className="row" style={{ gap: 8 }}>
              <CopyButton text={granted.code} label="Copy Code" />
              <button className="dbtn" onClick={() => (window.location.href = granted.redirectTo)} data-testid="continue">
                Continue to App
              </button>
            </div>
            <p style={{ ...help, marginTop: 8 }}>
              {openclaw
                ? <>Finish with <b>openclaw mcp login &lt;server&gt; --code &lt;code&gt;</b> · the code expires in ~2 minutes.</>
                : <>Terminal clients take it like <b>… login &lt;server&gt; --code &lt;code&gt;</b> · expires in ~2 minutes · safe to close this tab once your agent confirms.</>}
            </p>
          </>
        ) : (
          <>
            <p style={body}>Returning you to the app…</p>
            <button className="dbtn" onClick={() => (window.location.href = granted.redirectTo)} data-testid="continue">
              Continue
            </button>
          </>
        )}
      </div>
    );
  }
  if (!ready) return <div className="panel" style={body}>Loading…</div>;
  if (!authenticated) {
    return (
      <div className="panel" style={{ textAlign: "center", padding: 40 }}>
        <h1>Connect an Agent to remit</h1>
        <p style={{ ...body, margin: "8px 0 18px" }}>
          An agent is asking for spending authority · sign in to pick which card it gets.
        </p>
        <button className="dbtn" onClick={login} data-testid="login">
          Sign In
        </button>
      </div>
    );
  }
  if (err && !info) {
    return (
      <div className="panel">
        <p className="err">{err}</p>
        <p style={body}>
          The request may have expired (the agent can retry), or your account isn&apos;t set up yet:{" "}
          <Link href="/">open the dashboard</Link> first.
        </p>
      </div>
    );
  }
  if (!info || !cards) return <div className="panel" style={body}>Loading request…</div>;

  return (
    <div className="panel" data-testid="consent">
      <h1>Grant a Card</h1>
      <p style={body}>
        An app calling itself <b>{info.client_name ?? "an MCP client"}</b> is requesting access. If you
        approve, the authorization will be sent to:
      </p>
      <p className="mono" style={inset}>
        <b>{info.redirect_host}</b>
      </p>
      <p style={help}>
        The app name is self-reported and unverified. Only continue if you recognize that destination as
        the app you are connecting. It will receive a revocable token scoped to one card, never the card secret.
      </p>
      {cards.length === 0 ? (
        <p style={body}>
          No live cards to grant. <Link href="/">Issue one on the dashboard</Link>, then retry from your agent.
        </p>
      ) : (
        <>
          <div role="radiogroup" aria-label="Card to grant" style={{ display: "flex", flexDirection: "column", gap: 8, margin: "14px 0" }}>
            {cards.map((c) => {
              const on = picked === c.card_id;
              return (
                <div
                  key={c.card_id}
                  role="radio"
                  aria-checked={on}
                  tabIndex={0}
                  data-testid={`pick-${c.name}`}
                  onClick={() => setPicked(c.card_id)}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setPicked(c.card_id); } }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    padding: 12,
                    border: on ? "1px solid var(--accent)" : "1px solid var(--hairline)",
                    boxShadow: on ? "0 0 0 3px var(--accent-tint)" : undefined,
                    borderRadius: 12,
                    cursor: "pointer",
                  }}
                >
                  <span
                    aria-hidden
                    style={{
                      width: 18, height: 18, flex: "none", borderRadius: "50%",
                      border: on ? "none" : "1.5px solid var(--hairline-strong)",
                      background: on ? "var(--accent)" : "transparent",
                      color: "var(--on-ink)", display: "flex", alignItems: "center", justifyContent: "center",
                    }}
                  >
                    {on && <IconCheck />}
                  </span>
                  <span style={{ flex: 1 }}>
                    <b>{c.name}</b>{" "}
                    <span className={`chip ${c.status}`}>{capWord(c.status)}</span>
                    <br />
                    <span style={{ color: "var(--label)", fontSize: 12 }}>
                      {c.remaining_this_period !== null && `${c.remaining_this_period} USDC left this period`}
                      {c.remaining_this_period === null && c.remaining_lifetime !== null && `${c.remaining_lifetime} USDC lifetime left`}
                    </span>
                  </span>
                </div>
              );
            })}
          </div>
          {err && <p className="err">{err}</p>}
          <div className="row" style={{ gap: 8 }}>
            <button className="dbtn" onClick={approve} disabled={!picked || phase !== "idle"} data-testid="approve">
              {phase === "idle" ? "Grant This Card" : phase === "submitting" ? "Granting…" : "Returning to your agent…"}
            </button>
            <button className="mghost" onClick={deny} disabled={phase !== "idle"} data-testid="deny">
              Deny
            </button>
          </div>
        </>
      )}
    </div>
  );
}
