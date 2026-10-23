"use client";

import { ChevronDown } from "lucide-react";
import { usePathname } from "next/navigation";
import { useEffect, useRef, type ReactNode } from "react";
import { HelpTip } from "../ui";

/** Native disclosure keeps the form mounted and opens existing /jobs#new entry points. */
export function JobCreateSection({ children }: { children: ReactNode }) {
  const details = useRef<HTMLDetailsElement>(null);
  const pathname = usePathname();

  useEffect(() => {
    let frame: number | undefined;
    const reveal = () => {
      if (!details.current) return;
      details.current.open = true;
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => details.current?.scrollIntoView({ block: "start" }));
    };
    const fromHash = () => { if (window.location.hash === "#new") reveal(); };
    const fromLink = (event: MouseEvent) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
      if (!link || (link.target && link.target !== "_self") || link.hasAttribute("download")) return;
      const target = new URL(link.href, window.location.href);
      if (target.origin === window.location.origin && target.pathname === window.location.pathname && target.hash === "#new") reveal();
    };
    fromHash();
    window.addEventListener("hashchange", fromHash);
    window.addEventListener("popstate", fromHash);
    // Next client navigation and repeated clicks to the same hash need not emit hashchange.
    document.addEventListener("click", fromLink, true);
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      window.removeEventListener("hashchange", fromHash);
      window.removeEventListener("popstate", fromHash);
      document.removeEventListener("click", fromLink, true);
    };
  }, [pathname]);

  return <details ref={details} id="new" className="group min-w-0 scroll-mt-20 rounded-xl border border-line bg-surface shadow-[0_1px_2px_rgba(0,0,0,0.03)]">
    <summary className="cursor-pointer list-none rounded-xl p-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
      <span className="flex items-center justify-between gap-3 text-sm font-semibold text-ink">New job<ChevronDown size={16} className="shrink-0 text-ink-3 transition-transform group-open:rotate-180" aria-hidden /></span>
      <span className="mt-1 block text-xs text-ink-3">Describe the goal; the supervisor writes a plan in the job's working document and delegates from there.</span>
    </summary>
    <div className="border-t border-line"><p className="px-4 pt-3 text-xs text-ink-3">Supervisor <HelpTip term="supervisor" /></p>{children}</div>
  </details>;
}
