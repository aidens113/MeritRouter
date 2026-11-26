/**
 * Brief v1: the supervisor's typed request to a worker (supervisor-offload Phase 1 contract).
 *
 * A brief names what kind of work it is, what done looks like, what the worker may touch, which
 * tools it gets, and which exact commands verify it. `lintBrief` refuses vague or unsafe briefs
 * with messages that say how to fix them; `briefToTaskArgument` maps a clean brief onto the
 * existing task contract (core/task.ts WorkerTaskSchema, the shape submit_tasks takes), so the
 * executor, verification and old callers are unchanged.
 *
 * Tool grants are data here: TOOL_PROFILES maps each profile to tool names that exist in the
 * harness today. Enforcing them (the worker sees only granted tools) belongs to the worker-side
 * lane; ALWAYS_ON_WORKER_TOOLS are reserved names that lane implements.
 */
import { z } from "zod";
import { FILE_REF_RE, type WorkerTaskInput } from "./task.js";

export const BRIEF_KINDS = ["scout", "summarize", "edit", "implement", "run", "review"] as const;
export const BriefKindSchema = z.enum(BRIEF_KINDS);
export type BriefKind = z.infer<typeof BriefKindSchema>;

export const REPORT_DETAILS = ["brief", "standard", "full"] as const;
export const ReportDetailSchema = z.enum(REPORT_DETAILS);
export type ReportDetail = z.infer<typeof ReportDetailSchema>;

/** Tool profiles share the brief kinds' names: a brief's default profile is its kind. */
export const TOOL_PROFILE_NAMES = BRIEF_KINDS;
export type ToolProfileName = BriefKind;

/**
 * Reserved worker tools every worker gets whatever its grant (implemented by the worker-side
 * lane; `submit_result` exists today in harness/worker.ts). `reply_supervisor` answers a
 * supervisor probe by message id (storage/supervisor-channel.ts SupervisorChannelStore.answer).
 */
export const ALWAYS_ON_WORKER_TOOLS = ["ask_supervisor", "request_tools", "report_blocked", "reply_supervisor", "submit_result"] as const;

// Groups of existing harness tool names (harness/tools.ts, harness/*-operations.ts,
// operation-registry.ts, web-tools.ts, labs/tools.ts, budget-tools.ts, worker-action-tools.ts).
const READ_V1 = ["list_files", "read_file", "search", "read_artifact"] as const;
const READ_V2 = ["workspace_info", "list_paths", "read_files", "search_text", "read_output_page", "operation_status"] as const;
const BRAIN_READ = ["brain_search", "brain_read", "brain_list", "brain_my_requests"] as const;
const WEB = ["web_search", "web_fetch"] as const;
/** Tools that change files in the worker's workspace. `batch` can carry edits. */
const EDIT = ["write_file", "replace_in_file", "delete_file", "apply_edits", "batch"] as const;
/** Runs only the brief's declared checks, exactly as declared; safe for read-only work. */
const DECLARED_CHECK = ["run_check"] as const;
/** Run commands or recipes beyond the declared checks (pattern- and policy-limited). */
const COMMANDS = ["run_checks", "run_recipe", "run_command", "cancel_operation"] as const;
const LAB_READ = ["lab_status", "lab_logs"] as const;
const LAB_ACT = ["lab_check", "lab_http", "lab_restart"] as const;
const BUDGET = ["request_more_budget"] as const;
const SUPERVISOR_ACTION = ["request_supervisor_action", "await_supervisor_action", "supervisor_action_status"] as const;

/** Profile name -> the existing harness tools it grants (always-on tools come on top). */
export const TOOL_PROFILES: Readonly<Record<ToolProfileName, readonly string[]>> = Object.freeze({
  scout: Object.freeze([...READ_V1, ...READ_V2, ...BRAIN_READ, ...WEB, ...BUDGET]),
  summarize: Object.freeze([...READ_V1, ...READ_V2, ...BUDGET]),
  review: Object.freeze([...READ_V1, ...READ_V2, ...BRAIN_READ, ...DECLARED_CHECK, ...LAB_READ, ...BUDGET]),
  run: Object.freeze([...READ_V1, ...READ_V2, ...DECLARED_CHECK, ...COMMANDS, ...LAB_READ, "lab_check", ...BUDGET, ...SUPERVISOR_ACTION]),
  edit: Object.freeze([...READ_V1, ...READ_V2, ...EDIT, ...DECLARED_CHECK, ...BUDGET]),
  implement: Object.freeze([...READ_V1, ...READ_V2, ...BRAIN_READ, ...WEB, ...EDIT, ...DECLARED_CHECK, ...COMMANDS, ...LAB_READ, ...LAB_ACT, ...BUDGET, ...SUPERVISOR_ACTION]),
});

