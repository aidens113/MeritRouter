import { LabsConfigSchema } from "../labs/recipe.js";
import { SupervisorQualityRoutingSchema } from "../routing/supervisor-quality.js";
import { MemoryContextConfigSchema } from "../context/memory-manifest.js";
import { z } from "zod";
import { TAG_GROUPS } from "../scoring/rulebook.js";
import { BillingClassSchema } from "../providers/vault.js";
import { BUILTIN_PROVIDER_IDS } from "../providers/registry.js";
import { SEARCH_SERVICE_IDS, WEB_FETCH_BACKENDS, WEB_SEARCH_BACKEND_SETTINGS, WEB_SEARCH_BACKENDS, WEB_SEARCH_STRATEGIES } from "../web/services.js";

/** Internal numeric sentinel for request counts whose configured limit is absent. */
export const UNLIMITED_REQUESTS = Number.MAX_SAFE_INTEGER;

export const PROFILE_NAMES = ["summarize", "inspect", "analyze", "implement", "review", "supervise"] as const;
export const ProfileNameSchema = z.enum(PROFILE_NAMES);
/** Task type chosen by the supervisor: decides tools, sandbox, and output handling. */
export type ProfileName = z.infer<typeof ProfileNameSchema>;

export const TIER_NAMES = ["T1", "T2", "T3"] as const;
export const TierNameSchema = z.enum(TIER_NAMES);
export type TierName = z.infer<typeof TierNameSchema>;
/** T4 is "too difficult for workers": returned to the supervisor. */
export type TierOrRejected = TierName | "T4";

export const MODALITIES = ["text", "image", "audio", "video", "file"] as const;
export const ModalitySchema = z.enum(MODALITIES);
export type Modality = z.infer<typeof ModalitySchema>;

export const ProfileModeSchema = z.enum(["completion", "read_only", "coding", "supervisor"]);
export type ProfileMode = z.infer<typeof ProfileModeSchema>;

export const ToolPolicySchema = z.enum(["none", "repository_read", "repository_read_and_artifacts", "scoped_edit_and_checks", "supervisor"]);
export type ToolPolicy = z.infer<typeof ToolPolicySchema>;

/** Default output tokens per request for coding task types, and for every other task type. */
export const CODING_OUTPUT_TOKENS = 16000;
export const DEFAULT_OUTPUT_TOKENS = 4000;

const ProfileSchema = z
  .object({
    mode: ProfileModeSchema,
    /** Size floor for this task type regardless of tier. */
    min_total_parameters_b: z.number().positive().default(30),
    /** Null: no profile-level request cap. Worker tier/execution caps still apply. */
    max_model_requests: z.number().int().positive().nullable().optional(),
    max_input_tokens: z.number().int().positive().optional(),
    /** Output tokens reserved per request; default 16000 for coding task types (whole files), 4000 otherwise. */
    max_output_tokens: z.number().int().positive().optional(),
    tools: ToolPolicySchema.default("none"),
    workspace: z.enum(["none", "isolated_worktree"]).default("none"),
    requires_structured_output: z.boolean().default(false),
    /** When the difficulty classifier runs: only when tags could change the tier (auto). */
    classify: z.enum(["never", "auto", "always"]).default("auto"),
    /** Lowest tier this task type may use. */
    min_tier: TierNameSchema.default("T1"),
    batching: z
      .object({
        enabled: z.boolean().default(false),
        max_items: z.number().int().min(2).max(32).default(8),
        /** Output reserved per batch item; the whole response shares one output limit. */
        per_item_output_tokens: z.number().int().positive().default(1000),
      })
      .prefault({}),
  })
  .strict()
  .superRefine((p, ctx) => {
    if (p.mode === "coding" && p.workspace !== "isolated_worktree") {
      ctx.addIssue({ code: "custom", message: "coding task types must use workspace: isolated_worktree" });
    }
    if (p.mode !== "completion" && p.batching.enabled) {
      ctx.addIssue({ code: "custom", message: "only completion task types may enable prompt batching" });
    }
    if (p.mode === "completion" && p.tools !== "none") {
      ctx.addIssue({ code: "custom", message: "completion task types cannot use tools" });
    }
    if ((p.mode === "supervisor") !== (p.tools === "supervisor")) {
      ctx.addIssue({ code: "custom", message: "supervisor mode and the supervisor tool policy go together" });
    }
  })
  // A coding agent writes whole files in one reply: 4000 tokens cut them off (live check 2026-10-21).
  .transform((p) => ({
    ...p,
    max_model_requests: p.max_model_requests === undefined ? (p.mode === "supervisor" ? null : 1) : p.max_model_requests,
    max_output_tokens: p.max_output_tokens ?? (p.mode === "coding" ? CODING_OUTPUT_TOKENS : DEFAULT_OUTPUT_TOKENS),
  }));
export type ProfileConfig = z.infer<typeof ProfileSchema>;

const TierSchema = z
  .object({
    /** Highest difficulty score that maps to this tier. */
    max_score: z.number().int().min(0),
    min_total_parameters_b: z.number().positive(),
    max_model_requests: z.number().int().positive(),
    /** Prefer the smallest sufficient model (saves big-model quota) or the most capable one. */
    prefer: z.enum(["smallest_sufficient", "most_capable"]).default("smallest_sufficient"),
  })
  .strict();
export type TierConfig = z.infer<typeof TierSchema>;

const DEFAULT_TIERS = {
  T1: { max_score: 3, min_total_parameters_b: 30, max_model_requests: 4, prefer: "smallest_sufficient" },
  T2: { max_score: 7, min_total_parameters_b: 100, max_model_requests: 8, prefer: "smallest_sufficient" },
  T3: { max_score: 11, min_total_parameters_b: 100, max_model_requests: 12, prefer: "most_capable" },
} as const;

export const RepositorySchema = z.object({ path: z.string().min(1), writable: z.boolean().default(true) }).strict();
/** A repository alias as users write it (never contains `/`; see projects/context.ts for namespacing). */
export const REPOSITORY_ALIAS_RE = /^[A-Za-z0-9._-]+$/;
/** A project slug (also `brain.project`): lower case, no `/` or `:`. */
export const PROJECT_SLUG_RE = /^[a-z0-9][a-z0-9._-]*$/;

export const ROLE_NAMES = ["supervisor", "summarizer", "inspector", "analyst", "implementer", "reviewer", "classifier"] as const;
export const RoleNameSchema = z.enum(ROLE_NAMES);
export type RoleName = z.infer<typeof RoleNameSchema>;
export const BrainModeSchema = z.enum(["read", "append", "write", "admin"]);
export type BrainMode = z.infer<typeof BrainModeSchema>;

