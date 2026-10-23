import Link from "next/link";
import type { ReactNode } from "react";
import { cx } from "./ui";
import { TabAnchors } from "./client/tab-anchors";

/**
 * The one tab strip (panel-v2 D4). Tabs are links to `?tab=<id>` (the first tab is the bare URL),
 * so a tab can be bookmarked, opened in a new window, and is rendered on the server: a page reads
 * only the open tab's data. `anchors` maps old in-page anchors (`#plan`) to the tab that holds
 * them, so links from before the tabs still land on the right section.
 */

export interface TabItem {
  id: string;
  label: ReactNode;
  /** A count or short note after the label. */
  count?: number | string | null;
  /** Draw attention to the tab (something in it needs a decision). */
  tone?: "warn" | "bad";
}

/** The open tab from search params: a known id, else the first tab. */
export function pickTab(sp: Record<string, string | string[] | undefined>, ids: readonly string[], param = "tab"): string {
  const raw = sp[param];
  const v = typeof raw === "string" ? raw : "";
  return ids.includes(v) ? v : (ids[0] ?? "");
}

/** The URL of tab `id` on `path`, keeping `keep` query values; the first tab has no `tab` parameter. */
export function tabHref(path: string, id: string, first: string, keep: Record<string, string | undefined> = {}, param = "tab"): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(keep)) if (v) q.set(k, v);
  if (id !== first) q.set(param, id);
  const s = q.toString();
  return s ? `${path}?${s}` : path;
}

export function Tabs({
  items,
  active,
  path,
  label,
  keep,
  anchors,
  param = "tab",
  className,
}: {
  items: TabItem[];
  active: string;
  /** The page's path (tabs link to it with `?tab=`). */
  path: string;
  /** What the tabs choose between, for screen readers ("Job sections"). */
  label: string;
  /** Query values every tab link keeps (filters, the selected document). */
  keep?: Record<string, string | undefined>;
  anchors?: Record<string, string>;
  param?: string;
  className?: string;
}) {
  const first = items[0]?.id ?? "";
  return (
    <>
      <nav aria-label={label} className={cx("-mx-4 mb-5 overflow-x-auto overflow-y-hidden border-b border-line px-4 [scrollbar-width:thin] sm:mx-0 sm:px-0", className)}>
        <ul className="flex min-w-max gap-1">
          {items.map((t) => {
            const on = t.id === active;
            return (
              <li key={t.id}>
                <Link
                  href={tabHref(path, t.id, first, keep, param)}
                  scroll={false}
                  aria-current={on ? "page" : undefined}
                  data-tab={t.id}
                  className={cx(
                    "-mb-px inline-flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-sm transition-colors",
                    on ? "border-accent font-medium text-accent-ink" : "border-transparent text-ink-2 hover:border-line-strong hover:text-ink",
                  )}
                >
                  {t.label}
                  {t.count !== undefined && t.count !== null && t.count !== "" ? (
                    <span
                      className={cx(
                        "tabular rounded-full px-1.5 text-[11px] font-medium",
                        t.tone === "warn" ? "bg-warn-soft text-warn-ink" : t.tone === "bad" ? "bg-bad-soft text-bad-ink" : on ? "bg-accent-soft text-accent-ink" : "bg-surface-3 text-ink-3",
                      )}
                    >
                      {t.count}
                    </span>
                  ) : t.tone ? (
                    <span className={cx("h-1.5 w-1.5 rounded-full", t.tone === "warn" ? "bg-warn" : "bg-bad")} aria-label="needs attention" />
                  ) : null}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      {anchors ? <TabAnchors anchors={anchors} active={active} first={first} param={param} /> : null}
    </>
  );
}
