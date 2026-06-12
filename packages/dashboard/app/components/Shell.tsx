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
import { erc20Abi, formatUnits, type Address } from "viem";
import { api } from "@/lib/api";
import { publicClient, USDC_BASE } from "@/lib/chain";
import type { useRemit } from "../useRemit";
import { copyText, IconCheck, IconCopy, shortHex } from "./ui";
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
  aggregate,
  children,
}: {
  back?: { href: string; label: string };
  remit: Remit;
  refresh: () => void | Promise<void>;
  onLogout?: () => void;
  address?: string;
  nukeable?: boolean; // wallet has live cards: the nuke verb shows in the avatar menu
  aggregate?: string; // the wallet-level fact line ("2 live cards · $30.00 / wk delegated")
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
          {/* the Base mark, at rest · no pulse: the network is a fact, not an alarm */}
          <span className="net" title="Base · Mainnet" aria-label="Base · Mainnet">
            <svg viewBox="0 0 16 16" aria-hidden>
              <circle cx="8" cy="8" r="7" fill="currentColor" />
              <rect x="1" y="7.2" width="8.6" height="1.6" fill="var(--page)" />
            </svg>
          </span>
          <ThemeToggle />
          <ProfileMenu
            address={address}
            onLogout={onLogout}
            remit={remit}
            refresh={refresh}
            nukeable={nukeable}
            aggregate={aggregate}
          />
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
  aggregate,
}: {
  address?: string;
  onLogout?: () => void;
  remit: Remit;
  refresh: () => void | Promise<void>;
  nukeable: boolean;
  aggregate?: string;
}) {
  const [open, setOpen] = useState(false);
  const [nukeOpen, setNukeOpen] = useState(false);
  // the portal needs the document; the anchor pins the fixed menu to the avatar
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  // the wallet's USDC, read once per menu open (one balanceOf against Base) ·
  // the last value holds across reopens so the figure never flashes empty
  const [usdc, setUsdc] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // a same-tab account switch must never show the previous wallet's figure
  useEffect(() => setUsdc(null), [address]);
  useEffect(() => {
    if (!open || !address) return;
    let live = true;
    publicClient
      .readContract({ address: USDC_BASE, abi: erc20Abi, functionName: "balanceOf", args: [address as Address] })
      .then((v) => {
        if (live) setUsdc(formatUnits(v, 6));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [open, address]);
  const bal = usdc === null ? null : Number(usdc);
  const balFig = bal === null ? "–" : bal > 0 && bal < 0.01 ? "<$0.01" : `$${bal.toFixed(2)}`;
  const btnRef = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<React.CSSProperties | null>(null);
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
      // wide layout: the rail anchor (menu opens rightward, pinned to the avatar's
      // bottom). Top-bar layout (<1100px): the menu drops BELOW the avatar,
      // right-aligned · the rail anchor would put it off-canvas.
      setAnchor(
        window.innerWidth < 1100
          ? { right: 12, top: r.bottom + 10, transformOrigin: "right top" }
          : { left: r.right + 14, bottom: window.innerHeight - r.bottom - 6, transformOrigin: "left bottom" },
      );
    }
    setOpen((v) => !v);
  };
  return (
    <div className="profile">
      <button ref={btnRef} className="avatarbtn" onClick={toggle} aria-label="Account" data-testid="profile" data-tour="wallet">
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
                  style={anchor}
                >
                  <div className="prowho">
                    <span className="avatar" />
                    <span className="prowhocol">
                      <span className="em">{address ? shortHex(address, 6, 4) : ""}</span>
                      {aggregate && <span className="proagg">{aggregate}</span>}
                    </span>
                  </div>
                  {address && (
                    <div className="prowallet">
                      <div className="probal">
                        <span className="probalfig" data-testid="wallet-balance">
                          {balFig}
                        </span>
                        <span className="proballbl">USDC on Base</span>
                      </div>
                      <button
                        className={`proaddr${copied ? " done" : ""}`}
                        title="Copy your wallet address"
                        data-testid="wallet-address"
                        onClick={async () => {
                          if (!(await copyText(address))) return;
                          setCopied(true);
                          setTimeout(() => setCopied(false), 1500);
                        }}
                      >
                        <span className="proaddrtext">{address}</span>
                        {copied ? <IconCheck /> : <IconCopy />}
                      </button>
                      <p className="pronote">Send USDC on Base to this address to fund your cards</p>
                    </div>
                  )}
                  {onLogout && (
                    <button
                      className="proitem"
                      onClick={() => {
                        setOpen(false);
                        onLogout();
                      }}
                      data-testid="logout"
                    >
                      Sign Out
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
                        Nuke All Cards
                      </button>
                      <p className="pronote">One on-chain tx revokes every card and sub-card this wallet ever issued</p>
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
      title="Nuke every card?"
      body="One on-chain transaction revokes every card and sub-card this wallet ever issued. Agents holding them lose all authority, permanently."
      confirmLabel="Yes, Nuke Everything"
      busyNote={stage === "signing" ? "Signing with your wallet…" : "One tx, killing the whole tree…"}
      doneTitle="Every card is dead"
      doneNote={
        <>
          Nuked ✓ the whole tree is revoked on-chain.{" "}
          {tx && (
            <a href={`https://basescan.org/tx/${tx}`} target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>
              {shortHex(tx, 10, 0)}
            </a>
          )}
        </>
      }
      errorNote={err ? `Nuke failed: ${err}` : undefined}
      onConfirm={go}
      onClose={() => {
        onClose();
        // a finished or failed run re-arms for the next open
        setPhase("confirm");
      }}
    />
  );
}
