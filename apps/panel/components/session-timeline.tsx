import Link from "next/link";
import type { ReactNode } from "react";
import { Bot, CircleAlert, CornerDownRight, Cpu, Flag, FolderGit2, MessageSquare, Play, RotateCcw, Send, StickyNote, User, Wrench } from "lucide-react";
import type { SessionEvent } from "switchyard-router";
import { Badge, cx, Mono, type Tone } from "./ui";
import { SessionStatusBadge } from "./sessions-table";
import { purposeLabel } from "./requests-table";
import { duration, humanize, modelHref, num, shortDateTime } from "@/lib/format";

type Ev<T extends SessionEvent["type"]> = Extract<SessionEvent, { type: T }>;
type Outcome = Ev<"tool_outcome">;

const TYPE_LABEL: Record<SessionEvent["type"], string> = {
  started: "Started",
  message: "Message",
  model_request: "Model request",
  model_response: "Model response",
  model_error: "Model error",
  tool_intent: "Tool call",
  tool_outcome: "Tool result",
  note: "Note",
  workspace: "Workspace",
  ended: "Ended",
  resumed: "Resumed",
};

const SIDE_EFFECT: Record<string, { label: string; tone: Tone; title: string }> = {
  none: { label: "no side effects", tone: "neutral", title: "Changes nothing outside the session" },
  read: { label: "reads", tone: "neutral", title: "Only reads files or data; safe to repeat" },
  edit: { label: "edits files", tone: "warn", title: "Changes files in the session's worktree" },
  command: { label: "runs a command", tone: "warn", title: "Runs a command or check" },
  delegate: { label: "delegates", tone: "accent", title: "Starts other tasks (idempotent by label)" },
  brain: { label: "writes the brain", tone: "accent", title: "Commits to the shared brain" },
  external: { label: "external", tone: "serious", title: "Acts outside SwitchYard; the effect cannot be checked on resume" },
};

export interface TimelineProps {
  events: SessionEvent[];
  /** Session start, for the "+time" offsets. */
  startedAt: number;
  running: boolean;
  /** Outcomes found after this page for intents on this page, by intent seq. */
  laterOutcomes: Map<number, Outcome>;
  /** Link to the page that starts at a given seq. */
  pageHref: (seq: number) => string;
}

/** A page of a session's event log, in order. Tool intents show their outcome inline. */
export function SessionTimeline({ events, startedAt, running, laterOutcomes, pageHref }: TimelineProps) {
  const onPage = new Set(events.map((e) => e.seq));
  const outcomes = new Map<number, Outcome>(laterOutcomes);
  for (const e of events) if (e.type === "tool_outcome") outcomes.set(e.data.intentSeq, e);
  const intents = new Map<number, Ev<"tool_intent">>();
  for (const e of events) if (e.type === "tool_intent") intents.set(e.seq, e);

  return (
    <ol className="relative space-y-3 pl-6">
      <span className="absolute bottom-2 left-[0.4rem] top-2 w-px bg-line" aria-hidden />
      {events.map((e) => (
        <li key={e.seq} id={`e-${e.seq}`} className="relative scroll-mt-20">
          <span className={cx("absolute -left-[1.3rem] top-1.5 h-2.5 w-2.5 rounded-full ring-2 ring-surface", dotTone(e))} aria-hidden />
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <a href={`#e-${e.seq}`} className="tabular font-mono text-[11px] text-ink-3 hover:text-ink">
              #{e.seq}
            </a>
            <span className="inline-flex items-center gap-1 text-xs font-medium text-ink">
              {typeIcon(e)} {TYPE_LABEL[e.type] ?? e.type}
            </span>
            <span className="tabular text-[11px] text-ink-3" title={new Date(e.at).toISOString()}>
              {shortDateTime(e.at)} · +{duration(Math.max(0, e.at - startedAt))}
            </span>
          </div>
          <div className="mt-1 min-w-0">
            <EventBody e={e} outcomes={outcomes} intents={intents} onPage={onPage} running={running} pageHref={pageHref} />
          </div>
          <details className="group mt-1">
            <summary className="cursor-pointer list-none text-[11px] text-ink-3 hover:text-ink">
              <span className="group-open:hidden">Show raw event</span>
              <span className="hidden group-open:inline">Hide raw event</span>
            </summary>
            <Pre className="mt-1 max-h-96">{JSON.stringify(e, null, 2)}</Pre>
          </details>
        </li>
      ))}
    </ol>
  );
}

