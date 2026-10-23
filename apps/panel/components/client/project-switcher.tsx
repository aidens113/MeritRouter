"use client";

import Link from "next/link";
import { z } from "zod";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Check, ChevronsUpDown, FolderGit2, Globe, LayoutGrid, Plus, Network } from "lucide-react";
import { cx } from "../ui";
import { ALL, projectBase, SLUG_RE } from "@/lib/links";

/** A project as the switcher lists it (lib/project.ts `switcherProjects`). */
export interface SwitcherProject {
  slug: string;
  name: string;
  live: boolean;
  queued: boolean;
  attention: number;
  /** Archived metadata identifies the current settings page but never appears in the picker. */
  archived?: boolean;
}

// Preserve the last good menu when a refresh returns an error or malformed rows.
const SwitcherResponse = z.object({
  ok: z.literal(true),
  projects: z.array(z.object({
    slug: z.string().regex(SLUG_RE),
    name: z.string().min(1),
    live: z.boolean(),
    queued: z.boolean(),
    attention: z.number().int().nonnegative(),
    archived: z.boolean().optional(),
  })).max(10_000),
});

/** Where the person is: inside a project, the install-wide section, or the projects grid. */
export type Scope = { kind: "project"; slug: string } | { kind: "all" } | { kind: "home" };

