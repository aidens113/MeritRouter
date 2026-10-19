/**
 * Form description of the SwitchYard config. Help texts paraphrase the comments in
 * packages/router/src/config/schema.ts. Shared by the settings page (server) and form (client).
 */

export type FieldKind = "text" | "url" | "int" | "number" | "bool" | "enum" | "list" | "optInt" | "optText";

export interface Field {
  path: Array<string>;
  label: string;
  help: string;
  kind: FieldKind;
  options?: string[];
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  readOnly?: boolean;
  placeholder?: string;
}

export interface Section {
  id: string;
  title: string;
  description: string;
  fields: Field[];
}

const f = (path: string, label: string, kind: FieldKind, help: string, extra: Partial<Field> = {}): Field => ({ path: path.split("."), label, kind, help, ...extra });

export const SECTIONS: Section[] = [
  {
    id: "gateway",
    title: "Gateway (FreeLLMAPI)",
    description: "Where SwitchYard sends model requests and how it authenticates. Secrets are read from environment variables, never stored here.",
    fields: [
      f("gateway.base_url", "Gateway URL", "url", "FreeLLMAPI's OpenAI-compatible endpoint, usually ending in /v1. Admin routes are reached on the same origin.", { placeholder: "http://localhost:3001/v1" }),
      f("gateway.api_key_env", "Inference key variable", "text", "Name of the environment variable holding FreeLLMAPI's unified inference key."),
      f("gateway.admin_token_env", "Admin token variable", "text", "Name of the environment variable holding a FreeLLMAPI dashboard token. Needed to scan models, verify chains, and manage provider keys."),
      f("gateway.request_timeout_seconds", "Request timeout", "int", "Give up on a single model request after this long.", { min: 1, unit: "seconds" }),
      f("gateway.bypass_cache", "Bypass FreeLLMAPI's cache", "bool", "FreeLLMAPI's response cache is shared between clients (its key ignores who asked), so SwitchYard bypasses it by default."),
      f("gateway.require_verified_chains", "Require verified chains", "bool", "Refuse to send a request unless the model's single-model chain was checked to contain exactly that model."),
      f("gateway.chain_verification_ttl_seconds", "Chain check valid for", "int", "How long a chain verification is trusted before it is checked again.", { min: 1, unit: "seconds" }),
    ],
  },
  {
    id: "models",
    title: "Model catalog",
    description: "Manual model entries and how fresh model metadata must be.",
    fields: [
      f("models.file", "Models file", "optText", "Optional YAML with manual models and per-model corrections, relative to the config file. Leave empty for none.", { placeholder: "models.yaml" }),
      f("models.max_metadata_age_days", "Maximum metadata age", "int", "Models whose size, price, and limits were last checked longer ago than this are not routed until rescanned.", { min: 1, unit: "days" }),
      f("storage.directory", "Storage directory", "text", "Where the database, artifacts, and worktrees live (relative to the config file). Cannot change while SwitchYard is running: edit the YAML and restart.", { readOnly: true }),
    ],
  },
  {
    id: "discovery",
    title: "Discovery",
    description: "How models are found in FreeLLMAPI and how sizes and prices are verified.",
    fields: [
      f("discovery.interval_minutes", "Rescan every", "int", "A running worker rescans FreeLLMAPI's catalog this often. 0 turns automatic scans off.", { min: 0, unit: "minutes" }),
      f("discovery.free_platforms", "Free platforms", "list", "Platforms where every model is a free tier on your accounts. You declare this; it is never guessed. OpenRouter models count as free only when their published price is $0.", { placeholder: "groq" }),
      f("discovery.default_output_limit_tokens", "Default output limit", "int", "Output limit assumed when no source reports one. Such models are labelled 'default'.", { min: 1, unit: "tokens" }),
      f("discovery.require_confirmation_for_heuristic_params", "Confirm sizes guessed from names", "bool", "When a model's size comes only from its name or description, wait for you to confirm it before routing to it."),
      f("discovery.openrouter_models_url", "OpenRouter models URL", "url", "Where prices, context lengths, and Hugging Face ids are looked up."),
      f("discovery.huggingface_api_url", "Hugging Face API URL", "url", "Where exact parameter counts are read from model files."),
    ],
  },
  {
    id: "tiers",
    title: "Difficulty tiers",
    description: "The rulebook score picks a tier; each tier sets the size floor, request budget, and model order. Scores above the T3 limit go back to the supervisor (T4).",
    fields: (["T1", "T2", "T3"] as const).flatMap((t) => [
      f(`tiers.${t}.max_score`, `${t} highest score`, "int", `Highest difficulty score that still counts as ${t}. Must increase from T1 to T3.`, { min: 0, unit: "points" }),
      f(`tiers.${t}.min_total_parameters_b`, `${t} size floor`, "number", `Smallest model allowed at ${t}, in billions of parameters (the task type's own floor also applies).`, { min: 0.1, step: 0.1, unit: "B params" }),
      f(`tiers.${t}.max_model_requests`, `${t} request budget`, "int", `Most model requests one ${t} task may use.`, { min: 1, unit: "requests" }),
      f(`tiers.${t}.prefer`, `${t} model order`, "enum", "Smallest sufficient saves big-model quota; most capable tries the best-qualified, largest model first.", { options: ["smallest_sufficient", "most_capable"] }),
    ]),
  },
  {
    id: "routing",
    title: "Routing",
    description: "What happens when a model is busy or a task fails.",
    fields: [
      f("routing.max_endpoint_fallbacks", "Models tried per request", "int", "Distinct models tried for one model request before giving up on capacity.", { min: 1, max: 10 }),
      f("routing.escalate_on_failure", "Retry failures one tier up", "bool", "Retry a failed task once at the next tier (with larger models)."),
      f("routing.respect_provider_cooldowns", "Skip rate-limited platforms", "bool", "Move platforms FreeLLMAPI reports as rate limited to the end of the order until they recover."),
    ],
  },
  {
    id: "scoring",
    title: "Scoring",
    description: "How tasks are scored for difficulty. The point rules themselves are in the rulebook below.",
    fields: [
      f("scoring.rulebook_file", "Rulebook file", "optText", "Optional rulebook YAML overriding the built-in point rules, relative to the config file. Saving the rulebook editor sets this for you.", { placeholder: "rulebook.yaml" }),
      f("scoring.cache", "Reuse classifications", "bool", "Identical task specs reuse their earlier classification instead of asking the classifier again."),
      f("scoring.batch_window_ms", "Classifier batching window", "int", "Classifier requests from tasks arriving within this window share one model request.", { min: 0, max: 5000, unit: "ms" }),
      f("scoring.max_batch", "Classifier batch size", "int", "Most tasks classified in one request.", { min: 1, max: 16 }),
    ],
  },
  {
    id: "qualification",
    title: "Qualification",
    description: "Evaluation runs that measure each model's pass rate. They use free quota.",
    fields: [
      f("qualification.required", "Require qualification", "bool", "Once on, only models that passed qualification serve a task type and tier. Turn on after qualifying your models."),
      f("qualification.trials_per_task", "Trials per evaluation", "int", "How many times each evaluation runs per model in one qualification run.", { min: 1, max: 10 }),
      f("qualification.pass_threshold", "Pass threshold", "number", "Pass rate (0 to 1) a model needs to count as qualified.", { min: 0, max: 1, step: 0.05 }),
      f("qualification.min_trials", "Minimum trials", "int", "Results needed before a model can count as qualified.", { min: 1 }),
      f("qualification.max_requests_per_day", "Daily request allowance", "int", "Most model requests qualification may use in 24 hours.", { min: 1, unit: "requests" }),
    ],
  },
  {
    id: "execution",
    title: "Execution",
    description: "How many tasks run at once, how long they may take, and what happens when capacity runs out.",
    fields: [
      f("execution.max_concurrent_tasks", "Tasks at once", "int", "Most tasks a worker runs at the same time.", { min: 1 }),
      f("execution.max_concurrent_writers_per_repository", "Coding tasks per repository", "int", "Most coding tasks editing the same repository at once.", { min: 1 }),
      f("execution.max_model_requests_per_task", "Request ceiling per task", "int", "Hard ceiling on model requests for any task, regardless of tier or task type.", { min: 1, unit: "requests" }),
      f("execution.job_timeout_seconds", "Task timeout", "int", "A task that runs longer than this fails (unless it sets its own timeout).", { min: 1, unit: "seconds" }),
      f("execution.lease_seconds", "Worker lease", "int", "How long a worker's claim on a task lasts without a heartbeat. Expired leases mark the task interrupted.", { min: 10, unit: "seconds" }),
      f("execution.on_capacity_exhausted", "When every model is busy", "enum", "Queue: wait and retry later. Fail: return the task to the supervisor immediately.", { options: ["queue", "fail"] }),
      f("execution.max_invalid_output_retries", "Repair attempts", "int", "Times a model is asked to fix output that did not match the required format.", { min: 0, max: 3 }),
      f("execution.await_max_seconds", "Longest supervisor wait", "int", "Longest single wait the supervisor's await_results call may block for.", { min: 1, unit: "seconds" }),
      f("execution.check_timeout_seconds", "Check timeout", "int", "Longest a single acceptance check command may run.", { min: 1, unit: "seconds" }),
    ],
  },
  {
    id: "allocation",
    title: "Capacity allocation",
    description: "How much of your FreeLLMAPI capacity SwitchYard may use. Leave empty for no limit.",
    fields: [
      f("allocation.max_model_requests_per_hour", "Requests per hour", "optInt", "Most model requests SwitchYard may send in any hour, across all tasks.", { min: 1, placeholder: "no limit" }),
      f("allocation.max_model_requests_per_day", "Requests per day", "optInt", "Most model requests SwitchYard may send in any 24 hours.", { min: 1, placeholder: "no limit" }),
    ],
  },
  {
    id: "coding",
    title: "Coding workers",
    description: "The agent that performs implement tasks inside an isolated git worktree.",
    fields: [
      f("coding.runner", "Runner", "enum", "opencode runs the OpenCode agent; command runs any agent command you give below.", { options: ["opencode", "command"] }),
      f("coding.command", "Command", "text", "Executable for the opencode runner, or the full command line for the command runner."),
      f("coding.allowed_commands", "Allowed shell commands", "list", "Command patterns the coding agent may run (OpenCode permission syntax). Everything else is denied.", { placeholder: "pnpm test*" }),
      f("coding.allow_repo_agent_config", "Allow repository agent config", "bool", "Run even when the worktree contains its own agent config (opencode.json or .opencode)."),
      f("coding.max_denied_requests", "Stop after denied requests", "int", "Stop the agent after this many model requests in a row were refused.", { min: 1 }),
      f("coding.protected_paths", "Protected paths", "list", "Files whose modification blocks a 'met' result (tests, evaluators), so a worker cannot pass by weakening tests.", { placeholder: "**/*.test.*" }),
    ],
  },
  {
    id: "panel",
    title: "Panel",
    description: "This web panel. It always listens on 127.0.0.1 only.",
    fields: [
      f("panel.port", "Port", "int", "Port for the panel. The pnpm scripts use 4477; change both together.", { min: 1, max: 65535 }),
      f("panel.token_env", "Login token variable", "text", "Environment variable holding a login token. The panel currently reads SWITCHYARD_PANEL_TOKEN; when it is unset there is no login."),
    ],
  },
];

