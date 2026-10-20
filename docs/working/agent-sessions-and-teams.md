# Agent sessions, failure resilience, and agent teams

Status: Active
Status detail: S1, S2, R1, T1 complete 2026-10-19; T2 next.
Created: 2026-10-19
Last updated: 2026-10-19
Owner: Senior supervisor agent
Scope: Make every unit of work a durable, resumable agent session; make the system survive process, machine, and model failures; turn SwitchYard into a framework for coordinated agent teams that decompose work and run as many agents in parallel as capacity allows.
Paired document: none
Related: [importance and verification](./importance-and-verification.md), [harness, roles, brain](./harness-roles-brain.md), [decisions](../decisions.md), [roles](../roles.md), [operations](../operations.md)

## Current State

**Requirements (user, 2026-10-19):**
1. Everything is agent-based. Every agent's session is saved, so when the program dies the agent
   that was running can be spun back up where it was.
2. The whole system is resistant to failures of the hardware it runs on.
3. Native multi-agent work: coordinated teams that break goals down and use as many sub-agents
   as realistically possible, to finish faster, while still harvesting free and paid
   intelligence cheaply.

**What exists today (verified in code, `main` at 43aace8):**
- Tasks, leases (60 s), heartbeats, and expired-lease recovery in SQLite (WAL,
  `synchronous=NORMAL`).
- Supervisors persist their transcript every turn (`job_state`) and resume automatically after a
  crash, with answers given meanwhile.
- Completion and read-only workers are re-run from scratch on recovery (no transcript kept; up to
  3 runs).
- Coding workers are never auto-resumed; `resume` starts a fresh worktree and keeps the old one as
  evidence. Their per-response commits survive in the old worktree.
- Delegation is idempotent by label; the brain is git; the job branch survives in the repository.
- Concurrency is fixed: `execution.max_concurrent_tasks` (2), `supervisor.max_concurrent_jobs` (1),
  `supervisor.max_workers_per_job` (3). Supervisors cannot delegate to sub-supervisors.
- One process host. SQLite on local disk. No daemon or service install.

**Phase S1 done (2026-10-19):** every model-driven run records an agent session
(`packages/router/src/sessions/`): fsync'd JSONL log under `<storage>/sessions/`, indexed in
SQLite; transcript, model traffic, a tool journal (intent before, outcome after, side-effect
class), workspace changes, end state. Read surfaces in CLI, MCP, and panel.

**Phase S2 done (2026-10-19):** interrupted sessions resume. Read-only, native coding, and
supervisor tasks reopen their latest interrupted session (`SessionStore.reopen`), rebuild the
transcript, settle in-flight tool calls by side-effect class (`planResume`,
`src/harness/resume.ts`), and continue; coding resumes in the same worktree; supervisors no longer
write `job_state` (fallback read only); a submission accepted before the crash finishes without
another request; completion/batch/classifier runs re-run fresh, linked. Recovery marks dead
`running` sessions `interrupted`. Fault hook `SWITCHYARD_FAULT_AT` (`src/core/faults.ts`) drives
crash/restart tests. Surfaces: `switchyard resume <session|task>`, MCP `resume_session`, panel
Resume. Capacity deferrals end `interrupted` and resume like crashes (accepted: continuing is
correct).

**Phase R1 operations done (2026-10-19):** `storage.durability`, `switchyard backup` / `restore`,
`switchyard daemon` (restart policy), `switchyard service install|uninstall|status` (systemd,
launchd, Windows Task Scheduler). Fixed: `switchyard worker` exited after ~0.4 s. Not run: a real
service install on any platform; Linux/macOS.

**Phase R1b done (2026-10-19):** progress watchdog (`execution.watchdog_minutes`, reviewers
included after the V merge), per-provider circuit breakers (`gateway/breaker.ts`), and the R1
acceptance test: a real worker process killed with `taskkill /F` mid-task is resumed by a second
worker in the same session with no duplicated edit. Watchdog reads session tables directly
(a `SessionStore` method would be cleaner). Kill test has only run on Windows.

**Phase T1 done (2026-10-19):** `plan_work` and versioned `job_plans` with critical path;
upstream results injected into dependents (native and external runners) with the coding
base-commit rule; team-wide `file_leases` taken at claim, released at finish/interruption/expiry,
re-taken on resume; `team.max_agents` (default 8; presets regenerated) caps running tasks per
job; `requires_accepted_inputs` on plan nodes (default for high/critical importance) holds a
dependent on unaccepted upstreams. Surfaces: `switchyard plan`, MCP `get_plan`, panel plan card.
`src/admin/insights.ts` split into `jobs.ts`, `sessions.ts`, `job-plans.ts`, `calibration.ts`.

**Not done:** T2, T3. T1 gaps: two processes claiming at once untested; native coding plan
nodes end to end only through the demo; the external runner's TASK.md still omits inline text
and file refs (pre-existing).
Open gaps: external-runner resume and crash-during-batch are untested; `recover_edits: reset`
untested against git; two processes racing to resume untested; a session left `running` by a dead
process shows no panel Resume until recovery runs; already-finished batch members are not
recorded when the batch runner throws (sessions end `batch_aborted`).

