"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Check, Copy, MessageCircleQuestion, Play, Send } from "lucide-react";
import { ActionStatus, useAction } from "./actions";
import { LinesEditor } from "./lines-editor";
import { buttonClass, cx, HelpTip } from "../ui";
import { jobHref, projectBase } from "@/lib/links";

export interface RepoOption {
  alias: string;
  writable: boolean;
  path: string;
}

/** Form for starting a standalone job in `project`. The job is queued; a worker runs it. */
export function NewJobForm({ project, repos, enabled, labs = [] }: { project: string; repos: RepoOption[]; enabled: boolean; labs?: Array<{ name: string; state: string }> }) {
  const router = useRouter();
  const [lab, setLab] = useState("");
  const [goal, setGoal] = useState("");
  const [label, setLabel] = useState("");
  const [selected, setSelected] = useState<string[]>(repos.length === 1 ? [repos[0]!.alias] : []);
  const [criteria, setCriteria] = useState<string[]>([""]);
  const [checks, setChecks] = useState<string[]>([]);
  const [maxRequests, setMaxRequests] = useState("");
  const [maxPaid, setMaxPaid] = useState("");
  const { run, busy, error, errors, message, setError } = useAction();
  const disabled = !enabled || busy;

  const submit = async () => {
    const req = maxRequests.trim() ? Number(maxRequests) : undefined;
    const paid = maxPaid.trim() ? Number(maxPaid) : undefined;
    if (req !== undefined && (!Number.isInteger(req) || req <= 0)) return setError("Request budget must be a whole number above 0, or empty.");
    if (paid !== undefined && (!Number.isFinite(paid) || paid < 0)) return setError("Paid budget must be $0 or more, or empty.");
    const r = await run(
      "/api/jobs",
      "POST",
      {
        project,
        goal,
        repositories: selected,
        ...(lab ? { lab } : {}),
        acceptanceCriteria: criteria.map((c) => c.trim()).filter(Boolean),
        checks: checks.map((c) => c.trim()).filter(Boolean),
        ...(label.trim() ? { label: label.trim() } : {}),
        ...(req !== undefined ? { maxModelRequests: req } : {}),
        ...(paid !== undefined ? { maxPaidUsd: paid } : {}),
      },
      { success: "Job queued. A running worker will pick it up.", refresh: false },
    );
    const id = (r.job as { taskId?: string } | undefined)?.taskId;
    if (r.ok && id) router.push(jobHref(projectBase(project), id));
  };

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <fieldset disabled={!enabled} className="grid gap-4 lg:grid-cols-2">
        <label className="block text-sm font-medium text-ink lg:col-span-2">
          Goal
          <textarea value={goal} onChange={(e) => setGoal(e.target.value)} rows={3} required className="field mt-1 font-normal" placeholder="e.g. Add input validation to handle() so missing parameters return a 400, with tests." />
          <span className="mt-1 block text-xs font-normal text-ink-3">What the supervisor should achieve. Be specific about scope; it plans and delegates from this.</span>
        </label>
        <div>
          <div className="text-sm font-medium text-ink">Repositories</div>
          {repos.length ? (
            <div className="mt-1 space-y-1">
              {repos.map((r) => (
                <label key={r.alias} className="flex items-center gap-2 text-sm text-ink-2">
                  <input type="checkbox" checked={selected.includes(r.alias)} onChange={(e) => setSelected((s) => (e.target.checked ? [...s, r.alias] : s.filter((x) => x !== r.alias)))} />
                  <span className="font-mono text-[13px] text-ink">{r.alias}</span>
                  <span className="truncate text-xs text-ink-3" title={r.path}>
                    {r.writable ? "writable: gets a job branch" : "read only"}
                  </span>
                </label>
              ))}
            </div>
          ) : (
            <p className="mt-1 text-xs text-ink-3">
              This project has no repositories. Add one in its <Link href={`${projectBase(project)}/settings`} className="text-accent-ink hover:underline">project settings</Link>.
            </p>
          )}
          <span className="mt-1 block text-xs text-ink-3">Writable repositories get their own job branch; your checkout is never touched.</span>
        </div>
        <label className="block text-sm font-medium text-ink">Lab (optional)<select className="field mt-1" value={lab} onChange={e => setLab(e.target.value)}><option value="">Standalone job branch</option>{labs.map(l => <option key={l.name} value={l.name}>{l.name} ({l.state})</option>)}</select><span className="mt-1 block text-xs font-normal text-ink-3">A lab job integrates into that lab. Services are managed separately from the job.</span></label>
        <label className="block text-sm font-medium text-ink">
          Label (optional)
          <input value={label} onChange={(e) => setLabel(e.target.value.toLowerCase())} pattern="[a-z0-9][a-z0-9-]{0,40}" className="field mt-1 font-mono text-[13px] font-normal" placeholder="e.g. input-validation" />
          <span className="mt-1 block text-xs font-normal text-ink-3">Short name (lowercase, digits, dashes) used in commit trailers and the working document.</span>
        </label>
        <div>
          <div className="text-sm font-medium text-ink">Acceptance criteria</div>
          <div className="mt-1">
            <LinesEditor value={criteria} onChange={setCriteria} placeholder="e.g. GET /sum?a=2 returns 400" addLabel="Add criterion" />
          </div>
          <span className="mt-1 block text-xs text-ink-3">How you will judge the result. Leave empty to accept the supervisor&apos;s own verified finish.</span>
        </div>
        <div>
          <div className="text-sm font-medium text-ink">Checks</div>
          <div className="mt-1">
            <LinesEditor value={checks} onChange={setChecks} placeholder="e.g. pnpm test" addLabel="Add check" mono />
          </div>
          <span className="mt-1 block text-xs text-ink-3">Commands run on the job branch at the end. Only passing checks make the job &ldquo;met&rdquo;.</span>
        </div>
        <label className="block text-sm font-medium text-ink">
          Request budget (optional)
          <input value={maxRequests} onChange={(e) => setMaxRequests(e.target.value)} inputMode="numeric" className="field tabular mt-1 font-normal" placeholder="task type default" />
          <span className="mt-1 block text-xs font-normal text-ink-3">Most model requests the supervisor itself may use (workers have their own budgets).</span>
        </label>
        <label className="block text-sm font-medium text-ink">
          Paid budget (optional, USD)
          <input value={maxPaid} onChange={(e) => setMaxPaid(e.target.value)} inputMode="decimal" className="field tabular mt-1 font-normal" placeholder="no job-level cap" />
          <span className="mt-1 block text-xs font-normal text-ink-3">Hard cap on paid-model spend for this job. Global paid budgets still apply.</span>
        </label>
      </fieldset>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" className={buttonClass("primary")} disabled={disabled || !goal.trim() || selected.length === 0}>
          <Play size={14} aria-hidden /> Start job
        </button>
        <span className="inline-flex items-center gap-1 text-xs text-ink-3">
          Jobs are queued; a worker runs them. <HelpTip term="worker" />
        </span>
        <ActionStatus error={error} message={message} errors={errors} />
      </div>
    </form>
  );
}

