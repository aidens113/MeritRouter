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
  session:
    "One agent's run, whatever its role: a classifier call, a worker attempt at a task, or a supervisor. Everything it does is appended to a durable event log: each transcript message, model request and response, and every tool call as an intent written before it runs and an outcome written after. A retry or escalation is a new session linked to the previous one.",
  importance:
    "How much a task's result matters: low, normal, high, or critical. It is set by the submitter (high and critical need a reason), by a parent task, or raised by the policy's floors and rules (for example a security risk tag, or a change touching a critical path). It never lowers. With the tier, it picks the verification level.",
  verification:
    "The evidence a result needs before it is accepted. Basic: output contract, evidence provenance, scope, protected paths. Standard adds the declared checks, run on the submitted revision, and evidence per criterion. Deep adds an independent review. Strict also needs an explicit acceptance. The level is fixed in the task's contract before it runs and can only rise when the actual change is checked.",
  contract:
    "The acceptance contract: compiled once, after classification and before the first run, and stored unchanged with a SHA-256 digest. It holds the goal, the criteria with ids, the scope and base commits, the effective importance, the verification level and the rules that set it, the required checks, the request budget split (classification, execution, review, repair), and the rulebook and policy fingerprints.",
  review:
    "Deep and strict levels add an independent review: a reviewer model that served nothing in this task (another model family first) judges the result against the contract in its own session and submits a verdict per criterion, with evidence. A reviewer without the review qualification may still review (marked reviewer_unqualified) unless the policy requires it; strict always does. A failed review gets one repair, then a re-review. A reviewer missing evidence can ask for one targeted check. Review requests are charged under purpose verification, repairs under repair, within the contract's request budget.",
  acceptance:
    "Met: the verification policy was satisfied, or a supervisor or person accepted the result. Not verified: some criteria rest only on the worker's claims. Needs supervisor: the result waits for a decision (strict verification, missing evidence, or a review that has not run). Unmet: a check, criterion, or review failed, or the result was rejected. With verification.strict_acceptor set to human, only a person (CLI, MCP client, or this panel) can accept a strict result.",
  calibration:
    "Verification is measured against what happened to results afterwards. Every reviewer verdict is recorded with its reviewer, level, and qualification. A result is confirmed when the supervisor or a person accepted it, or it was integrated onto a job branch, and nothing contradicted it since; it is an escaped defect when it was integrated or accepted and then undone through attribution or failed a later job check. A decisive verdict on the finally accepted revision is then confirmed correct, a false approval, or a false rejection; a fail on an earlier revision led to a repair and is not judged.",
  falseApproval:
    "False approval: a reviewer passed work that was later undone, failed a job check after integration, or was rejected. False rejection: a reviewer failed work that the supervisor or a person accepted anyway, with nothing contradicting the acceptance since. Contradicted verdicts are never reused from the verdict cache.",
  audit:
    "Audit sampling: a share of results that passed verification (verification.audit_sample_rate, off by default) gets a second review in the background, by an independent reviewer on free models, as its own task with purpose audit. An audit never blocks or changes acceptance; its verdict only calibrates. Audits are skipped while the package allocation is tight or work is waiting for capacity. Reused verdicts: a decisive verdict for the same contract, artifact, policy, and source revisions is reused instead of reviewing again, never for a higher level.",
  toolJournal:
    "Before a tool runs, its intent (name, arguments, and what it touches) is written to the session log; after it runs, its outcome. An intent with no outcome means the tool was still running, or the process stopped before it finished.",
  plan:
    "The job's task graph, recorded by its supervisor with plan_work. Each node is a task; a node starts once the nodes it depends on finish, and is given their results (summary, findings, artifacts, patches, acceptance). Nodes with nothing to wait for run in parallel, up to the job's agent cap (team.max_agents). Re-planning adds a version; nodes already dispatched keep their tasks.",
  criticalPath:
    "The longest chain of dependent nodes by estimated cost (tier weight: T1 = 1, T2 = 2, T3 = 4, T4 = 8). The job cannot finish sooner than this chain, however many agents run in parallel.",
  fileLease:
    "A coding task holds a write lease on its allowed paths in its repository while it runs. Another coding task of any job whose paths overlap waits queued until the lease is released (the task finishes, is interrupted, or its worker's lease expires).",
  subJob:
    "A whole sub-goal a job's supervisor handed to a sub-supervisor. It runs its own workers on its own branch, forked from the parent's job branch, with a request budget carved from the parent's remaining budget (team.child_budget_share). When it finishes, the parent integrates its branch, and requests it did not use return to the parent. team.max_depth limits how deep jobs nest.",
  mergeQueue:
    "How finished work reaches a job branch: one integration per branch at a time, in order. Commits are cherry-picked one by one (never squashed), so blame still names each worker. When a pick conflicts, the work is rebased onto the branch head and picked again; if that conflicts too, the task is re-delegated once. The job checks run after each integration.",
  teamChannel:
    "Short posts between a job's supervisor and its workers: findings, blockers, and interface contracts (names and formats others must match). Posts are model output: they are shown quoted, as claims to check, never as instructions. A worker sees posts about its own task and job-wide posts.",
  redundancy:
    "A small plan node (T1 or T2, no code edits) can run twice at once on different models. The first result that passes verification is used and the other run is cancelled (superseded). Both runs are charged.",
  parallelism:
    "How many of a job's agents (the tasks its supervisor delegated, sub-jobs and their tasks included) were running at each moment, read from when each task was claimed and when it stopped. Peak is the most at once; mean is averaged over the job's wall-clock. The supervisor itself is not counted. A redundant node's twin runs count as one task.",
  waitReason:
    "Why a task was not running, replayed from its events: dependencies (upstream tasks unfinished), acceptance (an upstream result awaits acceptance), file lease (another task holds overlapping paths), provider slot (no provider in its route had a free concurrency slot), capacity (deferred while models were cooling down), queue (ready, waiting for a worker or the job's agent cap), interrupted (waiting to be resumed).",
  comparison:
    "The same goals run twice: once as a team job (a supervisor that plans and delegates) and once as a single agent, with the same configuration and model pools. Both metric sets are recorded. A comparison runs only when you start it (switchyard compare --yes) and its planned request budget must fit what is left of today's qualification allocation.",
} as const;

export type GlossaryKey = keyof typeof GLOSSARY;
