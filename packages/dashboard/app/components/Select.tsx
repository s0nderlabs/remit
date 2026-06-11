"use client";

// A proper dropdown: trigger styled like every other inset control, options in
// a floating canvas panel (hairline border, soft shadow, motion-eased) instead
// of the UA's native list. Keyboard: Enter/Space/arrows open and move, Escape
// closes, outside pointer closes.

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";

export type SelectOption = { value: string; label: string };

export function Select({
  value,
  options,
  onChange,
  width,
  testid,
}: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  width?: number;
  testid?: string;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const current = options.find((o) => o.value === value) ?? options[0];

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const step = (delta: number) => {
    const i = options.findIndex((o) => o.value === value);
    const next = options[Math.max(0, Math.min(options.length - 1, i + delta))];
    if (next && next.value !== value) onChange(next.value);
  };

  return (
    <div
      className="sel"
      ref={wrapRef}
      style={width ? { width } : undefined}
      // Tab-away must not leave the listbox floating: close when focus leaves the wrapper
      onBlur={(e) => {
        if (!wrapRef.current?.contains(e.relatedTarget as Node)) setOpen(false);
      }}
    >
      <button
        type="button"
        className={`selbtn${open ? " open" : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        data-testid={testid}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            open ? step(1) : setOpen(true);
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            if (open) step(-1);
          }
        }}
      >
        <span>{current?.label}</span>
        <svg viewBox="0 0 10 6" aria-hidden>
          <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <AnimatePresence>
        {open && (
          <motion.ul
            className="selpop"
            role="listbox"
            initial={{ opacity: 0, y: -4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1, transition: { duration: 0.16, ease: [0.22, 1, 0.36, 1] } }}
            exit={{ opacity: 0, y: -3, transition: { duration: 0.1, ease: "easeIn" } }}
          >
            {options.map((o) => (
              <li key={o.value} role="option" aria-selected={o.value === value}>
                <button
                  type="button"
                  className={`selopt${o.value === value ? " on" : ""}`}
                  onClick={() => {
                    onChange(o.value);
                    setOpen(false);
                  }}
                >
                  <span>{o.label}</span>
                  {o.value === value && (
                    <svg viewBox="0 0 12 10" aria-hidden>
                      <path d="M1.5 5.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </button>
              </li>
            ))}
          </motion.ul>
        )}
      </AnimatePresence>
    </div>
  );
}
