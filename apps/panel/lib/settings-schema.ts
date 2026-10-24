/**
 * Form description of the MeritRouter config. Help texts paraphrase the comments in
 * packages/router/src/config/schema.ts. Shared by the settings page (server) and form (client).
 */

export type FieldKind = "text" | "url" | "int" | "number" | "bool" | "enum" | "list" | "optInt" | "optNumber" | "optText";

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
  multiline?: boolean;
  placeholder?: string;
  /** Plain-language explanation of each enum option, shown under the select for the chosen one. */
  optionHelp?: Record<string, string>;
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
    id: "security",
    title: "Repository sandbox and outside access",
    description: "Workers stay inside their assigned repositories. Actions beyond that boundary require a recorded decision; approval never grants a worker blanket host access.",
    fields: [f("security.outside_repository", "Outside-repository actions", "enum", "Who can approve and perform an action beyond a worker's repository sandbox.", {
      options: ["disabled", "human_only", "supervisor"],
      optionHelp: {
        disabled: "Disabled: nobody can run requested actions outside the repository, including supervisors.",
        human_only: "Human approval only (default): you review and execute each exact request in the panel. Automated supervisors cannot approve it.",
        supervisor: "Supervisors and humans: an active owning supervisor may approve and perform an exact requested action. Workers remain contained.",
      },
    })],
  },
  {
    id: "client-supervision",
    title: "Claude/Codex supervision",
    description: "Choose whether MCP may dispatch MeritRouter as the final project supervisor. The external Claude/Codex client remains final supervisor by default and can delegate bounded sub-supervisors. This is separate from MeritRouter's internal job supervisors and grants no permissions. Existing MCP connections receive changes on their next tool call.",
    fields: [
      f("client_supervision.workflow", "Default delivery workflow", "enum", "The initiating client keeps FINAL review. Delegated delivery gives a qualified internal supervisor responsibility for planning, workers, integration and testing.", {options:["delegated_delivery","direct_tasks"],optionHelp:{delegated_delivery:"Default: delegate complete bounded deliveries to internal supervisors; return evidence for FINAL review.",direct_tasks:"Legacy: the initiating client coordinates individual tasks directly."}}),
      f("client_supervision.dispatch_final_supervisor", "Allow MeritRouter final project-supervisor dispatch", "bool", "Off by default: Claude/Codex owns final project review, testing and completion. Bounded MeritRouter sub-supervisors remain available. Turn on to permit explicitly project-scoped MCP jobs; you can also explicitly ask your connected model to change this setting."),
      f("client_supervision.instructions", "Custom supervision instructions", "optText", "Optional human workflow guidance, up to 8000 characters. Explicit user and repository instructions, permissions and budgets retain their authority.", { multiline: true }),
    ],
  },
  {
    id: "providers",
    title: "Providers",
    description: "MeritRouter calls each provider directly. Keys are added on the Provider keys page (or under providers in the config file).",
    fields: [f("providers.request_timeout_seconds", "Request timeout", "int", "Give up on a single model request after this long.", { min: 1, unit: "seconds" })],
  },
  {
    id: "models",
    title: "Model catalog",
    description: "Manual model entries and how fresh model metadata must be.",
    fields: [
      f("models.file", "Models file", "optText", "Optional YAML with manual models and per-model corrections, relative to the config file. Leave empty for none.", { placeholder: "models.yaml" }),
      f("models.max_metadata_age_days", "Maximum metadata age", "int", "Models whose size, price, and limits were last checked longer ago than this are not routed until rescanned.", { min: 1, unit: "days" }),
      f("storage.directory", "Storage directory", "text", "Where the database, artifacts, and worktrees live (relative to the config file). Cannot change while MeritRouter is running: edit the YAML and restart.", { readOnly: true }),
    ],
  },
  {
    id: "discovery",
    title: "Discovery",
    description: "How each provider's models are found and how sizes and prices are verified.",
    fields: [
      f("discovery.interval_minutes", "Rescan every", "int", "A running worker lists every provider's models this often. 0 turns automatic scans off.", { min: 0, unit: "minutes" }),
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
      f("routing.respect_provider_cooldowns", "Skip rate-limited platforms", "bool", "Move providers whose every key is cooling down or at a limit to the end of the order until a key is back."),
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
      f("team.max_agents", "Agents per job", "optInt", "Most tasks of one job running at the same time (team.max_agents). Tasks over the cap wait queued; Tasks at once still bounds everything. Empty: the old Workers per job setting if set, else 8.", { min: 1, placeholder: "8" }),
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
    description: "How many model requests MeritRouter may send across all providers. Leave empty for no limit.",
    fields: [
      f("allocation.max_model_requests_per_hour", "Requests per hour", "optInt", "Most model requests MeritRouter may send in any hour, across all tasks.", { min: 1, placeholder: "no limit" }),
      f("allocation.max_model_requests_per_day", "Requests per day", "optInt", "Most model requests MeritRouter may send in any 24 hours.", { min: 1, placeholder: "no limit" }),
    ],
  },
  {
    id: "coding",
    title: "Coding workers",
    description: "The agent that performs implement tasks inside an isolated git worktree.",
    fields: [
      f("coding.runner", "Runner", "enum", "Which agent performs implement tasks.", {
        options: ["native", "opencode", "command"],
        optionHelp: {
          native: "MeritRouter's own coding loop: edits are contained to allowed paths in code and every edit is committed with the agent and model that made it.",
          opencode: "Runs the OpenCode agent in the worktree, talking to models only through MeritRouter's per-task gateway.",
          command: "Runs any agent command you give below, with the same per-task gateway and worktree.",
        },
      }),
      f("coding.command", "Command", "text", "Executable for the opencode runner, or the full command line for the command runner (unused by native)."),
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
      f("panel.token_env", "Login token variable", "text", "Environment variable holding a login token. The panel currently reads MERITROUTER_PANEL_TOKEN; when it is unset there is no login."),
    ],
  },
];


