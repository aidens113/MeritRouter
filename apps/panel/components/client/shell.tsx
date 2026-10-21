"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import {
  Activity,
  BadgeCheck,
  Boxes,
  BookOpenText,
  KeyRound,
  LayoutDashboard,
  ListChecks,
  LogOut,
  Menu,
  Monitor,
  Moon,
  Network,
  Route,
  Scale,
  ScrollText,
  Settings,
  SlidersHorizontal,
  Sun,
  UsersRound,
  X,
  LayoutGrid,
  type LucideIcon,
} from "lucide-react";
import { cx } from "../ui";
import { THEME_KEY } from "@/lib/theme";
import { ALL, projectBase, slugOfPath } from "@/lib/links";
import { ProjectSwitcher, type Scope, type SwitcherProject } from "./project-switcher";

type NavItem = { href: string; label: string; icon: LucideIcon; exact?: boolean };

/** Inside a project: that project's pages. */
function projectNav(slug: string): NavItem[] {
  const b = projectBase(slug);
  return [
    { href: b, label: "Overview", icon: LayoutDashboard, exact: true },
    { href: `${b}/jobs`, label: "Jobs", icon: Network },
    { href: `${b}/teams`, label: "Teams", icon: UsersRound },
    { href: `${b}/tasks`, label: "Tasks", icon: ListChecks },
    { href: `${b}/sessions`, label: "Sessions", icon: ScrollText },
    { href: `${b}/requests`, label: "Requests", icon: Activity },
    { href: `${b}/brain`, label: "Brain", icon: BookOpenText },
    { href: `${b}/settings`, label: "Project settings", icon: SlidersHorizontal },
  ];
}

/** "All projects" and the projects grid: the install-wide pages. */
const GLOBAL_NAV: NavItem[] = [
  { href: "/", label: "Projects", icon: LayoutGrid, exact: true },
  { href: ALL, label: "Dashboard", icon: LayoutDashboard, exact: true },
  { href: `${ALL}/requests`, label: "Requests", icon: Activity },
  { href: `${ALL}/models`, label: "Models", icon: Boxes },
  { href: `${ALL}/routing`, label: "Routing", icon: Route },
  { href: `${ALL}/keys`, label: "Provider keys", icon: KeyRound },
  { href: `${ALL}/qualification`, label: "Qualification", icon: BadgeCheck },
  { href: `${ALL}/calibration`, label: "Calibration", icon: Scale },
  { href: `${ALL}/settings`, label: "Settings", icon: Settings },
];

function scopeOf(path: string): Scope {
  const slug = slugOfPath(path);
  if (slug) return { kind: "project", slug };
  if (path === ALL || path.startsWith(`${ALL}/`)) return { kind: "all" };
  return { kind: "home" };
}

function isActive(path: string, item: NavItem) {
  return item.exact ? path === item.href : path === item.href || path.startsWith(`${item.href}/`);
}

export function Shell({ children, configPath, loginEnabled, projects }: { children: ReactNode; configPath: string; loginEnabled: boolean; projects: SwitcherProject[] }) {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [path]);

  if (path === "/login") return <main className="min-h-screen">{children}</main>;

  const scope = scopeOf(path);
  const items = scope.kind === "project" ? projectNav(scope.slug) : GLOBAL_NAV;
  const nav = (
    <nav aria-label={scope.kind === "project" ? "Project" : "All projects"} className="flex flex-col gap-0.5">
      {scope.kind !== "project" ? <div className="px-3 pb-1 pt-1 text-[11px] font-medium uppercase tracking-wide text-ink-3">All projects</div> : null}
      {items.map((item) => {
        const { href, label, icon: Icon } = item;
        const active = isActive(path, item);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cx(
              "flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors",
              active ? "bg-accent-soft font-medium text-accent-ink" : "text-ink-2 hover:bg-surface-2 hover:text-ink",
            )}
          >
            <Icon size={16} aria-hidden />
            {label}
          </Link>
        );
      })}
    </nav>
  );

  const footer = (
    <div className="space-y-3 border-t border-line pt-3">
      <ThemeToggle />
      <div className="px-1 text-[11px] leading-snug text-ink-3">
        <div className="font-medium text-ink-2">Config</div>
        <div className="break-all font-mono">{configPath}</div>
      </div>
      {loginEnabled ? <LogoutButton /> : null}
    </div>
  );

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[15rem_1fr]">
      <aside className="sticky top-0 hidden h-screen flex-col gap-4 overflow-y-auto border-r border-line bg-surface px-3 py-4 lg:flex">
        <ProjectSwitcher scope={scope} initial={projects} />
        <div className="flex-1">{nav}</div>
        {footer}
      </aside>

      <div className="sticky top-0 z-40 flex items-center justify-between gap-2 border-b border-line bg-surface px-4 py-2 lg:hidden">
        <div className="min-w-0 max-w-[20rem] flex-1">
          <ProjectSwitcher scope={scope} initial={projects} />
        </div>
        <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-label="Toggle navigation" className="shrink-0 rounded-lg p-2 text-ink-2 hover:bg-surface-2">
          {open ? <X size={18} /> : <Menu size={18} />}
        </button>
        {open ? (
          <div className="absolute inset-x-0 top-full max-h-[calc(100vh-4rem)] space-y-4 overflow-y-auto border-b border-line bg-surface px-3 py-3 shadow-lg">
            {nav}
            {footer}
          </div>
        ) : null}
      </div>

      <main className="min-w-0 px-4 py-6 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-[1400px]">{children}</div>
      </main>
    </div>
  );
}

type Theme = "system" | "light" | "dark";
const listeners = new Set<() => void>();

function readTheme(): Theme {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

function applyTheme(t: Theme) {
  try {
    if (t === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, t);
  } catch {
    // storage blocked: the choice lasts for this page only
  }
  if (t === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", t);
  listeners.forEach((l) => l());
}

function ThemeToggle() {
  const theme = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    readTheme,
    () => "system" as Theme,
  );
  const opts: Array<{ v: Theme; icon: typeof Sun; label: string }> = [
    { v: "system", icon: Monitor, label: "System theme" },
    { v: "light", icon: Sun, label: "Light theme" },
    { v: "dark", icon: Moon, label: "Dark theme" },
  ];
  return (
    <div role="radiogroup" aria-label="Theme" className="flex rounded-lg border border-line bg-surface-2 p-0.5">
      {opts.map(({ v, icon: Icon, label }) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={theme === v}
          aria-label={label}
          title={label}
          onClick={() => applyTheme(v)}
          className={cx("flex flex-1 items-center justify-center rounded-md py-1 text-ink-3", theme === v && "bg-surface text-ink shadow-sm")}
        >
          <Icon size={14} aria-hidden />
        </button>
      ))}
    </div>
  );
}

function LogoutButton() {
  const router = useRouter();
  return (
    <button
      type="button"
      onClick={async () => {
        await fetch("/api/logout", { method: "POST" });
        router.replace("/login");
        router.refresh();
      }}
      className="flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-sm text-ink-2 hover:bg-surface-2"
    >
      <LogOut size={14} aria-hidden /> Sign out
    </button>
  );
}
