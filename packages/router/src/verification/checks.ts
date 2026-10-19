import type { ProfileMode } from "../config/schema.js";
import { checkEvidenceRef, type EvidenceUniverse, type WorkerOutput } from "../core/worker-output.js";
import { ARTIFACT_REF_RE, FILE_REF_RE, type CheckOutcome, type CriterionOutcome, type CriterionVerify, type WorkerResult } from "../core/task.js";
import type { AcceptanceContract } from "./contract.js";

/** The deterministic checks this version implements. Any other required name is not_implemented. */
export const NAMED_CHECKS = ["output_contract", "evidence_provenance", "scope", "protected_paths", "declared_checks", "criterion_evidence"] as const;
export type NamedCheck = (typeof NAMED_CHECKS)[number];

/** Exit codes meaning the command could not run at all: not executable, not found (sh), not found (cmd.exe). */
const NOT_RUNNABLE_EXIT_CODES: ReadonlySet<number> = new Set([126, 127, 9009]);

/** A worker's per-criterion self-assessment, keyed by criterion id. */
export interface SelfReportEntry {
  id: string;
  status: "met" | "unmet" | "unknown";
  evidenceRefs: string[];
  note?: string;
}

export type CheckRecord = WorkerResult["checks"][number];

/** The parts of a runner result the checks read. */
export type CheckedResult = Pick<WorkerResult, "executionStatus" | "stopReason" | "findings" | "checks" | "unresolvedCriteria" | "artifactRefs" | "patchRefs"> &
  Partial<Pick<WorkerResult, "data" | "changedPaths" | "scopeViolation" | "protectedPathsChanged">>;

export interface CheckSubject {
  contract: AcceptanceContract;
  mode: ProfileMode;
  /** Required named checks (the re-evaluated list); defaults to the contract's. */
  requiredChecks?: string[];
  result: CheckedResult;
  /** Revision the result is submitted at (coding: the commit or tree sha); null when not applicable. */
  revision: string | null;
  /** Digest of the submitted patch or artifact; null when not applicable. */
  artifactDigest?: string | null;
  /** Material the worker received or read; without it provenance is checked by form only. */
  universe?: EvidenceUniverse | null;
  /** Per-criterion self-assessment (selfReportFromOutput); null for runners that have none. */
  selfReport?: SelfReportEntry[] | null;
}

export interface NamedCheckResult {
  name: string;
  required: boolean;
  outcome: CheckOutcome;
  detail: string;
}

export interface CriterionResult {
  id: string;
  text: string;
  verify: CriterionVerify;
  outcome: CriterionOutcome;
  checks: string[];
  evidenceRefs: string[];
  note?: string;
}

export interface CheckReport {
  checks: NamedCheckResult[];
  criteria: CriterionResult[];
}

/** Map a validated worker output (criteria by index) to self-report entries by criterion id. */
export function selfReportFromOutput(output: Pick<WorkerOutput, "criteria">, contract: Pick<AcceptanceContract, "criteria">): SelfReportEntry[] {
  const out: SelfReportEntry[] = [];
  for (const c of output.criteria) {
    const crit = contract.criteria[c.index];
    if (!crit) continue;
    out.push({ id: crit.id, status: c.status, evidenceRefs: c.evidenceRefs, ...(c.note ? { note: c.note } : {}) });
  }
  return out;
}

export type CheckRunOutcome = "passed" | "failed" | "stale" | "environment_failure" | "not_run";

/**
 * Classify one declared command against the submitted revision. The latest record for the
 * command decides. A record bound to another revision or artifact (or to none, when the
 * subject has one) is stale: a result changed after its checks invalidates them.
 */
