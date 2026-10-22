"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import {
  BadgeCheck,
  Boxes,
  BookOpenText,
  GitBranch,
  KeyRound,
  LayoutDashboard,
  ListChecks,
  LogOut,
  Menu,
  Monitor,
  Moon,
  Network,
  Power,
  Settings,
  SlidersHorizontal,
  Sun,
  X,
  LayoutGrid,
  Library,
  type LucideIcon,
} from "lucide-react";
import { cx, Mono } from "../ui";
import { THEME_KEY } from "@/lib/theme";
import { ALL, projectBase, slugOfPath } from "@/lib/links";
import { ProjectSwitcher, type Scope, type SwitcherProject } from "./project-switcher";
import { ConfirmDialog } from "./confirm-dialog";
import { callApi } from "./actions";
import { LiveProvider } from "./live";
import { GroupTabs } from "../group-tabs";

/** `also`: other paths whose pages belong to this entry (they share its tab strip, components/group-tabs.tsx). */
type NavItem = { href: string; label: string; icon: LucideIcon; exact?: boolean; also?: string[] };

/** Inside a project: that project's pages (Teams sits under Jobs; Agents, Sessions, Requests under Tasks). */
function projectNav(slug: string): NavItem[] {
  const b = projectBase(slug);
  return [
    { href: b, label: "Overview", icon: LayoutDashboard, exact: true },
    { href: `${b}/jobs`, label: "Jobs", icon: Network, also: [`${b}/teams`] },
    { href: `${b}/tasks`, label: "Tasks", icon: ListChecks, also: [`${b}/agents`, `${b}/sessions`, `${b}/requests`] },
    { href: `${b}/repos`, label: "Code", icon: GitBranch },
    { href: `${b}/brain`, label: "Brain", icon: BookOpenText },
    { href: `${b}/settings`, label: "Project settings", icon: SlidersHorizontal },
  ];
}

/** "All projects" and the projects grid: the install-wide pages (Requests under Dashboard, Routing under Models, Calibration under Quality). */
const GLOBAL_NAV: NavItem[] = [
  { href: "/", label: "Projects", icon: LayoutGrid, exact: true },
  { href: ALL, label: "Dashboard", icon: LayoutDashboard, exact: true, also: [`${ALL}/requests`] },
  { href: `${ALL}/models`, label: "Models", icon: Boxes, also: [`${ALL}/routing`] },
  { href: `${ALL}/keys`, label: "Provider keys", icon: KeyRound },
  { href: `${ALL}/qualification`, label: "Quality", icon: BadgeCheck, also: [`${ALL}/calibration`] },
  { href: `${ALL}/knowledge`, label: "Knowledge", icon: Library },
  { href: `${ALL}/settings`, label: "Settings", icon: Settings },
];

function scopeOf(path: string): Scope {
  const slug = slugOfPath(path);
  if (slug) return { kind: "project", slug };
  if (path === ALL || path.startsWith(`${ALL}/`)) return { kind: "all" };
  return { kind: "home" };
}

function isActive(path: string, item: NavItem) {
  const under = (href: string) => path === href || path.startsWith(`${href}/`);
  return (item.exact ? path === item.href : under(item.href)) || (item.also ?? []).some(under);
}

