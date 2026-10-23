import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowRight, FlaskConical, RefreshCcw, ShieldAlert, ShieldCheck, TrendingUp } from "lucide-react";
import type { insights } from "switchyard-router";
import { Badge, cx, HelpTip, Mono, type Tone } from "./ui";
import { ArtifactViewer } from "./client/artifact-viewer";
import { dateTime, humanize, modelHref, shortId } from "@/lib/format";
import { sessionHref } from "@/lib/links";

type Trail = insights.TaskVerificationTrail;
type Review = insights.ReviewView;
type Budget = { classification: number; execution: number; review: number; repair: number; unallocated?: number | null; total: number };

const VERDICT_TONE: Record<string, Tone> = { pass: "good", fail: "bad", inconclusive: "serious" };
const ACTION_LABEL: Record<string, string> = {
  accept: "accept",
  repair: "repair",
  run_targeted_check: "run a targeted check",
  needs_supervisor: "send to the supervisor",
};

/** Requests charged to the task by purpose, against the contract's allocation for each. */
export function RequestsByPurpose({ used, budget }: { used: Trail["requestsByPurpose"]; budget: Budget | null }) {
  const rows: Array<{ purpose: string; label: string; used: number; allocated: number | null }> = [
    { purpose: "classification", label: "Classification", used: used.classification, allocated: budget?.classification ?? null },
    { purpose: "execution", label: "Execution", used: used.execution, allocated: budget?.execution ?? null },
    { purpose: "verification", label: "Verification (review)", used: used.verification, allocated: budget?.review ?? null },
    { purpose: "repair", label: "Repair", used: used.repair, allocated: budget?.repair ?? null },
  ];
  const total = rows.reduce((s, r) => s + r.used, 0);
  return (
    <table className="data-table tabular">
      <thead>
        <tr>
          <th>Purpose</th>
          <th className="text-right">Used</th>
          <th className="text-right">{budget ? "Allocated" : ""}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.purpose}>
            <td className="text-ink-2">{r.label}</td>
            <td className={cx("text-right font-medium", r.allocated !== null && r.used > r.allocated ? "text-serious-ink" : r.used ? "text-ink" : "text-ink-3")}>{r.used}</td>
            <td className="text-right text-ink-3">{r.allocated ?? ""}</td>
          </tr>
        ))}
        <tr>
          <td className="font-semibold text-ink">Total</td>
          <td className="text-right font-semibold text-ink">{total}</td>
          <td className="text-right text-ink-3">{budget ? `${budget.total}${budget.unallocated === null ? " (uncapped)" : budget.unallocated ? ` (${budget.unallocated} unallocated)` : ""}` : ""}</td>
        </tr>
      </tbody>
    </table>
  );
}

type Step =
  | { kind: "review"; at: number | null; order: number; review: Review }
  | { kind: "retry"; at: number; order: number; retry: insights.RetryView }
  | { kind: "targeted"; at: number; order: number; check: insights.TargetedCheckView }
  | { kind: "raised"; at: number; order: number; raised: insights.RaisedLevelView };

/**
 * What verification did after the run, in order: levels raised on the result, each independent
 * review (reviewer, qualification, verdict, per-criterion outcomes, findings), targeted checks
 * a reviewer asked for, and the repair or escalation with the run that carried it out.
 */
export function VerificationTrail({ trail, criteria, names, base }: { trail: Trail; criteria: Map<string, string>; names: Map<string, string>; base: string }) {
  const steps: Step[] = [
    ...trail.raised.map((raised, i): Step => ({ kind: "raised", at: raised.at, order: i, raised })),
    ...trail.reviews.map((review, i): Step => ({ kind: "review", at: review.at, order: i, review })),
    ...trail.targetedChecks.map((check, i): Step => ({ kind: "targeted", at: check.at, order: i, check })),
    ...trail.retries.map((retry, i): Step => ({ kind: "retry", at: retry.at, order: i, retry })),
  ];
  // Events without a kept timestamp keep their own order, after the timed ones.
  steps.sort((a, b) => (a.at ?? Number.MAX_SAFE_INTEGER) - (b.at ?? Number.MAX_SAFE_INTEGER) || a.order - b.order);
  if (!steps.length) return null;
  return (
    <ol className="space-y-3">
      {steps.map((s) => (
        <li key={`${s.kind}${s.order}`}>
          {s.kind === "review" ? (
            <ReviewCard r={s.review} criteria={criteria} names={names} base={base} />
          ) : s.kind === "retry" ? (
            <RetryRow r={s.retry} base={base} />
          ) : s.kind === "targeted" ? (
            <TargetedRow t={s.check} />
          ) : (
            <RaisedRow r={s.raised} />
          )}
        </li>
      ))}
    </ol>
  );
}