const BrainGrantSchema = z.object({ pattern: z.string().min(1), mode: BrainModeSchema }).strict();
export type BrainGrantConfig = z.infer<typeof BrainGrantSchema>;

export const RoleSchema = z
  .object({
    /** Charter markdown file overriding the built-in one (relative to the config file). */
    charter_file: z.string().min(1).optional(),
    /** Extra rules appended to the charter. */
    extra_rules: z.array(z.string()).default([]),
    /** Default brain access patterns; {project}, {effort}, {task}, {repo} are substituted. */
    brain_grants: z.array(BrainGrantSchema).optional(),
  })
  .strict();

/** When paid models may serve: never; only after every free model failed; before free ones; or for T4 work. */
export const PaidPolicySchema = z.enum(["never", "on_free_exhaustion", "preferred", "premium"]);
export type PaidPolicy = z.infer<typeof PaidPolicySchema>;

export const PaidProviderSchema = z
  .object({
    kind: z.enum(["openai_compatible", "anthropic"]),
    base_url: z.string().url(),
    /** Fetch prices from an OpenRouter-style /models endpoint at this URL (OpenRouter credits). */
    pricing_url: z.string().url().optional(),
    /** Provider balance endpoint style, when the provider exposes one. */
    balance_api: z.enum(["none", "openrouter", "deepseek"]).default("none"),
  })
  .strict();
export type PaidProviderConfig = z.infer<typeof PaidProviderSchema>;

export const PaidModelSchema = z
  .object({
    provider: z.string().regex(/^[a-z0-9-]+$/),
    model: z.string().min(1),
    display_name: z.string().optional(),
    /** Prices in USD per million tokens. Leave unset to fetch (pricing_url) or to keep the model unusable. */
    input_usd_per_million: z.number().positive().optional(),
    output_usd_per_million: z.number().positive().optional(),
    /** Price of input served from the provider's prompt cache; unset: fetched (pricing_url) or priced as ordinary input. */
    cached_input_usd_per_million: z.number().min(0).optional(),
    cache_write_input_usd_per_million: z.number().min(0).optional(),
    context_limit_tokens: z.number().int().positive(),
    output_limit_tokens: z.number().int().positive(),
    input_modalities: z.array(ModalitySchema).default(["text"]),
    supports_tools: z.boolean().default(true),
    supports_structured_output: z.boolean().default(false),
    /** Closed models do not publish sizes. Declare an assumed size, or exempt the model from size floors. */
    declared_parameters_b: z.number().positive().optional(),
    ignore_size_floor: z.boolean().default(false),
  })
  .strict();
export type PaidModelConfig = z.infer<typeof PaidModelSchema>;

const ProviderLimitFields = {
  rpm: z.number().int().positive().optional(),
  rpd: z.number().int().positive().optional(),
  tpm: z.number().int().positive().optional(),
  tpd: z.number().int().positive().optional(),
  /** Keys (or providers) sharing one provider quota: a Gemini project, a Cloudflare account. */
  quota_group: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/).optional(),
};

/** One provider key declared in config. Prefer `api_key_env`; a literal `api_key` puts a secret in the file. */
export const ProviderKeyConfigSchema = z
  .object({
    label: z.string().max(80).default(""),
    api_key_env: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional(),
    api_key: z.string().min(1).optional(),
    /** Required: whether this key is free or paid decides which routing policy applies. */
    billing_class: BillingClassSchema,
    enabled: z.boolean().default(true),
    /** Cloudflare: the account id that goes in the URL. */
    account_id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional(),
    ...ProviderLimitFields,
  })
  .strict()
  .superRefine((k, ctx) => {
    if ((k.api_key_env === undefined) === (k.api_key === undefined)) ctx.addIssue({ code: "custom", message: "set exactly one of api_key_env or api_key" });
  });
export type ProviderKeyConfig = z.infer<typeof ProviderKeyConfigSchema>;

/** `providers.<id>`: a built-in provider's keys and overrides, or a custom OpenAI-compatible provider. */
export const ProviderEntrySchema = z
  .object({
    enabled: z.boolean().default(true),
    display_name: z.string().min(1).max(80).optional(),
    /**
     * Required for a custom provider and for llamacpp (no default port); overrides a built-in's
     * base URL (a proxy, a region, a local server on another host or port).
     */
    base_url: z.string().url().optional(),
    /** Custom providers only; defaults to openai_compatible. */
    api: z.enum(["openai_compatible", "anthropic"]).optional(),
    /**
     * Send no key (a custom local server such as vLLM or LocalAI). Needs base_url. The built-in
     * local servers need no flag: ollama never takes a key, and lmstudio, llamacpp, and ovhcloud
     * run keyless when their entry has no keys.
     */
    no_key: z.boolean().default(false),
    /**
     * Local servers: the context a model gets when it sets none (Ollama's server default, from
     * OLLAMA_CONTEXT_LENGTH or VRAM; an LM Studio or llama.cpp load-time context). Budgets use it
     * when discovery cannot read a model's own context.
     */
    default_context_tokens: z.number().int().positive().optional(),
    /** Cloudflare: account id for keys that do not set their own. */
    account_id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional(),
    /** Extra request headers (OpenRouter's optional HTTP-Referer, X-OpenRouter-Title). */
    headers: z.record(z.string().regex(/^[A-Za-z0-9-]+$/), z.string()).default({}),
    /** Model list path below base_url (custom providers; default /models). */
    models_path: z.string().min(1).optional(),
    token_limit_param: z.enum(["max_tokens", "max_completion_tokens"]).optional(),
    rate_limit_headers: z.enum(["openai", "openrouter", "anthropic", "none"]).optional(),
    /**
     * How to ask this provider to cache the prompt prefix, replacing the registry's choice:
     * `cache_control` (Anthropic breakpoints), `prompt_cache_key` (OpenAI-style key), or `none`.
     * Custom providers default to `none`.
     */
    prompt_cache: z.enum(["cache_control", "prompt_cache_key", "none"]).optional(),
    keys: z.array(ProviderKeyConfigSchema).default([]),
    ...ProviderLimitFields,
  })
  .strict();
export type ProviderEntryConfig = z.infer<typeof ProviderEntrySchema>;

const PROVIDER_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ProviderTimeoutSchema = z.number().int().positive().default(300);

/**
 * `providers`: section-wide settings (`request_timeout_seconds`) beside one entry per provider
 * id. Parsed into `{ request_timeout_seconds, byId }` so the two never share a type.
 */
