import { z } from "zod";
import { TAG_GROUPS } from "../scoring/rulebook.js";

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

const ProfileSchema = z
  .object({
    mode: ProfileModeSchema,
    /** Size floor for this task type regardless of tier. */
    min_total_parameters_b: z.number().positive().default(30),
    max_model_requests: z.number().int().positive().default(1),
    max_input_tokens: z.number().int().positive().optional(),
    max_output_tokens: z.number().int().positive().default(4000),
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
  });
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

const RepositorySchema = z.object({ path: z.string().min(1), writable: z.boolean().default(true) }).strict();

export const ROLE_NAMES = ["supervisor", "summarizer", "inspector", "analyst", "implementer", "reviewer", "classifier"] as const;
export const RoleNameSchema = z.enum(ROLE_NAMES);
export type RoleName = z.infer<typeof RoleNameSchema>;
export const BrainModeSchema = z.enum(["read", "append", "write", "admin"]);
export type BrainMode = z.infer<typeof BrainModeSchema>;

const BrainGrantSchema = z.object({ pattern: z.string().min(1), mode: BrainModeSchema }).strict();
export type BrainGrantConfig = z.infer<typeof BrainGrantSchema>;

const RoleSchema = z
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
    max_total_requests_per_task: z.number().int().positive().default(24),
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
      if (reserve + 1 > v.max_total_requests_per_task) {
        ctx.addIssue({ code: "custom", path: ["max_total_requests_per_task"], message: `level ${level} reserves ${reserve} review request(s); max_total_requests_per_task must leave at least one for execution` });
      }
    }
    const ids = [...v.floors.map((f) => f.id), ...v.rules.map((r) => r.id)];
    const dup = ids.find((id, i) => ids.indexOf(id) !== i);
    if (dup) ctx.addIssue({ code: "custom", path: ["rules"], message: `duplicate floor/rule id ${dup}` });
  });
export type VerificationConfig = z.infer<typeof VerificationConfigSchema>;