function EventBody({
  e,
  outcomes,
  intents,
  onPage,
  running,
  pageHref,
}: {
  e: SessionEvent;
  outcomes: Map<number, Outcome>;
  intents: Map<number, Ev<"tool_intent">>;
  onPage: Set<number>;
  running: boolean;
  pageHref: (seq: number) => string;
}) {
  switch (e.type) {
    case "started": {
      const d = e.data;
      return (
        <p className="text-sm text-ink-2">
          Opened as <strong className="font-medium text-ink">{d.role}</strong> <Mono>{d.agentLabel}</Mono>
          {d.profile ? ` for a ${d.profile} task` : ""}
          {d.tier ? ` at ${d.tier}` : ""}.
        </p>
      );
    }
    case "message":
      return <MessageView index={e.data.index} message={e.data.message} />;
    case "model_request": {
      const d = e.data;
      return (
        <p className="text-sm text-ink-2">
          {purposeLabel(d.purpose)} with {d.messageCount} message{d.messageCount === 1 ? "" : "s"}, up to {num(d.maxTokens)} output tokens
          {d.temperature !== null ? `, temperature ${d.temperature}` : ""}
          {d.responseFormat ? `, ${humanize(d.responseFormat)} output` : ""}.
          {d.tools.length ? (
            <span className="mt-1 flex flex-wrap items-center gap-1 text-xs text-ink-3">
              Tools offered:
              {d.tools.map((t) => (
                <Mono key={t}>{t}</Mono>
              ))}
              {d.toolChoice ? <span>(choice: {d.toolChoice})</span> : null}
            </span>
          ) : null}
        </p>
      );
    }
    case "model_response": {
      const d = e.data;
      const fellBack = d.attempts.length > 1;
      return (
        <div className="space-y-1.5 text-sm">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-2">
            <Link href={modelHref(d.endpointId)} className="font-medium text-accent-ink hover:underline">
              {d.endpointId}
            </Link>
            {d.servedModel ? <span className="text-ink-3">served {d.servedModel}</span> : null}
            <span className="tabular">
              {num(d.usage.inputTokens)} in · {num(d.usage.outputTokens)} out
            </span>
            {d.finishReason ? <Badge>{humanize(d.finishReason)}</Badge> : null}
            {fellBack ? <Badge tone="warn" title={d.attempts.map((a) => `${a.endpointId}: ${a.outcome}`).join("\n")}>after {d.attempts.length - 1} fallback{d.attempts.length > 2 ? "s" : ""}</Badge> : null}
            <span className="font-mono text-[11px] text-ink-3">{d.requestId}</span>
          </div>
          {d.content?.trim() ? <LongText text={d.content} /> : null}
          {d.toolCalls.length ? (
            <div className="flex flex-wrap items-center gap-1 text-xs text-ink-3">
              Asked to call:
              {d.toolCalls.map((c) => (
                <Mono key={c.id}>{c.function.name}</Mono>
              ))}
            </div>
          ) : null}
          {fellBack ? <Attempts attempts={d.attempts} /> : null}
        </div>
      );
    }
    case "model_error": {
      const d = e.data;
      return (
        <div className="space-y-1.5 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            {d.code ? <Badge tone="bad">{d.code}</Badge> : <Badge tone="bad">error</Badge>}
            {d.status !== null ? <span className="text-xs text-ink-3">HTTP {d.status}</span> : null}
          </div>
          <p className="break-words text-bad-ink">{d.message}</p>
          {d.attempts.length ? <Attempts attempts={d.attempts} /> : null}
        </div>
      );
    }
    case "tool_intent": {
      const d = e.data;
      const out = outcomes.get(e.seq);
      const se = SIDE_EFFECT[d.sideEffect] ?? { label: d.sideEffect, tone: "neutral" as Tone, title: d.sideEffect };
      return (
        <div className="rounded-lg border border-line">
          <div className="flex flex-wrap items-center gap-2 px-3 py-1.5 text-xs">
            <Wrench size={12} className="text-ink-3" aria-hidden />
            <span className="font-mono font-medium text-ink">{d.name}</span>
            <Badge tone={se.tone} title={se.title}>
              {se.label}
            </Badge>
            {d.idempotent ? <Badge title="Safe to run again on resume">idempotent</Badge> : null}
            <span className="min-w-0 flex-1 truncate font-mono text-ink-3">{summarizeArgs(d.args)}</span>
            {out ? (
              out.data.ok ? (
                <Badge tone="good">ok</Badge>
              ) : (
                <Badge tone="bad">error</Badge>
              )
            ) : running ? (
              <Badge tone="accent">no result yet</Badge>
            ) : (
              <Badge tone="serious">no outcome recorded</Badge>
            )}
          </div>
          <div className="grid gap-2 border-t border-line p-3 lg:grid-cols-2">
            <div className="min-w-0">
              <div className="mb-1 text-[11px] font-medium text-ink-3">Arguments</div>
              <Pre>{typeof d.args === "string" ? d.args : JSON.stringify(d.args, null, 2)}</Pre>
            </div>
            <div className="min-w-0">
              <div className="mb-1 flex flex-wrap items-baseline gap-x-2 text-[11px] font-medium text-ink-3">
                Result
                {out ? (
                  <a href={onPage.has(out.seq) ? `#e-${out.seq}` : `${pageHref(out.seq)}#e-${out.seq}`} className="font-normal hover:text-ink">
                    #{out.seq} · {duration(Math.max(0, out.at - e.at))} later
                  </a>
                ) : null}
                {out?.data.truncated ? <span className="font-normal text-warn-ink">truncated to 16 KB</span> : null}
              </div>
              {out ? (
                <Pre>{out.data.output || "(empty)"}</Pre>
              ) : (
                <p className="text-xs text-ink-3">
                  {running
                    ? "The tool is running, or its outcome is not written yet."
                    : "No outcome was written: the session stopped before this tool finished, so its effect is unknown."}
                </p>
              )}
            </div>
          </div>
        </div>
      );
    }
    case "tool_outcome": {
      const d = e.data;
      const paired = intents.has(d.intentSeq);
      return (
        <div className="space-y-1.5 text-xs">
          <div className="flex flex-wrap items-center gap-2 text-ink-2">
            <CornerDownRight size={12} className="text-ink-3" aria-hidden />
            Result of
            <a href={paired ? `#e-${d.intentSeq}` : `${pageHref(d.intentSeq)}#e-${d.intentSeq}`} className="font-mono text-accent-ink hover:underline">
              #{d.intentSeq} {d.name}
            </a>
            {d.ok ? <Badge tone="good">ok</Badge> : <Badge tone="bad">error</Badge>}
            {paired ? <span className="text-ink-3">shown with the call above</span> : null}
          </div>
          {paired ? null : <Pre>{d.output || "(empty)"}</Pre>}
        </div>
      );
    }
    case "note":
      return <p className="whitespace-pre-wrap text-sm text-ink-2">{e.data.text}</p>;
    case "workspace":
      return e.data.repos.length ? (
        <ul className="space-y-1 text-xs text-ink-2">
          {e.data.repos.map((r) => (
            <li key={r.alias} className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <span className="font-medium text-ink">{r.alias}</span>
              {r.branch ? <Mono>{r.branch}</Mono> : null}
              <span>base {r.baseCommit ? r.baseCommit.slice(0, 12) : "–"}</span>
              <span>head {r.head ? r.head.slice(0, 12) : "no commit yet"}</span>
              <span className="break-all font-mono text-[11px] text-ink-3">{r.worktree}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-ink-3">No repositories.</p>
      );
    case "ended":
      return (
        <p className="flex flex-wrap items-center gap-2 text-sm text-ink-2">
          <SessionStatusBadge status={e.data.status} /> {humanize(e.data.stopReason)}
        </p>
      );
    case "resumed":
      return <ResumedView data={e.data} />;
    default:
      return null;
  }
}

/** What a resume reconciled: the notice the model got, and each action with its result. */
function ResumedView({ data }: { data: Ev<"resumed">["data"] }) {
  const label = (a: Ev<"resumed">["data"]["actions"][number]): string =>
    a.kind === "rerun_tool"
      ? `Re-ran ${a.name} (${a.sideEffect === "delegate" ? "delegation, idempotent by label" : "idempotent command"})`
      : a.kind === "reconcile_edits"
        ? `Reconciled interrupted edits: ${a.policy === "commit" ? "committed as recovered" : "reset to the last commit"} (${a.repos.map((r) => r.alias).join(", ") || "no repositories"})`
        : `Reported the stored state of ${a.name}`;
  return (
    <div className="space-y-1.5 text-sm">
      <LongText text={data.summary} />
      {data.actions.length ? (
        <ul className="space-y-1 text-xs text-ink-2">
          {data.actions.map((a, i) => (
            <li key={i} className="space-y-0.5">
              <span className="font-medium text-ink">{label(a)}</span>
              {a.result ? <Pre className="max-h-40">{a.result}</Pre> : null}
            </li>
          ))}
        </ul>
      ) : null}
      <p className="text-[11px] text-ink-3">
        {num(data.resolvedIntentSeqs.length)} interrupted tool call(s) settled · {num(data.droppedRequestSeqs.length)} unanswered model request(s) dropped
      </p>
    </div>
  );
}

function MessageView({ index, message }: { index: number; message: Ev<"message">["data"]["message"] }) {
  const text = typeof message.content === "string" ? message.content : Array.isArray(message.content) ? message.content.map((p) => ("text" in p ? p.text : "[image]")).join("") : "";
  const who = message.role === "system" ? "System prompt" : message.role === "user" ? (index <= 1 ? "Brief" : "SwitchYard") : message.role === "assistant" ? "Assistant" : "Tool output";
  const calls = message.role === "assistant" ? (message.tool_calls ?? []) : [];
  const collapsed = message.role === "system" || message.role === "tool" || text.length > 600;
  return (
    <div className="space-y-1 text-sm">
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-ink-3">
        {message.role === "assistant" ? <Bot size={12} aria-hidden /> : message.role === "tool" ? <Wrench size={12} aria-hidden /> : <User size={12} aria-hidden />}
        <span className="font-medium text-ink-2">{who}</span>
        <span>transcript message {index}</span>
        {message.role === "tool" ? <span className="font-mono">{message.tool_call_id}</span> : null}
        {calls.length ? (
          <>
            <span>· calls</span>
            {calls.map((c) => (
              <Mono key={c.id}>{c.function.name}</Mono>
            ))}
          </>
        ) : null}
      </div>
      {text.trim() ? (
        collapsed ? (
          <details className="rounded-lg border border-line">
            <summary className="cursor-pointer truncate px-3 py-1.5 text-xs text-ink-2">{firstLine(text)}</summary>
            <Pre className="max-h-96 rounded-none border-t border-line bg-transparent p-3">{text}</Pre>
          </details>
        ) : (
          <p className="whitespace-pre-wrap break-words text-ink">{text}</p>
        )
      ) : null}
    </div>
  );
}

function LongText({ text }: { text: string }) {
  if (text.length <= 600) return <p className="whitespace-pre-wrap break-words text-ink">{text}</p>;
  return (
    <details className="rounded-lg border border-line">
      <summary className="cursor-pointer truncate px-3 py-1.5 text-xs text-ink-2">{firstLine(text)}</summary>
      <Pre className="max-h-96 rounded-none border-t border-line bg-transparent p-3">{text}</Pre>
    </details>
  );
}

function Attempts({ attempts }: { attempts: Array<{ endpointId: string; outcome: string }> }) {
  return (
    <ol className="space-y-0.5 text-xs">
      {attempts.map((a, i) => (
        <li key={i} className="flex flex-wrap items-center gap-2">
          <span className="tabular w-4 text-ink-3">{i + 1}.</span>
          <Link href={modelHref(a.endpointId)} className="text-ink hover:underline">
            {a.endpointId}
          </Link>
          <Badge tone={a.outcome === "succeeded" ? "good" : "bad"}>{humanize(a.outcome).slice(0, 80)}</Badge>
        </li>
      ))}
    </ol>
  );
}

function Pre({ children, className }: { children: ReactNode; className?: string }) {
  return <pre className={cx("max-h-72 overflow-auto whitespace-pre-wrap break-words rounded bg-surface-2 p-2 font-mono text-[11px] text-ink-2", className)}>{children}</pre>;
}

function firstLine(text: string): string {
  return (text.split("\n").find((l) => l.trim()) ?? "").trim().slice(0, 160) || "(empty)";
}

function summarizeArgs(args: unknown): string {
  if (args && typeof args === "object" && !Array.isArray(args)) {
    return Object.entries(args as Record<string, unknown>)
      .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
      .join(" · ")
      .replace(/\s+/g, " ")
      .slice(0, 160);
  }
  return (typeof args === "string" ? args : JSON.stringify(args) ?? "").slice(0, 160);
}

function typeIcon(e: SessionEvent): ReactNode {
  const p = { size: 12, "aria-hidden": true, className: "text-ink-3" } as const;
  switch (e.type) {
    case "started":
      return <Play {...p} />;
    case "message":
      return <MessageSquare {...p} />;
    case "model_request":
      return <Send {...p} />;
    case "model_response":
      return <Cpu {...p} />;
    case "model_error":
      return <CircleAlert {...p} />;
    case "tool_intent":
    case "tool_outcome":
      return <Wrench {...p} />;
    case "note":
      return <StickyNote {...p} />;
    case "workspace":
      return <FolderGit2 {...p} />;
    case "ended":
      return <Flag {...p} />;
    case "resumed":
      return <RotateCcw {...p} />;
    default:
      return null;
  }
}

function dotTone(e: SessionEvent): string {
  switch (e.type) {
    case "started":
      return "bg-good";
    case "ended":
      return e.data.status === "completed" ? "bg-good" : e.data.status === "failed" ? "bg-bad" : "bg-warn";
    case "model_error":
      return "bg-bad";
    case "tool_outcome":
      return e.data.ok ? "bg-ink-3" : "bg-bad";
    case "tool_intent":
    case "resumed":
      return "bg-warn";
    case "model_request":
    case "model_response":
      return "bg-accent";
    default:
      return "bg-ink-3";
  }
}