export const ProvidersSectionSchema = z.record(z.string(), z.unknown()).transform((raw, ctx) => {
  const timeout = ProviderTimeoutSchema.safeParse(raw.request_timeout_seconds);
  if (!timeout.success) for (const i of timeout.error.issues) ctx.addIssue({ code: "custom", message: i.message, path: ["request_timeout_seconds", ...i.path] });
  const byId: Record<string, ProviderEntryConfig> = {};
  for (const [id, value] of Object.entries(raw)) {
    if (id === "request_timeout_seconds") continue;
    if (!PROVIDER_ID.test(id)) {
      ctx.addIssue({ code: "custom", message: `provider id must match ${PROVIDER_ID}`, path: [id] });
      continue;
    }
    if ((SEARCH_SERVICE_IDS as readonly string[]).includes(id)) {
      ctx.addIssue({ code: "custom", message: `${id} is a web search service, not a model provider: put its key under web.search.${id} (api_key_env), or add it with meritrouter keys add ${id}`, path: [id] });
      continue;
    }
    const parsed = ProviderEntrySchema.safeParse(value ?? {});
    if (!parsed.success) {
      for (const i of parsed.error.issues) ctx.addIssue({ code: "custom", message: i.message, path: [id, ...i.path] });
      continue;
    }
    const e = parsed.data;
    const builtIn = BUILTIN_PROVIDER_IDS.includes(id);
    if (!builtIn && !e.base_url) ctx.addIssue({ code: "custom", message: `${id} is not a built-in provider (${BUILTIN_PROVIDER_IDS.join(", ")}); set base_url to add it as a custom provider`, path: [id, "base_url"] });
    if (builtIn && e.api !== undefined) ctx.addIssue({ code: "custom", message: "api is set only for custom providers", path: [id, "api"] });
    if (e.no_key && !e.base_url) ctx.addIssue({ code: "custom", message: "no_key needs base_url (a local or custom server)", path: [id, "no_key"] });
    if (e.no_key && e.keys.length) ctx.addIssue({ code: "custom", message: "no_key providers take no keys", path: [id, "keys"] });
    if (id === "cloudflare") {
      for (const [n, k] of e.keys.entries()) if (!k.account_id && !e.account_id) ctx.addIssue({ code: "custom", message: "Cloudflare keys need account_id (on the key or the provider)", path: [id, "keys", n, "account_id"] });
    }
    const envs = e.keys.flatMap((k) => (k.api_key_env ? [k.api_key_env] : []));
    const dup = envs.find((v, n) => envs.indexOf(v) !== n);
    if (dup) ctx.addIssue({ code: "custom", message: `api_key_env ${dup} is listed twice`, path: [id, "keys"] });
    byId[id] = e;
  }
  return { request_timeout_seconds: timeout.success ? timeout.data : 300, byId };
});
export type ProvidersConfig = z.output<typeof ProvidersSectionSchema>;

/** How much a task's result matters. Raises verification, never difficulty. */
export const IMPORTANCE_LEVELS = ["low", "normal", "high", "critical"] as const;
export const ImportanceSchema = z.enum(IMPORTANCE_LEVELS);
export type Importance = z.infer<typeof ImportanceSchema>;

/** Verification levels, weakest first. Each is a bundle of checks and review requirements. */
export const VERIFICATION_LEVELS = ["basic", "standard", "deep", "strict"] as const;
export const VerificationLevelSchema = z.enum(VERIFICATION_LEVELS);
export type VerificationLevel = z.infer<typeof VerificationLevelSchema>;

/** Named verification check (see src/verification/checks.ts); unknown names never pass. */
export const CheckNameSchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);

const VerificationRuleIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);

const tagValues = <G extends keyof typeof TAG_GROUPS>(g: G) => z.array(z.enum(TAG_GROUPS[g])).min(1).optional();

/**
 * A rule condition. Every key given must match; inside a key any listed value matches. Paths
 * are globs tested against the task's declared paths before dispatch and against the changed
 * paths of a result.
 */
export const VerificationMatchSchema = z
  .object({
    tags: z
      .object({
        kind: tagValues("kind"),
        reasoning: tagValues("reasoning"),
        novelty: tagValues("novelty"),
        risk: tagValues("risk"),
        environment: tagValues("environment"),
        ambiguity: tagValues("ambiguity"),
      })
      .strict()
      .optional(),
    profiles: z.array(ProfileNameSchema).min(1).optional(),
    changed_paths: z.array(z.string().min(1)).min(1).optional(),
    /** Known only on a result: whether files under coding.protected_paths changed. */
    protected_paths_changed: z.boolean().optional(),
  })
  .strict()
  .refine((w) => Object.values(w).some((v) => v !== undefined), { message: "a rule condition needs at least one key" });
export type VerificationMatch = z.infer<typeof VerificationMatchSchema>;

const LevelReviewSchema = z
  .object({
    required: z.boolean().optional(),
    /** Qualification family the reviewer must hold (e.g. review, review_strict). */
    qualification: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/).optional(),
    min_total_parameters_b: z.number().positive().optional(),
    /** The reviewer must not be an endpoint that served the task. */
    independent: z.boolean().optional(),
  })
  .strict();

/** A level bundle. `extends` unions checks and inherits review fields the level leaves unset. */
const VerificationLevelBundleSchema = z
  .object({
    extends: VerificationLevelSchema.optional(),
    checks: z.array(CheckNameSchema).default([]),
    review: LevelReviewSchema.optional(),
    /** supervisor: the result waits for the job's supervisor (or a human) to accept it. */
    acceptance: z.enum(["automatic", "supervisor"]).optional(),
  })
  .strict();
export type VerificationLevelBundle = z.infer<typeof VerificationLevelBundleSchema>;

const DEFAULT_LEVELS: Record<VerificationLevel, z.input<typeof VerificationLevelBundleSchema>> = {
  basic: { checks: ["output_contract", "evidence_provenance", "scope", "protected_paths"] },
  standard: { extends: "basic", checks: ["declared_checks", "criterion_evidence"] },
  deep: { extends: "standard", review: { required: true, qualification: "review", min_total_parameters_b: 100, independent: true } },
  strict: { extends: "deep", review: { qualification: "review_strict" }, acceptance: "supervisor" },
};

const MatrixRowSchema = z.object({ low: VerificationLevelSchema, normal: VerificationLevelSchema, high: VerificationLevelSchema, critical: VerificationLevelSchema }).strict();
const DEFAULT_MATRIX = {
  T1: { low: "basic", normal: "standard", high: "deep", critical: "strict" },
  T2: { low: "standard", normal: "standard", high: "deep", critical: "strict" },
  T3: { low: "deep", normal: "deep", high: "deep", critical: "strict" },
} as const;

const VerificationFloorSchema = z.object({ id: VerificationRuleIdSchema, when: VerificationMatchSchema, importance: ImportanceSchema }).strict();
export type VerificationFloor = z.infer<typeof VerificationFloorSchema>;