/** Tools that write to the workspace; never granted to a non-writable brief. */
export const WRITE_TOOLS: ReadonlySet<string> = new Set(EDIT);
/** Every tool name an explicit grant may list: the profiles, plus tools only granted on request. */
export const KNOWN_WORKER_TOOLS: ReadonlySet<string> = new Set([
  ...Object.values(TOOL_PROFILES).flat(),
  "lab_promote",
  "post_channel",
  "read_channel",
  ...ALWAYS_ON_WORKER_TOOLS,
]);

const TOOL_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;
const text = (max: number) => z.string().trim().min(1).max(max);

export const BriefV1Schema = z
  .object({
    version: z.literal(1).optional(),
    kind: BriefKindSchema,
    /** What the worker must achieve, specific enough to act on without questions. */
    goal: text(20_000),
    context: z
      .object({
        /** `<alias>:<path>[#Lstart-Lend]`, or a bare path resolved against scope.repository. */
        files: z.array(text(1000)).max(200).default([]),
        notes: z.string().max(400_000).optional(),
      })
      .strict()
      .prefault({}),
    scope: z
      .object({
        /** Paths the worker may change (writable briefs). */
        allowedPaths: z.array(text(1000)).max(200).default([]),
        writable: z.boolean(),
        /** The repository alias the worker works in (and may edit when writable). */
        repository: text(64).optional(),
      })
      .strict(),
    /** A profile name, or an explicit list of tool names. Default: the kind's profile. */
    tools: z.union([BriefKindSchema, z.array(z.string().regex(TOOL_NAME_RE, "tool names are lower-case letters, digits and _")).min(1).max(80)]).optional(),
    /** Exact commands run in the worker's workspace to verify the result. */
    checks: z.array(text(4000)).max(10).default([]),
    /** Observable criteria for done (each becomes an acceptance criterion). */
    doneWhen: z.array(text(4000)).min(1, "doneWhen needs at least one observable criterion").max(30),
    report: z.object({ detail: ReportDetailSchema.default("standard") }).strict().prefault({}),
    budget: z.object({ requests: z.number().int().positive().optional() }).strict().optional(),
    /** Resubmitting the same key returns the same task. */
    idempotencyKey: text(200).optional(),
    /** Short agent label (lower-case letters, digits, hyphens). */
    label: z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/).optional(),
  })
  .strict();
export type BriefV1Input = z.input<typeof BriefV1Schema>;
export type BriefV1 = z.infer<typeof BriefV1Schema>;

export interface BriefIssue {
  /** Stable machine code, e.g. `missing_allowed_paths`. */
  code: string;
  /** Dotted path of the offending field ("" for the whole brief). */
  field: string;
  /** What is wrong and how to fix it. */
  message: string;
}
export interface BriefLint {
  errors: BriefIssue[];
  warnings: BriefIssue[];
}

export class BriefError extends Error {
  readonly code = "brief_rejected";
  constructor(readonly issues: BriefIssue[]) {
    super(`brief rejected:\n${issues.map((i) => `- ${i.field ? `${i.field}: ` : ""}${i.message}`).join("\n")}`);
  }
}

const WRITABLE_KINDS: ReadonlySet<BriefKind> = new Set(["edit", "implement"]);
const READ_ONLY_KINDS: ReadonlySet<BriefKind> = new Set(["scout", "summarize", "review"]);
const MIN_GOAL_CHARS = 30;
const MIN_GOAL_WORDS = 5;
const VAGUE_WORDS = /\b(etc\.?|and so on|as needed|whatever|somehow|stuff|things|make it work|properly|if possible|and more)\b/i;
const VAGUE_CRITERION = /^(it )?(done|works?|complete[d]?|finished|ok|fixed|good|better|clean(er)?)\.?$/i;
const BROAD_PATHS = new Set(["**", "*", ".", "./", "/", "**/*", "./**"]);
const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

/** The tool names a brief grants (its profile or explicit list) plus the always-on tools. */
export function resolveBriefTools(brief: Pick<BriefV1, "kind" | "tools">): string[] {
  const granted = Array.isArray(brief.tools) ? brief.tools : TOOL_PROFILES[brief.tools ?? brief.kind];
  return [...new Set([...granted, ...ALWAYS_ON_WORKER_TOOLS])];
}

/** Repository aliases a brief reads: scope.repository first, then aliases named by file refs. */
function briefRepositories(brief: BriefV1): string[] {
  const aliases = brief.scope.repository ? [brief.scope.repository] : [];
  for (const file of brief.context.files) {
    const m = FILE_REF_RE.exec(file);
    if (m && !aliases.includes(m[1]!)) aliases.push(m[1]!);
  }
  return aliases;
}

