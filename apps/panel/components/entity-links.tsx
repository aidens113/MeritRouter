import Link from "next/link";
import type { ReactNode } from "react";
import { agentHref, commitHref, jobHref, requestHref, taskHref } from "@/lib/links";
import { modelHref, shortId } from "@/lib/format";
import { cx } from "./ui";

/**
 * Links for entities named anywhere in the panel (panel-v2 D6: every place an entity is named is a
 * link to its page). Each falls back to plain text where the page does not exist under `base`.
 */

const LINK = "text-accent-ink hover:underline";

/** An agent (`<role>:<label>`): role in small text, then the label. */
export function AgentLink({ base, agent, className, children }: { base: string; agent: string; className?: string; children?: ReactNode }) {
  const i = agent.indexOf(":");
  const body = children ?? (
    <>
      <span className="text-ink-3">{i > 0 ? agent.slice(0, i + 1) : ""}</span>
      {i > 0 ? agent.slice(i + 1) : agent}
    </>
  );
  const href = agentHref(base, agent);
  return href ? (
    <Link href={href} className={cx("font-mono text-xs", LINK, className)} title={`Agent ${agent}`}>
      {body}
    </Link>
  ) : (
    <span className={cx("font-mono text-xs text-ink-2", className)}>{body}</span>
  );
}

export function TaskLink({ base, id, label, job = false, className }: { base: string; id: string; label?: string | null; job?: boolean; className?: string }) {
  return (
    <Link href={job ? jobHref(base, id) : taskHref(base, id)} className={cx(label ? "" : "font-mono text-xs", LINK, className)} title={id}>
      {label ?? shortId(id, 22)}
    </Link>
  );
}

export function RequestLink({ base, id, className, children }: { base: string; id: string; className?: string; children?: ReactNode }) {
  return (
    <Link href={requestHref(base, id)} className={cx("font-mono text-xs", LINK, className)} title={`Model request ${id}`}>
      {children ?? shortId(id, 18)}
    </Link>
  );
}

export function CommitLink({ base, repository, sha, className, children }: { base: string; repository: string; sha: string; className?: string; children?: ReactNode }) {
  const href = commitHref(base, repository, sha);
  const body = children ?? sha.slice(0, 10);
  return href ? (
    <Link href={href} className={cx("font-mono text-xs", LINK, className)} title={`Commit ${sha} in ${repository}`}>
      {body}
    </Link>
  ) : (
    <span className={cx("font-mono text-xs text-ink-2", className)}>{body}</span>
  );
}

export function ModelLink({ id, name, className }: { id: string; name?: string | null; className?: string }) {
  return (
    <Link href={modelHref(id)} className={cx(LINK, className)} title={id}>
      {name ?? id}
    </Link>
  );
}
