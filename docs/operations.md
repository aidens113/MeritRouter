# Operations

## Which limits are hard, estimated, or external

| Limit | Kind | Where |
| --- | --- | --- |
| Model requests per task (`maxModelRequests`), including fallbacks, classification, repairs, and every coding-agent call | Hard | Atomic reservation before dispatch (`admission.ts`) |
| Package allocation per hour/day | Hard | Same reservation |
| Only verified-free, eligible models; one model per request; served model must match | Hard | Route plan, chain verification, gate |
| Size floors, modalities, tool support, metadata age | Hard | Route plan |
| Paid spend | Hard | Worst-case cost reserved per request against global, per-key, prepaid-balance, and per-task budgets before dispatch; settled to billed cost |
| Paid policy | Hard | Paid models only where `paid.tiers` / `supervisor.paid_policy` allow; direct routes only, never via FreeLLMAPI |
| Worker file edits | Hard (native runner) | Edit tools refuse paths outside `allowedPaths` |
| Brain access | Hard | Every brain read and write checked against role grants; workers write only their report |
| Ledger integrity | Hard | Ledger entries are append-only and need a real validation record |
| Deadlines, cancellation, lease ownership | Hard | Checked before every dispatch; late responses cannot complete a cancelled task |
| One writer per repository | Hard | Claim transaction |
| Input/output token budgets | Estimated | ~3 chars/token at admission; reconciled when the provider reports usage |
| Per-item tokens inside a prompt batch | Estimated | Proportional share, labelled `estimated` |
| Provider attempts inside one model (key rotation, retries) | External, reported | FreeLLMAPI; `providerAttemptsExact` is always false |
| Provider quotas and cooldowns | External | FreeLLMAPI is authoritative; SwitchYard reads `/v1/providers` |

Allowed commands (`coding.allowed_commands`, `supervisor.allowed_commands`) refuse shell
operators, so a pattern cannot be extended with `&& ...`, but an allowed command such as
`npm test` still runs scripts the worker can edit (`package.json`, test files). Treat any allowed
command as arbitrary code execution and use an OS-level sandbox or container if that matters.

A worktree is not a sandbox. Containment for coding agents is: a provider allowlist that only
reaches the job gateway, stripped credentials, denied shell by default, and diff validation
against `allowedPaths` afterwards. Out-of-scope edits are reported and make acceptance `unmet`;
they are not reverted in the worktree.

## Reading results

- `executionStatus` says whether the run finished; `verificationStatus` says what verification
  established (`not_required`, `pending`, `passed`, `failed`, `inconclusive`, `skipped_budget`);
  `acceptanceStatus` is the outcome: `met`, `unmet`, `not_verified` (nothing established it), or
  `needs_supervisor` (the supervisor must accept or reject). See "Verification" below.
- `classification` shows the score breakdown (rulebook version included); `routing.attempts`
  shows every model tried and why it was skipped or failed.
- `artifactRefs` / `patchRefs` point at files under `.switchyard/artifacts/`
  (`switchyard artifact <ref>`). Patches include the base commit in `baseCommits`; apply them
  with `git apply` after checking the base.

## Verification