/** The writable repository: scope.repository, or the only repository the brief names. */
function writableRepository(brief: BriefV1): string | undefined {
  if (brief.scope.repository) return brief.scope.repository;
  const repos = briefRepositories(brief);
  return repos.length === 1 ? repos[0] : undefined;
}

/**
 * Reject vague or unsafe briefs before any model request is spent. Errors block dispatch;
 * warnings are advice the supervisor should read. Takes a parsed brief (see `checkBrief` for
 * raw input).
 */
export function lintBrief(brief: BriefV1): BriefLint {
  const errors: BriefIssue[] = [];
  const warnings: BriefIssue[] = [];
  const err = (code: string, field: string, message: string) => errors.push({ code, field, message });
  const warn = (code: string, field: string, message: string) => warnings.push({ code, field, message });
  const { kind, scope } = brief;

  // Goal.
  if (brief.goal.length < MIN_GOAL_CHARS || words(brief.goal) < MIN_GOAL_WORDS) {
    err("goal_too_short", "goal", `goal is too short to act on (${words(brief.goal)} words). Say what to change or find, where, and why, in at least ${MIN_GOAL_WORDS} words; e.g. "Add a --json flag to the status command in src/cli.ts so scripts can parse it".`);
  } else if (VAGUE_WORDS.test(brief.goal)) {
    warn("vague_goal", "goal", `goal contains open-ended wording ("${VAGUE_WORDS.exec(brief.goal)![0]}"). Replace it with the specific items the worker must handle.`);
  }

  // Scope.
  if (WRITABLE_KINDS.has(kind) && !scope.writable) {
    err("not_writable", "scope.writable", `a ${kind} brief changes files: set scope.writable to true, or use kind scout/review for read-only work.`);
  }
  if (WRITABLE_KINDS.has(kind) || (kind === "run" && scope.writable)) {
    if (!scope.allowedPaths.length) err("missing_allowed_paths", "scope.allowedPaths", `a ${kind} brief that writes must list the paths the worker may change in scope.allowedPaths (files or globs, e.g. "src/cli.ts", "tests/cli*.test.ts").`);
    if (!writableRepository(brief)) err("missing_repository", "scope.repository", `a ${kind} brief that writes must name the repository to edit in scope.repository (the brief names ${briefRepositories(brief).length || "no"} repositories).`);
  }
  if (READ_ONLY_KINDS.has(kind) && scope.writable) {
    err("writable_read_only_kind", "scope.writable", `a ${kind} brief is read-only: set scope.writable to false, or use kind edit/implement if the worker must change files.`);
  }
  if (!scope.writable && scope.allowedPaths.length) {
    warn("allowed_paths_unused", "scope.allowedPaths", "scope.allowedPaths has no effect on a non-writable brief; remove it or set scope.writable to true.");
  }
  scope.allowedPaths.forEach((p, i) => {
    if (BROAD_PATHS.has(p.trim())) warn("broad_allowed_path", `scope.allowedPaths.${i}`, `"${p}" lets the worker change the whole repository; list the directories or files it actually needs.`);
  });

  // Checks.
  if (kind === "implement" && !brief.checks.length) {
    err("missing_checks", "checks", 'an implement brief needs at least one exact verification command in checks (e.g. "pnpm vitest run tests/cli.test.ts"); without one the result can only be claimed, never verified.');
  }
  if (kind === "run" && !brief.checks.length) {
    err("missing_run_commands", "checks", "a run brief needs the exact commands to run in checks.");
  }
  if (kind === "edit" && !brief.checks.length) {
    warn("edit_without_checks", "checks", "no checks: the edit can only be reported as CLAIMED. Add a typecheck or test command if one covers the change.");
  }
  if (kind === "run" && !scope.writable && briefRepositories(brief).length !== 1) {
    err("run_needs_one_repository", "scope.repository", "a read-only run brief runs its checks in exactly one repository: set scope.repository.");
  }
  if (new Set(brief.checks).size !== brief.checks.length) warn("duplicate_checks", "checks", "checks lists the same command more than once.");

  // Done criteria.
  brief.doneWhen.forEach((c, i) => {
    if (VAGUE_CRITERION.test(c.trim()) || words(c) < 3) {
      err("vague_criterion", `doneWhen.${i}`, `"${c}" is not observable. State what someone can check, e.g. "pnpm test passes" or "status --json prints a JSON object with a tasks array".`);
    } else if (/\bpass(es|ing)?\b/i.test(c) && !brief.checks.length) {
      warn("criterion_without_check", `doneWhen.${i}`, `"${c}" expects something to pass, but checks is empty: add the exact command to checks so the harness runs it.`);
    }
  });

  // Context.
  brief.context.files.forEach((f, i) => {
    if (!FILE_REF_RE.test(f) && !scope.repository) err("unresolved_file", `context.files.${i}`, `"${f}" has no repository alias: write it as "<alias>:${f}" or set scope.repository.`);
  });
  if ((kind === "scout" || kind === "review" || kind === "summarize") && !brief.context.files.length && !brief.context.notes) {
    warn("no_context", "context", `a ${kind} brief with no context.files or notes leaves the worker searching blind; name the files or paste what to look at.`);
  }

  // Tools.
  if (Array.isArray(brief.tools)) {
    brief.tools.forEach((t, i) => {
      if (!KNOWN_WORKER_TOOLS.has(t)) err("unknown_tool", `tools.${i}`, `"${t}" is not a worker tool. Use a profile (${TOOL_PROFILE_NAMES.join(", ")}) or names from TOOL_PROFILES.`);
      else if ((ALWAYS_ON_WORKER_TOOLS as readonly string[]).includes(t)) warn("always_on_tool", `tools.${i}`, `"${t}" is always granted; it need not be listed.`);
    });
  }
  if (!scope.writable) {
    const writes = resolveBriefTools(brief).filter((t) => WRITE_TOOLS.has(t));
    if (writes.length) err("write_tools_not_writable", "tools", `the grant includes write tools (${writes.join(", ")}) but scope.writable is false. Pick a read-only profile or set scope.writable.`);
  }

  // Budget.
  if (brief.budget?.requests !== undefined && brief.budget.requests < 3) {
    warn("tiny_budget", "budget.requests", `${brief.budget.requests} model request(s) is rarely enough to read, act and report; most briefs need at least 3.`);
  }
  return { errors, warnings };
}

