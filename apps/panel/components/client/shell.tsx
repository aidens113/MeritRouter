"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import {
  Activity,
  BadgeCheck,
  Boxes,
  BookOpenText,
  CreditCard,
  KeyRound,
  LayoutDashboard,
  ListChecks,
  LogOut,
  Menu,
  Monitor,
  Moon,
  Network,
  Route,
  ScrollText,
  Settings,
  Sun,
  TrainTrack,
  X,
} from "lucide-react";
import { cx } from "../ui";
import { THEME_KEY } from "@/lib/theme";

const NAV = [
  { href: "/", label: "Overview", icon: LayoutDashboard },
  { href: "/models", label: "Models", icon: Boxes },
  { href: "/routing", label: "Routing", icon: Route },
  { href: "/jobs", label: "Jobs", icon: Network },
  { href: "/tasks", label: "Tasks", icon: ListChecks },
  { href: "/sessions", label: "Sessions", icon: ScrollText },
  { href: "/requests", label: "Requests", icon: Activity },
  { href: "/brain", label: "Brain", icon: BookOpenText },
  { href: "/keys", label: "Provider keys", icon: KeyRound },
  { href: "/paid", label: "Paid routes", icon: CreditCard },
  { href: "/qualification", label: "Qualification", icon: BadgeCheck },
  { href: "/settings", label: "Settings", icon: Settings },
] as const;

function isActive(path: string, href: string) {
  return href === "/" ? path === "/" : path === href || path.startsWith(`${href}/`);
}

export function Shell({ children, configPath, loginEnabled }: { children: ReactNode; configPath: string; loginEnabled: boolean }) {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [path]);

  if (path === "/login") return <main className="min-h-screen">{children}</main>;

  const nav = (
    <nav aria-label="Main" className="flex flex-col gap-0.5">
      {NAV.map(({ href, label, icon: Icon }) => {
        const active = isActive(path, href);
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
        <Brand />
        <div className="flex-1">{nav}</div>
        {footer}
      </aside>

      <div className="sticky top-0 z-40 flex items-center justify-between border-b border-line bg-surface px-4 py-2.5 lg:hidden">
        <Brand />
        <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-label="Toggle navigation" className="rounded-lg p-2 text-ink-2 hover:bg-surface-2">
          {open ? <X size={18} /> : <Menu size={18} />}
        </button>
      </div>
      {open ? (
        <div className="fixed inset-x-0 top-[53px] z-30 space-y-4 border-b border-line bg-surface px-3 py-3 shadow-lg lg:hidden">
          {nav}
          {footer}
        </div>
      ) : null}

      <main className="min-w-0 px-4 py-6 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-[1400px]">{children}</div>
      </main>
    </div>
  );
}

function Brand() {
  return (
    <Link href="/" className="flex items-center gap-2 px-2">
      <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent text-white">
        <TrainTrack size={16} aria-hidden />
      </span>
      <span className="leading-tight">
        <span className="block text-sm font-semibold text-ink">SwitchYard</span>
        <span className="block text-[11px] text-ink-3">Router panel</span>
      </span>
    </Link>
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