const POLICY_HELP: Record<string, string> = {
  never: "Never: free models only at this tier.",
  on_free_exhaustion: "On free exhaustion: paid models may serve when eligible free routes are unavailable or unsuccessful.",
  preferred: "Preferred: eligible paid models are tried before free ones, within the configured budgets.",
  premium: "Premium: T4 work uses an eligible paid model instead of returning to the supervisor.",
};

/** Sections for the paid, brain, and supervisor settings (their list editors are separate forms). */
export const PAID_SECTION: Section = {
  id: "paid",
  title: "Paid routing",
  description: "Control costs across paid and free models. New configurations enable paid routing with a $5 weekly cap and try eligible free routes first for T1-T3. Keys are added on the Provider keys page and stored encrypted, never here.",
  fields: [
    f("paid.enabled", "Paid routing on", "bool", "Master switch. Off means no paid request is ever made, whatever the tier policies say. Needs a weekly budget above $0."),
    f("paid.budgets.per_day_usd", "Daily budget", "optNumber", "Most paid spend in any 24 hours. Empty: no daily limit.", { min: 0, unit: "USD", placeholder: "no limit" }),
    f("paid.budgets.per_week_usd", "Weekly budget", "number", "Most paid spend in any 7 days. New configurations default to $5. A positive weekly budget is required while paid routing is enabled.", { min: 0, unit: "USD" }),
    f("paid.budgets.per_month_usd", "Monthly budget", "optNumber", "Most paid spend in any 30 days. Empty: no monthly limit.", { min: 0, unit: "USD", placeholder: "no limit" }),
    ...(["T1", "T2", "T3"] as const).map((t) =>
      f(`paid.tiers.${t}`, `${t} paid policy`, "enum", `When paid models may serve ${t} tasks.`, { options: ["never", "on_free_exhaustion", "preferred"], optionHelp: POLICY_HELP }),
    ),
    f("paid.tiers.T4", "T4 paid policy", "enum", "Whether T4 work returns to the supervisor or uses an eligible paid model.", { options: ["never", "premium"], optionHelp: { never: "Never: T4 work goes back to the supervisor.", premium: POLICY_HELP.premium! } }),
    f("paid.max_paid_attempts", "Paid models tried per request", "int", "Maximum paid endpoints tried per request, in the order chosen by the tier policy. Separate from the free-attempt limit.", { min: 1, max: 5 }),
  ],
};