**Next steps:** T2, then T3.

**Blockers:** none. Live checks against real providers are still outstanding from the previous
document.

## Design

### Agent sessions (S)

Every model-driven unit of work becomes an **agent session**, whatever its role: classifier,
summarizer, worker, reviewer, supervisor, qualification run. A task owns one or more sessions (a
retry or escalation is a new session linked to the old one).

A session record holds:
- identity: session id, role, agent label, parent session (who spawned it), task, job, team;
- the **transcript** as an append-only event log: model requests and responses, tool calls,
  tool results, decisions, each with a sequence number;
- a **tool journal**: for every side-effecting tool call, an intent record written *before*
  execution and an outcome record written *after* (idempotency key = session id + sequence);
- workspace pointer: worktree path, base commit, last committed head;
- budgets used, models served, status (`running`, `waiting`, `paused`, `interrupted`,
  `completed`, `failed`).

Storage: event logs as append-only JSONL files per session under `.switchyard/sessions/`, flushed
with fsync per event; SQLite indexes them. Brain and job branches already live in git.

**Resume protocol** (any role):
1. Reload the transcript up to the last durable event.
2. For a tool call with an intent but no outcome:
   - reads: re-run;
   - edits: compare the worktree with the last committed head; commit the difference as
     "recovered" under the session's identity, or reset to the head, per policy;
   - delegate: idempotent by label, so re-submit;
   - commands and checks: re-run only if marked idempotent, otherwise tell the agent the outcome
     is unknown;
   - paid requests: the reservation already counts as spent (uncertain), so never double-charged.
3. Append a "resumed" event that tells the model what happened, then continue the loop.

Every runner (completion, batch, read-only, native coding, supervisor, external agents through the
job gateway) moves onto this session engine. External agents (OpenCode) are re-launched with the
session's prior transcript summary as context.

Surface: `switchyard sessions [--running|--interrupted]`, `switchyard session <id>` (timeline),
`switchyard resume <session>`, panel Sessions page, MCP `list_sessions` / `resume_session`.

### Failure resilience (R)

- **Process crash:** sessions resume automatically on the next start (S above). A
  `switchyard daemon` runs workers under a restart policy, with service install for Windows
  (service), Linux (systemd user unit), and macOS (launchd).
- **Power loss / disk:** `storage.durability: full` sets SQLite `synchronous=FULL`; session logs
  are fsynced per event; brain commits are durable; optional periodic snapshots
  (`switchyard backup`) and brain push to a remote.
- **Machine loss:** state directory and brain on a synced or network volume, or a remote brain;
  later, a Postgres store adapter and multiple worker hosts sharing one queue (leases already
  support several workers).
- **Model and provider failure:** already handled by per-model fallback, escalation, quarantine,
  and cooldown-aware routing; add circuit breakers per provider and adaptive backoff.
- **Stuck agents:** progress watchdog (no new event for N minutes while running) restarts the
  session from its last durable event.
- **Tests:** kill the worker process at random points (fault injection) during each runner and
  assert resumed sessions finish with no lost or duplicated side effects.

### Agent teams (T)

- **Hierarchical supervision:** supervisors may delegate a sub-goal to a sub-supervisor (`supervise`
  inside `delegate`), with a depth limit and per-level budgets. Each sub-supervisor owns its own
  working document section and branch, integrated upward by its parent.
- **Plan as a task graph:** a `plan_work` tool records the decomposition as a DAG (tasks, file
  ownership, dependencies, estimated tier). The scheduler dispatches every ready node at once,
  subject to capacity, and reports the critical path.
- **Maximum safe parallelism:** concurrency is bounded by real capacity, not fixed numbers:
  per-provider limits and cooldowns from FreeLLMAPI, paid budgets, and adaptive (AIMD)
  concurrency per provider. Defaults stay conservative; `team.max_agents` caps the total.
