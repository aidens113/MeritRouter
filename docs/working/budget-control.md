# Budget control: supervisor-set budgets and requests for more

Status: Active
Status detail: B1 and B2 done; panel acceptance passes; real-provider job/CLI/MCP transport validation remains outstanding.
Created: 2026-10-21
Last updated: 2026-10-22
Owner: Senior supervisor agent
Scope: Per-task request budgets are set by the supervisor that delegates (with a configured
default), and a worker that runs low asks its supervisor for more instead of stopping.
Paired document: none
Related: [live-validation](./live-validation.md), [agent-sessions-and-teams](./agent-sessions-and-teams.md)

---

## Current State

**Why (live 2026-10-21):** in the Pomodoro and Facebook-clone jobs, implementers stopped with
"model request budget (N) exhausted" while the provider quota was 99% unused: SwitchYard's own
caps (T2 8, T3 12, 16 per task, 24 total) starved real coding work. The presets now use much
higher caps (T2 60, T3 100, 150 per task, 300 total; commit 7537187) and coding runs get a stall
nudge and a repeat-call note. The user asked for the next step: "a supervisor should set the
budget limit (which has a default value) when it spawns subagents", and "if a submodel hits a
limit, it should be able to request more from a supervisor".

**What exists:** a task's cap is `effectiveBudget` (profile, tier, execution ceiling, the spec's
`budget.maxModelRequests`) inside the verification contract's total
(`verification.max_total_requests_per_task`); sub-jobs get a carved share of the parent's
remaining requests (`team.child_budget_share`, `job_budget_carves`); a contract's budget is fixed
when the task starts. Workers already ask supervisors for brain access (`brain_request_access`,
`brain_access_requests`, `brain_decide_request`), the pattern this plan reuses.

**Done (B1, merged 7f8d2df, report `reports/budget-control-b1.md`):** job request pool with
`max_requests` on briefs (default: the tier cap held from the pool), `team.supervisor_reserve_requests`
(4), `request_more_budget` with supervisor / auto / human decisions (MCP `budget_requests`,
`decide_budget_request`; CLI `switchyard budget`), delegate-only supervisors
(`supervisor.implementation: delegate`, `coordination_paths`, brief `shared_files`, conflict files),
`run_check` for implementers' declared checks (`coding.max_check_runs_per_task` 20). Presets:
supervise 1000. Supervisor accepted the worker's three choices (held default, 1000, reserve 4).
Validation: worker 587 tests; supervisor reviewed the edit gate and run_check, merged dev into the
branch, 587 passed, `pnpm -r build` and typecheck pass on dev.

**Not verified:** a live job; the CLI `budget` command run; MCP budget tools over a transport;
OpenCode/command runners lack the new tools; `**/*.md` coordination paths may be wider than wanted.

**Done (B2, 901161a; integrated 6927dba):** pending requests on job/task/project/install pages,
approve/deny with reasons and partial grants, job pool/held/reserve/available totals, task grants
and extras, and live budget invalidation. Scoped decisions reject unassigned/cross-project
requests rather than treating empty scope as a wildcard. Demo seeds two genuine pending human
requests without running a scheduler.

**Verified:** supervisor production browser approval (partial grant 1), denial, required reason,
wrong-project 404, invalid reason 400, over-pool/stale 409, independent budget live refresh with
open history retained, task Usage extras, phone/desktop light/dark screenshots and 200 pages.
Full integrated suite 622/622, recursive typecheck and build pass. Worker report:
[panel-b2.md](budget-control/reports/panel-b2.md). Acceptance details also in Panel v2 validation.

**Next steps:** real-provider team job; CLI/MCP budget transport checks. B2 implementation is complete.

**Blockers:** none.

---

## Decisions (recommended defaults; the user may override)

- **D1. The supervisor sets each delegated task's budget.** `delegate` and `plan_work` nodes take
  `max_requests`; without it the task gets `team.default_task_requests` (default: the tier cap).
  It must fit in what the job has left (its own budget minus requests held by running and queued
  children), checked in code; an over-ask is refused with the number available.
