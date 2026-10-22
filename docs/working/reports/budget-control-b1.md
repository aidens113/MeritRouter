# Report: budget-control-b1

Worktree: `D:\SwitchYardRouter\.claude\worktrees\agent-a30d5c30627090b20`, branch `feat/budget-control`
(fast-forwarded to `dev` 1b3766d first). Nothing committed.

## Outcome

Done. Phase B1 (D1-D5, D7) and the supervisor's addition ("declared checks for implementers") are
implemented in the router, with charters, docs, presets, and 13 new scripted-model tests. The full
router suite passes (587 tests, up from 574), `pnpm -r typecheck` and `pnpm -r build` pass.

## What changed and why

**Storage and config**
- `src/storage/migrations.ts`: new migration (appended) with `task_request_grants` (each delegated
  worker's grant) and `budget_requests` (requests for more and their decisions, with a project
  trigger like the other per-project tables). `src/projects/deletion.ts` removes both with a project.
- `src/config/schema.ts`: `team.default_task_requests` (optional), `team.supervisor_reserve_requests`
  (4), `team.budget_approver` (supervisor | auto | human), `team.budget_request_wait_seconds` (300),
  `team.max_budget_requests_per_task` (3), `team.auto_grant_max` (30); `supervisor.implementation`
  (delegate | allowed, default delegate) and `supervisor.coordination_paths` (`**/*.md`, `docs/**`);
  `coding.max_check_runs_per_task` (20). `src/projects/schema.ts`: these are project-overridable.

**The pool (D1, D2)**
- `src/admission/job-pool.ts` (new): grants, approved extras, and what each granted task holds
  (open: grant + extras, or what it used if more; finished: what it used, so the rest returns).
- `src/admission/admission.ts`: `heldRequests` = sub-supervisor carves + worker holds; the
  supervisor's admission check now counts it (one pool, enforced at reservation).
- `src/admission/budget-requests.ts` (new): `jobPool` (cap, supervisor used, held, reserve,
  available), `defaultTaskGrant`, `BudgetRequests` (file, decide, autoDecide, expire; the pool check
  and the decision run in one transaction; events and channel posts), `approverFor`.
- `src/harness/supervisor-tools.ts`: briefs take `max_requests` and `shared_files`; `dispatchBriefs`
  grants every new worker brief and refuses the call when they do not fit, naming the number left
  (`grantBriefs` in `budget-tools.ts`); an explicit `max_requests` (or a configured
  `default_task_requests`) becomes the task's `budget.maxModelRequests`; grants are recorded after
  submission and re-recorded on resume (`ensureCarves`); sub-supervisor carves now come from what is
  left after worker holds; `await_tasks` returns early on a pending supervisor-decided request and
  lists pending requests with the pool.

**Requests for more (D3-D5)**
- `src/harness/budget-tools.ts` (new): worker tool `request_more_budget(requests, reason)` (every
  worker role, not verification reviewers; count limit in code; waits without requests; auto decides
  at once; timeout expires the request; an approval raises `ctx.budget` immediately), supervisor tools
  `budget_requests` and `decide_budget_request` (only this job's supervisor-decided requests; grant
  must fit the pool). Offered to native coding and read-only runners.
