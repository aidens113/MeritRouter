"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef } from "react";

/**
 * Deep links from before the tabs (D5): a `#section` that now lives in another tab opens that tab
 * (`?tab=<id>#section`, replacing the history entry) and scrolls to the section once it renders.
 * Each hash is handled once per tab, so a live refresh never scrolls the page back.
 */
export function TabAnchors({ anchors, active, first, param }: { anchors: Record<string, string>; active: string; first: string; param: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const key = JSON.stringify(anchors);
  const handled = useRef("");
  const query = search.toString();

  useEffect(() => {
    const map = JSON.parse(key) as Record<string, string>;
    const go = (force: boolean) => {
      let id = "";
      try {
        id = decodeURIComponent(window.location.hash.replace(/^#/, ""));
      } catch {
        return;
      }
      if (!id) return;
      const mark = `${active}#${id}`;
      if (!force && handled.current === mark) return;
      handled.current = mark;
      const tab = map[id];
      if (tab && tab !== active) {
        const q = new URLSearchParams(query);
        if (tab === first) q.delete(param);
        else q.set(param, tab);
        const s = q.toString();
        router.replace(`${pathname}${s ? `?${s}` : ""}#${encodeURIComponent(id)}`, { scroll: false });
        return;
      }
      // The section is in this tab: bring it into view (it may have rendered after the browser's own jump).
      requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ block: "start" }));
    };
    go(false);
    const onHash = () => go(true);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [key, active, first, param, pathname, router, query]);

  return null;
}