export function checkRunOutcome(command: string, records: CheckRecord[], revision: string | null, artifactDigest: string | null = null): { outcome: CheckRunOutcome; record: CheckRecord | null } {
  const record = [...records].reverse().find((r) => r.command === command) ?? null;
  if (!record) return { outcome: "not_run", record };
  if (revision !== null && record.revision !== revision) return { outcome: "stale", record };
  if (artifactDigest !== null && record.artifactDigest !== artifactDigest) return { outcome: "stale", record };
  if (record.exitCode === null || NOT_RUNNABLE_EXIT_CODES.has(record.exitCode)) return { outcome: "environment_failure", record };
  return { outcome: record.exitCode === 0 ? "passed" : "failed", record };
}

function refWellFormed(ref: string): boolean {
  return FILE_REF_RE.test(ref) || ARTIFACT_REF_RE.test(ref);
}

/** Run every named check (they are cheap and deterministic) and mark which ones are required. */
export function runNamedChecks(s: CheckSubject): CheckReport {
  const required = new Set(s.requiredChecks ?? s.contract.verification.requiredChecks);
  const r = s.result;
  const coding = s.mode === "coding";
  const digest = s.artifactDigest ?? null;
  const completed = r.executionStatus === "completed";
  const self = new Map((s.selfReport ?? []).map((e) => [e.id, e]));
  const results: NamedCheckResult[] = [];
  const add = (name: string, outcome: CheckOutcome, detail: string) => results.push({ name, required: required.has(name), outcome, detail });

  // output_contract: the run produced a well-formed answer for its mode. An execution that did
  // not complete produced no answer to judge: that is its execution status, not a defect, so
  // only defects in what it did produce (a coding run that changed nothing) fail here.
  {
    const problems: string[] = [];
    if (completed) {
      if (r.stopReason === "invalid_output") problems.push("worker output failed validation");
      if (s.contract.hasOutputSchema && r.data === undefined) problems.push("the task's outputSchema requires data");
      if (!coding && s.selfReport) {
        const missing = s.contract.criteria.filter((c) => !self.has(c.id)).map((c) => c.id);
        if (missing.length) problems.push(`criteria not assessed: ${missing.join(", ")}`);
      }
    }
    if (coding && r.changedPaths !== undefined && r.changedPaths.length === 0) problems.push("no files changed");
    if (problems.length) add("output_contract", "failed", problems.join("; "));
    else if (!completed) add("output_contract", "not_run", `execution ${r.executionStatus}${r.stopReason ? ` (${r.stopReason})` : ""}`);
    else if (coding && r.changedPaths === undefined) add("output_contract", "not_run", "the result does not report its changed paths");
    else add("output_contract", "passed", coding ? `${r.changedPaths!.length} file(s) changed` : "output validated");
  }

  // evidence_provenance: every cited ref points at material the worker had (or is produced output).
  {
    const own = new Set([...r.artifactRefs, ...r.patchRefs, ...r.checks.map((c) => c.logRef)]);
    const refs = [...r.findings.flatMap((f) => f.evidenceRefs), ...(s.selfReport ?? []).flatMap((e) => e.evidenceRefs)];
    const bad: string[] = [];
    for (const ref of refs) {
      if (own.has(ref)) continue;
      if (s.universe) {
        const e = checkEvidenceRef(ref, s.universe);
        if (e) bad.push(e);
      } else if (!refWellFormed(ref)) bad.push(`evidence ref ${ref} is not a recognised reference`);
    }
    if (bad.length) add("evidence_provenance", "failed", bad.join("; "));
    else add("evidence_provenance", "passed", s.universe ? `${refs.length} ref(s) inside the evidence universe` : `${refs.length} ref(s) well-formed (no evidence universe given)`);
  }

  // scope and protected_paths: coding results only.
  if (!coding) {
    add("scope", "not_applicable", "the task cannot write files");
    add("protected_paths", "not_applicable", "the task cannot write files");
  } else {
    if (r.scopeViolation === undefined) add("scope", "not_run", "the result does not report scope");
    else if (r.scopeViolation.length) add("scope", "failed", `outside allowedPaths: ${r.scopeViolation.join(", ")}`);
    else add("scope", "passed", "all changes inside allowedPaths");
    if (r.protectedPathsChanged === undefined) add("protected_paths", "not_run", "the result does not report protected paths");
    else if (r.protectedPathsChanged.length) add("protected_paths", "inconclusive", `tests or evaluator files changed: ${r.protectedPathsChanged.join(", ")}; verify independently`);
    else add("protected_paths", "passed", "no protected paths changed");
  }

  // declared_checks: every constraints.checks command passed on the submitted revision.
  const runs = new Map(s.contract.declaredChecks.map((cmd) => [cmd, checkRunOutcome(cmd, r.checks, s.revision, digest).outcome]));
  if (!runs.size) add("declared_checks", "not_applicable", "the task declares no checks");
  else {
    const by = (o: CheckRunOutcome) => [...runs].filter(([, v]) => v === o).map(([k]) => k);
    const detail = [...runs].map(([k, v]) => `${k} -> ${v}`).join("; ");
    if (by("failed").length) add("declared_checks", "failed", detail);
    else if (by("environment_failure").length) add("declared_checks", "environment_failure", detail);
    else if (by("stale").length) add("declared_checks", "stale", detail);
    else if (by("not_run").length) add("declared_checks", "not_run", detail);
    else add("declared_checks", "passed", detail);
  }

  // criterion_evidence: each criterion by its verify kind.
  const crit: CriterionResult[] = s.contract.criteria.map((c) => {
    const base = { id: c.id, text: c.text, verify: c.verify, checks: c.checks };
    const claim = self.get(c.id);
    if (c.verify === "check") {
      const outcomes = c.checks.map((cmd) => runs.get(cmd) ?? checkRunOutcome(cmd, r.checks, s.revision, digest).outcome);
      const outcome: CriterionOutcome = outcomes.includes("failed")
        ? "failed"
        : outcomes.includes("environment_failure")
          ? "environment_failure"
          : outcomes.includes("stale")
            ? "stale"
            : outcomes.includes("not_run") || !outcomes.length
              ? "not_run"
              : "passed";
      return { ...base, outcome, evidenceRefs: r.checks.filter((x) => c.checks.includes(x.command)).map((x) => x.logRef) };
    }
    if (claim?.status === "unmet") return { ...base, outcome: "failed", evidenceRefs: claim.evidenceRefs, ...(claim.note ? { note: claim.note } : {}) };
    if (c.verify === "review") return { ...base, outcome: "pending_review", evidenceRefs: claim?.evidenceRefs ?? [], ...(claim?.note ? { note: claim.note } : {}) };
    if (claim) return { ...base, outcome: claim.status === "met" && claim.evidenceRefs.length ? "claimed" : "unknown", evidenceRefs: claim.evidenceRefs, ...(claim.note ? { note: claim.note } : {}) };
    // No self-report (older runners): unresolved texts are unknown, the rest are claimed.
    return { ...base, outcome: r.unresolvedCriteria.includes(c.text) || !completed ? "unknown" : "claimed", evidenceRefs: [] };
  });
  {
    const o = crit.map((c) => c.outcome);
    const ids = (k: CriterionOutcome) => crit.filter((c) => c.outcome === k).map((c) => c.id);
    const detail = crit.map((c) => `${c.id}: ${c.outcome}`).join("; ");
    if (o.includes("failed")) add("criterion_evidence", "failed", `failed: ${ids("failed").join(", ")}`);
    else if (o.some((x) => x === "not_run" || x === "stale" || x === "environment_failure")) add("criterion_evidence", "inconclusive", detail);
    else if (o.every((x) => x === "passed")) add("criterion_evidence", "passed", detail);
    else add("criterion_evidence", "unverified", detail);
  }

  // Required names this version cannot run never pass silently.
  for (const name of required) {
    if (!(NAMED_CHECKS as readonly string[]).includes(name)) add(name, "not_implemented", `check ${name} is required but not implemented in this version`);
  }
  return { checks: results, criteria: crit };
}
