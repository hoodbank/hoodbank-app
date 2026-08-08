"use client";

// Floating centered pill nav: brand · dot-grid menu · CTA. A client component
// only because the menu needs to close when a link is picked — everything else
// on the landing stays server-rendered.

import { useEffect, useRef, useState } from "react";

const WALLET = "https://wallet.hoodbank.org";

const LINKS = [
  ["#features", "Features"],
  ["#how", "How it works"],
  ["#coverage", "Coverage"],
  ["#faq", "FAQ"],
] as const;

export function LandingNav() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLElement | null>(null);

  // While the menu is open, the page body blurs (CSS keys off this class) —
  // the one blur technique that works even without backdrop-filter support.
  useEffect(() => {
    document.body.classList.toggle("lp-menuopen", open);
    return () => document.body.classList.remove("lp-menuopen");
  }, [open]);

  // Outside click / Esc dismisses the menu.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <nav className="lp-nav" ref={ref}>
      <a className="brand" href="/">
        <img src="/logo.png" alt="HoodBank" />
        <span>HoodBank</span>
      </a>

      <div className="lp-menuwrap">
        <button
          className="lp-dots"
          aria-label="Menu"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
            {[2, 8, 14].flatMap((y) =>
              [2, 8, 14].map((x) => <circle key={`${x}${y}`} cx={x} cy={y} r="1.5" />)
            )}
          </svg>
        </button>
        {open && (
          <div className="lp-pop" role="menu">
            {LINKS.map(([href, label]) => (
              <a key={href} href={href} role="menuitem" onClick={() => setOpen(false)}>
                {label}
              </a>
            ))}
          </div>
        )}
      </div>

      <a className="lp-cta" href={WALLET}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M4 12 20 5l-6 16-2.5-6.5L4 12Z" />
        </svg>
        Open Wallet
      </a>
    </nav>
  );
}
