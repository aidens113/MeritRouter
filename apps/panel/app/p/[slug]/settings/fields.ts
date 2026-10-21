/**
 * Labels, help, and editors for the project settings page's overrides. Help paraphrases the
 * comments in packages/router/src/config/schema.ts and src/projects/schema.ts. Shared by the
 * server page (which pairs each entry with the router's values) and the client forms.
 */

export type OverrideKind = "int" | "number" | "bool" | "enum" | "list" | "text" | "yaml" | "role" | "autoApprove";

export interface OverrideMeta {
  label: string;
  help: string;
  kind: OverrideKind;
  options?: string[];
  min?: number;
  max?: number;
  unit?: string;
  /** Shown as the global value when the install-wide config leaves the key unset. */
  unsetNote?: string;
}

/** One override row as the client forms receive it: the meta plus the router's values. */
export interface OverrideItem extends OverrideMeta {
  id: string;
  path: string[];
  global: unknown;
  overridden: boolean;
  override: unknown;
}

const IMPORTANCE = ["low", "normal", "high", "critical"];

export const VERIFICATION_META: Record<string, OverrideMeta> = {
  default_importance: { label: "Default importance", kind: "enum", options: IMPORTANCE, help: "Importance a task gets when its brief does not say. Higher importance means stronger verification (more checks, an independent review)." },
  inherit_parent_importance: { label: "Workers inherit a job's importance", kind: "bool", help: "A critical job makes its workers' tasks at least as important." },
  max_total_requests_per_task: { label: "Requests per task, all purposes", kind: "int", min: 1, unit: "requests", help: "A task's total model requests across execution, review, and repair." },
  reviewer_qualification: { label: "Reviewer qualification", kind: "enum", options: ["preferred", "required"], help: "Preferred: qualified reviewers first, otherwise a reviewer at the size floor (marked unqualified). Required: deep review without a qualified reviewer is inconclusive." },
  review_strict_pass_threshold: { label: "Strict reviewer pass rate", kind: "number", min: 0, max: 1, help: "Pass rate on T3 review evaluations a reviewer needs for strict reviews (0 to 1)." },
  strict_acceptor: { label: "Strict results accepted by", kind: "enum", options: ["supervisor", "human"], help: "Who accepts results verified at the strict level: the job's supervisor, or only a person." },
  audit_sample_rate: { label: "Audit sample rate", kind: "number", min: 0, max: 1, help: "Share of passed results re-reviewed in the background to calibrate reviewers (0 turns audits off). Audits never change acceptance." },
  audit_max_requests: { label: "Requests per audit", kind: "int", min: 1, max: 20, unit: "requests", help: "Model requests one audit review may use." },
  audit_min_free_fraction: { label: "Skip audits below free allocation", kind: "number", min: 0, max: 1, help: "Audits are skipped while less than this share of the hourly or daily request allocation is left." },
  cache_verdicts: { label: "Reuse review verdicts", kind: "bool", help: "Reuse a pass or fail for the same contract, artifact, policy, and sources instead of reviewing again." },
  version: { label: "Policy version", kind: "int", min: 1, help: "Bump by hand when the policy changes meaning; recorded with every verdict." },
  levels: { label: "Verification levels", kind: "yaml", help: "What each level (basic, standard, deep, strict) runs: checks, review, and acceptance. Keys you give are merged onto the global levels." },
  matrix: { label: "Tier and importance matrix", kind: "yaml", help: "The level each tier uses at each importance (T1 to T3 by low, normal, high, critical). Merged onto the global matrix." },
  floors: { label: "Importance floors", kind: "yaml", help: "Rules that raise a task's importance when it matches (for example by path). A list here replaces the global list." },
  rules: { label: "Verification rules", kind: "yaml", help: "Rules that require a minimum level or add checks when a task matches. A list here replaces the global list." },
  budget: { label: "Review and repair budget", kind: "yaml", help: "Requests reserved for review per level, and for each quality retry." },
  failure: { label: "Failure handling", kind: "yaml", help: "Quality retries, and what happens when evidence is missing or the verification budget runs out." },
};

