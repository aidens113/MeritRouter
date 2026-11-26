/**
 * Report v1: the structured text a supervisor reads for one finished task (supervisor-offload
 * Phase 1 contract), built from the stored worker result.
 *
 * Every section is always present, and length scales with the work: there is no small fixed
 * cap. `detail` (brief | standard | full) sets verbosity. Only bulky raw output (full logs, full
 * diffs, transcripts) stays behind drill-down refs. Checks are labelled VERIFIED only when the
 * harness ran them (the result's `checks`); anything the worker merely says is CLAIMED.
 * Worker-written text (summary, findings, messages) is quoted as data.
 *
 * This module must only import types from task.ts: task.ts imports SelfCheckSchema from here.
 */
import { z } from "zod";
import type { WorkerResult } from "./task.js";
import type { ReportDetail } from "./brief.js";
import type { ChannelMessage } from "./channel.js";

const item = z.string().trim().min(1).max(4000);

/** The fixed questions every worker answers when it submits. */
export const SelfCheckSchema = z
  .object({
    /** What the worker did not test or could not verify. */
    notTested: z.array(item).max(50),
    /** Assumptions the worker made in place of asking. */
    assumptions: z.array(item).max(50),
    /** The change most likely to be wrong, and why ("none" for read-only work). */
    riskiestChange: item,
    /** What the supervisor should check next. */
    checkNext: z.array(item).max(50),
  })
  .strict();
export type SelfCheck = z.infer<typeof SelfCheckSchema>;

export interface DiffstatEntry {
  path: string;
  added: number | null;
  removed: number | null;
}

export interface ReportRenderOptions {
  /** Default standard. */
  detail?: ReportDetail;
  /** The task's channel messages; pending ones are listed under Open messages (all of them at full detail). */
  messages?: readonly ChannelMessage[];
  /** The task's criteria (id, text) so met criteria are listed even without a verification record. */
  criteria?: ReadonlyArray<{ id: string; text: string }>;
  /** Per-path line counts for the changed paths, when the caller computed them from the patch. */
  diffstat?: readonly DiffstatEntry[];
  /** Raw check log text by log ref; the renderer shows the last lines. */
  checkTails?: Readonly<Record<string, string>>;
  /** Checks the worker says it ran but the harness did not (labelled CLAIMED). */
  claimedChecks?: ReadonlyArray<{ command: string; exitCode: number | null; note?: string }>;
  /** Further drill-down refs (session, transcript, full diff). */
  refs?: readonly string[];
}

/** Last lines of a check log shown per detail level: [passing check, failing check]. */
const TAIL_LINES: Readonly<Record<ReportDetail, readonly [number, number]>> = { brief: [0, 10], standard: [10, 40], full: [80, 200] };

const quote = (text: string) =>
  text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");
const lastLines = (text: string, n: number) => {
  const lines = text.replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n");
  return lines.length > n ? { lines: lines.slice(-n), omitted: lines.length - n } : { lines, omitted: 0 };
};
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

type CriterionState = "met" | "unmet" | "not verified";
const CRITERION_STATE: Readonly<Record<string, CriterionState>> = { passed: "met", failed: "unmet" };

interface CriterionLine {
  id: string;
  text: string;
  state: CriterionState;
  outcome: string;
  evidenceRefs: string[];
  note?: string;
}

function criterionLines(result: WorkerResult, given: ReportRenderOptions["criteria"]): CriterionLine[] {
  const recorded = result.verification?.criteria;
  if (recorded?.length) {
    return recorded.map((c) => ({ id: c.id, text: c.text, state: CRITERION_STATE[c.outcome] ?? "not verified", outcome: c.outcome, evidenceRefs: c.evidenceRefs, ...(c.note ? { note: c.note } : {}) }));
  }
  // No verification record: only the unresolved list is known; everything else is unverified.
  const unresolvedIds = result.unresolvedCriterionIds ?? [];
  const lines: CriterionLine[] = result.unresolvedCriteria.map((text, i) => ({ id: unresolvedIds[i] ?? `unresolved-${i + 1}`, text, state: "unmet", outcome: "unresolved", evidenceRefs: [] }));
  for (const c of given ?? []) {
    if (!lines.some((l) => l.id === c.id)) lines.push({ id: c.id, text: c.text, state: "not verified", outcome: "no verification record", evidenceRefs: [] });
  }
  return lines;
}

