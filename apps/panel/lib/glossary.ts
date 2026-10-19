/** Plain-language explanations for the jargon shown in the panel (used by help popovers). */
export const GLOSSARY = {
  tier:
    "Difficulty level SwitchYard assigns to each task from its rulebook score. T1 is easy (models of at least 30B parameters), T2 is moderate, T3 is hard (largest models first). T4 means 'too hard for workers': the task goes back to the supervisor.",
  t4: "T4 is not a model tier. It means the task scored above the T3 limit (or was too large or ambiguous), so it is returned to the Claude Code supervisor instead of being sent to a free model.",
  sizeFloor:
    "The smallest model (total parameters, in billions) allowed for a task type and tier. It is the larger of the task type's floor and the tier's floor. Smaller models are never used unless a force override explicitly allows it.",
  provenance:
    "Where the parameter count came from. Exact: read from Hugging Face model files or entered by you. Agreed: two independent sources agree. From name only: guessed from the model's name or description and needs your confirmation. Unknown: no source found.",
  chain:
    "Each model gets its own single-model chain in FreeLLMAPI (named sy-…). SwitchYard picks the model and FreeLLMAPI only rotates keys inside that chain, so a request can never silently land on a different model. 'Verified' means the chain was checked to contain exactly this model.",
  quarantine:
    "A model is quarantined when FreeLLMAPI reported that a different model actually served a request. SwitchYard discards that answer and stops using the model until its chain is verified again by a scan.",
  taskType:
    "What the supervisor asked for: summarize (answer from supplied text), inspect (simple repository lookups), analyze (cross-file reasoning), review (check a patch or evidence), implement (edit code in an isolated worktree).",
  prefer:
    "Smallest sufficient: try the smallest model that clears the size floor first, saving big-model quota. Most capable: try the best-qualified, largest model first.",
  freeVerified:
    "SwitchYard only routes to models it can show are free: either the platform is in your discovery.free_platforms list, or OpenRouter publishes a $0 price. Paid routing is not available yet.",
  qualification:
    "Short evaluation tasks run against a model to measure its pass rate per task family and tier. Results carry a 95% confidence interval. Qualification uses your free quota.",
  quotaScope:
    "Keys on the same provider account share one allowance. Give them the same group label so SwitchYard does not assume two keys means twice the quota.",
  override:
    "A manual correction you made in the panel. Overrides sit on top of what was discovered and survive rescans. Reset removes them.",
  eligibility:
    "For every task type and tier, whether this model can be picked and at what position. Green numbers are its rank in the candidate list; red cells list why it is excluded.",
  fallback:
    "When a model is rate limited or fails with a capacity error, SwitchYard tries the next ranked model, up to routing.max_endpoint_fallbacks per request. Every attempt counts against the task budget.",
  forceOverride:
    "Force: only the chosen model is used for that task type and tier. Prefer: the model is tried first, others remain as fallbacks. Block: the model is never used there.",
  belowFloor:
    "Lets a forced model run even though it is smaller than the size floor. Every such request is recorded. Use only when you have checked the model can do the work.",
  worker:
    "Tasks run only while a worker is active: the MCP server inside Claude Code, or `switchyard worker` in a terminal. The panel itself never runs tasks.",
  requests:
    "One model request is one physical call admitted at SwitchYard's gate. A batch of several tasks answered in one call counts once.",
  outputDefault:
    "No source reported this model's output limit, so the configured default (discovery.default_output_limit_tokens) is assumed.",
} as const;

export type GlossaryKey = keyof typeof GLOSSARY;
