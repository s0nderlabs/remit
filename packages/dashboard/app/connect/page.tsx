"use client";

// /connect — the OAuth consent page (THE card picker). The API's /authorize endpoint
// 302s the agent's browser here with ?request=<id>; the user signs in with the
// EXISTING Privy session, picks WHICH card to grant, and we bounce back to the
// client's redirect_uri with the authorization code. The agent ends up holding a
// short-lived card-scoped token — never a raw card secret.

import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { api, type CardState } from "@/lib/api";
import { useRemit } from "../useRemit";

export default function ConnectPage() {
  return (
    <main className="narrow">
      <Suspense fallback={<div className="mono">loading…</div>}>
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

function Consent() {
  const params = useSearchParams();
  const requestId = params.get("request");
  const { ready, authenticated, login } = useRemit();

  const [info, setInfo] = useState<RequestInfo | null>(null);
  const [cards, setCards] = useState<CardState[] | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [phase, setPhase] = useState<"idle" | "submitting" | "redirecting">("idle");
  const [err, setErr] = useState<string | null>(null);

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
      setPhase("redirecting");
      window.location.href = redirect_to;
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setPhase("idle");
    }
  }, [requestId, picked]);

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
    return <div className="panel mono">missing ?request parameter, start the connection from your agent.</div>;
  }
  if (!ready) return <div className="mono">loading…</div>;
  if (!authenticated) {
    return (
      <div className="panel" style={{ textAlign: "center", padding: 40 }}>
        <h2>connect an agent to remit</h2>
        <p className="mono" style={{ color: "#666" }}>
          an agent is asking for spending authority · sign in to pick which card it gets
        </p>
        <button className="primary" onClick={login} data-testid="login">
          sign in
        </button>
      </div>
    );
  }
  if (err && !info) {
    return (
      <div className="panel mono">
        <p className="err">{err}</p>
        <p>
          the request may have expired (the agent can retry), or your account isn&apos;t set up yet:{" "}
          <Link href="/">open the dashboard</Link> first.
        </p>
      </div>
    );
  }
  if (!info || !cards) return <div className="mono">loading request…</div>;

  return (
    <div className="panel" data-testid="consent">
      <h2>grant a card</h2>
      <p className="mono" style={{ color: "#666" }}>
        An app calling itself <b>{info.client_name ?? "an MCP client"}</b> is requesting access. If you
        approve, the authorization will be sent to:
      </p>
      <p className="mono" style={{ margin: "6px 0", padding: "10px 12px", background: "var(--surface-warm)", border: "1px solid var(--hairline)", borderLeft: "3px solid var(--accent)", borderRadius: 8, color: "var(--ink)" }}>
        → <b>{info.redirect_host}</b>
      </p>
      <p className="mono" style={{ color: "#666", fontSize: 12 }}>
        The app name is self-reported and unverified. Only continue if you recognize that destination as
        the app you are connecting. It will receive a revocable token scoped to ONE card, never the card secret.
      </p>
      {cards.length === 0 ? (
        <p className="mono">
          no live cards to grant. <Link href="/">issue one on the dashboard</Link>, then retry from your agent.
        </p>
      ) : (
        <>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, margin: "12px 0" }}>
            {cards.map((c) => (
              <label
                key={c.card_id}
                className="mono"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: 10,
                  border: picked === c.card_id ? "1px solid var(--accent)" : "1px solid var(--hairline)",
                  boxShadow: picked === c.card_id ? "0 0 0 3px var(--accent-tint)" : undefined,
                  borderRadius: 10,
                  cursor: "pointer",
                }}
              >
                <input
                  type="radio"
                  name="card"
                  checked={picked === c.card_id}
                  onChange={() => setPicked(c.card_id)}
                  data-testid={`pick-${c.name}`}
                />
                <span style={{ flex: 1 }}>
                  <b>{c.name}</b>{" "}
                  <span className={`chip ${c.status}`}>{c.status}</span>
                  <br />
                  <span style={{ color: "#666", fontSize: 12 }}>
                    {c.remaining_this_period !== null && `${c.remaining_this_period} USDC left this period`}
                    {c.remaining_this_period === null && c.remaining_lifetime !== null && `${c.remaining_lifetime} USDC lifetime left`}
                  </span>
                </span>
              </label>
            ))}
          </div>
          {err && <p className="err">{err}</p>}
          <div className="row" style={{ gap: 8 }}>
            <button className="primary" onClick={approve} disabled={!picked || phase !== "idle"} data-testid="approve">
              {phase === "idle" ? "grant this card" : phase === "submitting" ? "granting…" : "returning to your agent…"}
            </button>
            <button onClick={deny} disabled={phase !== "idle"} data-testid="deny">
              deny
            </button>
          </div>
        </>
      )}
    </div>
  );
}