- **D2. A job has one request pool.** The supervisor's own requests and every child's grant come out
  of the job's budget (`profiles.supervise.max_model_requests`, or the parent's carve for a
  sub-job). Unused grants return to the pool when a child finishes.
- **D3. A worker can ask for more.** Tool `request_more_budget(requests, reason)` for every worker
  role (offered when it has a supervisor or an external approver). The run waits (no model
  requests) up to `team.budget_request_wait_seconds` (default 300) for a decision.
  - Approved: the task's contract total and run cap grow by the granted amount (from the job's pool),
    the run continues with a note of the new limit.
  - Denied or timed out: the run continues to its final request, which submits (as today).
  - At most `team.max_budget_requests_per_task` (default 3) requests per task.
- **D4. Who decides:** `team.budget_approver: supervisor | auto | human` (default `supervisor`).
  - `supervisor`: the job's supervisor sees pending requests in `await_tasks` (which returns
    early on one) and decides with `decide_budget_request(id, approve, grant, reason)`.
  - `auto`: granted while the job's pool has room, up to `team.auto_grant_max` per request.
  - `human`: decided in the panel or the CLI.
  - Top-level tasks with no job (MCP `submit_tasks` from Claude Code or Codex): the external
    supervisor decides through MCP tools `budget_requests` and `decide_budget_request`, or `auto`.
- **D5. Recorded everywhere:** every request and decision is an event and a row
  (`budget_requests`), visible in the job's channel, the task page, and the session timeline.
  Granted requests count in the contract's budget history.