const VerificationRuleSchema = z
  .object({
    id: VerificationRuleIdSchema,
    when: VerificationMatchSchema,
    require_at_least: VerificationLevelSchema.optional(),
    add_checks: z.array(CheckNameSchema).min(1).optional(),
    importance: ImportanceSchema.optional(),
  })
  .strict()
  .refine((r) => r.require_at_least !== undefined || r.add_checks !== undefined || r.importance !== undefined, {
    message: "a rule needs require_at_least, add_checks, or importance",
  });
export type VerificationRule = z.infer<typeof VerificationRuleSchema>;

const DEFAULT_FLOORS: Array<z.input<typeof VerificationFloorSchema>> = [
  { id: "risk-critical", when: { tags: { risk: ["security", "data_migration"] } }, importance: "critical" },
  { id: "risk-public-api", when: { tags: { risk: ["public_api_change"] } }, importance: "high" },
];

const DEFAULT_VERIFICATION_RULES: Array<z.input<typeof VerificationRuleSchema>> = [
  { id: "refactor", when: { tags: { kind: ["refactor"] } }, require_at_least: "deep" },
  { id: "evaluator-changes", when: { protected_paths_changed: true }, require_at_least: "deep", add_checks: ["evaluator_change_review"] },
];

/** The level chain from `level` up through `extends` (the level itself first); throws on a cycle. */
export function levelChain(levels: Record<VerificationLevel, Pick<VerificationLevelBundle, "extends">>, level: VerificationLevel): VerificationLevel[] {
  const chain: VerificationLevel[] = [];
  let cur: VerificationLevel | undefined = level;
  while (cur) {
    if (chain.includes(cur)) throw new Error(`verification level ${level} has an extends cycle: ${[...chain, cur].join(" -> ")}`);
    chain.push(cur);
    cur = levels[cur].extends;
  }
  return chain;
}

export const VerificationConfigSchema = z
  .object({
    /** Bumped by hand when the policy changes meaning; the fingerprint also hashes the content. */
    version: z.number().int().positive().default(1),
    default_importance: ImportanceSchema.default("normal"),
    /** A critical parent job makes its workers' tasks at least as important. */
    inherit_parent_importance: z.boolean().default(true),
    levels: z
      .object({
        basic: VerificationLevelBundleSchema.prefault(DEFAULT_LEVELS.basic),
        standard: VerificationLevelBundleSchema.prefault(DEFAULT_LEVELS.standard),
        deep: VerificationLevelBundleSchema.prefault(DEFAULT_LEVELS.deep),
        strict: VerificationLevelBundleSchema.prefault(DEFAULT_LEVELS.strict),
      })
      .strict()
      .prefault({}),
    /** tier -> importance -> level. T4 never reaches verification (it returns to the supervisor). */
    matrix: z
      .object({ T1: MatrixRowSchema.prefault(DEFAULT_MATRIX.T1), T2: MatrixRowSchema.prefault(DEFAULT_MATRIX.T2), T3: MatrixRowSchema.prefault(DEFAULT_MATRIX.T3) })
      .strict()
      .prefault({}),
    /** Importance floors; the strongest matching floor wins. */
    floors: z.array(VerificationFloorSchema).prefault(DEFAULT_FLOORS),
    /** Level minimums, extra checks, and importance; matched before dispatch and again on the result. */
    rules: z.array(VerificationRuleSchema).prefault(DEFAULT_VERIFICATION_RULES),
    /**
     * A task's total model requests across every purpose (classification, execution, review,
     * repair). Review and repair reserves sit on top of the profile and tier execution caps,
     * within this total; an explicit task budget.maxModelRequests narrows it.
     */
    /** Null (default): no configured task-wide request ceiling; profile/task budgets still apply. */
    max_total_requests_per_task: z.number().int().positive().nullable().default(null),
    /**
     * preferred: qualified reviewers are chosen first; without one, deep review uses a reviewer
     * at the size floor and the verdict is marked reviewer_unqualified. required: deep review
     * without a qualified reviewer is inconclusive. Strict always requires review_strict.
     */
    reviewer_qualification: z.enum(["preferred", "required"]).default("preferred"),
    /** Pass rate on T3 review evaluations a reviewer needs for review_strict (strict reviews). */
    review_strict_pass_threshold: z.number().min(0).max(1).default(0.85),
    /** Requests reserved out of the task's total before execution. */
    budget: z
      .object({
        review_requests: z.partialRecord(VerificationLevelSchema, z.number().int().min(0)).default({ deep: 4, strict: 6 }),
        /** Per quality retry: a fixed count, or the execution allotment of the next tier. */
        repair_requests: z.union([z.literal("same_as_execution_at_next_tier"), z.number().int().min(0)]).default("same_as_execution_at_next_tier"),
      })
      .strict()
      .prefault({}),
    failure: z
      .object({
        max_quality_retries: z.number().int().min(0).max(3).default(1),
        /** Acceptance when required evidence is missing (a check not run, stale, or not runnable). */
        on_insufficient_evidence: z.enum(["needs_supervisor", "not_verified"]).default("needs_supervisor"),
        on_verification_budget_exhausted: z.enum(["verification_pending"]).default("verification_pending"),
      })
      .strict()
      .prefault({}),
    /** Who accepts strict results: the job's supervisor (model or Claude Code) or only a human. */
    strict_acceptor: z.enum(["supervisor", "human"]).default("supervisor"),
    /**
     * Share of passed results sampled for a background audit review (purpose audit). Audits never
     * block or change acceptance; they only calibrate reviewers and checks. 0 turns them off.
     */
    audit_sample_rate: z.number().min(0).max(1).default(0),
    /** Model requests one audit review may use (its own audit task's budget). */
    audit_max_requests: z.number().int().min(1).max(20).default(4),
    /**
     * Audits are skipped while the package allocation is tight: when less than this share of the
     * hourly or daily allocation (allocation.max_model_requests_per_*) is left.
     */
    audit_min_free_fraction: z.number().min(0).max(1).default(0.25),
    /**
     * Reuse a decisive verdict (pass or fail) for the same contract, artifact, policy, and source
     * revisions instead of running the reviewer again. A verdict at a lower level never satisfies a
     * higher one; a verdict later contradicted (false approval or rejection) is never reused.
     */
    cache_verdicts: z.boolean().default(true),
  })
  .strict()
  .superRefine((v, ctx) => {
    for (const level of VERIFICATION_LEVELS) {
      let chain: VerificationLevel[];
      try {
        chain = levelChain(v.levels, level);
      } catch (err) {
        ctx.addIssue({ code: "custom", path: ["levels", level, "extends"], message: (err as Error).message });
        continue;
      }
      const required = chain.map((l) => v.levels[l].review?.required).find((r) => r !== undefined) ?? false;
      if (required && !(v.budget.review_requests[level] ?? 0)) {
        ctx.addIssue({ code: "custom", path: ["budget", "review_requests", level], message: `level ${level} requires review; reserve at least 1 review request` });
      }
      const reserve = required ? (v.budget.review_requests[level] ?? 0) : 0;
      if (v.max_total_requests_per_task !== null && reserve + 1 > v.max_total_requests_per_task) {
        ctx.addIssue({ code: "custom", path: ["max_total_requests_per_task"], message: `level ${level} reserves ${reserve} review request(s); max_total_requests_per_task must leave at least one for execution` });
      }
    }
    const ids = [...v.floors.map((f) => f.id), ...v.rules.map((r) => r.id)];
    const dup = ids.find((id, i) => ids.indexOf(id) !== i);
    if (dup) ctx.addIssue({ code: "custom", path: ["rules"], message: `duplicate floor/rule id ${dup}` });
  });