export interface QuestionView {
  id: number;
  question: string;
  options: string[] | null;
  answer: string | null;
  askedAt: number;
  answeredAt: number | null;
}

/** One pending question: options as buttons, or a free-text answer. */
export function QuestionAnswer({ q, project }: { q: QuestionView; project: string }) {
  const [text, setText] = useState("");
  const { run, busy, error, message } = useAction();
  const answer = (a: string) => run("/api/jobs/questions", "POST", { project, id: q.id, answer: a }, { success: "Answer sent. The supervisor continues within a second if it is running." });
  return (
    <div className="space-y-2">
      <p className="flex items-start gap-2 text-sm text-ink">
        <MessageCircleQuestion size={16} className="mt-0.5 shrink-0 text-accent-ink" aria-hidden />
        <span className="whitespace-pre-wrap">{q.question}</span>
      </p>
      {q.options?.length ? (
        <div className="flex flex-wrap gap-2 pl-6">
          {q.options.map((o) => (
            <button key={o} type="button" className={buttonClass("secondary", true)} disabled={busy} onClick={() => void answer(o)}>
              <Check size={13} aria-hidden /> {o}
            </button>
          ))}
        </div>
      ) : null}
      <form
        className="flex flex-wrap items-center gap-2 pl-6"
        onSubmit={async (e) => {
          e.preventDefault();
          const r = await answer(text);
          if (r.ok) setText("");
        }}
      >
        <input value={text} onChange={(e) => setText(e.target.value)} className="field max-w-xl flex-1" placeholder={q.options?.length ? "…or write a different answer" : "Your answer"} aria-label="Answer" />
        <button type="submit" className={buttonClass("primary", true)} disabled={busy || !text.trim()}>
          <Send size={13} aria-hidden /> Answer
        </button>
      </form>
      <div className="pl-6">
        <ActionStatus error={error} message={message} />
      </div>
    </div>
  );
}

/** Copy a command to the clipboard, with a fallback selection when the clipboard is blocked. */
export function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState<"yes" | "no" | null>(null);
  return (
    <div className="flex min-w-0 items-center gap-2">
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-lg bg-surface-2 px-3 py-2 font-mono text-xs text-ink">{command}</code>
      <button
        type="button"
        className={cx(buttonClass("secondary", true), "shrink-0")}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(command);
            setCopied("yes");
          } catch {
            setCopied("no");
          }
          setTimeout(() => setCopied(null), 2000);
        }}
        aria-label={`Copy ${command}`}
      >
        {copied === "yes" ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
        {copied === "yes" ? "Copied" : copied === "no" ? "Select and copy" : "Copy"}
      </button>
    </div>
  );
}