export const BRAIN_SECTION: Section = {
  id: "brain",
  title: "Brain (shared knowledge)",
  description: "The git repository of markdown working documents shared by supervisors and workers.",
  fields: [
    f("brain.path", "Brain repository", "text", "Directory of the brain repository (created and git-initialised when missing). Relative to the config file; ~ means your home folder."),
    f("brain.project", "Project", "text", "Project scope this config works in: documents live under projects/<project>/. Lowercase letters, digits, dots, dashes."),
    f("brain.commit", "Commit every write", "bool", "Commit each write under the writing agent's identity and model, so history and blame show who wrote what."),
    f("brain.push", "Push after commits", "bool", "Push the brain repository after each commit (needs a configured remote)."),
    f("brain.worker_reports", "Worker reports", "bool", "Write each worker's report into its working document's reports/ folder."),
    f("brain.current_state_max_lines", "Current State line limit", "int", "Longest a working document's Current State may be; longer saves are rejected.", { min: 1, unit: "lines" }),
    f("brain.compact_at_lines", "Compact at document length", "int", "Suggest moving ledger history to the archive once a working document is this long.", { min: 1, unit: "lines" }),
    f("brain.compact_at_ledger_entries", "Compact at ledger entries", "int", "Suggest compaction once the Work Ledger has this many entries.", { min: 1, unit: "entries" }),
    f("brain.access_approver", "Access requests decided by", "enum", "Who decides workers' requests for more brain access.", {
      options: ["supervisor", "human", "auto"],
      optionHelp: {
        supervisor: "Supervisor: the job's supervisor approves or denies (you can still decide on the Brain page).",
        human: "You: requests wait on the Brain page until you decide.",
        auto: "Auto: every request is approved at once.",
      },
    }),
  ],
};

export const SUPERVISOR_SECTION: Section = {
  id: "supervisor",
  title: "Supervisor (jobs)",
  description: "How standalone jobs are supervised. Used by the supervise task type.",
  fields: [
    f("supervisor.endpoints", "Supervisor models", "list", "Optional endpoint pool. Eligible models are ranked by current supervisor quality evidence across providers; vendor names and size alone do not qualify. Configure supervisor.routing.quality_evidence in YAML.", { placeholder: "provider/model-id" }),
    f("supervisor.delivery_budget.total_requests", "Delivery request budget", "int", "Default ceiling for delegated delivery, including supervisor, workers and validation. Explicit smaller task or profile limits still apply.", {min:1,unit:"requests"}),
    f("supervisor.delivery_budget.supervisor_reserve_requests", "Supervisor reserve", "int", "Requests protected from worker grants for planning and integration.", {min:0,unit:"requests"}),
    f("supervisor.delivery_budget.validation_reserve_requests", "Validation reserve", "int", "Requests protected until integration, validation and handoff.", {min:0,unit:"requests"}),
    f("supervisor.delivery_budget.extension_requests", "Requested extension", "int", "Default amount requested upward when a delivery needs more budget. Approval and ancestor ceilings still apply.", {min:1,unit:"requests"}),
    f("supervisor.paid_policy", "Paid policy for supervisors", "enum", "Whether a job's supervisor may use paid models.", { options: ["never", "on_free_exhaustion", "preferred", "premium"], optionHelp: POLICY_HELP }),
    f("supervisor.max_concurrent_jobs", "Jobs at once", "int", "Most jobs running at the same time.", { min: 1 }),
    f("supervisor.max_workers_per_job", "Workers per job (old name)", "optInt", "Old name for Agents per job (Execution, team.max_agents), used only when that is empty. Leave empty.", { min: 1 }),
    f("supervisor.job_timeout_seconds", "Job time limit", "int", "Wall-clock limit for one job.", { min: 1, unit: "seconds" }),
    f("supervisor.question_timeout_seconds", "Wait for an answer", "int", "How long a supervisor waits for your answer to a question before deciding with a sensible default.", { min: 1, unit: "seconds" }),
    f("supervisor.branch_prefix", "Branch prefix", "text", "Jobs commit to <prefix><job id>. Pushing is never automatic."),
    f("supervisor.allowed_commands", "Allowed commands", "list", "Commands the supervisor may run in its integration worktree, besides its briefs' checks.", { placeholder: "pnpm test*" }),
  ],
};

