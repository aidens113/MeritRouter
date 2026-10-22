import Link from "next/link";
import { ALL } from "@/lib/links";
import { cx } from "./ui";

/**
 * Pages that share one sidebar entry (panel-v2 D3: fewer top-level tabs) move between each other
 * with this strip at the top of the page. Each keeps its own URL.
 */

type Entry = { id: string; href: string; label: string };

const GROUPS = {
  jobs: (b: string): Entry[] => [
    { id: "jobs", href: `${b}/jobs`, label: "Jobs" },
    { id: "teams", href: `${b}/teams`, label: "Teams" },
  ],
  work: (b: string): Entry[] => [
    { id: "tasks", href: `${b}/tasks`, label: "Tasks" },
    { id: "agents", href: `${b}/agents`, label: "Agents" },
    { id: "sessions", href: `${b}/sessions`, label: "Sessions" },
    { id: "requests", href: `${b}/requests`, label: "Requests" },
  ],
  dashboard: (): Entry[] => [
    { id: "dashboard", href: ALL, label: "Dashboard" },
    { id: "requests", href: `${ALL}/requests`, label: "Requests" },
  ],
  models: (): Entry[] => [
    { id: "models", href: `${ALL}/models`, label: "Models" },
    { id: "routing", href: `${ALL}/routing`, label: "Routing" },
  ],
  quality: (): Entry[] => [
    { id: "qualification", href: `${ALL}/qualification`, label: "Qualification" },
    { id: "calibration", href: `${ALL}/calibration`, label: "Calibration" },
  ],
} as const;

export type GroupName = keyof typeof GROUPS;

export function GroupTabs({ group, active, base = "" }: { group: GroupName; active: string; base?: string }) {
  const entries = GROUPS[group](base);
  return (
    <nav aria-label="Pages in this section" className="mb-4 overflow-x-auto [scrollbar-width:thin]">
      <ul className="inline-flex min-w-max rounded-lg border border-line bg-surface-2 p-0.5">
        {entries.map((e) => (
          <li key={e.id}>
            <Link
              href={e.href}
              aria-current={e.id === active ? "page" : undefined}
              className={cx("block whitespace-nowrap rounded-md px-3 py-1 text-sm", e.id === active ? "bg-surface font-medium text-ink shadow-sm" : "text-ink-2 hover:text-ink")}
            >
              {e.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