- **Coordination:**
  - file-ownership leases across the whole team (generalising today's overlap check);
  - a merge queue that integrates finished work one at a time with checks, and re-bases or
    re-delegates on conflict;
  - a team channel per job (agents post findings, blockers, and interface contracts; supervisors
    read it; stored in the brain);
  - automatic review is planned in [importance-and-verification](./importance-and-verification.md)
    (V2: reviewer phase inside the task); optional redundant execution
    of small tasks on two cheap models, taking the first validated result.
- **Cost-aware staffing:** cheap free models for leaf work, strong models for planning and review;
  the planner picks tiers per node and prefers more small tasks when capacity is free.
- **Metrics:** wall-clock per job, parallelism achieved over time, critical-path length,
  requests and cost per completed task, comparison of team versus single-agent runs on the
  qualification suite.

### S1 implementation decisions (2026-10-19)

- New area `packages/router/src/sessions/`: `events.ts` (zod event schemas), `store.ts`
  (`SessionStore`), `recorder.ts` (`SessionRecorder`). `Switchyard.sessions` exposes the store.
- One session per model-driven run: each executor run of a task (a tier escalation or a recovery
  re-run is a new session with `previous_session_id`), each classification (role `classifier`),
  each batch item. `parent_session_id` is the session that delegated the task, when known.
- Log: `<storage.directory>/sessions/<sessionId>.jsonl`, one JSON event per line
  `{seq, at, type, data}`, appended with `fsyncSync` per event. Session ids come from `newId("s")`.
- SQLite (new migration): `sessions` (id, task_id, job_id, parent_session_id,
  previous_session_id, role, agent_label, profile, tier, status, stop_reason, log_path, last_seq,
  model_requests, tool_calls, workspace_json, created_at, updated_at, ended_at) and
  `session_events` (session_id, seq, type, at, name, ok; PK session_id+seq) without payloads.
- Event types: `started`, `message` (each transcript message once, in order), `model_request`,
  `model_response` (endpoint, request id, content, tool calls, usage), `model_error`,
  `tool_intent` (call id, name, args, side_effect) written before a tool runs, `tool_outcome`
  (intent seq, ok, output capped at 16 KB) after, `note`, `workspace`, `ended`.
- Status: `running` -> `completed` | `failed` | `interrupted` | `cancelled`; on store open,
  sessions still `running` from a dead owner are marked `interrupted` only by S2 (S1 leaves them).
- A recording failure (disk) throws: the log is the record of truth.
- `job_state` stays for supervisor resume until S2 moves resume onto sessions.
- `resume_session` / `switchyard resume <session>` belong to S2; S1 ships read surfaces only.

### R1b and T implementation decisions (2026-10-19)

- **R1b (after S2):**
  - Progress watchdog: a running session with no new event for
    `execution.watchdog_minutes` (default 10; supervisors waiting in `await_tasks` or on a
    question are exempt) is aborted as `interrupted` (`watchdog`) and resumes through S2.
  - Per-provider circuit breaker in `ProviderHealth`: N consecutive failures (default 5) open it
    for a backoff that doubles up to a cap; half-open admits one probe; routing skips open
    platforms like cooling ones.
  - Acceptance: a test kills a worker process mid-run (real child process), restarts it, and
    the session resumes; backup/restore round trip.
- **T1 (task graph):**
  - A `plan_work` supervisor tool records the job's decomposition as a versioned plan
    (`job_plans`: nodes with label, profile, goal, criteria, allowed paths, depends_on labels,
    difficulty, importance; validated acyclic) and dispatches every node through the existing
    delegate path. Re-planning appends a version; nodes already dispatched keep their tasks.
  - Ready nodes run as soon as their dependencies are satisfied (the existing dependency
    gate).
  - Dependents receive their upstream results: summary, findings, artifact and patch refs,
    and acceptance status, injected as context and listed in the evidence universe. For coding
    dependents the base commit is the job branch after the upstream was integrated, or the
    upstream's head when it is not integrated yet (recorded).
  - Team-wide file leases (`file_leases`: job, task, repository, path globs, mode, acquired,
    released) are acquired at claim and released at finish. The scheduler skips a coding task
    whose write globs overlap a live lease in the same repository; this replaces the
    per-call overlap check, which becomes advisory. Leases expire with the task lease.
  - `team.max_agents` (default 8) caps concurrently running tasks per job (replacing
    `supervisor.max_workers_per_job`, which stays as an alias). Global
    `execution.max_concurrent_tasks` still bounds everything.
  - Critical path: the longest chain by estimated cost (tier weight) is computed from the plan
    and exposed in insights.
- **T2 (team coordination):**
  - Sub-supervisors: `delegate` accepts profile `supervise` for a sub-goal when `team.max_depth`
    (default 2) allows. The child job works on its own branch `switchyard/job-<child>` forked
    from the parent's job branch and gets its own working-document section; its request budget
    is carved from the parent's (`team.child_budget_share`, default 0.5 of the remaining).
  - Merge queue: `integrate_task` enqueues; one integration per job branch at a time; job checks
    run after each; on conflict the item is rebased onto the branch head in its worktree when
    clean, else re-delegated once with the conflict as context; every outcome is recorded.
  - Team channel: an append-only per-job channel (`job_channel` table, mirrored to the brain
    document section) with tools `post_channel` (kinds finding, blocker, interface_contract)
    and `read_channel`; workers can read channel posts that reference their task.
  - Redundant execution (opt-in per node, `redundancy: 2`) runs a small task on two cheap
    models and takes the first result that passes verification; the other is cancelled.
- **T3 (capacity and metrics):**
  - AIMD concurrency per provider: start at `team.provider_concurrency_start` (2); +1 after N
    successes, halve on 429 or cooldown; bounded by FreeLLMAPI-reported limits when known. The
    scheduler admits a task only if a provider in its plan has a free slot.
  - Cost-aware staffing: `plan_work` nodes without a tier get one from the rulebook. When
    capacity is free, the planner prompt prefers more smaller nodes; strong models are kept for
    the supervisor and for Deep/Strict review.
  - Metrics, stored per job: wall-clock time, parallelism over time (sampled running count),
    critical-path length, requests and cost per completed task. A qualification-suite
    comparison runs the same goals as team vs single agent. Shown in a panel Teams view.

## Phases

| Phase | Deliverable | Acceptance |
| --- | --- | --- |
| S1 | Session store (event log, tool journal), all runners on the session engine | Every model call and tool call appears in a session log; panel/CLI show it |
| S2 | Resume protocol for every role | Fault-injection tests: kill at each step, resumed sessions finish without duplicated edits, delegations, or paid charges |
| R1 | Durability settings, daemon with service install, watchdog, backup | Process kill and restart resumes all sessions; `switchyard backup` restores |
| T1 | Task-graph planning, ready-node parallel dispatch, team-wide file leases | A goal splits into N independent tasks that run concurrently up to capacity |
| T2 | Sub-supervisors, merge queue, team channel (auto-review moved to V2 of importance-and-verification) | Nested job completes with correct attribution and no lost integrations |
| T3 | Adaptive concurrency per provider, cost-aware staffing, metrics | Panel shows parallelism and critical path; throughput beats single-agent on the eval suite |
| R2 (later) | Postgres store, multiple worker hosts | Two hosts share one queue without double execution |

## Worker Briefs

### S2 and R1 decisions (2026-10-19)
- Branches/worktrees: S2 on `feat/s2-resume` (`D:/sy-wt/s2`), R1 operations on `feat/r1-ops`
  (`D:/sy-wt/r1`); V1 runs in parallel on `feat/v1-verification`. Workers never commit.
- Resume rule: a task's next run resumes its latest session when that session is `interrupted`
  (crash, shutdown, lost lease, capacity deferral) and its role is resumable (agent-loop roles:
  read-only workers, native coding, supervisors; external coding relaunches in the same
  worktree with a transcript summary). Completion, batch, and classifier runs re-run fresh with
  a linked session (one request; cheap). Escalations always start fresh.
- At recovery, sessions still `running` whose task lease expired become `interrupted`
  (`process_died`).
- Pending intents (intent without outcome) are resolved before the loop continues, and every
  tool call of the last assistant message gets a tool message (synthetic when needed):
  `none`/`read` -> "interrupted; call again"; `edit` -> worktree diffed against the last
  committed head, the difference committed as "recovered" under the session's identity
  (`sessions.recover_edits: commit | reset`, default commit) and the model told which files;
  `delegate` -> re-run automatically (idempotent by label); `command` -> re-run when
  `idempotent`, else "outcome unknown"; `brain` -> "outcome unknown; check before repeating";
  `external` (ask_user) -> the stored question/answer state is reported. A `model_request`
  without a response is dropped (its reservation already counts).
- Coding tasks now auto-resume in the same worktree (within the 3-run cap); `switchyard resume
  <task>` keeps its fresh-worktree behaviour.
- Supervisors resume from the session transcript; `job_state` is read only as a fallback for
  jobs that have no session, and is no longer written.
- A `resumed` event records what was reconciled.

### Brief: s2-core
- Repository: this repository, worktree `D:/sy-wt/s2` (branch `feat/s2-resume`).
- Task: in `src/sessions/`, add `SessionStore.reopen(id) -> SessionRecorder` (continues seq,
  status back to `running`), `transcript(id) -> ChatMessage[]` (rebuilt from `message` events;
  a later event for the same index replaces the earlier), `pendingIntents(id)`, a pure
  `planResume(events, opts) -> { messages, actions[], summary }` implementing the rules above
  (actions are what the caller must do: re-run delegate X, reconcile edits in repo Y, ...),
  `markDeadRunning(isLeaseLive)`, and `recorder.resumed(summary, actions)`.
- Required reads: this Current State, "S2 and R1 decisions", `src/sessions/**`,
  `reports/s1-store.md`, `reports/s1-runners.md`.
- Owns: `packages/router/src/sessions/**`, `tests/session-resume.test.ts`, an appended
  migration only if needed.
- Must not touch: anything else.
- Definition of done: unit tests cover each side-effect class, an orphaned tool call, a lost
  model request, and reopen counters; `pnpm -r typecheck` and `npx vitest run tests` pass in
  the worktree.
- Report to: docs/working/agent-sessions-and-teams/reports/s2-core.md

### Brief: s2-exec (after s2-core)
- Task: the executor, scheduler, harness loop, and runners apply the resume rule; supervisors
  move off `job_state`; coding auto-resumes in the same worktree with edit reconciliation;
  `Switchyard.resumeSession(id)` in `service.ts` re-queues a task to resume that session.
  Fault injection: a test-only hook (`SWITCHYARD_FAULT_AT=<point>[:<n>]`; points after
  tool_intent, after tool run, after model_request, after model_response) simulates process
  death (throws past cleanup, leaving session and lease as a crash would). A fresh
  `Switchyard` on the same storage must finish each role's task with no duplicated edits,
  delegations, or paid charges.
- Owns: `src/core/**`, `src/harness/**`, `src/runners/**`, `src/storage/tasks.ts`,
  `tests/session-faults.test.ts`, existing tests that assert the old recovery behaviour.
- Report to: docs/working/agent-sessions-and-teams/reports/s2-exec.md

### Brief: s2-surface (after s2-exec)
- Task: `switchyard resume <session-id>` (task ids keep working), MCP `resume_session`, panel
  Resume action on interrupted sessions.
- Owns: `src/cli.ts`, `src/mcp.ts`, `src/admin/insights.ts`, `apps/panel/**`, related tests.
- Report to: docs/working/agent-sessions-and-teams/reports/s2-surface.md

### Brief: r1-ops
- Repository: worktree `D:/sy-wt/r1` (branch `feat/r1-ops`).
- Task: (1) `storage.durability: normal | full` (SQLite `synchronous`; session logs stay
  fsynced per event either way); (2) `switchyard backup <dir>` (SQLite online backup plus
  sessions and artifacts, never worktrees) and `switchyard restore <dir>` (refuses while a
  worker holds live leases); (3) `switchyard daemon` (runs the worker under a restart policy:
  exponential backoff, max restarts per window, logs under `<storage>/logs/`); (4)
  `switchyard service install | uninstall | status` for a systemd user unit, a launchd plist,
  and a Windows Task Scheduler task (at logon, restart on failure) via `schtasks`; `--dry-run`
  prints the definition. New area `src/operations/` (daemon, service, backup).
- Owns: `src/operations/**`, `src/storage/db.ts`, `src/config/schema.ts` (storage section
  only), `src/cli.ts` (new commands only), `tests/operations.test.ts`.
- Must not touch: executor, scheduler, runners, sessions, panel.
- Definition of done: tests for a backup/restore round trip (tasks and session logs readable
  after restore), the durability pragma, unit definitions for all three platforms (dry run),
  and the daemon restart policy with a fake child; never install a real service in tests;
  typecheck and tests pass.
- Report to: docs/working/agent-sessions-and-teams/reports/r1-ops.md

### Brief: r1b-resilience
- Repository: worktree `D:/sy-wt/r1` (branch `feat/r1b-resilience`).
- Task: per "R1b and T implementation decisions": (1) progress watchdog
  (`execution.watchdog_minutes`, default 10; supervisors in `await_tasks` or waiting on a
  question exempt) aborting a stuck run as `interrupted` (`watchdog`) so it resumes through S2;
  (2) per-provider circuit breaker in `ProviderHealth` (open after N consecutive failures,
  default 5; doubling backoff to a cap; half-open single probe; routing skips open platforms like
  cooling ones; state visible in insights); (3) the R1 acceptance test: a real child-process
  worker (`dist/cli.js worker`) killed mid-run (taskkill /F on Windows) and restarted on the same
  storage finishes the task by resuming its session.
- Owns: `src/gateway/**`, `src/routing/select.ts`, `src/core/scheduler.ts`, the watchdog hook in
  `src/core/executor.ts` (small, self-contained), `src/config/schema.ts` (execution and routing
  keys only), `src/admin/insights.ts` (provider health view only), `tests/resilience.test.ts`.
- Must not touch: `src/verification/**`, `src/harness/**`, `src/runners/**`, panel.
- Definition of done: tests for the watchdog (fake clock), breaker transitions, routing skip,
  and the real kill-and-restart; typecheck and all tests pass.
- Report to: docs/working/agent-sessions-and-teams/reports/r1b-resilience.md

### Brief: t1-graph (after V1+V2 are on dev)
- Repository: worktree `D:/sy-wt/t1` (branch `feat/t1-task-graph`).
- Task: T1 per "R1b and T implementation decisions": the `plan_work` supervisor tool and
  versioned `job_plans`; dispatch through the existing delegate path (importance and criteria
  pass through to contracts); upstream results injected into dependents (context + evidence
  universe; coding base commit rule); team-wide `file_leases` acquired at claim, released at
  finish or lease expiry, enforced by the scheduler (overlap check becomes advisory);
  `team.max_agents` (alias `supervisor.max_workers_per_job`); critical path computed from the
  plan; supervisor charter updated to plan first for multi-part goals.
- Owns: `src/harness/supervisor-tools.ts`, `src/runners/supervisor.ts`, `src/runners/prompts.ts`,
  `src/context/**`, `src/core/scheduler.ts`, `src/core/executor.ts` (context injection only),
  `src/storage/tasks.ts`, new `src/storage/plans.ts` and `src/storage/file-leases.ts`,
  `src/storage/migrations.ts` (append), `src/config/schema.ts` (team section), `charters/**`,
  `tests/team-graph.test.ts`.
- Definition of done: a supervisor plan of N independent nodes runs them concurrently up to
  `team.max_agents`; dependents see upstream results; overlapping write globs never run at the
  same time across the job; re-planning keeps dispatched nodes; critical path correct on a
  diamond graph; typecheck and all tests pass.
- Report to: docs/working/agent-sessions-and-teams/reports/t1-graph.md

### Brief: t1-surface (after t1-graph)
- Task: plan view (nodes, states, dependencies, critical path, leases) in insights, CLI
  `switchyard plan <job>`, MCP `get_plan`, and the panel job page.
- Owns: `src/cli.ts`, `src/mcp.ts`, `src/admin/insights.ts`, `apps/panel/**`, related tests.
- Report to: docs/working/agent-sessions-and-teams/reports/t1-surface.md

### T2 split (2026-10-19)
T2 runs as two parallel branches partitioned by file: `feat/t2-nesting` (worktree `D:/sy-wt/v1`)
and `feat/t2-channel` (worktree `D:/sy-wt/s2`). Both append a migration (order set at merge).
The supervisor wires the channel tools into the supervisor's tool list at merge.

### Brief: t2-nesting
- Task: sub-supervisors and the merge queue, per the T2 bullet of "R1b and T implementation
  decisions". Sub-supervisors: `delegate` / `plan_work` accept profile `supervise` for a
  sub-goal when depth < `team.max_depth` (2); the child job's branch `switchyard/job-<child>` is
  forked from the parent's job branch; the child's request budget is carved from the parent's
  remaining (`team.child_budget_share`, 0.5) and recorded; it gets its own working-document
  section in the parent's effort; the parent integrates the child's branch through the merge
  queue; resume (S2), verification (V), and leases (T1) apply to child jobs like any task.
  Merge queue: `integrate_task` enqueues; one integration per job branch at a time; job checks
  run after each; on conflict, rebase onto the branch head in the item's worktree when clean,
  else re-delegate once with the conflict as context; every outcome a task event.
- Owns: `src/harness/supervisor-tools.ts`, `src/runners/supervisor.ts`, `src/workspaces/**`, new
  `src/workspaces/merge-queue.ts`, `src/config/schema.ts` (team section), `src/admission/**`
  (child budget), `charters/supervisor.md`, a migration, `tests/team-nesting.test.ts`.
- Must not touch: `src/core/executor.ts`, `src/core/scheduler.ts`, `src/storage/plans.ts`,
  `src/brain/**`, `src/harness/tools.ts`, panel.
- Definition of done: a nested job (parent -> child supervisor -> workers) completes with correct
  Agent/Model/Task trailers on the parent branch and no lost integrations; two conflicting
  integrations are serialised and the second rebased; a crash mid-integration resumes without a
  double cherry-pick; typecheck and all tests pass.
- Report to: docs/working/agent-sessions-and-teams/reports/t2-nesting.md

### Brief: t2-channel
- Task: the team channel and redundant execution. Channel: `job_channel` table (job, author
  session/task, kind finding | blocker | interface_contract, refs to tasks, text, created_at),
  mirrored as an append-only section of the job's working document in the brain; tools in a new
  `src/harness/channel-tools.ts` exporting `channelTools(): HarnessTool[]` (`post_channel`,
  `read_channel`) for supervisors and workers (workers read posts that reference their task or
  are job-wide; posting is bounded per task). Wire the worker side in `harness/tools.ts`; the
  supervisor side is wired by the supervisor at merge. Redundancy: plan nodes accept
  `redundancy: 2` (small nodes only: T1/T2, non-coding or disjoint worktrees); two runs on
  different cheap endpoints; the first result that passes verification wins; the other is
  cancelled, its session ended `cancelled` / `superseded`; both charged.
- Owns: `src/harness/channel-tools.ts`, `src/harness/tools.ts`, new `src/storage/channel.ts`,
  `src/storage/plans.ts` (redundancy field), `src/brain/**` (mirror only), `src/core/executor.ts`,
  `src/core/scheduler.ts`, a migration, `tests/team-channel.test.ts`.
- Must not touch: `src/harness/supervisor-tools.ts`, `src/runners/supervisor.ts`,
  `src/workspaces/**`, `src/config/schema.ts` (ask the supervisor for keys), panel.
- Definition of done: channel posts persist, mirror to the brain, survive restart, and are
  visible to the referenced worker; a redundant node takes the first verified result and cancels
  the other; typecheck and all tests pass.
- Report to: docs/working/agent-sessions-and-teams/reports/t2-channel.md

### Brief: t2-integrate (after both are merged on feat/t2-nesting)
- Task: tie T2 together: `plan_work` accepts `supervise` nodes (drop the refusal in
  `storage/plans.ts`) and exposes/passes `redundancy`; channel tools only for tasks in a job;
  config keys `team.channel_max_posts_per_task` (10), `team.channel_max_posts_per_supervisor`
  (40), `team.channel_max_post_chars` (2000) replacing the constants; calibration's integration
  signal uses its own event type so the dependents' `integrated` event is unambiguous; move the
  integration block out of `supervisor-tools.ts` (863 lines) into
  `src/harness/integration-tools.ts`; the watchdog allowance covers `integrate_task` running
  several job checks; `undo` by task on a sub-job reaches its descendants' commits; exports in
  `src/index.ts`.
- Owns: `src/harness/**`, `src/storage/plans.ts`, `src/config/schema.ts`,
  `src/verification/calibration.ts`, `src/core/watchdog.ts`, `src/attribution/**`,
  `src/index.ts`, tests.
- Report to: docs/working/agent-sessions-and-teams/reports/t2-integrate.md

### Brief: t2-surface (after both)
- Task: panel/CLI/MCP for sub-jobs (job tree), merge queue state, channel; docs.
- Owns: `src/cli.ts`, `src/mcp.ts`, `src/admin/**`, `apps/panel/**`, related tests.
- Report to: docs/working/agent-sessions-and-teams/reports/t2-surface.md

### Brief: t3-capacity (after T2 is on dev)
- Task: T3 per "R1b and T implementation decisions": AIMD concurrency per provider (start
  `team.provider_concurrency_start` 2, +1 after N successes, halve on 429/cooldown/breaker
  open, bounded by FreeLLMAPI-reported limits when known; the scheduler admits a task only when
  a provider in its plan has a free slot); cost-aware staffing (planner prompt and `plan_work`
  tier defaults from the rulebook; strong models reserved for supervisors and Deep/Strict
  review); job metrics (wall-clock, sampled parallelism, critical-path length, requests and
  cost per completed task); a team-vs-single comparison runner over the qualification suite;
  panel Teams view.
- Owns: `src/gateway/**`, `src/admission/**`, `src/core/scheduler.ts`, new `src/core/metrics.ts`
  or `src/admin/team-metrics.ts`, `src/qualification/**` (comparison), `src/admin/**`,
  `apps/panel/**`, `charters/supervisor.md`, `tests/team-capacity.test.ts`.
- Report to: docs/working/agent-sessions-and-teams/reports/t3-capacity.md

### Brief: s1-store
- Repository: this repository.
- Task: build the session store and recorder per "S1 implementation decisions". `SessionStore`:
  `create({taskId, jobId, parentSessionId, previousSessionId, role, agentLabel, profile, tier})`
  -> `SessionRecorder`; `get(id)`; `list({status?, taskId?, jobId?, limit?})`;
  `events(id, {afterSeq?, limit?})` (reads the JSONL, validates with zod); `forTask(taskId)`.
  `SessionRecorder`: `id`, `syncMessages(messages)` (logs messages not yet logged, by index),
  `modelRequest`, `modelResponse`, `modelError`, `toolIntent(...) -> seq`,
  `toolOutcome(intentSeq, ...)`, `note`, `setWorkspace`, `end(status, stopReason)`; every
  append updates `sessions` counters and inserts the `session_events` row in one transaction.
  Add `session: SessionRecorder | null` to `RunContext` and record requests, responses, and
  errors inside `ask()` when it is set (call `syncMessages(req.chat.messages)` first). Set
  `session: null` where `RunContext` objects are built so everything compiles. Add
  `Switchyard.sessions`. Add `sessionsView(sy, filter)` and `sessionDetail(sy, id, {afterSeq,
  limit})` to `src/admin/insights.ts`; export the store types from `src/index.ts`.
- Required reads: Current State and "S1 implementation decisions" in this document;
  `src/runners/types.ts`, `src/storage/db.ts`, `src/storage/migrations.ts` (tail),
  `src/core/service.ts`, `src/admin/insights.ts` (jobs section), `tests/helpers.ts`.
- Owns: `packages/router/src/sessions/**`, `src/storage/migrations.ts` (append only),
  `src/runners/types.ts`, `src/core/service.ts`, `src/admin/insights.ts`, `src/index.ts`, any
  file needing only `session: null` added to a `RunContext` literal, `tests/sessions.test.ts`.
- Must not touch: `src/harness/**`, `src/cli.ts`, `src/mcp.ts`, `apps/panel/**`, docs.
- Definition of done: `tests/sessions.test.ts` covers create/append/list/events/end, fsync'd
  JSONL readable after the store closes, counters, zod rejection of a corrupt line (skipped and
  reported, not thrown on read); `pnpm -r typecheck` and `npx vitest run` in packages/router pass.
- Report to: docs/working/agent-sessions-and-teams/reports/s1-store.md

### Brief: s1-runners (after s1-store)
- Task: put every runner on sessions. Executor opens a session per run (role from
  `roleForProfile`, label from `agentLabel`, `previousSessionId` = the task's prior session),
  sets `ctx.session`, ends it with the outcome state. Harness loop writes `tool_intent` before
  and `tool_outcome` after each tool call (terminal tool included); tools declare
  `sideEffect`. Classifier and batch items get sessions; native coding and supervisors record
  their workspace; delegated tasks carry the delegating session as parent.
- Owns: `src/core/executor.ts`, `src/core/service.ts`, `src/harness/**`, `src/runners/**` except
  `types.ts`, `src/scoring/classifier.ts`, `tests/session-recording.test.ts`.
- Must not touch: `src/sessions/**`, `src/cli.ts`, `src/mcp.ts`, `insights.ts`, `apps/panel/**`.
- Done: a test per runner shows its model calls and tool calls in the session log; typecheck and
  its own tests pass. Report: `reports/s1-runners.md`.

### Brief: s1-surface (after s1-store, parallel with s1-runners)
- Task: CLI `switchyard sessions [--status s] [--task id] [--job id] [--json]` and
  `switchyard session <id> [--json]` (timeline); MCP tools `list_sessions`, `get_session`.
- Owns: `src/cli.ts`, `src/mcp.ts`, `tests/mcp.test.ts`, `tests/session-surface.test.ts`.
- Done: tests for both commands and both MCP tools pass. Report: `reports/s1-surface.md`.

### Brief: s1-panel (after s1-store, parallel)
- Task: panel Sessions list (`/sessions`, filter by status) and timeline (`/sessions/[id]`),
  API routes, nav entry, links from task and job detail pages; seed sessions in the demo.
- Owns: `apps/panel/**`. Done: panel builds; pages screenshot correctly. Report:
  `reports/s1-panel.md`.

---

## Work Ledger

### 2026-10-19 — Requirements and design recorded
- Agent: supervisor
- Changed: this document; `docs/working/README.md`
- Why: user asked for durable agent sessions, failure resilience, and native agent teams, written down before handoff.
- Validation: not validated (design only).
- Outcome: Accepted
- Follow-up: Phase S1.

---

### 2026-10-19 — Phase S1: agent sessions recorded for every run
- Agent: supervisor; workers s1-store, s1-runners, s1-surface, s1-panel
- Changed: `packages/router/src/sessions/**` (new), migration, `runners/types.ts` (`ask()` records),
  executor, service, harness loop and tools (tool journal, `sideEffect`), batch, classifier,
  coding and supervisor runners (`runners/session-workspace.ts`), CLI, MCP, insights, panel
  Sessions pages and API, demo seed; `docs/operations.md`, `docs/decisions.md` (14).
- Why: requirement 1 (every agent's session saved); S1 records, S2 resumes.
- Validation: `pnpm -r typecheck` -> router and panel Done; `pnpm --filter switchyard-router build`
  ok; `npx vitest run tests` -> 16 files, 122 tests passed (supervisor-run); demo seed recorded
  ~25 real sessions across classifier, summarizer, batch, inspector, analyst, reviewer,
  implementer, supervisor (child linked to parent; escalation linked to previous);
  panel: production build, seed, server on :4512 -> `/sessions`, `/sessions?status=failed`,
  `/sessions/<id>`, `/api/sessions`, `/api/sessions/<id>`, task and job pages 200; unknown id
  404; bad query 400; screenshots of the list and a supervisor timeline inspected; server stopped.
- Outcome: Accepted
- Follow-up: Phase S2.

---

### 2026-10-19 — Phase S2 (resume) and R1 operations
- Agent: supervisor; workers s2-core, s2-exec, s2-surface (`feat/s2-resume`), r1-ops (`feat/r1-ops`)
- Changed: `src/sessions/resume.ts`, store/recorder reopen; `src/harness/{resume,journal}.ts`,
  executor, scheduler, service, runners, supervisor tools, `src/core/faults.ts`; CLI, MCP,
  insights, panel; `src/operations/{backup,daemon,service}.ts`, `storage/db.ts`, config; docs
  `operations.md`, `setup.md`.
- Why: requirement 1 (resume where it stopped) and 2 (survive failures).
- Validation: s2 branch: typecheck router+panel Done, 147 tests passed, panel on :4521 pages 200
  and API 400/401/404/409/200 as expected, screenshots inspected (worker); supervisor re-ran
  typecheck + 147 tests and inspected the resume screenshot. r1 branch: 145 tests passed; the
  supervisor reproduced the worker exiting, fixed it, and saw it stay alive (exit 124 at
  timeout). Merged dev: router build ok, `pnpm -r typecheck` Done, `npx vitest run tests` -> 19
  files, 170 passed.
- Outcome: Accepted
- Follow-up: R1b, T1.

---

### 2026-10-19 — R1b, and V1+V2 merged with resume
- Agent: supervisor; worker r1b-resilience (`feat/r1b-resilience`); V merge per the
  importance-and-verification ledger
- Changed: `src/core/watchdog.ts`, `src/gateway/breaker.ts`, gate, select, scheduler, executor
  hook, insights `providerHealth`, `tests/resilience.test.ts`; docs `operations.md`,
  `decisions.md` (15).
- Why: requirement 2 (survive failures); R1 acceptance.
- Validation: r1b branch: supervisor ran typecheck Done, resilience 11/11, full 181/181. Merged
  dev after V: router build ok, `pnpm -r typecheck` Done, `npx vitest run tests` -> 25 files, 242
  passed; `pnpm -r build` Done.
- Outcome: Accepted
- Follow-up: T1.

---

### 2026-10-19 — Phase T1 (task graph, file leases, upstream results)
- Agent: supervisor; workers t1-graph, t1-surface, seed-merge (`feat/t1-task-graph`)
- Changed: `src/storage/{plans,file-leases}.ts`, `src/context/upstream.ts`, scheduler,
  executor (context), supervisor tools and charter, config `team`, CLI, MCP, `src/admin/*`
  split, panel plan card and shared HelpTip fix, presets; docs `roles.md`, `operations.md`
  (Teams), `decisions.md` (17), CLAUDE.md layout, AGENTS.md areas.
- Why: requirement 3 (native multi-agent teams).
- Validation: supervisor applied t1-graph's test fix (overlap test now waits and asserts the
  lease wait), passed the service clock to plan writes, resolved the migration and
  supervisor-tools conflicts with V3 (one supervisor edit broke two tests and was reverted);
  branch after merging dev: router build ok, `pnpm -r typecheck` Done, `npx vitest run` -> 28
  files, 265 passed; plan-view screenshot inspected; seed worker confirmed plan and calibration
  demo data.
- Outcome: Accepted
- Follow-up: T2.

---

## Open Questions

- Where should session logs live when the state directory is on a network volume (fsync
  semantics differ)? Owner: user, when R2 is scheduled.
- Default team size: start at `team.max_agents: 8` with adaptive limits, or tie it to provider
  capacity only? Recommended: capacity-driven with a cap of 8 by default. Owner: user.