function StepRow({ icon, title, at, children, tone = "neutral" }: { icon: ReactNode; title: ReactNode; at: number | null; children?: ReactNode; tone?: "neutral" | "warn" }) {
  return (
    <div className={cx("rounded-lg border px-3 py-2 text-xs", tone === "warn" ? "border-warn/40 bg-warn-soft/40" : "border-line")}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-ink-3">{icon}</span>
        <span className="font-medium text-ink">{title}</span>
        {at ? <span className="tabular text-ink-3">{dateTime(at)}</span> : null}
      </div>
      {children ? <div className="mt-1 space-y-1 text-ink-2">{children}</div> : null}
    </div>
  );
}

function RaisedRow({ r }: { r: insights.RaisedLevelView }) {
  const a = r.reserveAdjustment;
  return (
    <StepRow icon={<TrendingUp size={14} aria-hidden />} title={`Level raised on the result: ${r.from} to ${r.to}`} at={r.at} tone="warn">
      <p>
        {r.tier ? `Judged at the tier it ran at (${r.tier}). ` : ""}
        {r.newRules.length ? (
          <>
            Rules matched by the actual change: <span className="inline-flex flex-wrap gap-1">{r.newRules.map((x) => <Mono key={x}>{x}</Mono>)}</span>
          </>
        ) : null}
      </p>
      {a ? (
        <p>
          Review reserve: the {r.to} review wants {a.wanted} request(s); the contract reserved {a.from}, so {a.to - a.from} more came from the room under the ceiling ({a.fromUnallocated} available){a.to < a.wanted ? `. Only ${a.to} fit` : ""}.
        </p>
      ) : null}
    </StepRow>
  );
}

function TargetedRow({ t }: { t: insights.TargetedCheckView }) {
  return (
    <StepRow icon={<FlaskConical size={14} aria-hidden />} title="Targeted check the reviewer asked for" at={t.at}>
      <ul className="space-y-0.5">
        {(t.ran.length ? t.ran : t.commands.map((command) => ({ command, exitCode: null as number | null }))).map((c, i) => (
          <li key={i} className="flex flex-wrap items-center gap-2">
            {t.ran.length ? c.exitCode === 0 ? <Badge tone="good">exit 0</Badge> : <Badge tone="bad">exit {c.exitCode ?? "killed"}</Badge> : <Badge>not run</Badge>}
            <code className="break-all font-mono text-ink-2">{c.command}</code>
          </li>
        ))}
      </ul>
      <p className="text-ink-3">{t.note}</p>
    </StepRow>
  );
}

