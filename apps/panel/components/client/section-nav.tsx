"use client";

import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import { cx } from "../ui";

export type SectionNavItem = { id: string; title: string };

/** How far below a section's scroll margin its top may sit and still count as the section in view. */
const SPY_SLACK_PX = 24;
/** Quiet time after a jump before scrolling selects by position again. */
const SETTLE_MS = 160;

/**
 * In-page section menu: jumps to a section (smooth unless reduced motion is asked for), marks the
 * section in view while the page scrolls, and mirrors the selection in the URL hash with
 * replaceState so deep links work without adding history entries. A vertical sticky list on wide
 * screens, a sticky horizontal strip on narrow ones.
 */
export function SectionNav({ items, label }: { items: SectionNavItem[]; label: string }) {
  const [active, setActiveState] = useState(items[0]?.id ?? "");
  const activeRef = useRef(active);
  const setActive = useCallback((id: string) => {
    activeRef.current = id;
    setActiveState(id);
  }, []);
  const listRef = useRef<HTMLUListElement>(null);
  // While a jump is in flight the clicked item stays selected; scroll events only extend the lock.
  const lock = useRef<{ id: string; timer: ReturnType<typeof setTimeout> | null } | null>(null);
  const ids = items.map((i) => i.id).join(" ");

  const writeHash = useCallback((id: string) => {
    const url = `${window.location.pathname}${window.location.search}#${id}`;
    if (window.location.hash === `#${id}`) return;
    try {
      window.history.replaceState(window.history.state, "", url);
    } catch {
      // history blocked (sandboxed frame): the selection still works without the hash
    }
  }, []);

  const holdLock = useCallback((id: string, ms: number) => {
    if (lock.current?.timer) clearTimeout(lock.current.timer);
    // When the lock lapses nothing is recomputed: the jumped-to item stays selected until the user scrolls.
    lock.current = { id, timer: setTimeout(() => (lock.current = null), ms) };
  }, []);

  const releaseLock = useCallback(() => {
    if (lock.current?.timer) clearTimeout(lock.current.timer);
    lock.current = null;
  }, []);

  // Deep link on load, hash changes from elsewhere, and scroll-spy.
  useEffect(() => {
    const list = ids.split(" ").filter(Boolean);
    const known = (hash: string) => {
      const id = decodeURIComponent(hash.replace(/^#/, ""));
      return list.includes(id) ? id : null;
    };

    const spy = () => {
      const doc = document.documentElement;
      let current = list[0] ?? "";
      if (window.innerHeight + window.scrollY >= doc.scrollHeight - 4) {
        current = list[list.length - 1] ?? current; // a short last section never reaches the top
      } else {
        for (const id of list) {
          const el = document.getElementById(id);
          if (!el) continue;
          const margin = parseFloat(getComputedStyle(el).scrollMarginTop) || 0;
          if (el.getBoundingClientRect().top <= margin + SPY_SLACK_PX) current = id;
          else break;
        }
      }
      return current;
    };

    const fromHash = known(window.location.hash);
    if (fromHash) {
      setActive(fromHash);
      document.getElementById(fromHash)?.scrollIntoView({ block: "start" });
      holdLock(fromHash, SETTLE_MS * 2);
    } else {
      setActive(spy());
    }

    let frame = 0;
    const onScroll = () => {
      if (lock.current) {
        holdLock(lock.current.id, SETTLE_MS);
        return;
      }
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const id = spy();
        if (id === activeRef.current) return;
        setActive(id);
        writeHash(id);
      });
    };
    const onHashChange = () => {
      const id = known(window.location.hash);
      if (!id) return;
      setActive(id);
      holdLock(id, SETTLE_MS * 2);
    };

    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("hashchange", onHashChange);
    // A user scrolling by hand ends a jump's lock at once.
    window.addEventListener("wheel", releaseLock, { passive: true });
    window.addEventListener("touchstart", releaseLock, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      releaseLock();
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("hashchange", onHashChange);
      window.removeEventListener("wheel", releaseLock);
      window.removeEventListener("touchstart", releaseLock);
    };
  }, [ids, holdLock, releaseLock, writeHash, setActive]);

  // Keep the selected item visible when the list itself scrolls (narrow strip, or a tall list).
  useEffect(() => {
    const ul = listRef.current;
    const link = ul?.querySelector<HTMLElement>(`[data-section="${CSS.escape(active)}"]`);
    if (!ul || !link) return;
    const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const left = ul.scrollWidth > ul.clientWidth ? link.offsetLeft - (ul.clientWidth - link.offsetWidth) / 2 : ul.scrollLeft;
    const top = ul.scrollHeight > ul.clientHeight ? link.offsetTop - (ul.clientHeight - link.offsetHeight) / 2 : ul.scrollTop;
    if (left !== ul.scrollLeft || top !== ul.scrollTop) ul.scrollTo({ left, top, behavior: smooth ? "smooth" : "auto" });
  }, [active]);

  const jump = (e: MouseEvent<HTMLAnchorElement>, id: string) => {
    const el = document.getElementById(id);
    if (!el || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    setActive(id);
    writeHash(id);
    holdLock(id, SETTLE_MS * 3);
    const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "start" });
    // Move keyboard focus to the section, as a native in-page link would.
    if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1");
    el.focus({ preventScroll: true });
  };

  return (
    <nav
      aria-label={label}
      className="sticky top-[53px] z-20 -mx-4 border-b border-line bg-page/95 px-4 py-2 backdrop-blur sm:-mx-6 sm:px-6 lg:top-0 lg:-mx-8 lg:px-8 xl:top-6 xl:mx-0 xl:self-start xl:border-0 xl:bg-transparent xl:p-0 xl:backdrop-blur-none"
    >
      <ul ref={listRef} className="relative flex gap-0.5 overflow-x-auto text-sm [scrollbar-width:thin] xl:max-h-[calc(100vh-3rem)] xl:flex-col xl:overflow-x-visible xl:overflow-y-auto">
        {items.map(({ id, title }) => {
          const selected = id === active;
          return (
            <li key={id} className="shrink-0">
              <a
                href={`#${id}`}
                data-section={id}
                onClick={(e) => jump(e, id)}
                aria-current={selected ? "location" : undefined}
                className={cx(
                  "block whitespace-nowrap rounded-lg px-2.5 py-1 transition-colors xl:whitespace-normal",
                  selected ? "bg-accent-soft font-medium text-accent-ink" : "text-ink-2 hover:bg-surface-2 hover:text-ink",
                )}
              >
                {title}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
