# Agent sessions, failure resilience, and agent teams

Status: Active
Status detail: Requirements recorded and design drafted 2026-10-19; implementation not started.
Created: 2026-10-19
Last updated: 2026-10-19
Owner: Senior supervisor agent
Scope: Make every unit of work a durable, resumable agent session; make the system survive process, machine, and model failures; turn SwitchYard into a framework for coordinated agent teams that decompose work and run as many agents in parallel as capacity allows.
Paired document: none
Related: [harness, roles, brain](./harness-roles-brain.md), [decisions](../decisions.md), [roles](../roles.md), [operations](../operations.md)

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

**Not done:** everything below.

**Next steps:** Phase S1 (agent sessions), then R1 (durability), T1 (teams).

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
  - automatic review agents for implementation tasks (config), and optional redundant execution
    of small tasks on two cheap models, taking the first validated result.
- **Cost-aware staffing:** cheap free models for leaf work, strong models for planning and review;
  the planner picks tiers per node and prefers more small tasks when capacity is free.
- **Metrics:** wall-clock per job, parallelism achieved over time, critical-path length,
  requests and cost per completed task, comparison of team versus single-agent runs on the
  qualification suite.

## Phases

| Phase | Deliverable | Acceptance |
| --- | --- | --- |
| S1 | Session store (event log, tool journal), all runners on the session engine | Every model call and tool call appears in a session log; panel/CLI show it |
| S2 | Resume protocol for every role | Fault-injection tests: kill at each step, resumed sessions finish without duplicated edits, delegations, or paid charges |
| R1 | Durability settings, daemon with service install, watchdog, backup | Process kill and restart resumes all sessions; `switchyard backup` restores |
| T1 | Task-graph planning, ready-node parallel dispatch, team-wide file leases | A goal splits into N independent tasks that run concurrently up to capacity |
| T2 | Sub-supervisors, merge queue, team channel, auto-review | Nested job completes with correct attribution and no lost integrations |
| T3 | Adaptive concurrency per provider, cost-aware staffing, metrics | Panel shows parallelism and critical path; throughput beats single-agent on the eval suite |
| R2 (later) | Postgres store, multiple worker hosts | Two hosts share one queue without double execution |

## Worker Briefs

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

## Open Questions

- Where should session logs live when the state directory is on a network volume (fsync
  semantics differ)? Owner: user, when R2 is scheduled.
- Default team size: start at `team.max_agents: 8` with adaptive limits, or tie it to provider
  capacity only? Recommended: capacity-driven with a cap of 8 by default. Owner: user.