export const PROFILE_FIELDS = (name: string): Field[] => [
  f(`profiles.${name}.mode`, "Mode", "enum", "Completion answers from supplied text; read-only investigates repositories with tools; coding edits files in a worktree.", { options: ["completion", "read_only", "coding", "supervisor"] }),
  f(`profiles.${name}.min_total_parameters_b`, "Size floor", "number", "Smallest model for this task type at any tier, in billions of parameters.", { min: 0.1, step: 0.1, unit: "B params" }),
  f(`profiles.${name}.min_tier`, "Starts at tier", "enum", "Lowest tier this task type may use, whatever its score.", { options: ["T1", "T2", "T3"] }),
  f(`profiles.${name}.max_model_requests`, "Request budget", "int", "Most model requests one task of this type may use (also capped by its tier and the per-task ceiling).", { min: 1, unit: "requests" }),
  f(`profiles.${name}.max_input_tokens`, "Input token limit", "optInt", "Optional cap on input tokens per request. Empty means the model's context limit decides.", { min: 1, placeholder: "no limit", unit: "tokens" }),
  f(`profiles.${name}.max_output_tokens`, "Output token limit", "int", "Output tokens reserved per request.", { min: 1, unit: "tokens" }),
  f(`profiles.${name}.tools`, "Tools", "enum", "What the worker may do: nothing, read repositories, read and use artifacts, or edit within scope and run checks.", { options: ["none", "repository_read", "repository_read_and_artifacts", "scoped_edit_and_checks", "supervisor"] }),
  f(`profiles.${name}.workspace`, "Workspace", "enum", "Coding task types must use an isolated git worktree.", { options: ["none", "isolated_worktree"] }),
  f(`profiles.${name}.requires_structured_output`, "Needs structured output", "bool", "Only route to models that support JSON-schema structured output."),
  f(`profiles.${name}.classify`, "Run the classifier", "enum", "auto: only when its tags could change the tier; always; or never (rules only).", { options: ["auto", "always", "never"] }),
  f(`profiles.${name}.batching.enabled`, "Batch prompts", "bool", "Answer several compatible tasks in one model request (completion task types only)."),
  f(`profiles.${name}.batching.max_items`, "Batch size", "int", "Most tasks answered in one batched request.", { min: 2, max: 32 }),
  f(`profiles.${name}.batching.per_item_output_tokens`, "Output per batch item", "int", "Output reserved for each task in a batch; the whole response shares one output limit.", { min: 1, unit: "tokens" }),
];

export const PROFILE_HELP: Record<string, string> = {
  summarize: "Answer from text the supervisor supplies (logs, traces, documents).",
  inspect: "Simple read-only lookups in a repository.",
  analyze: "Cross-file reasoning, root causes, and repair proposals.",
  implement: "Bounded code edits in an isolated worktree, verified by checks.",
  review: "Review a patch or a piece of evidence.",
  supervise: "A standalone supervisor that plans and delegates a whole job.",
};

export function getIn(obj: unknown, path: string[]): unknown {
  let cur: unknown = obj;
  for (const k of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}