function sectionTabs(path: string, scope: Scope) {
  if (scope.kind === "project") {
    const base = projectBase(scope.slug);
    const section = path.slice(base.length).split("/")[1] ?? "";
    if (section === "jobs" || section === "teams") return <GroupTabs group="jobs" active={section} base={base} />;
    if (["tasks", "agents", "sessions", "requests"].includes(section)) return <GroupTabs group="work" active={section} base={base} />;
  }
  if (path === ALL || path.startsWith(`${ALL}/requests`)) return <GroupTabs group="dashboard" active={path === ALL ? "dashboard" : "requests"} />;
  if (path.startsWith(`${ALL}/models`) || path === `${ALL}/routing`) return <GroupTabs group="models" active={path === `${ALL}/routing` ? "routing" : "models"} />;
  if (path.startsWith(`${ALL}/qualification`) || path === `${ALL}/calibration`) return <GroupTabs group="quality" active={path === `${ALL}/calibration` ? "calibration" : "qualification"} />;
  return null;
}
export function Shell({ children, configPath, loginEnabled, projects }: { children: ReactNode; configPath: string; loginEnabled: boolean; projects: SwitcherProject[] }) {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const [confirmOff, setConfirmOff] = useState(false);
  const [offError, setOffError] = useState<string | null>(null);
  const [off, setOff] = useState(false);
  useEffect(() => setOpen(false), [path]);

  if (path === "/login") return <main className="min-h-screen">{children}</main>;
  if (off) return <PanelOff />;

  const turnOff = async (): Promise<boolean> => {
    setOffError(null);
    const r = await callApi("/api/panel/stop", "POST");
    if (!r.ok) {
      setOffError(r.error ?? "The panel did not turn off.");
      return false;
    }
    setOff(true);
    return true;
  };
  const power = (
    <button
      type="button"
      onClick={() => {
        setOffError(null);
        setConfirmOff(true);
      }}
      aria-label="Turn the panel off"
      title="Turn the panel off"
      className="shrink-0 rounded-lg p-2 text-ink-2 hover:bg-surface-2 hover:text-bad-ink"
    >
      <Power size={18} aria-hidden />
    </button>
  );

  const scope = scopeOf(path);
  // A project missing from the live list is archived (its settings page is the only one that opens).
  const archived = scope.kind === "project" && !projects.some((p) => p.slug === scope.slug);
  const items = scope.kind === "project" ? projectNav(scope.slug).filter((i) => !archived || i.href.endsWith("/settings")) : GLOBAL_NAV;
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
        <div className="flex items-start gap-1">
          <div className="min-w-0 flex-1">
            <ProjectSwitcher scope={scope} initial={projects} />
          </div>
          {power}
        </div>
        <div className="flex-1">{nav}</div>
        {footer}
      </aside>

      <div className="sticky top-0 z-40 flex items-center justify-between gap-2 border-b border-line bg-surface px-4 py-2 lg:hidden">
        <div className="min-w-0 max-w-[20rem] flex-1">
          <ProjectSwitcher scope={scope} initial={projects} />
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {power}
          <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-label="Toggle navigation" className="shrink-0 rounded-lg p-2 text-ink-2 hover:bg-surface-2">
            {open ? <X size={18} /> : <Menu size={18} />}
          </button>
        </div>
        {open ? (
          <div className="absolute inset-x-0 top-full max-h-[calc(100vh-4rem)] space-y-4 overflow-y-auto border-b border-line bg-surface px-3 py-3 shadow-lg">
            {nav}
            {footer}
          </div>
        ) : null}
      </div>

      <main className="min-w-0 px-4 py-6 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-[1400px]">
          {/* One live connection per tab, scoped to the project being viewed (or every project). */}
          <LiveProvider scope={scope.kind === "project" ? scope.slug : "all"}>{sectionTabs(path, scope)}{children}</LiveProvider>
        </div>
      </main>

      <ConfirmDialog
        open={confirmOff}
        onClose={() => setConfirmOff(false)}
        onConfirm={turnOff}
        title="Turn the panel off?"
        description={
          <>
            Agents keep running; the panel starts again when a new agent session begins or you run <Mono>switchyard panel</Mono>.
          </>
        }
        confirmLabel="Turn off"
        tone="danger"
      >
        {offError ? (
          <p role="alert" className="text-bad-ink">
            {offError}
          </p>
        ) : null}
      </ConfirmDialog>
    </div>
  );
}

/** What stays on screen once the panel's server has stopped: static, nothing here calls it. */
function PanelOff() {
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-10">
      <div role="status" className="w-full max-w-md rounded-xl border border-line bg-surface p-6 text-center shadow-sm">
        <Power size={28} className="mx-auto text-ink-3" aria-hidden />
        <h1 className="mt-3 text-lg font-semibold tracking-tight text-ink">Panel turned off</h1>
        <p className="mt-2 text-sm leading-relaxed text-ink-2">
          Agents keep running. The panel starts again when a new agent session begins, or when you run{" "}
          <code className="rounded bg-surface-2 px-1 py-0.5 font-mono text-[0.85em]">switchyard panel</code>.
        </p>
      </div>
    </main>
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
