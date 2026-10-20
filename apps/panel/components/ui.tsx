import type { ReactNode } from "react";
import type { GlossaryKey } from "@/lib/glossary";
import { HelpTip } from "./client/help-tip";

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

export type Tone = "neutral" | "accent" | "good" | "warn" | "serious" | "bad";

const TONES: Record<Tone, string> = {
  neutral: "bg-surface-3 text-ink-2",
  accent: "bg-accent-soft text-accent-ink",
  good: "bg-good-soft text-good-ink",
  warn: "bg-warn-soft text-warn-ink",
  serious: "bg-serious-soft text-serious-ink",
  bad: "bg-bad-soft text-bad-ink",
};

export function Badge({ tone = "neutral", icon, children, title, className }: { tone?: Tone; icon?: ReactNode; children: ReactNode; title?: string; className?: string }) {
  return (
    <span title={title} className={cx("inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium", TONES[tone], className)}>
      {icon}
      {children}
    </span>
  );
}

export function Card({ children, className, id }: { children: ReactNode; className?: string; id?: string }) {
  return (
    <section id={id} className={cx("min-w-0 rounded-xl border border-line bg-surface shadow-[0_1px_2px_rgba(0,0,0,0.03)]", className)}>
      {children}
    </section>
  );
}

export function CardHeader({ title, help, description, actions }: { title: ReactNode; help?: GlossaryKey; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3">
      <div className="min-w-0">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold text-ink">
          {title}
          {help ? <HelpTip term={help} /> : null}
        </h2>
        {description ? <p className="mt-0.5 text-xs text-ink-3">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight text-ink">{title}</h1>
        {description ? <p className="mt-1 max-w-3xl text-sm text-ink-2">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

// The help popover keeps itself inside the viewport, which needs a little client code.
export { HelpTip };

export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-10 text-center">
      {icon ? <div className="text-ink-3">{icon}</div> : null}
      <p className="text-sm font-medium text-ink">{title}</p>
      {children ? <div className="max-w-md text-sm text-ink-3">{children}</div> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

export function Stat({ label, value, sub, help, tone }: { label: string; value: ReactNode; sub?: ReactNode; help?: GlossaryKey; tone?: Tone }) {
  return (
    <div className="rounded-xl border border-line bg-surface px-4 py-3">
      <div className="flex items-center gap-1 text-xs font-medium text-ink-3">
        {label}
        {help ? <HelpTip term={help} /> : null}
      </div>
      <div className={cx("mt-1 text-2xl font-semibold tracking-tight", tone === "bad" ? "text-bad-ink" : tone === "good" ? "text-good-ink" : tone === "warn" ? "text-warn-ink" : "text-ink")}>{value}</div>
      {sub ? <div className="mt-0.5 text-xs text-ink-3">{sub}</div> : null}
    </div>
  );
}

export const btn = {
  base: "inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50",
  primary: "bg-accent text-white hover:brightness-110",
  secondary: "border border-line-strong bg-surface text-ink hover:bg-surface-2",
  ghost: "text-ink-2 hover:bg-surface-2 hover:text-ink",
  danger: "border border-bad/40 bg-bad-soft text-bad-ink hover:bg-bad/20",
  sm: "px-2 py-1 text-xs",
};

export function buttonClass(variant: "primary" | "secondary" | "ghost" | "danger" = "secondary", small = false): string {
  return cx(btn.base, btn[variant], small && btn.sm);
}

export function KeyValue({ items }: { items: Array<[ReactNode, ReactNode]> }) {
  return (
    <dl className="grid grid-cols-[minmax(8rem,auto)_1fr] gap-x-4 gap-y-2 text-sm">
      {items.map(([k, v], i) => (
        <div key={i} className="contents">
          <dt className="text-ink-3">{k}</dt>
          <dd className="min-w-0 break-words text-ink">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <code className={cx("rounded bg-surface-2 px-1 py-0.5 font-mono text-[0.8em] text-ink-2", className)}>{children}</code>;
}

export function Callout({ tone = "accent", icon, title, children }: { tone?: Tone; icon?: ReactNode; title?: ReactNode; children?: ReactNode }) {
  const border: Record<Tone, string> = {
    neutral: "border-line",
    accent: "border-accent/30",
    good: "border-good/30",
    warn: "border-warn/40",
    serious: "border-serious/40",
    bad: "border-bad/40",
  };
  return (
    <div className={cx("flex gap-3 rounded-xl border px-4 py-3 text-sm", border[tone], TONES[tone].split(" ")[0])}>
      {icon ? <div className={cx("mt-0.5 shrink-0", TONES[tone].split(" ")[1])}>{icon}</div> : null}
      <div className="min-w-0 text-ink">
        {title ? <div className="font-medium">{title}</div> : null}
        {children ? <div className={cx("text-ink-2", title ? "mt-0.5" : "")}>{children}</div> : null}
      </div>
    </div>
  );
}
