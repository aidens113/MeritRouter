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

- `executionStatus` says whether the run finished; `acceptanceStatus` says whether the evidence
  shows the criteria are met. Only coding tasks whose supervisor-supplied checks all pass, with
  every change in scope and no test/evaluator edits, are `met`. Read-only and completion results
  are at best `not_verified`.
- `classification` shows the score breakdown (rulebook version included); `routing.attempts`
  shows every model tried and why it was skipped or failed.
- `artifactRefs` / `patchRefs` point at files under `.switchyard/artifacts/`
  (`switchyard artifact <ref>`). Patches include the base commit in `baseCommits`; apply them
  with `git apply` after checking the base.

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