function ActivityDot({ p }: { p: Pick<SwitcherProject, "live" | "queued"> }) {
  return (
    <span className="relative flex h-2.5 w-2.5 shrink-0 items-center justify-center" aria-hidden>
      {p.live ? <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-good opacity-50 motion-reduce:hidden" /> : null}
      <span className={cx("relative inline-flex h-2 w-2 rounded-full", p.live ? "bg-good" : p.queued ? "bg-warn" : "bg-surface-3 ring-1 ring-line-strong")} />
    </span>
  );
}

function activityText(p: SwitcherProject): string {
  const parts = [p.live ? "running" : p.queued ? "queued work" : "idle"];
  if (p.attention) parts.push(`${p.attention} need${p.attention === 1 ? "s" : ""} attention`);
  return parts.join(", ");
}

/**
 * The project switcher at the top left of the shell: the current project (or "All projects"),
 * every live project with an activity dot, the install-wide section, the grid, and "New project".
 * A menu button: Enter, Space, or ArrowDown opens it; arrows, Home, and End move; Escape closes
 * and returns focus to the button. The list refreshes from /api/projects each time it opens.
 */
export function ProjectSwitcher({ scope, initial }: { scope: Scope; initial: SwitcherProject[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [projects, setProjects] = useState(initial);
  // The menu is fixed to the viewport: the sidebar scrolls (overflow), which would clip it.
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => setProjects(initial), [initial]);

  const items = () => Array.from(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
  const focusAt = (i: number) => {
    const all = items();
    if (!all.length) return;
    all[(i + all.length) % all.length]!.focus();
  };

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  }, []);

  // Fresh activity whenever the menu opens (the layout's list is from the last full render).
  useEffect(() => {
    if (!open) return;
    let live = true;
    fetch("/api/projects", { cache: "no-store" })
      .then((r) => r.json())
      .then((data: unknown) => {
        const parsed = SwitcherResponse.safeParse(data);
        if (live && parsed.success) setProjects(parsed.data.projects);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [open]);

  // Click outside closes; so do resizing and scrolling the page, which would move the button away.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) close(false);
    };
    const onMove = () => close(false);
    document.addEventListener("mousedown", onDown);
    window.addEventListener("resize", onMove);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("resize", onMove);
    };
  }, [open, close]);

  const current = scope.kind === "project" ? projects.find((p) => p.slug === scope.slug) : undefined;
  const available = projects.filter(p => !p.archived);
  const title = scope.kind === "project" ? (current?.name ?? scope.slug) : scope.kind === "all" ? "All projects" : "MeritRouter";
  const subtitle = scope.kind === "project" ? `${scope.slug}${current?.archived ? " · archived" : ""}` : scope.kind === "all" ? "Install-wide pages" : "Projects";

  const openMenu = (focus: "first" | "last" | "current") => {
    const r = button.current?.getBoundingClientRect();
    if (r) setPos({ left: Math.max(8, Math.min(r.left, window.innerWidth - Math.min(320, window.innerWidth - 32) - 8)), top: r.bottom + 4 });
    setOpen(true);
    requestAnimationFrame(() => {
      const all = items();
      if (focus === "last") return focusAt(all.length - 1);
      const cur = all.findIndex((el) => el.getAttribute("aria-current") === "page");
      focusAt(focus === "current" && cur >= 0 ? cur : 0);
    });
  };

  const onButtonKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openMenu("current");
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      openMenu("last");
    }
  };

  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const all = items();
    const i = all.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown") (e.preventDefault(), focusAt(i + 1));
    else if (e.key === "ArrowUp") (e.preventDefault(), focusAt(i - 1));
    else if (e.key === "Home") (e.preventDefault(), focusAt(0));
    else if (e.key === "End") (e.preventDefault(), focusAt(all.length - 1));
    else if (e.key === "Escape") (e.preventDefault(), close(true));
    else if (e.key === "Tab") close(false);
  };

  const go = (href: string) => {
    close(false);
    router.push(href);
  };

  const itemClass = "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm text-ink outline-none hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent";

  return (
    <div ref={wrap} className="relative min-w-0">
      <button
        ref={button}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`Project: ${title}. Switch project`}
        onClick={() => (open ? close(false) : openMenu("current"))}
        onKeyDown={onButtonKey}
        className="flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-surface-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent text-white">
          {scope.kind === "project" ? <FolderGit2 size={15} aria-hidden /> : scope.kind === "all" ? <Globe size={15} aria-hidden /> : <Network size={16} aria-hidden />}
        </span>
        <span className="min-w-0 flex-1 leading-tight">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-sm font-semibold text-ink">{title}</span>
            {current && !current.archived ? <ActivityDot p={current} /> : null}
          </span>
          <span className="block truncate font-mono text-[11px] text-ink-3">{subtitle}</span>
        </span>
        <ChevronsUpDown size={14} className="shrink-0 text-ink-3" aria-hidden />
      </button>

      {open ? (
        <div
          ref={menu}
          id={menuId}
          role="menu"
          aria-label="Switch project"
          onKeyDown={onMenuKey}
          style={pos ? { left: pos.left, top: pos.top } : undefined}
          className="fixed z-50 w-[min(20rem,calc(100vw-2rem))] rounded-xl border border-line bg-surface p-1.5 shadow-lg"
        >
          <div className="px-2.5 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wide text-ink-3">Projects</div>
          <div className="max-h-[50vh] overflow-y-auto p-px">
            {available.length ? (
              available.map((p) => {
                const here = scope.kind === "project" && scope.slug === p.slug;
                return (
                  <Link
                    key={p.slug}
                    href={projectBase(p.slug)}
                    role="menuitem"
                    aria-current={here ? "page" : undefined}
                    onClick={(e) => (e.preventDefault(), go(projectBase(p.slug)))}
                    className={cx(itemClass, here && "bg-accent-soft")}
                  >
                    <ActivityDot p={p} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{p.name}</span>
                      <span className="block truncate text-[11px] text-ink-3">
                        <span className="font-mono">{p.slug}</span> · {activityText(p)}
                      </span>
                    </span>
                    {here ? <Check size={14} className="shrink-0 text-accent-ink" aria-hidden /> : null}
                  </Link>
                );
              })
            ) : (
              <p className="px-2.5 py-2 text-sm text-ink-3">No projects yet.</p>
            )}
          </div>
          <div className="my-1 border-t border-line" role="separator" />
          <Link href={ALL} role="menuitem" aria-current={scope.kind === "all" ? "page" : undefined} onClick={(e) => (e.preventDefault(), go(ALL))} className={cx(itemClass, scope.kind === "all" && "bg-accent-soft")}>
            <Globe size={15} className="shrink-0 text-ink-3" aria-hidden />
            <span className="flex-1">All projects</span>
            <span className="text-[11px] text-ink-3">dashboard</span>
          </Link>
          <Link href="/" role="menuitem" aria-current={scope.kind === "home" ? "page" : undefined} onClick={(e) => (e.preventDefault(), go("/"))} className={itemClass}>
            <LayoutGrid size={15} className="shrink-0 text-ink-3" aria-hidden />
            <span className="flex-1">Projects grid</span>
          </Link>
          <Link href="/new" role="menuitem" onClick={(e) => (e.preventDefault(), go("/new"))} className={itemClass}>
            <Plus size={15} className="shrink-0 text-accent-ink" aria-hidden />
            <span className="flex-1 font-medium text-accent-ink">New project</span>
          </Link>
        </div>
      ) : null}
    </div>
  );
}
