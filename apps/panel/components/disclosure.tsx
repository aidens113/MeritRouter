import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { cx } from "./ui";

/**
 * The one disclosure (panel-v2 D4): detail that is there when wanted and out of the way otherwise
 * (provenance, raw records, long lists). A native `<details>`: it works without script, and a live
 * refresh keeps it open or closed as the person left it.
 */
export function Disclosure({
  summary,
  meta,
  children,
  defaultOpen = false,
  id,
  className,
  bodyClassName,
}: {
  summary: ReactNode;
  /** Right-aligned note in the summary line (a count, a size). */
  meta?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  id?: string;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <details id={id} open={defaultOpen || undefined} className={cx("group min-w-0 rounded-lg border border-line bg-surface", className)}>
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-lg px-3 py-2 text-sm text-ink hover:bg-surface-2 [&::-webkit-details-marker]:hidden">
        <ChevronRight size={14} className="shrink-0 text-ink-3 transition-transform group-open:rotate-90" aria-hidden />
        <span className="min-w-0 flex-1 font-medium">{summary}</span>
        {meta ? <span className="shrink-0 text-xs text-ink-3">{meta}</span> : null}
      </summary>
      <div className={cx("border-t border-line p-3", bodyClassName)}>{children}</div>
    </details>
  );
}