export type VerificationConfig = z.infer<typeof VerificationConfigSchema>;

export const BrainConfigSchema = z
  .object({
    memory_context: MemoryContextConfigSchema,
    /** Brain repository directory (created and git-initialised when missing). `~` expands to home. */
    path: z.string().min(1).default("~/.MeritRouter/brain"),
    /**
     * Project scope of a single-project config (brain/projects/<project>/): with no `projects`
     * section, the config is read as one project of this name. With `projects`, it names the
     * primary project (rows from before projects existed, system tasks) when it is one of them.
     */
    project: z.string().regex(PROJECT_SLUG_RE).default("default"),
    /** Map brain path prefixes to existing folders (e.g. a repository's docs/working). */
    /** commit: let MeritRouter commit into the mounted folder's repository (off: you commit). */
    mounts: z.array(z.object({ prefix: z.string().min(1), path: z.string().min(1), commit: z.boolean().default(false) }).strict()).default([]),
    commit: z.boolean().default(true),
    /** Write each worker's report into its working document's reports/ folder. */
    worker_reports: z.boolean().default(true),
    /** Push the brain repository after commits (needs a configured remote). */
    push: z.boolean().default(false),
    current_state_max_lines: z.number().int().positive().default(150),
    compact_at_lines: z.number().int().positive().default(800),
    compact_at_ledger_entries: z.number().int().positive().default(20),
    /** Who decides workers' requests for more brain access. */
    access_approver: z.enum(["supervisor", "human", "auto"]).default("supervisor"),
    /** Requests matching these rules are approved without asking. */
    auto_approve: z.array(z.object({ pattern: z.string().min(1), mode: BrainModeSchema, min_tier: TierNameSchema.default("T1") }).strict()).default([]),
    /** A supervisor's lesson that passed the global-knowledge review also waits for a person's approval. */
    global_requires_approval: z.boolean().default(false),
  })
  .strict();
export type BrainConfig = z.infer<typeof BrainConfigSchema>;

export const SupervisorConfigSchema = z
  .object({
    routing: SupervisorQualityRoutingSchema.prefault({}),
    delivery_budget: z.object({
      total_requests: z.number().int().positive().default(600),
      supervisor_reserve_requests: z.number().int().min(0).default(80),
      validation_reserve_requests: z.number().int().min(0).default(80),
      extension_requests: z.number().int().positive().default(200),
    }).strict().prefault({}),
    /** Endpoint ids to use, in order. Empty: route like any T3 task (most capable). */
    endpoints: z.array(z.string().min(1)).default([]),
    paid_policy: PaidPolicySchema.default("on_free_exhaustion"),
    max_concurrent_jobs: z.number().int().positive().default(1),
    /** Alias of `team.max_agents` (which wins when both are set); see `maxAgentsPerJob`. */
    max_workers_per_job: z.number().int().positive().optional(),
    /** Wall-clock limit for one job. */
    job_timeout_seconds: z.number().int().positive().default(14_400),
    /** Commands the supervisor may run in its integration worktree (plus its briefs' checks). */
    allowed_commands: z.array(z.string().min(1)).default([]),
    /** Supervisors commit to meritrouter/job-<id>; pushing is never automatic. */
    branch_prefix: z.string().regex(/^[A-Za-z0-9._/-]+$/).default("meritrouter/job-"),
    /** How long ask_user waits for an answer before the job pauses as interrupted. */
    question_timeout_seconds: z.number().int().positive().default(86_400),
    /**
     * delegate (default): the supervisor's edit tools may change only coordination files (paths
     * matching `coordination_paths`, files a brief names in `shared_files`, and files of an
     * integration conflict it fixes); any other edit is refused, so implementation goes to
     * workers. allowed: the supervisor may edit anything in its integration worktree.
     */
    implementation: z.enum(["delegate", "allowed"]).default("delegate"),
    /** Globs (repository-relative) a delegating supervisor may always edit: shared docs and interface notes. */
    coordination_paths: z.array(z.string().min(1)).default(["**/*.md", "docs/**"]),
  })
  .strict();
export type SupervisorConfig = z.infer<typeof SupervisorConfigSchema>;

export const TeamConfigSchema = z
  .object({
    /**
     * Most tasks of one job running at once (default 8; `supervisor.max_workers_per_job` is an
     * alias). Enforced by the scheduler; `execution.max_concurrent_tasks` still bounds
     * everything, and tasks over the cap wait queued.
     */
    max_agents: z.number().int().positive().optional(),
    /**
     * Supervisor levels a job tree may have: a top-level job is depth 1, and a job may
     * delegate a `supervise` sub-job only while its depth is below this (default 2: one
     * level of sub-supervisors; 1 disables nesting).
     */
    max_depth: z.number().int().min(1).max(5).default(2),
    /** Share of the parent's remaining request budget a sub-supervisor is given (and the parent loses while it runs). */
    child_budget_share: z.number().gt(0).max(1).default(0.5),
    /**
     * Request budget of a delegated worker task whose brief sets no `max_requests` (it becomes the
     * task's budget.maxModelRequests). Unset: the execution cap at the brief's tier (the profile,
     * tier, and per-task caps), and the task keeps its usual verification reserves.
     */
    default_task_requests: z.number().int().positive().optional(),
    /** Requests of a job's budget new delegations may never take: kept for the supervisor's own turns. */
    supervisor_reserve_requests: z.number().int().min(0).default(4),
    /**
     * Who decides a worker's request for more model requests (request_more_budget): the job's
     * supervisor (top-level tasks: the external supervisor over MCP, or a person), auto (granted
     * while the job's pool has room, up to auto_grant_max), or human (the panel or the CLI).
     */
    budget_approver: z.enum(["supervisor", "auto", "human"]).default("supervisor"),
    /** How long a worker waits (without model requests) for a decision on its request. */
    budget_request_wait_seconds: z.number().int().positive().max(86_400).default(300),
    /** Requests for more budget one task may make (0: workers are not offered request_more_budget). */
    max_budget_requests_per_task: z.number().int().min(0).max(20).default(3),
    /** Most requests the auto approver grants per request. */
    auto_grant_max: z.number().int().positive().default(30),
    /** Posts one worker task may make to its job's team channel. */
    channel_max_posts_per_task: z.number().int().min(1).max(1000).default(10),
    /** Posts a job's supervisor may make to its own job's team channel. */
    channel_max_posts_per_supervisor: z.number().int().min(1).max(1000).default(40),
    /**
     * Longest team-channel post, in characters. At most 2000: the channel store's own limit
     * (`CHANNEL_MAX_TEXT_CHARS` in storage/channel.ts).
     */
    channel_max_post_chars: z.number().int().min(100).max(2000).default(2000),
    /**
     * Per-provider concurrency (AIMD): at most this many model requests in flight per
     * platform, across every task and process sharing the store. Off: no slot limit.
     */
    provider_concurrency_enabled: z.boolean().default(true),
    /** Slots a platform starts with (and returns to when its state is unknown). */
    provider_concurrency_start: z.number().int().min(1).max(64).default(2),
    /** Consecutive successful requests on a platform that add one slot. */
    provider_concurrency_increase_after: z.number().int().min(1).max(1000).default(5),
    /** Most slots any platform grows to. */
    provider_concurrency_max: z.number().int().min(1).max(256).default(8),
    /**
     * Confirmed per-platform ceilings (a provider's documented concurrent-request limit),
     * below `provider_concurrency_max`.
     */
    provider_concurrency_limits: z.record(z.string().min(1), z.number().int().min(1).max(256)).default({}),
  })
  .strict();
