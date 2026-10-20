"use client";

import { useRef } from "react";
import { CircleHelp } from "lucide-react";
import { GLOSSARY, type GlossaryKey } from "@/lib/glossary";

const MARGIN = 8;

/**
 * Hover/focus popover explaining a term. Keyboard reachable. The popover is not rendered
 * (display: none) until shown, so a hidden one never widens the page; when it opens, it is
 * shifted to stay inside the viewport (an icon near the right edge would otherwise push it out
 * and make the page scroll sideways).
 */
export function HelpTip({ term, text, label }: { term?: GlossaryKey; text?: string; label?: string }) {
  const body = text ?? (term ? GLOSSARY[term] : "");
  const tip = useRef<HTMLSpanElement>(null);
  const place = (retry = true) => {
    const el = tip.current;
    if (!el) return;
    el.style.marginLeft = "0px";
    const r = el.getBoundingClientRect();
    // Not shown yet (the hover style applies after this event): measure on the next frame.
    if (!r.width) {
      if (retry) requestAnimationFrame(() => place(false));
      return;
    }
    const vw = document.documentElement.clientWidth;
    let shift = 0;
    if (r.right > vw - MARGIN) shift = vw - MARGIN - r.right;
    if (r.left + shift < MARGIN) shift = MARGIN - r.left;
    el.style.marginLeft = `${Math.round(shift)}px`;
  };
  return (
    <span className="group relative inline-flex align-middle" onMouseEnter={() => place()} onFocus={() => place()}>
      <button type="button" aria-label={label ?? "What does this mean?"} className="inline-flex rounded-full text-ink-3 hover:text-ink focus:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-accent">
        <CircleHelp size={14} aria-hidden />
      </button>
      <span
        ref={tip}
        role="tooltip"
        className="pointer-events-none absolute left-1/2 top-full z-50 mt-1.5 hidden w-72 max-w-[calc(100vw-1rem)] -translate-x-1/2 rounded-lg border border-line bg-surface p-3 text-left text-xs font-normal leading-relaxed text-ink-2 shadow-lg group-focus-within:block group-hover:block"
      >
        {body}
      </span>
    </span>
  );
}