export const ConfigSchema = z
  .object({
    version: z.literal(1),
    gateway: z
      .object({
        adapter: z.literal("freellmapi"),
        base_url: z.string().url(),
        api_key_env: z.string().min(1).default("FREELLMAPI_API_KEY"),
        request_timeout_seconds: z.number().int().positive().default(300),
        /** FreeLLMAPI's cache key ignores the client key (entries are shared), so bypass by default. */
        bypass_cache: z.boolean().default(true),
        /** Dashboard session token for FreeLLMAPI's /api admin routes (catalog, chains, keys). */
        admin_token_env: z.string().min(1).default("FREELLMAPI_ADMIN_TOKEN"),
        /** Refuse live dispatch unless the endpoint's single-model chain was verified. */
        require_verified_chains: z.boolean().default(true),
        chain_verification_ttl_seconds: z.number().int().positive().default(600),
      })
      .strict(),
    storage: z
      .object({
        directory: z.string().min(1).default(".switchyard"),
        /**
         * SQLite durability: `normal` (synchronous=NORMAL; a power loss may drop the last commits)
         * or `full` (synchronous=FULL; every commit is on disk first). Session logs are fsynced
         * per event either way.
         */
        durability: z.enum(["normal", "full"]).default("normal"),
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
        /** Rescan FreeLLMAPI's catalog this often from a running worker (0 disables). */
        interval_minutes: z.number().int().min(0).default(60),
        /**
         * Platforms whose every model is a free tier on your accounts. You declare this; it is
         * never inferred. OpenRouter models count as free only when their published price is 0.
         */
        free_platforms: z.array(z.string().min(1)).default([]),
        /** Output limit assumed when no source reports one (labelled "default"). */
        default_output_limit_tokens: z.number().int().positive().default(4096),
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
        /** Distinct models tried per model request before giving up on capacity. */
        max_endpoint_fallbacks: z.number().int().min(1).max(10).default(3),
        /** Retry a failed task once at the next tier. */
        escalate_on_failure: z.boolean().default(true),
        /** Skip platforms FreeLLMAPI reports as rate limited (GET /v1/providers). */
        respect_provider_cooldowns: z.boolean().default(true),
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
    repositories: z.record(z.string().regex(/^[A-Za-z0-9._-]+$/), RepositorySchema).default({}),
    execution: z
      .object({
        max_concurrent_tasks: z.number().int().positive().default(2),
        max_concurrent_writers_per_repository: z.number().int().positive().default(1),
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
    /** Direct paid routes (never through FreeLLMAPI). Keys live in the encrypted vault, not here. */
    paid: z
      .object({
        enabled: z.boolean().default(false),
        providers: z.record(z.string().regex(/^[a-z0-9-]+$/), PaidProviderSchema).default({}),
        models: z.array(PaidModelSchema).default([]),
        budgets: z
          .object({
            per_day_usd: z.number().min(0).optional(),
            per_week_usd: z.number().min(0).default(0),
            per_month_usd: z.number().min(0).optional(),
          })
          .strict()
          .prefault({}),
        tiers: z
          .object({ T1: PaidPolicySchema.default("never"), T2: PaidPolicySchema.default("never"), T3: PaidPolicySchema.default("never"), T4: PaidPolicySchema.default("never") })
          .strict()
          .prefault({}),
        /** Paid endpoints tried per request after free ones (they never count toward free fallbacks). */
        max_paid_attempts: z.number().int().min(1).max(5).default(2),
      })
      .strict()
      .prefault({}),
    /** Shared knowledge: a git repository of markdown working documents. */
    brain: z
      .object({
        /** Brain repository directory (created and git-initialised when missing). `~` expands to home. */
        path: z.string().min(1).default("~/.switchyard/brain"),
        /** Project scope this config works in: brain/projects/<project>/. */
        project: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/).default("default"),
        /** Map brain path prefixes to existing folders (e.g. a repository's docs/working). */
        /** commit: let SwitchYard commit into the mounted folder's repository (off: you commit). */
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
      })
      .strict()
      .prefault({}),
    /** Per-role charters and brain access. */
    roles: z.partialRecord(RoleNameSchema, RoleSchema).default({}),
    /** Standalone supervisor settings (used by the supervise task type). */
    supervisor: z
      .object({
        /** Endpoint ids to use, in order. Empty: route like any T3 task (most capable). */
        endpoints: z.array(z.string().min(1)).default([]),
        paid_policy: PaidPolicySchema.default("never"),
        max_concurrent_jobs: z.number().int().positive().default(1),
        /** Alias of `team.max_agents` (which wins when both are set); see `maxAgentsPerJob`. */
        max_workers_per_job: z.number().int().positive().optional(),
        /** Wall-clock limit for one job. */
        job_timeout_seconds: z.number().int().positive().default(14_400),
        /** Commands the supervisor may run in its integration worktree (plus its briefs' checks). */
        allowed_commands: z.array(z.string().min(1)).default([]),
        /** Supervisors commit to switchyard/job-<id>; pushing is never automatic. */
        branch_prefix: z.string().regex(/^[A-Za-z0-9._/-]+$/).default("switchyard/job-"),
        /** How long ask_user waits for an answer before the job pauses as interrupted. */
        question_timeout_seconds: z.number().int().positive().default(86_400),
      })
      .strict()
      .prefault({}),
    /** Agent teams: how one job's task graph runs. */
    team: z
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
         * below `provider_concurrency_max`. FreeLLMAPI v0.2.1 reports no concurrency limit.
         */
        provider_concurrency_limits: z.record(z.string().min(1), z.number().int().min(1).max(256)).default({}),
      })
      .strict()
      .prefault({}),
    coding: z
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
        /** Files whose modification blocks a "met" acceptance status (tests, evaluators). */
        protected_paths: z.array(z.string()).default(["**/*.test.*", "**/*.spec.*", "**/test/**", "**/tests/**", "**/__tests__/**"]),
      })
      .strict()
      .prefault({}),
    /** Importance and verification policy: what evidence a result needs before it is accepted. */
    verification: VerificationConfigSchema.prefault({}),
    panel: z
      .object({
        port: z.number().int().positive().default(4477),
        /** Env var holding a login token for the panel; unset means localhost-only, no login. */
        token_env: z.string().min(1).default("SWITCHYARD_PANEL_TOKEN"),
      })
      .strict()
      .prefault({}),
    profiles: z.partialRecord(ProfileNameSchema, ProfileSchema),
  })
  .strict()
  .superRefine((c, ctx) => {
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
