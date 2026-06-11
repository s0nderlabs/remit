"use client";

// The shell: a quiet left rail instead of a navbar. Wordmark up top (and the
// back affordance, on card pages); the bottom stack carries the network dot,
// the theme toggle, and the avatar. The avatar menu opens rightward; the
// wallet-level danger verb (nuke) lives there and walks the DangerModal
// staircase; the modal is mounted outside the menu so it survives the menu
// closing. The content column owns the rest of the viewport.
//
// The menu PORTALS to document.body (the house rule for every floating
// surface): the sticky rail is a stacking context at z auto, so anything
// absolutely positioned inside it paints UNDER the content column no matter
// its z-index.

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { api } from "@/lib/api";
import type { useRemit } from "../useRemit";
import { shortHex } from "./ui";
import { ThemeToggle } from "./Theme";
import { DangerModal, type DangerPhase } from "./Confirm";

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
    <div className="app">
      <aside className="rail">
        <Link className="brand" href="/">
          remit
        </Link>
        {back && (
          <Link className="railback" href={back.href} title={back.label} aria-label={back.label}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M15 5l-7 7 7 7" />
            </svg>
          </Link>
        )}
        <div className="railfoot">
          <span className="net" title="base · mainnet">
            <b />
            <i>base</i>
          </span>
          <ThemeToggle />
          <ProfileMenu address={address} onLogout={onLogout} remit={remit} refresh={refresh} nukeable={nukeable} />
        </div>
      </aside>
      <div className="maincol">{children}</div>
    </div>
  );
}

// Avatar menu (rail bottom): account identity, sign out, and nuke. It kills
// EVERY card, so it confirms through the destructive-action modal.

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
  const [nukeOpen, setNukeOpen] = useState(false);
  // the portal needs the document; the anchor pins the fixed menu to the avatar
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<{ left: number; bottom: number } | null>(null);
  // the anchor is captured at open; a resize would detach the menu from the avatar
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener("resize", close);
    return () => window.removeEventListener("resize", close);
  }, [open]);
  const toggle = () => {
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setAnchor({ left: r.right + 14, bottom: window.innerHeight - r.bottom - 6 });
    }
    setOpen((v) => !v);
  };
  return (
    <div className="profile">
      <button ref={btnRef} className="avatarbtn" onClick={toggle} aria-label="account" data-testid="profile">
        <span className="avatar" />
      </button>
      {mounted &&
        createPortal(
          <AnimatePresence>
            {open && anchor && (
              <>
                <div className="scrim" onClick={() => setOpen(false)} />
                <motion.div
                  className="promenu"
                  initial={{ opacity: 0, x: -8, scale: 0.97 }}
                  animate={{ opacity: 1, x: 0, scale: 1, transition: { type: "spring", stiffness: 480, damping: 34 } }}
                  exit={{ opacity: 0, x: -6, scale: 0.98, transition: { duration: 0.12 } }}
                  style={{ transformOrigin: "left bottom", left: anchor.left, bottom: anchor.bottom }}
                >
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
                  {nukeable && (
                    <div className="prodanger">
                      <button
                        className="proitem danger"
                        disabled={!remit.embeddedReady}
                        onClick={() => {
                          setOpen(false);
                          setNukeOpen(true);
                        }}
                        data-testid="nuke"
                      >
                        nuke all cards
                      </button>
                      <p className="pronote">one on-chain tx revokes every card + sub-card this wallet ever issued</p>
                    </div>
                  )}
                </motion.div>
              </>
            )}
          </AnimatePresence>,
          document.body,
        )}
      <NukeModal remit={remit} onNuked={refresh} open={nukeOpen} onClose={() => setNukeOpen(false)} />
    </div>
  );
}

// Cascade revoke (NonceEnforcer bump): ONE on-chain tx kills every card and
// sub-card this wallet ever issued. Same client-signed flow as v1, now walked
// through the shared destructive-action modal.

function NukeModal({
  remit,
  onNuked,
  open,
  onClose,
}: {
  remit: Remit;
  onNuked: () => void | Promise<void>;
  open: boolean;
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<DangerPhase>("confirm");
  const [stage, setStage] = useState<"signing" | "submitting">("signing");
  const [tx, setTx] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function go() {
    setErr(null);
    try {
      setPhase("busy");
      setStage("signing");
      const prep = await api.prepareNuke();
      const signature = await remit.signDelegation(prep.delegation);
      setStage("submitting");
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
    <DangerModal
      open={open}
      phase={phase}
      prefix="nuke"
      title="nuke every card?"
      body="one on-chain transaction revokes every card and sub-card this wallet ever issued. agents holding them lose all authority, permanently."
      confirmLabel="yes, nuke everything"
      busyNote={stage === "signing" ? "signing with your wallet…" : "one tx, killing the whole tree…"}
      doneTitle="every card is dead"
      doneNote={
        <>
          nuked ✓ the whole tree is revoked on-chain.{" "}
          {tx && (
            <a href={`https://basescan.org/tx/${tx}`} target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>
              {shortHex(tx, 10, 0)}
            </a>
          )}
        </>
      }
      errorNote={err ? `nuke failed: ${err}` : undefined}
      onConfirm={go}
      onClose={() => {
        onClose();
        // a finished or failed run re-arms for the next open
        setPhase("confirm");
      }}
    />
  );
}