Every task gets an immutable acceptance contract before it runs (stored in `task_contracts`,
shown on the panel's task page): criteria with ids, scope and base commit, the effective
importance and where it came from, the verification level and the rules that set it, required
checks, the request budget split (classification, execution, review, repair), and the rulebook
and policy fingerprints.

- **Importance** (`low | normal | high | critical`, with `importanceReason` for high and
  critical) is set by the submitter or the supervisor's `delegate`; `verification.floors` raise
  it (by default `security` / `data_migration` risk tags -> critical, `public_api_change` ->
  high), as do path rules and the parent job. It raises verification, never difficulty.
- **Level** comes from `verification.matrix` (tier x importance; T1/T2 normal -> `standard`, T3 ->
  `deep`, critical -> `strict`) and `verification.rules`, and is re-evaluated on the actual
  result (changed paths, protected-path edits) at the tier the run used. It only rises.
  - `basic`: output contract, evidence provenance, scope, protected paths.
  - `standard`: plus every declared check on the submitted revision and per-criterion
    evidence. Deterministic; no model review.
  - `deep`: plus an independent reviewer.
  - `strict`: a `review_strict`-qualified reviewer, then supervisor acceptance.
- **Reviewers** run in a child session in a fresh context with an evidence package (contract,
  base, patch or artifact, check logs; the author's summary labelled as a claim). They are never
  an endpoint that classified, executed, or repaired the task, and prefer another model family.
  `verification.reviewer_qualification: preferred` (default) falls back to a size-floor reviewer
  and marks the verdict `reviewer_unqualified`; strict always requires a qualified reviewer.
  Qualify reviewers with the `review` eval family (`switchyard qualify`).
- **Decision:** all mandatory items pass -> `met`; a concrete defect gets one repair at the next
  tier, starting from the submitted revision, then a re-review; missing evidence can trigger one
  targeted check; otherwise `needs_supervisor`. Failed checks stay `unmet`; a defect only a
  reviewer found goes to `needs_supervisor` so the supervisor can overrule it.
- **Budget:** review and repair reserves are added to the execution caps, bounded by
  `verification.max_total_requests_per_task` (24) or an explicit task budget. A level raised by
  the result may draw from the remaining room; if none is left the result is `skipped_budget` /
  `needs_supervisor`. The level is never lowered to fit.
- **Acceptance:** the supervisor decides `needs_supervisor` results with `accept_task` /
  `reject_task`, judged against the job's goal and the specifications it was given, and
  `integrate_task` refuses `unmet` results and requires an explicit acceptance for
  `not_verified` ones. With `verification.strict_acceptor: human`, strict results need a person:
  `switchyard accept|reject <task> --reason ...` or the panel's Accept/Reject buttons (MCP
  `accept_result` acts as the supervisor and is refused for them).

### Calibration

Verification is itself measured. Every reviewer verdict is recorded with its reviewer, level,
and qualification; what happens afterwards confirms or contradicts it: acceptance or rejection,
integration onto a job branch, job checks after integration, and undo through attribution (an
undone or later-failing result that passed is an escaped defect; a reviewer fail the supervisor
overrules is a false rejection). The panel's Calibration page shows passed-verification vs
subsequently-confirmed per level and per reviewer, with review cost per accepted task.

- Cached verdicts (`verification.cache_verdicts`, default on): a decisive verdict is reused,
  at no cost, for the same judged content (contract criteria, artifact digest, policy
  fingerprint, source revisions) when it was given at the required level or a stricter one, by
  a reviewer that did not author the task, unless something contradicted it since.
- Audits (`verification.audit_sample_rate`, default 0): a deterministic sample of results that
  needed no review is reviewed in the background as a separate `audit` task. Audits never
  change acceptance and are skipped when the request allocation is tight or tasks are waiting
  for capacity.

## Teams: plans, leases, and capacity

- **Plans.** A supervisor's `plan_work` records the job's decomposition as an immutable,
  versioned, acyclic plan (`job_plans`) and dispatches every node through the normal delegate
  path; re-planning adds a version and keeps nodes already dispatched. The plan reports its
  critical path (tier-weighted: T1=1, T2=2, T3=4). See it with `switchyard plan <job>`, MCP
  `get_plan`, or the panel's job page.
- **Upstream results.** When a dependent first runs, its upstreams' summaries, findings, artifact
  and patch refs, and acceptance/verification status are saved as one artifact and shown to it as
  an "Upstream results" block; the upstream artifacts become citable evidence. A coding
  dependent starts from the job branch head once the upstream is integrated, otherwise from the
  upstream's own head. A node with `requires_accepted_inputs` (default for high and critical
  importance) waits while an upstream is `not_verified` or `needs_supervisor`, and fails on
  `unmet`.