export const TEAM_META: Record<string, OverrideMeta> = {
  max_agents: { label: "Agents per job", kind: "int", min: 1, unit: "agents", unsetNote: "not set (8)", help: "Most tasks of one job running at the same time. Tasks over the cap wait queued." },
  max_depth: { label: "Supervisor levels", kind: "int", min: 1, max: 5, unit: "levels", help: "How deep a job tree may go: 1 disables sub-supervisors, 2 allows one level of them." },
  child_budget_share: { label: "Sub-supervisor budget share", kind: "number", min: 0.01, max: 1, help: "Share of the parent's remaining request budget a sub-supervisor gets (0 to 1)." },
  channel_max_posts_per_task: { label: "Channel posts per worker", kind: "int", min: 1, max: 1000, unit: "posts", help: "Posts one worker task may make to its job's team channel." },
  channel_max_posts_per_supervisor: { label: "Channel posts per supervisor", kind: "int", min: 1, max: 1000, unit: "posts", help: "Posts a job's supervisor may make to its own team channel." },
  channel_max_post_chars: { label: "Longest channel post", kind: "int", min: 100, max: 2000, unit: "characters", help: "Longest team-channel post." },
};

export const COMMANDS_META: Record<string, OverrideMeta> = {
  "coding.allowed_commands": { label: "Coding workers: allowed commands", kind: "list", help: "Command patterns coding workers may run (OpenCode permission syntax, e.g. pnpm test*). Everything else is denied. A list here replaces the global one." },
  "coding.protected_paths": { label: "Protected paths", kind: "list", help: "Files whose modification blocks a 'met' result (tests, evaluators), so a worker cannot pass by weakening tests. A list here replaces the global one." },
  "supervisor.allowed_commands": { label: "Supervisors: allowed commands", kind: "list", help: "Commands a job's supervisor may run in its integration worktree, besides its briefs' checks." },
  "supervisor.branch_prefix": { label: "Branch prefix", kind: "text", help: "Jobs commit to <prefix><job id> in this project's repositories. Pushing is never automatic." },
};

export const ROLE_HELP: Record<string, string> = {
  supervisor: "Plans, delegates, verifies, and integrates jobs.",
  summarizer: "Runs summarize tasks.",
  inspector: "Runs inspect tasks (simple repository lookups).",
  analyst: "Runs analyze tasks (cross-file reasoning).",
  implementer: "Runs implement tasks (code edits in a worktree).",
  reviewer: "Runs review tasks.",
  classifier: "The difficulty classifier.",
};

export const BRAIN_META: Record<string, OverrideMeta> = {
  access_approver: {
    label: "Access requests decided by",
    kind: "enum",
    options: ["supervisor", "human", "auto"],
    help: "Who decides this project's workers' requests for more brain access: the job's supervisor, you (on the Brain page), or automatically.",
  },
  auto_approve: { label: "Auto-approve rules", kind: "autoApprove", help: "Requests matching a rule are approved without asking, when the rule's access covers what is asked and the worker's tier is high enough. A list here replaces the global rules." },
};

/** Meta for an override id (`verification.levels`, `team.max_agents`, `roles.reviewer`, ...). */
export function metaFor(id: string): OverrideMeta {
  const [section, key = ""] = id.split(".");
  if (section === "verification") return VERIFICATION_META[key] ?? { label: key.replace(/_/g, " "), kind: "yaml", help: "Merged onto the global value." };
  if (section === "team") return TEAM_META[key] ?? { label: key, kind: "int", help: "" };
  if (section === "coding" || section === "supervisor") return COMMANDS_META[id] ?? { label: key, kind: "text", help: "" };
  if (section === "roles") return { label: key, kind: "role", unsetNote: "built-in charter and grants", help: `${ROLE_HELP[key] ?? ""} A role set here replaces the global entry for this role in this project.`.trim() };
  if (section === "brain") return BRAIN_META[key] ?? { label: key, kind: "yaml", help: "" };
  return { label: id, kind: "yaml", help: "" };
}
