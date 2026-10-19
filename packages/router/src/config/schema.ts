import { z } from "zod";
import { unsafePoolName } from "../gateway/freellmapi.js";

export const PROFILE_NAMES = ["summarize", "inspect", "analyze", "implement", "review"] as const;
export const ProfileNameSchema = z.enum(PROFILE_NAMES);
export type ProfileName = z.infer<typeof ProfileNameSchema>;

export const ProfileModeSchema = z.enum(["completion", "read_only", "coding"]);
export type ProfileMode = z.infer<typeof ProfileModeSchema>;

export const ToolPolicySchema = z.enum([
  "none",
  "repository_read",
  "repository_read_and_artifacts",
  "scoped_edit_and_checks",
]);
export type ToolPolicy = z.infer<typeof ToolPolicySchema>;

const ProfileSchema = z
  .object({
    mode: ProfileModeSchema,
    min_total_parameters_b: z.number().positive(),
    /** FreeLLMAPI curated chain, e.g. `auto:switchyard-summary`. */
    gateway_model: z
      .string()
      .regex(/^auto:[A-Za-z0-9._-]+$/, "gateway_model must be a curated auto:<chain> name")
      .superRefine((m, ctx) => {
        const reason = unsafePoolName(m);
        if (reason) ctx.addIssue({ code: "custom", message: reason });
      }),
    max_model_requests: z.number().int().positive().default(1),
    max_input_tokens: z.number().int().positive().optional(),
    max_output_tokens: z.number().int().positive().default(4000),
    tools: ToolPolicySchema.default("none"),
    workspace: z.enum(["none", "isolated_worktree"]).default("none"),
    requires_tools: z.boolean().optional(),
    requires_structured_output: z.boolean().default(false),
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
      ctx.addIssue({ code: "custom", message: "coding profiles must use workspace: isolated_worktree" });
    }
    if (p.mode === "coding" && p.batching.enabled) {
      ctx.addIssue({ code: "custom", message: "coding profiles cannot enable batching" });
    }
    if (p.mode !== "completion" && p.batching.enabled) {
      ctx.addIssue({ code: "custom", message: "only completion profiles may enable prompt batching" });
    }
    if (p.mode === "completion" && p.tools !== "none") {
      ctx.addIssue({ code: "custom", message: "completion profiles cannot use tools" });
    }
  });
export type ProfileConfig = z.infer<typeof ProfileSchema>;

const RepositorySchema = z
  .object({
    path: z.string().min(1),
    writable: z.boolean().default(true),
  })
  .strict();

export const ConfigSchema = z
  .object({
    version: z.literal(1),
    gateway: z
      .object({
        adapter: z.literal("freellmapi"),
        base_url: z.string().url(),
        api_key_env: z.string().min(1).default("FREELLMAPI_API_KEY"),
        request_timeout_seconds: z.number().int().positive().default(300),
        /**
         * Bypass FreeLLMAPI's response cache. Its cache key ignores the client key, so entries
         * are shared across clients; bypass by default.
         */
        bypass_cache: z.boolean().default(true),
        /** Dashboard session token for FreeLLMAPI's /api admin routes (pool verification, keys). */
        admin_token_env: z.string().min(1).default("FREELLMAPI_ADMIN_TOKEN"),
        /** Refuse live dispatch unless pool membership was verified through the admin API. */
        require_verified_pools: z.boolean().default(true),
        pool_verification_ttl_seconds: z.number().int().positive().default(600),
      })
      .strict(),
    storage: z.object({ directory: z.string().min(1).default(".switchyard") }).strict().prefault({}),
    models: z
      .object({
        /** Endpoint metadata overlay (YAML), relative to the config file. */
        file: z.string().min(1),
        /** Metadata older than this is not eligible for live routing. */
        max_metadata_age_days: z.number().int().positive().default(30),
      })
      .strict(),
    repositories: z.record(z.string().regex(/^[A-Za-z0-9._-]+$/), RepositorySchema).default({}),
    execution: z
      .object({
        max_concurrent_tasks: z.number().int().positive().default(2),
        max_concurrent_writers_per_repository: z.number().int().positive().default(1),
        max_model_requests_per_task: z.number().int().positive().default(12),
        job_timeout_seconds: z.number().int().positive().default(1200),
        lease_seconds: z.number().int().min(10).default(60),
        on_capacity_exhausted: z.enum(["queue", "fail"]).default("queue"),
        continuation_after_client_exit: z.literal(false).default(false),
        max_invalid_output_retries: z.number().int().min(0).max(3).default(1),
        await_max_seconds: z.number().int().positive().default(240),
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
    profiles: z.record(ProfileNameSchema, ProfileSchema),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (c.spend.paid_fallback_enabled) {
      // The FreeLLMAPI adapter cannot bound cost across hidden upstream attempts, so paid
      // routing stays unavailable rather than pretending to enforce a monetary cap.
      ctx.addIssue({
        code: "custom",
        path: ["spend", "paid_fallback_enabled"],
        message:
          "paid fallback is not supported: the gateway adapter cannot establish a cost bound across all upstream attempts",
      });
    }
    if (!c.spend.paid_fallback_enabled && c.spend.max_paid_usd_per_week !== 0) {
      ctx.addIssue({
        code: "custom",
        path: ["spend", "max_paid_usd_per_week"],
        message: "max_paid_usd_per_week must be 0 while paid fallback is disabled",
      });
    }
  });

export type RawConfig = z.infer<typeof ConfigSchema>;