export const WEB_SECTION: Section = {
  id: "web",
  title: "Web search",
  description: "Lets agents search the web and read pages (web_search, web_fetch). Every configured search backend serves, like model providers: a failing backend is skipped within the same call, cooled down, or marked. Results are untrusted data, budgets are enforced in code, and local or private addresses are never fetched. Search-service keys are added on the Provider keys page.",
  fields: [
    f("web.enabled", "Web access on", "bool", "Master switch. Off: no agent gets web_search or web_fetch."),
    f("web.search.backends", "Search backends", "list", "The pool, in order: ollama, tavily, brave, exa, searxng, or auto (every backend not listed, in that order). Backends without a key are skipped; a backend you name here without a key gets a doctor warning.", { placeholder: "auto" }),
    f("web.search.strategy", "Strategy", "enum", "Which backend a search starts at. Either way a failing backend is skipped within the same call.", {
      options: ["spread", "fallback"],
      optionHelp: {
        spread: "Spread: start at the least recently used healthy backend, so the free allowances of every backend add up.",
        fallback: "Fallback: start at the first backend in the list; later ones serve only when it fails, cools down, or is capped.",
      },
    }),
    f("web.search.searxng.base_url", "SearXNG instance", "optText", "URL of a SearXNG instance. Its settings.yml must allow the json format.", { placeholder: "https://searx.example.org" }),
    f("web.fetch.backends", "Page fetch chain", "list", "In order: builtin (MeritRouter's own fetch, free; http(s) only, every address checked against local and private ranges, also after each redirect) and ollama (Ollama's web_fetch with an ollama-cloud key). The next one is tried when one fails; a URL the guard refused is never sent anywhere.", { placeholder: "builtin" }),
    f("web.roles", "Roles with web access", "list", "Roles that get web_search and web_fetch: supervisor, inspector, analyst, implementer, reviewer. Summarize tasks never have tools.", { placeholder: "analyst" }),
    f("web.max_requests_per_task", "Web calls per task", "int", "web_search and web_fetch calls one task may make (a call that moves on to a second backend counts once). Past it, the tool tells the agent to continue with what it has.", { min: 0, unit: "calls" }),
    f("web.max_requests_per_day", "Web calls per day", "int", "Calls the whole install may make per UTC day.", { min: 0, unit: "calls" }),
    f("web.max_results", "Results per search", "int", "Most results one search returns.", { min: 1, max: 10 }),
    f("web.page_excerpt_chars", "Page excerpt", "int", "Characters of a page returned inline; a longer page is stored as an artifact and returned as an excerpt plus its reference.", { min: 1000, max: 14000, unit: "characters" }),
    f("web.fetch.timeout_seconds", "Request timeout", "int", "Longest one search or page fetch attempt may take.", { min: 1, max: 120, unit: "seconds" }),
    f("web.fetch.max_bytes", "Largest page", "int", "Most bytes of a page body read (after decompression).", { min: 10000, max: 20000000, unit: "bytes" }),
    f("web.fetch.max_redirects", "Redirects followed", "int", "Most redirects the built-in fetch follows; each target is checked again.", { min: 0, max: 10 }),
  ],
};

/** Defaults for adding the supervise task type from the panel (mirrors the standalone preset). */
export const SUPERVISE_PROFILE_DEFAULT = {
  mode: "supervisor",
  tools: "supervisor",
  min_total_parameters_b: 100,
  max_model_requests: null,
  max_output_tokens: 8000,
  classify: "never",
  min_tier: "T3",
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