export type TeamConfig = z.infer<typeof TeamConfigSchema>;

export const CodingConfigSchema = z
  .object({
    runner: z.enum(["native", "opencode", "command"]).default("native"),
    /** Executable for the opencode runner, or the full command for the generic runner. */
    command: z.string().min(1).default("opencode"),
    /** Shell command patterns the coding agent may run (OpenCode permission syntax); everything else is denied. */
    allowed_commands: z.array(z.string().min(1)).default([]),
    /** Run even when the worktree contains its own agent config (opencode.json / .opencode). */
    allow_repo_agent_config: z.boolean().default(false),
    /** Stop the agent after this many consecutive denied model requests. */
    max_denied_requests: z.number().int().positive().default(3),
    /** Runs of the task's declared checks (run_check) one coding task may make before submitting. */
    max_check_runs_per_task: z.number().int().min(0).default(20),
    /** Files whose modification blocks a "met" acceptance status (tests, evaluators). */
    protected_paths: z.array(z.string()).default(["**/*.test.*", "**/*.spec.*", "**/test/**", "**/tests/**", "**/__tests__/**"]),
  })
  .strict();
export type CodingConfig = z.infer<typeof CodingConfigSchema>;

/** A search service's key in config (`web.search.<service>`); keys can also live in the vault. */
const SearchServiceConfigSchema = z
  .object({
    api_key_env: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional(),
    /** A literal key puts a secret in the file; prefer api_key_env or the vault. */
    api_key: z.string().min(1).optional(),
    /** Overrides the service's API root (a proxy). */
    base_url: z.string().url().optional(),
  })
  .strict()
  .refine((s) => !(s.api_key_env !== undefined && s.api_key !== undefined), { message: "set at most one of api_key_env or api_key" });

/** Default roles that get web_search and web_fetch (summarize tasks never have tools). */
export const DEFAULT_WEB_ROLES: RoleName[] = ["supervisor", "analyst", "reviewer", "implementer", "inspector"];

export const WebConfigSchema = z
  .object({
    /** Master switch for agents' web_search and web_fetch. */
    enabled: z.boolean().default(true),
    search: z
      .object({
        /**
         * The search backend pool, in order. `auto` stands for every backend not listed
         * elsewhere, in the order ollama, tavily, brave, exa, searxng. Backends without a key
         * (or SearXNG without base_url) are skipped. Empty: no web search.
         */
        backends: z
          .array(z.enum(WEB_SEARCH_BACKEND_SETTINGS))
          .default(["auto"])
          .refine((l) => new Set(l).size === l.length, { message: "list each backend once" }),
        /** spread: start at the least recently used healthy backend (free allowances add up); fallback: start at the first. */
        strategy: z.enum(WEB_SEARCH_STRATEGIES).default("spread"),
        /**
         * Optional caps per backend, counted from the web request record (searches and, for
         * ollama, fetches). A capped backend is skipped until its UTC day or month resets. No
         * built-in numbers: providers' allowances change, set your own.
         */
        limits: z
          .partialRecord(
            z.enum(WEB_SEARCH_BACKENDS),
            z.object({ per_day: z.number().int().positive().optional(), per_month: z.number().int().positive().optional() }).strict(),
          )
          .default({}),
        tavily: SearchServiceConfigSchema.optional(),
        brave: SearchServiceConfigSchema.optional(),
        exa: SearchServiceConfigSchema.optional(),
        /** A SearXNG instance (self-hosted, no key); its settings.yml must enable the json format. */
        searxng: z.object({ base_url: z.string().url().optional() }).strict().optional(),
      })
      .strict()
      .prefault({}),
    fetch: z
      .object({
        /**
         * The fetch chain, in order: builtin (MeritRouter's own SSRF-guarded fetch, free) and
         * ollama (Ollama's web_fetch, with an ollama-cloud key). A URL the SSRF guard refuses is
         * never sent to any backend.
         */
        backends: z
          .array(z.enum(WEB_FETCH_BACKENDS))
          .default(["builtin", "ollama"])
          .refine((l) => new Set(l).size === l.length, { message: "list each backend once" }),
        timeout_seconds: z.number().int().min(1).max(120).default(15),
        /** Most bytes of a page body read (after decompression). */
        max_bytes: z.number().int().min(10_000).max(20_000_000).default(2_000_000),
        max_redirects: z.number().int().min(0).max(10).default(5),
      })
      .strict()
      .prefault({}),
    /** Roles given web_search and web_fetch. */
    roles: z.array(RoleNameSchema).default(DEFAULT_WEB_ROLES),
    /** Web requests (searches and fetches) one task may make. */
    max_requests_per_task: z.number().int().min(0).default(12),
    /** Web requests the whole install may make per UTC day. */
    max_requests_per_day: z.number().int().min(0).default(300),
    /** Most results one search returns (each backend allows at least 10). */
    max_results: z.number().int().min(1).max(10).default(5),
    /** Characters of a fetched page returned inline; a longer page returns an excerpt and its artifact ref. */
    page_excerpt_chars: z.number().int().min(1000).max(14_000).default(10_000),
    /**
     * Web search inside the model call (models whose provider searches during the request). A
     * task with `hints.web: true` prefers such models and has the search turned on; a priced
     * search is paid (paid routing and budgets apply). Models that always search are never
     * routed for `hints.web: false`.
     */
    native: z
      .object({
        /** Turn on optional native search for tasks that need the web. Always-on models search regardless. */
        enabled: z.boolean().default(true),
        /**
         * Most searches one model request may make: sent as the cap where the provider takes one
         * (Anthropic `max_uses`) and used for the worst-case cost reserved before a paid request.
         */
        max_searches_per_request: z.number().int().min(1).max(20).default(5),
        /** Results per search where the provider takes a count (OpenRouter's web plugin). */
        max_results: z.number().int().min(1).max(25).default(5),
      })
      .strict()
      .prefault({}),
  })
  .strict();