- `src/core/executor.ts`: a first run's cap adds approved extras (resumed and later runs keep grants).
- `src/core/service.ts`: task status `maxModelRequests` includes extras.
- `src/verification/trail.ts`: `budgetGrants` (the contract's budget history from `budget_granted`).
- `src/harness/loop.ts`: one low-budget notice when the worker can ask (allowance >= 6); after a
  grant the final-request notice and the low notice reset.
- `src/core/watchdog.ts`: `request_more_budget` is a deliberate wait (exempt).
- `src/admin/budget.ts` (new, re-exported by `insights.ts`): `budgetRequestsView`,
  `decideBudgetRequest` (a person decides anything; an MCP client anything but `human`), `jobBudget`,
  `taskBudget` (for B2's panel).
- `src/mcp/tools.ts`: MCP tools `budget_requests` and `decide_budget_request` (36 tools now).
- `src/cli.ts`, `src/cli/help.ts`: `switchyard budget list|approve|deny` (`--status`, `--job`,
  `--grant`, `--reason`).
- `src/index.ts`: exports for the new modules.

**D7: supervisors delegate implementation**
- `src/harness/coordination-edits.ts` (new): `coordinationGuard` allows only `coordination_paths`,
  files briefs named in `shared_files` (persisted as `shared_files_declared` job events), and files of
  this job's merge-queue items whose latest attempt ended `conflict`; everything else is refused with
  "delegate it". `allowed` returns no guard.
- `src/harness/tools.ts`: the workspace takes an optional `guard`; `workspacePath` applies it.
- `src/runners/supervisor.ts`: wires the guard and states the mode and pool in the job prompt.

**Addition: declared checks for implementers**
- `src/harness/tools.ts`: `declaredCheckTool()` (`run_check`): only a declared check, exactly as
  declared (trimmed match allowed); unknown commands refused with the list; same cwd, environment
  (`minimalEnv({HOME, USERPROFILE, CI})`), timeout, and shell as `finishCoding`'s checks; output
  capped; log stored as a `check_log` artifact labelled `run_check: <cmd>`; each run a
  `worker_check_run` event, counted against `coding.max_check_runs_per_task`. Informational only.
- `src/runners/coding/native.ts`: offers it when the task declares checks; the system prompt says to
  run them with `run_check` and that there is no other shell.

**Charters, presets, docs**
- `charters/supervisor.md` (delegate implementation, re-delegate instead of coding; new "Budget your
  workers" section), `charters/worker.md` (ask early with `request_more_budget`),
  `charters/implementer.md` (run declared checks, no shell).
- `examples/switchyard.config.example.yaml` and `scripts/build-presets.mjs` (supervise
  `max_model_requests` 300 -> 1000, since the job's budget now holds every delegated task's grant),
  presets regenerated with the script.
- `docs/roles.md` (supervisor rules 4 and 6, worker rules, new "Budgets and requests for more"),
  `docs/operations.md` (limits table rows, team section entries).

## Commands run and observed results

- Baseline before changes: `pnpm build` then `npx vitest run` -> 57 files, 574 tests passed.
- `npx vitest run tests/budget-control.test.ts` -> 13 passed (13).
- Final, after all edits: `pnpm -r typecheck` -> exit 0 (router and panel);
  `pnpm --filter switchyard-router build` -> exit 0; `cd packages/router && npx vitest run` ->
  "Test Files 58 passed (58), Tests 587 passed (587)"; `pnpm -r build` -> exit 0 (panel build Done).
- An intermediate full run failed only the 4 MCP tool-list tests (36 tools now); I updated
  `tests/mcp.test.ts` and `tests/mcp-http.test.ts` to the new list and counts.

New tests (`tests/budget-control.test.ts`): a supervisor sets a child's budget and an over-ask of 40
is refused with "25 left"; unused grant returns to the pool; default grant from
`team.default_task_requests`; a worker at cap 3 asks, the supervisor approves +3, the worker uses 6
requests and submits (row, events, channel posts, status, session, trail all checked); a denial lets
it submit at 3; auto grants up to `auto_grant_max`; auto denies on an empty pool; a 3-second timeout
expires and the worker continues; a top-level task decided through `decideBudgetRequest` (the MCP
path) runs past its cap; human approver refuses an MCP decision and a wrong project; a finished
task's request expires; the per-task request limit; D7 refuses `src/app.ts`, allows `INTERFACES.md`
and a conflict fix (merge-queue row in `conflict`), and `shared_files`/`allowed` at the guard level;
`run_check` runs a declared check (exit 1 then 0, logs stored, events), refuses `node --test` with the
list, refuses past 2 runs, and is not offered without declared checks.

## Not verified

- Nothing ran against a live provider, OpenCode, or the user's install.
- The CLI `budget` command was typechecked and built but not executed in a test.
- The MCP tools were only checked through the tool list and the shared `decideBudgetRequest`
  function, not by calling them over a transport.
- The external coding runners (OpenCode, command) do not get `request_more_budget` or `run_check`
  (they have no SwitchYard tool loop); their caps still include approved extras.
- A sub-supervisor cannot itself ask its parent for more budget (only worker roles are offered the
  tool, per D3).

## Open questions or contradictions found

- Default grant semantics: D1 says the default is "the tier cap". Without `team.default_task_requests`
  I hold the execution cap at the brief's tier (its difficulty, else T2 or the profile's floor) but do
  not narrow the task's budget, so review and repair reserves stay as before and the pool counts what
  the task actually uses beyond the hold. Setting `team.default_task_requests` makes it the task's
  budget, like `max_requests`.
- Pool sizing: with the presets' T2 cap of 60, the old supervise budget (300) would have held only
  about 4 open workers (a plan dispatches every node at once and queued nodes hold too), so I raised
  the presets to 1000. The supervisor should confirm this value.
- I added `team.supervisor_reserve_requests` (default 4), not in the Decisions, so grants can never
  starve the supervisor's own turns; admission refuses the supervisor's own requests that would eat
  into open holds.
- Under `delegate`, `**/*.md` lets a supervisor edit any Markdown file, not only those its briefs
  name; narrow `supervisor.coordination_paths` if that is too wide.
- The project-settings panel (B2 or the panel worker) may want to show the new overridable keys.
