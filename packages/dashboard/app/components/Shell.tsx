"use client";

// The shell. Chrome floats OUTSIDE the slab on the bare canvas: the wordmark
// (and the back link, on card pages) top-left; network + avatar top-right.
// No navbar, no view toggle — everything lives on the one slab below.

import Link from "next/link";
import { useState } from "react";
import { api } from "@/lib/api";
import type { useRemit } from "../useRemit";
import { shortHex } from "./ui";

type Remit = ReturnType<typeof useRemit>;

export function Cockpit({
  back,
  remit,
  refresh,
  onLogout,
  address,
  nukeable = false,
  children,
}: {
  back?: { href: string; label: string };
  remit: Remit;
  refresh: () => void | Promise<void>;
  onLogout?: () => void;
  address?: string;
  nukeable?: boolean; // wallet has live cards: the nuke verb shows in the avatar menu
  children: React.ReactNode;
}) {
  return (
    <div className="page">
      <header className="chrome">
        <div className="chromeleft">
          <Link className="brand" href="/">
            remit
          </Link>
          {back && (
            <Link className="backlink" href={back.href}>
              ← {back.label}
            </Link>
          )}
        </div>
        <div className="cright">
          <span className="net">
            <b />
            base · mainnet
          </span>
          <ProfileMenu address={address} onLogout={onLogout} remit={remit} refresh={refresh} nukeable={nukeable} />
        </div>
      </header>
      {children}
    </div>
  );
}

// Avatar menu (top right): account identity, sign out, and the wallet-level
// danger verb — nuke lives here because it kills EVERY card, not one.

function ProfileMenu({
  address,
  onLogout,
  remit,
  refresh,
  nukeable,
}: {
  address?: string;
  onLogout?: () => void;
  remit: Remit;
  refresh: () => void | Promise<void>;
  nukeable: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="profile">
      <button className="avatarbtn" onClick={() => setOpen((v) => !v)} aria-label="account" data-testid="profile">
        <span className="avatar" />
      </button>
      {open && (
        <>
          <div className="scrim" onClick={() => setOpen(false)} />
          <div className="promenu">
            <div className="prowho">
              <span className="avatar" />
              <span className="em">{address ? shortHex(address, 6, 4) : ""}</span>
            </div>
            {onLogout && (
              <button
                className="proitem"
                onClick={() => {
                  setOpen(false);
                  onLogout();
                }}
                data-testid="logout"
              >
                sign out
              </button>
            )}
            {nukeable && <NukeItem remit={remit} onNuked={refresh} />}
          </div>
        </>
      )}
    </div>
  );
}

// Cascade revoke (NonceEnforcer bump): ONE on-chain tx kills every card and
// sub-card this wallet ever issued. Same client-signed flow as v1.

type NukePhase = "idle" | "confirm" | "signing" | "submitting" | "done" | "error";

function NukeItem({ remit, onNuked }: { remit: Remit; onNuked: () => void | Promise<void> }) {
  const [phase, setPhase] = useState<NukePhase>("idle");
  const [tx, setTx] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

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
      await onNuked();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  }

  return (
    <div className="prodanger">
      {phase === "done" ? (
        <p className="pronote" data-testid="nuke-done">
          nuked ✓ every card is dead.{" "}
          {tx && (
            <a href={`https://basescan.org/tx/${tx}`} target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>
              {tx.slice(0, 10)}…
            </a>
          )}
        </p>
      ) : phase === "signing" || phase === "submitting" ? (
        <p className="pronote" data-testid="nuke-busy">
          {phase === "signing" ? "signing with your wallet…" : "one tx, killing the whole tree…"}
        </p>
      ) : phase === "confirm" ? (
        <>
          <p className="pronote err">kill every card and sub-card, permanently, on-chain?</p>
          <div className="prorow">
            <button className="danger-ghost" onClick={go} data-testid="nuke-confirm">
              yes, nuke
            </button>
            <button onClick={() => setPhase("idle")}>cancel</button>
          </div>
        </>
      ) : (
        <>
          <button
            className="proitem danger"
            disabled={!remit.embeddedReady}
            onClick={() => setPhase("confirm")}
            data-testid="nuke"
          >
            nuke all cards
          </button>
          <p className="pronote">one on-chain tx revokes every card + sub-card this wallet ever issued</p>
        </>
      )}
      {err && <p className="pronote err">nuke failed: {err}</p>}
    </div>
  );
}