export type WebConfig = z.infer<typeof WebConfigSchema>;

/** Advice for the connected outer MCP client; grants no permissions. */
export const ClientSupervisionSchema = z.object({
  dispatch_final_supervisor: z.boolean().default(false),
  workflow: z.enum(["delegated_delivery", "direct_tasks"]).default("delegated_delivery"),
  instructions: z.string().trim().max(8000).default(""),
}).strict();

export const ConfigSchema = z
  .object({
    version: z.literal(1),
    /** Removed with the external gateway: MeritRouter calls providers directly. */
    gateway: z
      .never({ error: "the gateway section is no longer supported: MeritRouter calls providers directly. Delete it and add your provider keys under providers (or in the panel's Provider keys page); request_timeout_seconds now lives under providers" })
      .optional(),
    storage: z
      .object({
        directory: z.string().min(1).default(".MeritRouter"),
        /**
         * SQLite durability: `normal` (synchronous=NORMAL; a power loss may drop the last commits)
         * or `full` (synchronous=FULL; every commit is on disk first). Session logs are fsynced
         * per event either way.
         */
        durability: z.enum(["normal", "full"]).default("normal"),
        /**
         * Where project-owned data lives: `split` (each project's rows live in its own
         * `<directory>/.MeritRouter` store; this installation store holds only coordination data)
         * or `legacy` (every project's rows live in this installation store). `setup` and `init`
         * write `split` for every config they create; existing configs keep `legacy` until migrated.
         */
        layout: z.enum(["split", "legacy"]).default("legacy"),
      })
      .strict()
      .prefault({}),
    models: z
      .object({
        /** Optional YAML with manual endpoints and per-model overrides, relative to the config file. */
        file: z.string().min(1).optional(),
        /** Metadata older than this is not eligible for live routing. */
        max_metadata_age_days: z.number().int().positive().default(30),
      })
      .strict()
      .prefault({}),
    discovery: z
      .object({
        /** Rediscover models this often from a running worker (0 disables). */
        interval_minutes: z.number().int().min(0).default(60),
        /** Opt-in: probe tool calling with one cheap request when no source reports it. */
        probe_tools: z.boolean().default(false),
        /** Most tool probes per UTC day across all providers (spends provider quota). */
        max_probe_requests_per_day: z.number().int().min(0).default(20),
        /** Removed: a model is free from its price and the key's billing class (providers.<id>.keys). */
        free_platforms: z.never({ error: "discovery.free_platforms is no longer supported: set billing_class: free_tier on the provider's keys instead" }).optional(),
        /** Removed: a model whose output limit is unknown is excluded until an override sets it. */
        default_output_limit_tokens: z.never({ error: "discovery.default_output_limit_tokens is no longer supported: set outputLimitTokens in a model override instead" }).optional(),
        /** Assign profiles automatically only with exact or agreeing parameter evidence. */
        require_confirmation_for_heuristic_params: z.boolean().default(true),
        openrouter_models_url: z.string().url().default("https://openrouter.ai/api/v1/models"),
        huggingface_api_url: z.string().url().default("https://huggingface.co/api/models"),
      })
      .strict()
      .prefault({}),
    tiers: z
      .object({ T1: TierSchema, T2: TierSchema, T3: TierSchema })
      .strict()
      .prefault(DEFAULT_TIERS),
    routing: z
      .object({
        /** Ordinary free endpoint attempts per request; definite account/model refusals do not consume this transient retry allowance. */
        max_endpoint_fallbacks: z.number().int().min(1).max(10).default(3),
        /** Retry a failed task once at the next tier. */
        escalate_on_failure: z.boolean().default(true),
        /** Rank providers whose every key is cooling down last (from key state and rate-limit headers). */
        respect_provider_cooldowns: z.boolean().default(true),
        /**
         * Keep a conversation on the model that served its last turn while that model stays
         * healthy and eligible, so the provider's prompt cache keeps working. Never moves a paid
         * model ahead of a free one.
         */
        sticky_endpoints: z.boolean().default(true),
        /**
         * Per-provider circuit breaker: after `failure_threshold` consecutive provider or
         * transport failures (5xx, timeouts, connection errors, 429s outside a reported
         * cooldown) the provider is skipped for `open_seconds`, doubling after each failed probe
         * up to `max_open_seconds`; then one probe request is let through. Invalid model output
         * never counts.
         */
        circuit_breaker: z
          .object({
            enabled: z.boolean().default(true),
            failure_threshold: z.number().int().min(1).max(100).default(5),
            open_seconds: z.number().int().min(1).default(30),
            max_open_seconds: z.number().int().min(1).default(900),
          })
          .strict()
          .prefault({}),
      })
      .strict()
      .prefault({}),
    scoring: z
      .object({
        /** Optional rulebook YAML overriding the built-in point rules. */
        rulebook_file: z.string().min(1).optional(),
        /** Classifications are reused for identical task specs. */
        cache: z.boolean().default(true),
        /** Classifier requests are batched across tasks within this window. */
        batch_window_ms: z.number().int().min(0).max(5000).default(400),
        max_batch: z.number().int().min(1).max(16).default(8),
      })
      .strict()
      .prefault({}),
    qualification: z
      .object({
        /** Once enabled, only qualified models serve a task type and tier. */
        required: z.boolean().default(false),
        trials_per_task: z.number().int().min(1).max(10).default(3),
        pass_threshold: z.number().min(0).max(1).default(0.6),
        min_trials: z.number().int().min(1).default(6),
        max_requests_per_day: z.number().int().positive().default(200),
      })
      .strict()
      .prefault({}),
    /** Repositories of a single-project config (the legacy shape); with `projects`, they live under projects.<slug>.repositories. */
    repositories: z.record(z.string().regex(REPOSITORY_ALIAS_RE), RepositorySchema).default({}),
    /**
     * Projects (one install, many projects): `projects.<slug>` holds a project's repositories,
     * brain mounts, and overrides of project-scoped settings. Validated by
     * `ProjectConfigSchema` (src/projects/schema.ts) when the config is parsed.
     */
    projects: z.record(z.string().regex(PROJECT_SLUG_RE), z.unknown()).default({}),
    execution: z
      .object({
        max_concurrent_tasks: z.number().int().positive().default(4),
        max_concurrent_writers_per_repository: z.number().int().positive().default(4),
        max_model_requests_per_task: z.number().int().positive().default(16),
        job_timeout_seconds: z.number().int().positive().default(1200),
        lease_seconds: z.number().int().min(10).default(60),
        on_capacity_exhausted: z.enum(["queue", "fail"]).default("queue"),
        continuation_after_client_exit: z.literal(false).default(false),
        max_invalid_output_retries: z.number().int().min(0).max(3).default(1),
        await_max_seconds: z.number().int().positive().default(240),
        check_timeout_seconds: z.number().int().positive().default(600),
        /**
         * Progress watchdog: a running session with no new event for this long is aborted as
         * `interrupted` (`watchdog`) and resumes from its last durable event. A tool still
         * running, a pending model request, or final checks extend the allowance to their own
         * timeouts; supervisors waiting in await_tasks or ask_user are exempt. 0 disables it.
         */
        watchdog_minutes: z.number().min(0).default(10),
      })
      .strict()
      .prefault({}),
    /** Agent sessions (durable per-run logs) and how an interrupted session is resumed. */
    sessions: z
      .object({
        /**
         * Uncommitted changes an interrupted edit left in a worktree: commit them as "recovered"
         * under the session's identity, or reset the worktree to its last commit.
         */
        recover_edits: z.enum(["commit", "reset"]).default("commit"),
      })
      .strict()
      .prefault({}),
    /** How much gateway capacity this package may consume (package allocation layer). */
    allocation: z
      .object({
        max_model_requests_per_hour: z.number().int().positive().optional(),
        max_model_requests_per_day: z.number().int().positive().optional(),
      })
      .strict()
      .prefault({}),
    /** Direct providers: built-in and custom provider settings and keys declared in config. */
    providers: ProvidersSectionSchema.prefault({}),
    /** Paid routing: policy, budgets, and configured paid models. Keys live in the vault or under providers. */
    paid: z
      .object({
        enabled: z.boolean().default(true),
        providers: z.record(z.string().regex(/^[a-z0-9-]+$/), PaidProviderSchema).default({}),
        models: z.array(PaidModelSchema).default([]),
        budgets: z
          .object({
            per_day_usd: z.number().min(0).optional(),
            per_week_usd: z.number().min(0).default(5),
            per_month_usd: z.number().min(0).optional(),
          })
          .strict()
          .prefault({}),
        tiers: z
          .object({ T1: PaidPolicySchema.default("on_free_exhaustion"), T2: PaidPolicySchema.default("on_free_exhaustion"), T3: PaidPolicySchema.default("on_free_exhaustion"), T4: PaidPolicySchema.default("never") })
          .strict()
          .prefault({}),
        /** Paid endpoints tried per request after free ones (they never count toward free fallbacks). */
        max_paid_attempts: z.number().int().min(1).max(5).default(2),
      })
      .strict()
      .prefault({}),
    /** Shared knowledge: a git repository of markdown working documents. */
    brain: BrainConfigSchema.prefault({}),
    /** Per-role charters and brain access. */
    roles: z.partialRecord(RoleNameSchema, RoleSchema).default({}),
    /** Standalone supervisor settings (used by the supervise task type). */
    supervisor: SupervisorConfigSchema.prefault({}),
    /** Host effects outside enforced repository containment require the selected trusted authority. */
    security: z.object({ outside_repository: z.enum(["disabled", "human_only", "supervisor"]).default("human_only") }).strict().prefault({}),
    /** Agent teams: how one job's task graph runs. */
    team: TeamConfigSchema.prefault({}),
    coding: CodingConfigSchema.prefault({}),
    labs: LabsConfigSchema.prefault({}),
    client_supervision: ClientSupervisionSchema.prefault({}),
    /** Importance and verification policy: what evidence a result needs before it is accepted. */
    verification: VerificationConfigSchema.prefault({}),
    /** Agents' web search and page fetch: backends, roles, budgets. */
    web: WebConfigSchema.prefault({}),
    panel: z
      .object({
        port: z.number().int().positive().default(4477),
        /** Start the panel when the MCP server or a worker starts and nothing answers on the port. */
        auto_start: z.boolean().default(true),
        /** Env var holding a login token for the panel; unset means localhost-only, no login. */
        token_env: z.string().min(1).default("MERITROUTER_PANEL_TOKEN"),
      })
      .strict()
      .prefault({}),
    profiles: z.partialRecord(ProfileNameSchema, ProfileSchema),
  })
  .strict()
  .superRefine((c, ctx) => {
    for (const [name, profile] of Object.entries(c.profiles)) {
      if (profile && name === "supervise" && profile.mode !== "supervisor") ctx.addIssue({ code: "custom", path: ["profiles", name, "mode"], message: "the reserved supervise profile must use supervisor mode" });
    }
    for (const [i, m] of c.paid.models.entries()) {
      if (!c.paid.providers[m.provider]) ctx.addIssue({ code: "custom", path: ["paid", "models", i, "provider"], message: `unknown paid provider ${m.provider}` });
    }
    if (c.paid.enabled && c.paid.budgets.per_week_usd === 0) {
      ctx.addIssue({ code: "custom", path: ["paid", "budgets", "per_week_usd"], message: "set a weekly paid budget greater than 0 to enable paid routing" });
    }
    if (c.paid.tiers.T4 !== "never" && c.paid.tiers.T4 !== "premium") {
      ctx.addIssue({ code: "custom", path: ["paid", "tiers", "T4"], message: "T4 accepts only never or premium" });
    }
    const t = c.tiers;
    if (!(t.T1.max_score < t.T2.max_score && t.T2.max_score < t.T3.max_score)) {
      ctx.addIssue({ code: "custom", path: ["tiers"], message: "tier max_score values must increase T1 < T2 < T3" });
    }
  });

export type RawConfig = z.infer<typeof ConfigSchema>;

/** Default of `team.max_agents`. */
export const DEFAULT_MAX_AGENTS = 8;

/** Tasks of one job that may run at once: `team.max_agents`, else its alias `supervisor.max_workers_per_job`, else 8. */
export function maxAgentsPerJob(cfg: { team: { max_agents?: number | undefined }; supervisor: { max_workers_per_job?: number | undefined } }): number {
  return cfg.team.max_agents ?? cfg.supervisor.max_workers_per_job ?? DEFAULT_MAX_AGENTS;
}

/** Fewest model requests a sub-supervisor is started with; a smaller carve is refused. */
export const MIN_CHILD_REQUESTS = 3;