- **File leases.** A coding task takes a lease on its write globs when it is claimed and keeps it
  until it finishes, is interrupted, or its task lease expires; a resumed task re-takes it. A task
  whose globs overlap a live lease in the same repository waits (`waiting_for_file_lease`).
- **Capacity.** `team.max_agents` (default 8; `supervisor.max_workers_per_job` is an older alias)
  caps running tasks per job; `execution.max_concurrent_tasks` bounds everything.
- **Sub-supervisors.** A supervisor may hand a sub-goal to a child supervisor (`delegate` or a
  `plan_work` node with profile `supervise`) while the job tree is shallower than
  `team.max_depth` (2). The child works on `switchyard/job-<child>` forked from the parent's job
  branch as integrated so far, keeps its own section of the parent's working document, and runs on
  a carved share of the parent's remaining request budget (`team.child_budget_share`, 0.5;
  unused requests return when it finishes, an interrupted child keeps its share). Sub-supervisors
  take no job slot; they count toward the parent's `team.max_agents`. The parent integrates the
  child's branch like any task, so worker commits keep their trailers and blame still names the
  worker. Undoing a sub-job by task reverts its whole subtree.
- **Merge queue.** `integrate_task` enqueues; each job branch integrates one item at a time and
  runs the job's checks after each (a failing check is recorded, not undone automatically). A
  failed pick is retried as a clean rebase in the item's worktree; a real conflict re-delegates
  the task once with the conflict as context. Recovery after a crash picks only the commits not
  yet on the branch.
- **Team channel.** Agents in a job post findings, blockers, and interface contracts with
  `post_channel` and read them with `read_channel` (only tasks in a job see these tools). Posts
  are append-only, validated and capped (`team.channel_max_posts_per_task` 10,
  `team.channel_max_posts_per_supervisor` 40, `team.channel_max_post_chars` 2000), idempotent per
  call, mirrored into a "Team Channel" section of the job's working document, and shown to other
  agents as quoted data, never as instructions. A worker sees job-wide posts and posts that
  reference its task.
- **Redundant nodes.** A small non-coding plan node (T1/T2) with `redundancy: 2` runs on two
  different endpoints; the first result that passes verification wins and the other run is
  superseded. Both runs are charged; a node whose budget cannot hold both is refused.

## Recovery

- State lives in `.switchyard/switchyard.db` (SQLite, WAL). It is written before every
  acknowledgement and at every state change.
- When a worker dies, its leases expire (`execution.lease_seconds`). The next worker marks those
  tasks `interrupted` and their still-running sessions `interrupted` (`process_died`), then
  resumes them automatically (up to 3 runs per task):
  - read-only workers, native coding workers, and supervisors continue their session from its
    log: the transcript is restored, and any tool call that was in flight is settled first
    (reads are retried; delegations and idempotent commands re-run under their original call id;
    edits made but not committed are committed as "recovered edits after interruption" under the
    agent's identity, or discarded with `sessions.recover_edits: reset`; a pending `ask_user`
    is answered from the stored question). A submission accepted before the crash finishes
    without another model request. Coding work continues in the same worktree.
  - external coding agents (OpenCode) are relaunched in the same worktree with a summary of the
    interrupted session.
  - completion, batch, and classification runs re-run fresh in a new linked session.
- Manual resume: `switchyard resume <session-id>` continues that session; `switchyard resume
  <task-id>` restarts the task (a coding task in a fresh worktree; the old one stays as
  evidence). MCP `resume_session` / `resume_task` and the panel's Resume buttons do the same.
- Stuck runs: a run whose session records nothing for `execution.watchdog_minutes` (default 10;
  0 disables) is interrupted with stop reason `watchdog` and resumed like a crash (counts against
  the 3 automatic runs). A pending model request, a running tool call, or final checks extend the
  allowance to their own timeout plus 60 s; supervisors waiting in `await_tasks` or on a question
  are exempt.
- Failing providers: each provider has a circuit breaker for transport failures (5xx, timeouts,
  connection errors, 429 without a reported cooldown; never invalid model output). After 5
  consecutive failures it opens for 30 s, doubling to 15 minutes, then lets one probe through.
  Routing ranks open providers last and the gate skips them; when every candidate is open the
  task waits for capacity instead of failing. `insights.providerHealth` shows the state.
