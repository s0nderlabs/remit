"use client";

// The theme toggle: one icon morphing between sun and moon (a masked circle
// slides in to carve the crescent; the rays collapse). The switch itself rides
// the View Transitions crossfade when the browser has it.

import { useEffect, useId, useState } from "react";
import { motion } from "motion/react";

type Theme = "light" | "dark";

const spring = { type: "spring", stiffness: 320, damping: 26 } as const;

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme | null>(null);
  const mid = useId().replace(/[^a-zA-Z0-9]/g, "");

  useEffect(() => {
    setTheme(document.documentElement.dataset.theme === "dark" ? "dark" : "light");
  }, []);

  const flip = () => {
    if (!theme) return;
    const next: Theme = theme === "dark" ? "light" : "dark";
    const apply = () => {
      document.documentElement.dataset.theme = next;
      try {
        localStorage.setItem("remit-theme", next);
      } catch {}
      setTheme(next);
    };
    const doc = document as Document & { startViewTransition?: (cb: () => void) => void };
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (doc.startViewTransition && !reduced) doc.startViewTransition(apply);
    else apply();
  };

  const dark = theme === "dark";
  return (
    <button
      className="themebtn"
      onClick={flip}
      disabled={theme === null}
      aria-label={dark ? "switch to light mode" : "switch to dark mode"}
      title={dark ? "light mode" : "dark mode"}
      data-testid="theme-toggle"
    >
      <motion.svg
        width="17"
        height="17"
        viewBox="0 0 24 24"
        fill="none"
        animate={{ rotate: dark ? -28 : 0 }}
        transition={spring}
        aria-hidden
      >
        <mask id={`moon${mid}`}>
          <rect x="0" y="0" width="24" height="24" fill="white" />
          {/* the bite that carves the crescent: slides in from off-canvas */}
          <motion.circle
            fill="black"
            initial={false}
            animate={dark ? { cx: 16.5, cy: 7.5, r: 7 } : { cx: 27, cy: 2, r: 7 }}
            transition={spring}
          />
        </mask>
        <motion.circle
          cx="12"
          cy="12"
          fill="currentColor"
          mask={`url(#moon${mid})`}
          initial={false}
          animate={{ r: dark ? 8.5 : 4.6 }}
          transition={spring}
        />
        <motion.g
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          initial={false}
          animate={{ opacity: dark ? 0 : 1, scale: dark ? 0.45 : 1 }}
          transition={spring}
          style={{ transformOrigin: "12px 12px" }}
        >
          <path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.55 1.55M17.15 17.15l1.55 1.55M18.7 5.3l-1.55 1.55M6.85 17.15L5.3 18.7" />
        </motion.g>
      </motion.svg>
    </button>
  );
}
