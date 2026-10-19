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
    "SwitchYard only routes to models it can show are free: either the platform is in your discovery.free_platforms list, or OpenRouter publishes a $0 price. Paid models are separate direct routes, used only under the paid policy you set.",
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
  job:
    "A standalone piece of work handed to a SwitchYard supervisor: it plans, delegates bounded tasks to workers, checks their results, and integrates their commits onto a job branch for you to review and merge.",
  supervisor:
    "The model (or Claude Code) that plans the work and delegates tasks to workers. In a job, SwitchYard runs the supervisor itself using the models you configured under supervisor.",
  brain:
    "Shared knowledge for supervisors and workers: markdown documents in a git repository (working documents, reports, decisions, facts, lessons). Every edit is committed with the agent and model that made it.",
  workingDoc:
    "The living document for one effort or job: a header, an authoritative Current State, worker briefs, an append-only Work Ledger, and open questions. Agents read its Current State before acting.",
  currentState:
    "The section of a working document that says where things stand right now. It is rewritten in place (never appended to) and must stay under the configured line limit.",
  ledger:
    "The Work Ledger: an append-only log in a working document. Each entry records who changed what, why, the exact validation command and its observed result, and the outcome.",
  accessRequest:
    "A worker asked for more brain access than its role grants (for example, write access to decisions). The configured approver (the supervisor, you, or auto rules) approves or denies it with a reason.",
  billingClass:
    "How a key is paid for. Free tier: no charge. Paid credits: a prepaid balance is drawn down. Billed to card: usage is charged after the fact. Trial: free credits that run out. A FreeLLMAPI key marked as anything but free tier blocks its platform from free routing.",
  premium:
    "For T4 work (too hard for free workers), 'premium' sends the task to a paid model instead of returning it to the supervisor. 'Never' keeps T4 with the supervisor.",
  paidPolicy:
    "When paid models may serve a tier. Never: free models only. On free exhaustion: only after every free model failed or was busy. Preferred: paid models are tried before free ones.",
  branch:
    "Each job commits to its own branch (by default switchyard/job-<id>) in an integration worktree. Nothing is merged or pushed for you: review the branch, then merge it yourself.",
} as const;

export type GlossaryKey = keyof typeof GLOSSARY;