function RetryRow({ r, base }: { r: insights.RetryView; base: string }) {
  const title =
    r.kind === "repair"
      ? `Repair${r.toTier !== r.fromTier ? ` at ${r.toTier} (escalated from ${r.fromTier})` : ` at ${r.toTier}`}`
      : `Escalation from ${r.fromTier} to ${r.toTier}: ${humanize(r.reason)}`;
  return (
    <StepRow icon={<RefreshCcw size={14} aria-hidden />} title={title} at={r.at}>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {r.reviewVerdict ? (
          <span>
            Called for by a review verdict <Badge tone={VERDICT_TONE[r.reviewVerdict] ?? "neutral"}>{r.reviewVerdict}</Badge>
          </span>
        ) : r.kind === "repair" ? (
          <span>Called for by a failed check or criterion.</span>
        ) : null}
        {r.startFrom ? (
          <span>
            Started from the submitted commit <Mono>{r.startFrom.slice(0, 12)}</Mono>
          </span>
        ) : null}
        {r.sessionId ? (
          <Link href={sessionHref(base, r.sessionId)} className="inline-flex items-center gap-1 font-medium text-accent-ink hover:underline">
            {r.kind === "repair" ? "Repair" : "Retry"} run session <Mono>{shortId(r.sessionId, 14)}</Mono> <ArrowRight size={12} aria-hidden />
          </Link>
        ) : (
          <span className="text-ink-3">The {r.kind === "repair" ? "repair" : "retry"} run has no recorded session yet.</span>
        )}
      </p>
      {r.reasons.length ? (
        <ul className="list-disc space-y-0.5 pl-5">
          {r.reasons.map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ul>
      ) : null}
    </StepRow>
  );
}

function ReviewCard({ r, criteria, names, base }: { r: Review; criteria: Map<string, string>; names: Map<string, string>; base: string }) {
  const unqualified = r.flags.includes("reviewer_unqualified");
  const otherFlags = r.flags.filter((f) => f !== "reviewer_unqualified");
  return (
    <div className="rounded-lg border border-line text-xs">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <span className="text-ink-3">{unqualified || !r.reviewer ? <ShieldAlert size={14} aria-hidden /> : <ShieldCheck size={14} aria-hidden />}</span>
        <span className="font-semibold text-ink">Review {r.attempt}</span>
        {r.reviewer ? (
          <Link href={modelHref(r.reviewer)} className="font-medium text-accent-ink hover:underline">
            {r.reviewerName ?? names.get(r.reviewer) ?? r.reviewer}
          </Link>
        ) : (
          <span className="text-ink-3">no reviewer</span>
        )}
        {r.reviewerFamily ? <span className="text-ink-3">family {r.reviewerFamily}</span> : null}
        {r.reviewer ? (
          unqualified ? (
            <Badge tone="warn" title={`The reviewer holds no ${r.qualification ?? "review"} qualification at this tier. The verdict counts, and the record says so (reviewer_unqualified).`}>
              unqualified for {r.qualification ?? "review"}
            </Badge>
          ) : (
            <Badge tone="good" title={`Qualified on the ${r.qualification ?? "review"} evaluations`}>
              {r.qualification ?? "review"} qualified
            </Badge>
          )
        ) : null}
        {otherFlags.map((f) => (
          <Badge key={f} tone="serious">
            {humanize(f)}
          </Badge>
        ))}
        <span className="ml-auto flex flex-wrap items-center gap-2">
          {r.verdict ? <Badge tone={VERDICT_TONE[r.verdict] ?? "neutral"}>verdict {r.verdict}</Badge> : <Badge>no verdict</Badge>}
          {r.recommendedAction ? <span className="text-ink-2">recommends {ACTION_LABEL[r.recommendedAction] ?? humanize(r.recommendedAction)}</span> : null}
          {r.at ? <span className="tabular text-ink-3">{dateTime(r.at)}</span> : null}
        </span>
      </div>
      <div className="space-y-3 px-3 py-2">
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-ink-3">
          <span>
            {r.requests} request{r.requests === 1 ? "" : "s"} (purpose verification)
          </span>
          {r.revision ? (
            <span>
              examined <Mono>{r.revision.slice(0, 24)}</Mono>
            </span>
          ) : null}
          {r.score !== null ? <span>score {r.score} (recorded, never decisive)</span> : null}
          {r.sessionId ? (
            <Link href={sessionHref(base, r.sessionId)} className="inline-flex items-center gap-1 text-accent-ink hover:underline">
              reviewer session <Mono>{shortId(r.sessionId, 14)}</Mono>
            </Link>
          ) : null}
        </p>
        {!r.verdict ? <p className="text-ink-2">{humanize(r.stopReason || "no verdict was recorded")}</p> : null}
        {r.criteria.length ? (
          <table className="data-table">
            <thead>
              <tr>
                <th>Criterion</th>
                <th>Reviewer</th>
                <th>Evidence and reason</th>
              </tr>
            </thead>
            <tbody>
              {r.criteria.map((c) => (
                <tr key={c.id}>
                  <td className="text-ink-2">
                    <span className="mr-1 font-mono text-ink-3">{c.id}</span>
                    {criteria.get(c.id) ?? ""}
                  </td>
                  <td>
                    <Badge tone={VERDICT_TONE[c.outcome] ?? "neutral"}>{c.outcome}</Badge>
                  </td>
                  <td>
                    <span className="flex flex-wrap gap-1">{c.evidenceRefs.length ? c.evidenceRefs.map((e) => <Mono key={e}>{e}</Mono>) : <span className="text-ink-3">no evidence cited</span>}</span>
                    {c.reason ? <p className="mt-1 text-ink-2">{c.reason}</p> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
        {r.blockingFindings.length ? (
          <div>
            <h4 className="mb-1 font-semibold text-bad-ink">Blocking findings</h4>
            <ul className="space-y-1">
              {r.blockingFindings.map((f, i) => (
                <li key={i} className="rounded-md bg-bad-soft/40 px-2 py-1 text-ink">
                  {f.criterionId ? <span className="mr-1 font-mono text-ink-3">{f.criterionId}</span> : null}
                  {f.description}
                  {f.evidenceRefs.length ? <span className="ml-1 inline-flex flex-wrap gap-1">{f.evidenceRefs.map((e) => <Mono key={e}>{e}</Mono>)}</span> : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {r.missingEvidence.length ? (
          <div>
            <h4 className="mb-1 font-semibold text-serious-ink">Missing evidence</h4>
            <ul className="list-disc space-y-0.5 pl-5 text-ink-2">
              {r.missingEvidence.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {r.artifactRef ? <ArtifactViewer refId={r.artifactRef} kind="review" label="Verdict, evidence package, and transcript" /> : null}
      </div>
    </div>
  );
}

/** Heading for the trail, with its help tip. */
export function TrailHeading() {
  return (
    <h3 className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-ink-3">
      Reviews and follow-ups <HelpTip term="review" />
    </h3>
  );
}
