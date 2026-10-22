import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { LiveStatus } from "./client/live";

/**
 * The one page-header pattern (panel-v2 D4): an optional way back, the title, a one-line purpose,
 * the live state (when the page shows data that changes; `live` lists the topics it follows),
 * the page's actions, and an optional row of status badges.
 */
export function PageHeader({
  title,
  description,
  meta,
  actions,
  live,
  back,
}: {
  title: ReactNode;
  /** One line: what the page is for. Longer explanations go in a help tip or a disclosure. */
  description?: ReactNode;
  /** Status badges and identifiers under the title. */
  meta?: ReactNode;
  actions?: ReactNode;
  /** Live topics this page shows (see components/client/live.tsx); omitted for pages that do not change on their own. */
  live?: string[];
  back?: { href: string; label: string };
}) {
  return (
    <header className="mb-5 space-y-2">
      {back ? (
        <Link href={back.href} className="inline-flex items-center gap-1 text-sm text-ink-3 hover:text-ink">
          <ArrowLeft size={14} aria-hidden /> {back.label}
        </Link>
      ) : null}
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 basis-72">
          <h1 className="break-words text-xl font-semibold tracking-tight text-ink">{title}</h1>
          {description ? <div className="mt-1 max-w-3xl text-sm text-ink-2">{description}</div> : null}
        </div>
        {live || actions ? (
          <div className="flex flex-wrap items-center gap-2">
            {live ? <LiveStatus topics={live} /> : null}
            {actions}
          </div>
        ) : null}
      </div>
      {meta ? <div className="flex flex-wrap items-center gap-2">{meta}</div> : null}
    </header>
  );
}