/** Render a worker result as Report v1 text. */
export function renderReportV1(result: WorkerResult, opts: ReportRenderOptions = {}): string {
  const detail: ReportDetail = opts.detail ?? "standard";
  const full = detail === "full";
  const brief = detail === "brief";
  const out: string[] = [];
  const section = (title: string, body: string[]) => out.push(`## ${title}`, ...(body.length ? body : ["(none)"]), "");
  const verificationChecks = result.verification?.checks ?? [];
  const criteria = criterionLines(result, opts.criteria);

  // ---- Outcome
  const failingChecks = result.checks.filter((c) => c.exitCode !== 0).length;
  const unmet = criteria.filter((c) => c.state === "unmet").length;
  const unverified = criteria.filter((c) => c.state === "not verified").length;
  const pendingMessages = (opts.messages ?? []).filter((m) => m.status === "pending");
  const attention = [
    failingChecks ? `${plural(failingChecks, "check")} failed or did not finish` : "",
    unmet ? `${plural(unmet, "criterion")} unmet` : "",
    unverified ? `${plural(unverified, "criterion")} not verified` : "",
    result.scopeViolation?.length ? `${plural(result.scopeViolation.length, "path")} changed outside allowedPaths` : "",
    result.protectedPathsChanged?.length ? `${plural(result.protectedPathsChanged.length, "protected path")} changed` : "",
    pendingMessages.length ? `${plural(pendingMessages.length, "open message")}` : "",
    result.selfCheck ? "" : "no self-check",
  ].filter(Boolean);
  section("Outcome", [
    `Task ${result.taskId}: execution ${result.executionStatus}, acceptance ${result.acceptanceStatus}, verification ${result.verificationStatus ?? "not_required"}.`,
    `Stop reason: ${result.stopReason}`,
    attention.length ? `Needs attention: ${attention.join("; ")}.` : "Needs attention: nothing flagged.",
  ]);

  // ---- Summary (worker-written)
  section("Summary (the worker's own account)", result.summary.trim() ? [quote(result.summary.trim())] : []);

  // ---- Changed
  const changed = result.changedPaths ?? [];
  const stats = new Map((opts.diffstat ?? []).map((d) => [d.path, d]));
  const outside = new Set(result.scopeViolation ?? []);
  const isProtected = new Set(result.protectedPathsChanged ?? []);
  const changedBody: string[] = [];
  if (!changed.length) changedBody.push(result.changedPaths ? "No files changed." : "No changes recorded (not a coding result).");
  else {
    let added = 0;
    let removed = 0;
    let counted = false;
    for (const p of [...changed].sort()) {
      const s = stats.get(p);
      if (s?.added != null) {
        added += s.added;
        counted = true;
      }
      if (s?.removed != null) {
        removed += s.removed;
        counted = true;
      }
      const counts = s ? ` (+${s.added ?? "?"} -${s.removed ?? "?"})` : "";
      const flags = [outside.has(p) ? "OUTSIDE allowedPaths" : "", isProtected.has(p) ? "PROTECTED" : ""].filter(Boolean);
      changedBody.push(`- ${p}${counts}${flags.length ? ` [${flags.join(", ")}]` : ""}`);
    }
    changedBody.push(`${plural(changed.length, "file")} changed${counted ? `, +${added} -${removed} lines` : opts.diffstat ? "" : "; line counts not available (see patch refs)"}.`);
  }
  for (const p of result.scopeViolation ?? []) if (!changed.includes(p)) changedBody.push(`- ${p} [OUTSIDE allowedPaths]`);
  section("Changed", changedBody);

  // ---- Checks (harness-run = VERIFIED; worker-reported = CLAIMED)
  const checkBody: string[] = [];
  const [passTail, failTail] = TAIL_LINES[detail];
  for (const c of result.checks) {
    const policy = verificationChecks.find((v) => v.name === c.command);
    const label =
      policy?.outcome === "stale"
        ? "STALE (ran against an earlier revision; does not verify the submitted work)"
        : c.exitCode === null
          ? "VERIFIED did not finish (no exit code: timed out or killed)"
          : c.exitCode === 0
            ? "VERIFIED pass (exit 0)"
            : `VERIFIED fail (exit ${c.exitCode})`;
    checkBody.push(`- [${label}] \`${c.command}\`${full && c.revision ? ` at ${c.revision}` : ""} (log ${c.logRef})`);
    const raw = opts.checkTails?.[c.logRef];
    const n = c.exitCode === 0 && policy?.outcome !== "stale" ? passTail : failTail;
    if (raw !== undefined && n > 0) {
      const t = lastLines(raw, n);
      checkBody.push(`  Last ${plural(t.lines.length, "line")}${t.omitted ? ` (${t.omitted} earlier lines in ${c.logRef})` : ""}:`, "  ```", ...t.lines.map((l) => `  ${l}`), "  ```");
    } else if (raw === undefined && n > 0 && !brief) checkBody.push(`  Output: read ${c.logRef}.`);
  }
  const ranCommands = new Set(result.checks.map((c) => c.command));
  for (const v of verificationChecks) {
    if (ranCommands.has(v.name)) continue;
    if (brief && v.outcome === "passed") continue;
    const tag = v.outcome === "passed" ? "VERIFIED pass" : v.outcome === "not_run" ? "NOT RUN" : v.outcome.toUpperCase().replace(/_/g, " ");
    checkBody.push(`- [${tag}] ${v.name}${v.required ? " (required)" : ""}${v.detail ? `: ${v.detail}` : ""}`);
  }
  for (const c of opts.claimedChecks ?? []) {
    checkBody.push(`- [CLAIMED by the worker, not run by the harness] \`${c.command}\`${c.exitCode !== null ? ` exit ${c.exitCode}` : ""}${c.note ? `: ${c.note}` : ""}`);
  }
  if (!checkBody.length) checkBody.push("No checks ran. Nothing in this result is harness-verified.");
  section("Checks", checkBody);

  // ---- Criteria
  const criteriaBody: string[] = [];
  const met = criteria.filter((c) => c.state === "met");
  for (const c of criteria) {
    if (brief && c.state === "met") continue;
    const refs = c.evidenceRefs.length ? ` Evidence: ${c.evidenceRefs.join(", ")}.` : c.state === "met" ? "" : " No evidence cited.";
    const why = c.state === "not verified" ? ` (${c.outcome.replace(/_/g, " ")})` : "";
    criteriaBody.push(`- ${c.state.toUpperCase()}${why} ${c.id}: ${c.text}${refs}${c.note && !brief ? ` Note: ${c.note}` : ""}`);
  }
  if (brief && met.length) criteriaBody.push(`${plural(met.length, "criterion")} met: ${met.map((c) => c.id).join(", ")}.`);
  if (!criteria.length) criteriaBody.push("No criteria recorded on this result.");
  section("Criteria", criteriaBody);

  // ---- Claims not verified by the harness
  const claims: string[] = [];
  for (const c of criteria.filter((c) => c.outcome === "claimed")) claims.push(`- Criterion ${c.id} claimed met by the worker; no check or review confirmed it.`);
  if (result.findings.length) {
    claims.push(`Findings (${result.findings.length}), as the worker states them:`);
    for (const f of result.findings) {
      const text = brief ? f.description.trim().split(/\r?\n/)[0]! : f.description.trim();
      claims.push(`- ${text.replace(/\r?\n/g, "\n  ")}${!brief && f.evidenceRefs.length ? ` [evidence: ${f.evidenceRefs.join(", ")}]` : !brief ? " [no evidence cited]" : ""}`);
    }
  }
  for (const c of opts.claimedChecks ?? []) claims.push(`- Check \`${c.command}\` is reported by the worker only.`);
  if (result.acceptanceStatus === "not_verified") claims.push("- Acceptance is not_verified: the result has not been confirmed by checks or review.");
  section("Claims not verified by the harness", claims);

  // ---- Self-check
  const sc = result.selfCheck;
  section(
    "Self-check",
    sc
      ? [
          `Not tested: ${sc.notTested.length ? "" : "(worker says nothing)"}`,
          ...sc.notTested.map((s) => `- ${s}`),
          `Assumptions: ${sc.assumptions.length ? "" : "(none stated)"}`,
          ...sc.assumptions.map((s) => `- ${s}`),
          `Riskiest change: ${sc.riskiestChange}`,
          `Check next: ${sc.checkNext.length ? "" : "(nothing suggested)"}`,
          ...sc.checkNext.map((s) => `- ${s}`),
        ].map((l) => l.trimEnd())
      : ["NOT PROVIDED: the worker did not answer the self-check questions; treat untested areas as unknown."],
  );

  // ---- Open messages
  const shown = full ? [...(opts.messages ?? [])] : pendingMessages;
  section(
    "Open messages",
    shown.flatMap((m) => {
      const head = `- ${m.id} ${m.kind} (${m.direction === "worker_to_supervisor" ? "from worker" : "to worker"}, ${m.status})${m.inReplyTo ? ` re ${m.inReplyTo}` : ""}${m.refs?.length ? ` refs: ${m.refs.join(", ")}` : ""}`;
      const body = brief ? m.body.split(/\r?\n/)[0]! : m.body;
      return [head, quote(body).replace(/^/gm, "  ")];
    }),
  );

  // ---- Drill-down refs
  const refs: string[] = [];
  const add = (label: string, list: readonly string[]) => {
    const unique = [...new Set(list)];
    if (unique.length) refs.push(`- ${label}: ${unique.join(", ")}`);
  };
  add("Patches", result.patchRefs);
  add("Check logs", result.checks.map((c) => c.logRef));
  add("Artifacts", result.artifactRefs);
  if (!brief) add("Finding evidence", result.findings.flatMap((f) => f.evidenceRefs));
  if (!brief) add("Reviews", (result.verification?.reviews ?? []).flatMap((r) => (r.artifactRef ? [r.artifactRef] : [])));
  add("Other", opts.refs ?? []);
  if (full) {
    const u = result.usage;
    refs.push(`- Usage: ${plural(u.modelRequests, "model request")}, input ${u.inputTokens ?? "?"} / output ${u.outputTokens ?? "?"} tokens (${u.tokenUsageBasis}), cost ${u.reportedCostUsd ?? u.estimatedCostUsd ?? 0} USD`);
    if (result.servedEndpoints.length) refs.push(`- Served by: ${result.servedEndpoints.join(", ")}${result.routing ? ` (tier ${result.routing.tier}${result.routing.escalatedFrom ? `, escalated from ${result.routing.escalatedFrom}` : ""})` : ""}`);
  }
  section("Drill-down refs", refs);

  return out.join("\n").trimEnd() + "\n";
}
