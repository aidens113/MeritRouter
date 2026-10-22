import Link from "next/link";
import type { ReactNode } from "react";
import { Card, CardHeader } from "./ui";

/**
 * The "Related" panel on every entity page (panel-v2 D6): what the entity connects to, each item a
 * link to its own page. Groups with nothing in them are left out; a long group shows its first
 * items and a link to the full list.
 */

export interface RelatedItem {
  key: string;
  node: ReactNode;
  /** Small text after the item (a state, a count). */
  meta?: ReactNode;
}

export interface RelatedGroup {
  label: string;
  items: RelatedItem[];
  /** Where the full list is, when only the first items are shown. */
  more?: { href: string; label: string };
  /** Shown when the group is empty (otherwise an empty group is left out). */
  empty?: string;
}

const SHOWN = 6;

export function RelatedPanel({ groups, title = "Related", description }: { groups: RelatedGroup[]; title?: string; description?: ReactNode }) {
  const shown = groups.filter((g) => g.items.length || g.empty);
  if (!shown.length) return null;
  return (
    <Card>
      <CardHeader title={title} description={description} />
      <dl className="grid gap-x-6 gap-y-3 p-4 text-sm sm:grid-cols-2 xl:grid-cols-3">
        {shown.map((g) => (
          <div key={g.label} className="min-w-0">
            <dt className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-3">
              {g.label}
              {g.items.length > 1 ? <span className="ml-1 font-normal normal-case tracking-normal">({g.items.length})</span> : null}
            </dt>
            <dd>
              {g.items.length ? (
                <ul className="space-y-0.5">
                  {g.items.slice(0, SHOWN).map((i) => (
                    <li key={i.key} className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
                      <span className="min-w-0 break-all">{i.node}</span>
                      {i.meta ? <span className="text-[11px] text-ink-3">{i.meta}</span> : null}
                    </li>
                  ))}
                  {g.items.length > SHOWN ? (
                    <li className="text-xs text-ink-3">
                      {g.more ? (
                        <Link href={g.more.href} className="text-accent-ink hover:underline">
                          {g.more.label}
                        </Link>
                      ) : (
                        <details className="mt-1">
                          <summary className="cursor-pointer text-accent-ink">Show {g.items.length - SHOWN} more</summary>
                          <ul className="mt-1 space-y-0.5">
                            {g.items.slice(SHOWN).map(i => <li key={i.key} className="break-all">{i.node}{i.meta ? <span className="ml-1.5 text-ink-3">{i.meta}</span> : null}</li>)}
                          </ul>
                        </details>
                      )}
                    </li>
                  ) : g.more ? (
                    <li className="text-xs">
                      <Link href={g.more.href} className="text-accent-ink hover:underline">
                        {g.more.label}
                      </Link>
                    </li>
                  ) : null}
                </ul>
              ) : (
                <span className="text-xs text-ink-3">{g.empty}</span>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}