- **D7. Supervisors delegate implementation (user concern 2026-10-21: "the supervisor is doing a
  ton of the work").** `supervisor.implementation: delegate | allowed` (default `delegate`). Under
  `delegate` the supervisor's edit tools are limited, in code, to coordination files: the working
  documents in the brain, files its briefs name as shared interfaces or docs (for example
  `INTERFACES.md`, `README.md`), and conflict fixes during integration; any other edit is refused
  with "delegate it". When a worker fails or runs out, the supervisor re-delegates (with more
  budget, a narrower brief, or after a dependency lands) instead of writing the code itself; the
  charter says so. `allowed` keeps today's behaviour for small jobs.
- **D6. Paid spend is unchanged.** Extra requests never raise the dollar budgets; a paid request
  still needs paid headroom.

---

## Phases

| Phase | Deliverable | Acceptance |
| --- | --- | --- |
| B1 | Router: `max_requests` on delegate/plan_work with the pool check; `request_more_budget`; `budget_requests` table and events; supervisor `await_tasks` wake-up and `decide_budget_request`; auto and human approvers; contract and run-cap growth; MCP tools; CLI `switchyard budget list|approve|deny`; charters teach it | Scripted-model tests: a supervisor sets a child's budget; an over-ask is refused with the number left; a worker near its cap requests more, the supervisor approves, the worker continues past its old cap; a denial lets it submit; auto approves within the pool; timeout path; unused grant returns to the pool |
| B2 | Panel: pending budget requests (approve or deny), the job's pool (used, granted, left), each task's grants | Demo seed with a pending request; pages 200; screenshots |

---

## Worker Briefs

### Brief: budget-control-b1
- Repository: this repository; your own worktree on branch `feat/budget-control`; run
  `pnpm install --frozen-lockfile` first.
- Task: Phase B1 exactly as the Decisions describe, including D7 (supervisor edit limits and the
  re-delegation charter rules; test: under `delegate` a supervisor edit to src/ is refused while an
  INTERFACES.md edit and an integration conflict fix are allowed). Reuse the brain access-request pattern for the
  request/decision flow. Budgets are enforced in code (admission and the contract), never by
  prompt text alone.
- Required reads: this document; `AGENTS.md`; `src/admission/admission.ts`, `src/verification/contract*.ts`,
  `src/harness/supervisor-tools.ts`, `src/harness/loop.ts`, `src/harness/tools.ts`,
  `src/brain/access.ts` (request pattern), `src/mcp/tools.ts`, `packages/router/charters/`.
- Owns: `packages/router/src/**` except `src/admin/live*.ts` (another worker's), `packages/router/tests/**`,
  `packages/router/charters/**`, `packages/router/examples/**` (regenerate presets with the script),
  `docs/roles.md`, `docs/operations.md`, `docs/working/reports/budget-control-b1.md`.
- Must not touch: `apps/panel/**` (B2 later), this document, other working documents, `AGENTS.md`, `CLAUDE.md`.
- No live provider calls; never the user's install (D:\SwitchYard, panel 4477).
- Definition of done: the B1 acceptance tests; `pnpm -r typecheck`; full router suite; `pnpm -r build`.
- Report to: docs/working/reports/budget-control-b1.md

---

### Brief: budget-panel-b2
- Repository: D:/SwitchYardRouter/.claude/worktrees/budget-panel, feat/budget-panel. Isolated worktree because supervisor validates Panel v2 concurrently. Install frozen/offline.
- Task: Implement B2: pending budget requests with human approve/deny, reasons and optional partial grants; job pool used/granted/held/available; per-task grants/extras. Expose pending requests in project and install attention views. Reuse existing insights budget APIs; library enforcement remains authoritative.
- Required reads: this doc Current State/Decisions/Phases; admin/budget.ts and admission/budget-requests.ts; panel API handle/body, actions patterns, job/task/overview components. Public budget APIs are stable.
- Owns: new panel components/budget-requests.tsx, client/budget-decision.tsx (or clearly named budget files); new app/api/budget/requests/[id]/route.ts; job detail, task-detail, project overview and install dashboard integration; admin/budget.ts; admin/live.ts + tests/admin-live.test.ts for budget topics; new tests/admin-budget-panel.test.ts; report below.
- Must not touch: seed-demo.mjs (supervisor adds fixtures after seed repair); brain files, link components, shared docs, export files. No commits/push. Do not edit root checkout.
- Requirements: zod bodies/IDs; strict project scope including unassigned requests; fail stale/finished/pool-exhausted decisions as actionable 409/400, not 500. Test project denial and budget invariants. Live budget changes must refresh subscribed views. Accessible controls and phone layout; pending count navigates to decisions.
- Definition of done: B2 core UI/API implemented, focused tests and builds/typecheck observed; supervisor seeds pending requests and validates browser approve/deny/caps after integration. Report exact commands and unresolved risks.
- Report to: docs/working/budget-control/reports/panel-b2.md in your worktree.

## Work Ledger

### 2026-10-21 — Plan written
- Agent: supervisor
- Changed: this document; `docs/working/README.md`.
- Why: user requests after live jobs stopped on SwitchYard's own caps.
- Validation: not validated (design only). Evidence: live sessions in live-validation.md; caps in
  `src/admission/admission.ts` (`effectiveBudget`), `src/config/schema.ts`.
- Outcome: Accepted

---

### 2026-10-22 - B2 accepted
- Agent: supervisor; worker link_completion.
- Changed: panel budget decisions, pool/task grant summaries, attention views, scoped API, budget live topic and demo requests; operations documentation updated.
- Validation: supervisor full integrated suite 622/622, recursive typecheck/build, demo seed exit 0. Browser partial approve/deny, reason validation, scope/pool/stale responses, independent budget live refresh and task extras; desktop/phone light/dark captures inspected. See Panel v2 validation for artifacts.
- Outcome: Accepted for B2. No real-provider job or CLI/MCP transport claim.
- Follow-up: dev/main integration with Panel v2; live team/transport checks remain separately listed.

## Open Questions

- Should `auto` be the default approver for free-only installs (no paid routing), since extra free
  requests cost only time? Default here: `supervisor`.
