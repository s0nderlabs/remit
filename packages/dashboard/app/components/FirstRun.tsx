"use client";

// First-run onboarding: shown once per wallet while the tree is empty. It
// replaces the old hard-gated composer ("the modal IS the front door"), which
// trapped a fresh user who had never seen their address and had no funds yet.
// Two steps, in-place swaps: (1) what remit is and how to drive it, (2) the
// wallet address with a LIVE USDC readout that ticks up the moment funding
// lands. Issuing is free (a signature, no gas), so funding is skippable; the
// avatar menu carries the same address and balance forever after.

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { erc20Abi, formatUnits, type Address } from "viem";
import { publicClient, USDC_BASE } from "@/lib/chain";
import { copyText, IconCheck, IconCopy } from "./ui";

const swapEase = [0.22, 1, 0.36, 1] as const;

export function FirstRun({
  address,
  onIssue,
  onExplore,
  onTour,
  initialStep = 0,
}: {
  address: string;
  onIssue: () => void; // straight into the composer
  onExplore: () => void; // to the empty dashboard
  onTour?: () => void; // the live spotlight tour over the specimen card
  initialStep?: 0 | 1; // preview/testing hook only
}) {
  const [step, setStep] = useState<0 | 1>(initialStep);

  // the live readout: one balanceOf every 3s while the funding step shows ·
  // a fresh wallet flipping from $0 to funded ON SCREEN is the whole point
  const [usdc, setUsdc] = useState<string | null>(null);
  useEffect(() => {
    if (step !== 1) return;
    let live = true;
    const read = () => {
      publicClient
        .readContract({ address: USDC_BASE, abi: erc20Abi, functionName: "balanceOf", args: [address as Address] })
        .then((v) => {
          if (live) setUsdc(formatUnits(v, 6));
        })
        .catch(() => {});
    };
    read();
    const t = setInterval(read, 3000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [step, address]);
  const bal = usdc === null ? null : Number(usdc);
  // a displayable cent is the funded floor · dust under $0.01 would flash the
  // success state next to a "$0.00" figure
  const funded = bal !== null && bal >= 0.01;

  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (!(await copyText(address))) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  // modal semantics, properly: lock the page scroll and let Escape skip ·
  // the scrim already blocks clicks, this closes the keyboard/scroll gaps
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onExplore();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [onExplore]);

  return (
    <motion.div
      className="mscrim"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.18 } }}
    >
      <motion.div
        className="modal fr"
        role="dialog"
        aria-modal="true"
        aria-label="Welcome to remit"
        initial={{ opacity: 0, y: 26, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1, transition: { type: "spring", stiffness: 360, damping: 30 } }}
        exit={{ opacity: 0, y: 14, scale: 0.98, transition: { duration: 0.16 } }}
        data-testid="firstrun"
      >
        <AnimatePresence initial={false} mode="popLayout">
          {step === 0 ? (
            <motion.div
              key="welcome"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0, transition: { duration: 0.3, ease: swapEase } }}
              exit={{ opacity: 0, y: -5, transition: { duration: 0.18, ease: "easeOut" } }}
            >
              <div className="mhead">
                <div>
                  <div className="mtitle">Welcome to remit</div>
                  <div className="msub">Authority, lent not given.</div>
                </div>
              </div>
              <p className="frlede">
                Every card here is a scoped, revocable spending authority your agents borrow. They never hold your
                funds, and they die the moment you say so.
              </p>
              <div className="frrows">
                <div className="frrow">
                  <span className="frk">Issue</span>
                  <span className="frv">Describe terms in plain language · they compile to on-chain caveats you sign</span>
                </div>
                <div className="frrow">
                  <span className="frk">Connect</span>
                  <span className="frv">Any agent plugs in over MCP · the card URL is the credential</span>
                </div>
                <div className="frrow">
                  <span className="frk">Control</span>
                  <span className="frv">Freeze or revoke any time · sub-cards die with their parent</span>
                </div>
              </div>
              <div className="mfoot">
                <span className="frsteps" aria-hidden>
                  <i className="on" />
                  <i />
                </span>
                <button className="mghost" onClick={onExplore} data-testid="firstrun-skip">
                  Skip the Tour
                </button>
                <button className="dbtn" onClick={() => setStep(1)} data-testid="firstrun-next">
                  Next
                </button>
              </div>
            </motion.div>
          ) : (
            <motion.div
              key="fund"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0, transition: { duration: 0.3, ease: swapEase } }}
              exit={{ opacity: 0, y: -5, transition: { duration: 0.18, ease: "easeOut" } }}
            >
              <div className="mhead">
                <div>
                  <div className="mtitle">Fund Your Wallet</div>
                  <div className="msub">Cards spend USDC from your embedded wallet on Base</div>
                </div>
              </div>
              <div className={`frbal${funded ? " funded" : ""}`} data-testid="firstrun-balance">
                {funded && <IconCheck />}
                <span className="frbalfig">{bal === null ? "–" : `$${bal.toFixed(2)}`}</span>
                <span className="frballbl">{funded ? "USDC received · live on Base" : "USDC on Base"}</span>
              </div>
              <button className="fraddr" onClick={copy} title="Copy your wallet address" data-testid="firstrun-address">
                <span className="fraddrtext">{address}</span>
                {copied ? <IconCheck /> : <IconCopy />}
              </button>
              <p className="frnote">
                Send USDC on Base to this address · it lands in seconds and the figure above will tick up. Issuing a
                card is free (a signature, no gas), so you can also fund later · your avatar menu keeps this address
                and balance.
              </p>
              <div className="mfoot">
                <span className="frsteps" aria-hidden>
                  <i />
                  <i className="on" />
                </span>
                <button className="mghost" onClick={onTour ?? onExplore} data-testid="firstrun-explore">
                  {onTour ? "Show Me Around" : "Explore First"}
                </button>
                <button className="dbtn" onClick={onIssue} data-testid="firstrun-issue">
                  Issue Your First Card
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </motion.div>
  );
}