- A model that served a request it should not have is quarantined until its chain is re-verified:
  run `switchyard models scan`.
- Tasks waiting for capacity (`waiting_for_capacity`) retry automatically until their deadline.

## Agent sessions

Every model-driven run is an agent session: each run of a task (a recovery re-run or a tier
escalation is a new session linked to the one before it), each classification, and each batch
item. A delegated task's session names the supervisor session that delegated it as its parent.

- The log is `.switchyard/sessions/<session id>.jsonl`, one event per line, fsynced as it is
  written: the transcript (`message`), model requests, responses and errors, a tool journal
  (`tool_intent` written before a tool runs, `tool_outcome` after, with the tool's side-effect
  class), notes, workspace changes (worktree, branch, base commit, head), and the end state.
  SQLite indexes it in `sessions` and `session_events` (no payloads). A failure to write the log
  fails the run.
- Statuses: `running`, `completed`, `failed` (budget exhaustion is `failed` with stop reason
  `budget_exhausted`), `interrupted` (shutdown, lost lease, or deferral for capacity), and
  `cancelled`.
- Read them with `switchyard sessions [--status s] [--task id] [--job id]` and
  `switchyard session <id> [--after seq] [--limit n] [--json]`, the MCP tools `list_sessions` and
  `get_session`, or the panel's Sessions page (also linked from task and job pages).
- External agents (OpenCode) run their tools inside their own process: their sessions record the
  model traffic through the policy gateway, not individual tool calls.
- A resume appends a `resumed` event recording what was settled and the notice the agent got.

## Housekeeping

- Worktrees and agent homes are not deleted automatically. Remove old ones with
  `git worktree remove` in the source repository, then delete the folder.
- Backups: `switchyard backup <dir>` takes a consistent snapshot while workers run (SQLite
  online backup, then session logs and artifacts; never worktrees; the vault master key only with
  `--include-master-key`). `switchyard restore <dir>` refuses while any task holds a live lease or
  a daemon runs, refuses existing state without `--force`, and with `--force` moves the old state
  to `.switchyard/pre-restore-<time>/`. Restored running tasks have their leases expired so the
  next worker recovers them.
- Durability: `storage.durability: full` sets SQLite `synchronous=FULL` (survives power loss at
  some write cost); `normal` (default) can lose the last transactions on power loss but never
  corrupts. Session logs are fsynced per event either way.
- Session logs are not pruned automatically.

## The brain and attribution

- The brain is a git repository (`brain.path`). `switchyard brain ls|read|search` or the panel's
  Brain page browse it; every change is a commit under the writing agent, so `git log` and
  `git blame` inside it show who (and which model) wrote what.
- Job branches live in your repositories as `switchyard/job-<id>`; integration worktrees under
  `.switchyard/worktrees/job-<id>-<alias>`. Review, then `git merge --no-ff` (not squash).
- `switchyard blame <repo> <path> --ref <branch>` attributes lines to agents and models.

## Known limitations

- Live behaviour against a real FreeLLMAPI instance, real providers, and OpenCode has not been
  exercised yet (no gateway or credentials were available during development). Every policy path
  is covered by tests with an in-process gateway double and a scripted coding agent.
- OpenCode's JSON event format is undocumented; its output is stored as evidence, not parsed.
- Paid routes have not been exercised against real providers yet; prices are yours to keep
  current (OpenRouter prices are fetched when `pricing_url` is set).
- Audio/video inputs are routed only to models that accept them; there is no transcription or
  frame-extraction preprocessing yet.
- Tasks and jobs run only while a worker process is running (the MCP server stops with the
  Claude session; run `switchyard worker`, `switchyard daemon`, or `switchyard service install`
  for unattended work).
- Line attribution for external agents (OpenCode) is per model request, not per tool call, and can
  blur when the agent sends several requests at once.