export interface BriefCheck extends BriefLint {
  /** The parsed brief when the input matched the schema. */
  brief?: BriefV1;
  /** True when the brief parsed and has no lint errors. */
  ok: boolean;
}

/** Validate raw input against the schema and lint it; schema problems are reported as errors. */
export function checkBrief(input: unknown): BriefCheck {
  const parsed = BriefV1Schema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, warnings: [], errors: parsed.error.issues.map((i) => ({ code: "schema", field: i.path.join("."), message: i.message })) };
  }
  const lint = lintBrief(parsed.data);
  return { ...lint, brief: parsed.data, ok: lint.errors.length === 0 };
}

/** The existing task profile that runs a brief of this kind. */
export function taskProfileFor(brief: Pick<BriefV1, "kind" | "scope">): WorkerTaskInput["profile"] {
  switch (brief.kind) {
    case "scout":
      return "inspect";
    case "summarize":
      return "summarize";
    case "review":
      return "review";
    case "edit":
    case "implement":
      return "implement";
    case "run":
      // A run that may write (e.g. a code generator) needs a worktree; otherwise the read-only
      // runner runs declared checks.
      return brief.scope.writable ? "implement" : "inspect";
  }
}

/**
 * Map a brief onto the existing task contract (WorkerTaskSchema; also a valid submit_tasks
 * TaskArgument). Throws BriefError when the brief does not parse or has lint errors. The tool
 * grant and report detail have no place in today's task contract: read them from the brief with
 * `resolveBriefTools` and `brief.report.detail`.
 */
export function briefToTaskArgument(input: BriefV1Input | BriefV1): WorkerTaskInput {
  const check = checkBrief(input);
  if (!check.ok || !check.brief) throw new BriefError(check.errors);
  const brief = check.brief;
  const profile = taskProfileFor(brief);
  const coding = profile === "implement";
  const fileRefs = brief.context.files.map((f) => (FILE_REF_RE.test(f) ? f : `${brief.scope.repository}:${f.replace(/^\.?\//, "")}`));
  const task: WorkerTaskInput = {
    profile,
    goal: brief.goal,
    repositoryAliases: briefRepositories(brief),
    context: {
      ...(fileRefs.length ? { fileRefs } : {}),
      ...(brief.context.notes ? { inlineText: brief.context.notes } : {}),
    },
    constraints: {
      acceptanceCriteria: [...brief.doneWhen],
      ...(coding ? { allowedPaths: [...brief.scope.allowedPaths] } : {}),
      ...(brief.checks.length ? { checks: [...brief.checks] } : {}),
    },
  };
  if (coding) task.writableRepository = writableRepository(brief);
  const profileName = Array.isArray(brief.tools) ? undefined : brief.tools ?? brief.kind;
  task.tools = { ...(profileName ? { profile: profileName } : {}), allow: resolveBriefTools(brief) };
  if (brief.budget?.requests !== undefined) task.budget = { maxModelRequests: brief.budget.requests };
  if (brief.idempotencyKey) task.idempotencyKey = brief.idempotencyKey;
  if (brief.label) task.label = brief.label;
  return task;
}
