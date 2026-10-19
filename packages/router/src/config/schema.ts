import { z } from "zod";

export const PROFILE_NAMES = ["summarize", "inspect", "analyze", "implement", "review"] as const;
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

export const ProfileModeSchema = z.enum(["completion", "read_only", "coding"]);
export type ProfileMode = z.infer<typeof ProfileModeSchema>;

export const ToolPolicySchema = z.enum(["none", "repository_read", "repository_read_and_artifacts", "scoped_edit_and_checks"]);
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
    storage: z.object({ directory: z.string().min(1).default(".switchyard") }).strict().prefault({}),
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
    spend: z
      .object({
        paid_fallback_enabled: z.boolean().default(false),
        max_paid_usd_per_week: z.number().min(0).default(0),
      })
      .strict()
      .prefault({}),
    coding: z
      .object({
        runner: z.enum(["opencode", "command"]).default("opencode"),
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
    panel: z
      .object({
        port: z.number().int().positive().default(4477),
        /** Env var holding a login token for the panel; unset means localhost-only, no login. */
        token_env: z.string().min(1).default("SWITCHYARD_PANEL_TOKEN"),
      })
      .strict()
      .prefault({}),
    profiles: z.record(ProfileNameSchema, ProfileSchema),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (c.spend.paid_fallback_enabled) {
      ctx.addIssue({
        code: "custom",
        path: ["spend", "paid_fallback_enabled"],
        message: "paid routing is not available in this release; only verified-free endpoints are routed",
      });
    }
    if (!c.spend.paid_fallback_enabled && c.spend.max_paid_usd_per_week !== 0) {
      ctx.addIssue({ code: "custom", path: ["spend", "max_paid_usd_per_week"], message: "max_paid_usd_per_week must be 0 while paid fallback is disabled" });
    }
    const t = c.tiers;
    if (!(t.T1.max_score < t.T2.max_score && t.T2.max_score < t.T3.max_score)) {
      ctx.addIssue({ code: "custom", path: ["tiers"], message: "tier max_score values must increase T1 < T2 < T3" });
    }
  });

export type RawConfig = z.infer<typeof ConfigSchema>;
