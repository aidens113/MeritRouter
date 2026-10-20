# Report: t3-metrics

Worker report for "Brief: t3-metrics" in [agent-sessions-and-teams.md](../../agent-sessions-and-teams.md).
Worktree `D:\sy-wt\s2`, branch `feat/t3-metrics`. Nothing committed. One index change: the move of
`src/admin/job-team-text.ts` to `src/cli/` was done with `git mv`, so the rename is staged.

## Outcome

Done. Everything below was built and checked:

- job metrics, derived from stored data;
- the team-vs-single comparison runner;
- CLI `switchyard metrics` and `switchyard compare`;
- MCP `get_job_metrics`;
- the panel Teams view, a metrics card on the job page, and API routes;
- the CLI formatting move into `src/cli/`. `cli.ts` went from 813 to 478 lines, and the output of every
  moved command is byte-identical;
- the fix to a sub-job's result text.

Typecheck, the full router suite (297 tests), `pnpm -r build`, the demo seed (which includes one
recorded comparison), curls, CDP overflow checks, and screenshots all passed.

## What changed and why

**Metrics: `packages/router/src/admin/job-metrics.ts` (new)**

`jobMetrics(sy, id, {now?})` takes any task id:
- for a `supervise` task it returns `kind: "team"`, covering every task under it, sub-jobs included;
- for any other task it returns `kind: "single"`, which describes one agent. This lets the two runs of a comparison be measured the same way.

Nothing is sampled. `agentTimeline` replays each task's events:
- **Running.** A run starts at `claimed` and ends at a terminal event, `interrupted`, or `waiting_for_capacity`.
- **Waits** are attributed to a reason:
  - `dependencies`: from `submitted` in `waiting_for_dependencies`;
  - `acceptance`: `dependency_awaiting_acceptance`;
  - `file_lease`: `waiting_for_file_lease`;
  - `provider_slot`: a `waiting_for_provider_slot` event, or that prefix on the task's current `state_reason` (whichever the capacity worker records);
  - `capacity`;
  - `queue`: ready, but waiting for a worker or the agent cap, which the scheduler records no reason for;
  - `interrupted`: until `resumed`.

What it returns:
- wall-clock (first start to finish) and the time queued before the first start;
- `parallelism.points`: change points of agents running and tasks waiting, plus peak, the time-weighted mean over the wall-clock, busy time, and total agent time;
- the critical path:
  - planned: the latest plan's `criticalPath` by estimated cost, plus the agent time those nodes took;
  - actual: the longest dependency chain of the job's direct tasks by running time, with a sub-job counted as one node;
- requests: distinct ids, so a batch request charged to two tasks counts once. They are given by purpose, with the failed count, cost (`reported_cost_usd`, else `estimated_cost_usd`), and requests and cost per completed task;
- the verification share of requests;
- waiting time by reason, and how many tasks waited;
- per-agent timelines, and a summary for each sub-job.

Two cases stop the clock early:
- A job left interrupted stops at its last event, not at "now".
- Timelines are cut at the job's end.

`teamMetrics(sy)` lists summaries for the newest jobs. `insights.ts` re-exports all of this, and `index.ts` exports it.

**Comparison runner: `src/qualification/comparison.ts` (new)**

`planComparison(sy, {evalIds?, goals?, teamFactor?, teamRequests?})` builds the plan. It does not run anything.
- **Goals** are either:
  - the eval suite's coding and read-only goals (review evals are excluded), each run on its own fresh fixture copy;
  - a supplied set, validated with zod: `{id, goal, repository, profile: inspect|analyze|implement, acceptanceCriteria, allowedPaths (required for implement), checks?, singleRequests?, teamRequests?}`.
- **Caps.** Each run gets a request cap. The single run's cap is the eval's `budget.maxModelRequests`, or 8. The team run's cap is `teamRequests`, else 3 × the single cap.
- **Budget check.** `plannedRequests` is the sum of every cap. It is checked against what is left of `qualification.max_requests_per_day`. "Used today" counts qualification requests plus `comparisonRequestsToday`: a recursive CTE over tasks with purpose `comparison` and everything under them.

`runComparison(sy, plan, opts)` runs it:
- It re-checks the budget and refuses if the plan no longer fits.
- Each goal runs as a team job (a `supervise` task) and then as a single agent, one after the other. The order is the same for every goal. Both runs:
  - get the same config and model pools;
  - are submitted with purpose `comparison`;
  - carry `budget.maxModelRequests` set to their cap.
- **Enforcing the team cap.** The team's cap covers the whole tree, so the runner checks it every `pollMs` (500 ms by default). Once the cap is reached, it cancels every open task in the tree. The run timeout also cancels.
- It records events with `task_id` NULL: `comparison_started`, then one `comparison_run` per goal holding both metric snapshots and the served endpoints, then `comparison_finished`.
- `comparisons()` and `comparison(id)` read the records back, validated with zod. No migration was needed.

Also in `runner.ts`: `initRepo` is now exported, and `Qualifier.suiteDir` is now public.

**CLI move: `src/cli/` (new)**

These are pure moves of existing code:

| File | What it holds | Lines |
| --- | --- | --- |
| `terminal.ts` | out, table, oneLine, clock, stamp, duration, plural | |
| `args.ts` | countFlag, statusFlag, withImportance | |
| `session-text.ts` | timeline, plus the `sessions` rows, extracted from the inline map | |
| `plan-text.ts` | | |
| `job-team-text.ts` | moved from `src/admin/`; it now imports stamp and plural from `terminal.ts` | |
| `operations.ts` | backup, restore, daemon, service | |
| `help.ts` | | |

`operationsCommand` now takes `cliPath` as a parameter. Without it, `import.meta.url` would have pointed at `dist/cli/operations.js` and broken the daemon and service.

New in `src/cli/`: `metrics-text.ts`, which has the metrics text with a sparkline, the comparison plan, comparison results, and the list.

New commands:
- `switchyard metrics <job|task> [--json]`.
- `switchyard compare [--eval a,b] [--goals file] [--team-factor n] [--team-requests n] [--timeout s] --dry-run|--yes`. It always prints the plan and the planned request budget first:
  - with `--dry-run` it stops there and says "dry run: nothing ran";
  - without `--yes` it also runs nothing and prints "nothing ran: add --yes to run it (up to N requests)". It exits 1 when the plan does not fit;
  - with `--yes` it opens a worker in-process, runs, and prints progress lines and the result.
- `compare list` and `compare show <id>`.
- The help text was updated for these.

`cli.ts` is now dispatch only: 478 lines.

**MCP** (`src/mcp.ts`): new tool `get_job_metrics {jobId, agents?}`. Per-agent intervals are included only with `agents: true`.

**Sub-job result text** (`src/runners/supervisor.ts`): for a sub-job the summary now reads "delivered on <branch>; the parent job <id> integrates it through its merge queue (integrate_task <label>)". It used to say `git merge`. The same fix is in two other places, for sub-jobs only:
- the CLI `job` branch line: "(the parent job integrates it)";
- the panel Branches card.

**Panel**
- `components/client/charts.tsx`: a new `StepChart`, following the existing chart conventions:
  - the first series is a filled step area and the others are dashed step lines, so identity is never shown by colour alone;
  - a legend, a hover and keyboard crosshair with a tooltip, and a table view twin;
  - colours `--series-1` / `--series-2`, checked with the dataviz validator in light and dark (all checks pass);
  - `ChartTooltip` gained `showTotal`.
- `components/job-metrics.tsx` (new):
  - `JobMetricsCard` holds six stat tiles, the "Agents over time" step chart, waiting time by reason (`StackedBars`, in seconds), an agents table, and the sub-jobs;
  - `MetricsTable` is a reusable table of metric summaries.
- `app/teams/page.tsx` (new), with a "Teams" nav item:
  - summary stats;
  - a jobs table with metrics (pick a row with `?job=`);
  - the selected job's metrics card;
  - "Team vs single agent", with recorded comparisons side by side (outcome, wall-clock, peak/mean, requests against the cap, cost, critical path, verification, and a speed ratio);
  - an empty state that points to `switchyard compare --dry-run`.
- `app/jobs/[id]/page.tsx`: shows the metrics card when the job has agents, and the sub-job branch text above.
- New API routes:
  - `app/api/jobs/[id]/metrics/route.ts`, with `?agents=1`;
  - `app/api/comparisons/route.ts`, with `?limit` (1–100). It is read-only.
- `lib/glossary.ts`: new terms parallelism, waitReason, and comparison.
- `scripts/seed-demo.mjs` records one comparison at 1.62 h. The goal is a supplied read-only goal on `core`:
  - the team supervisor plans two parallel inspect nodes with `plan_work`, so two agents run at once;
  - the single run is one inspect task.

  Every existing job gets metrics from its stored runs.

**Tests**
- `tests/team-metrics.test.ts` (new, 7 tests):
  - A seeded job with known intervals under a fake clock. The tests assert exactly:
    - the 17 change points;
    - peak 2, mean 0.8, busy 36 s, agent time 39 s;
    - both critical paths: a→c→d, 26 s;
    - 12 distinct requests by purpose, 1 failed, $0.025, 2.4 requests per task, verification 0.167;
    - waits by reason: dependencies 62 s, file_lease 11, provider_slot 2 (from a synthetic `waiting_for_provider_slot` event), capacity 3, queue 1.5;
    - one agent's single view;
    - `teamMetrics`.
  - A sub-job counts in its parent and is summarised; an interrupted parent's clock stops.
  - `provider_slot` is taken from `state_reason` alone.
  - CLI `metrics` text, `--json`, unknown, and usage.
  - A comparison with a fake gateway (ScriptedClient) records both runs. It also covers:
    - plan validation;
    - progress lines;
    - `comparisonRequestsToday`;
    - `usedToday`.
  - A team stopped at its cap: 5 to 8 requests out of a possible 13, and `cancelled`. A plan that does not fit is refused, and nothing is recorded.
  - CLI `compare --dry-run`, the run without `--yes`, `--eval`, an unknown eval, `list`, and `show`.
- `tests/mcp.test.ts`: `get_job_metrics` is in the tool list. Also checked: the unknown error, the single view, and that `agents` is omitted unless asked for.

## Commands run and observed results

- `pnpm --filter switchyard-router build`: passes.
- `pnpm -r typecheck`: router Done, panel Done.
- `cd packages/router && npx vitest run`: 32 files, **297 tests passed**. `tests/team-metrics.test.ts` was run 3 more times, 7/7 each time; the cap test did not flake.
- `pnpm -r build`: router Done, panel Done. The route list includes `/teams`.
- **CLI byte-identity.** I reseeded a baseline demo with the pre-change code and froze a copy in the scratchpad (`t3m-demo-frozen`). `t3m-capture.mjs` captures 215 commands against it: help, jobs, every job's `job`/`plan`/`channel` (text, `--json`, `--limit`, `--kind`, bad kind), `sessions` (filters, bad flags), `session` for all 63 sessions (with paging and `--json`), status, questions, models, route, keys, brain ls, blame, qualify status, backup, restore, service, resume, an unknown command, and error paths. Capturing twice before the change gave identical output. After the move, `diff -r` shows only three intended differences:
  - `--help` and the unknown-command help: the new `metrics` and `compare` lines;
  - the sub-job's `job` output: "(the parent job integrates it)".
- `switchyard metrics` on every frozen demo job printed sensible values, for example plan-divide-modulo: critical path scan → modulo → check-exports, waiting for dependencies 9.3 s and file lease 2.2 s. This run exposed a `longestChain` crash on single-node jobs; it is fixed and covered by the tests.
- `switchyard compare --dry-run` on the demo: 5 eval goals, up to 200 requests, fits 0/200.
- `pnpm --filter switchyard-panel seed:demo`: every phase completed. The new line: `comparison: team vs single (read-only goal)  finished; team completed peak 2, 7 requests; single completed, 2 requests`. `switchyard compare list` shows the comparison.
- **Production panel** on 127.0.0.1:4541 against `.demo`:
  - 200: `/`, `/jobs`, `/teams`, `/teams?job=<cmp team>`, `/teams?job=nope`, three job pages, `/api/jobs/<id>/metrics`, `?agents=1`, `/api/comparisons`, `?limit=2`, `/api/jobs/<id>/plan`;
  - 400: `?agents=x`, a bad id, `?limit=0`;
  - 404: `/api/jobs/nope/metrics`;
  - the sub-job page has the "parent job integrates" text and no `git merge --no-ff`.
- **Overflow**, checked with CDP (`t3m-cdp.mjs`) on `/teams`, `/teams?job=…`, `/jobs/<plan job>`, and `/jobs` at 1400, 800, and 420: `scrollWidth === clientWidth` every time (1400/1400, 800/800, 420/420). No element sticks out past the viewport outside a scroll container. The metrics card and step chart are present.
- **Screenshots** in the scratchpad, which I looked at:
  - `t3m-teams.png` (1400, dark), `t3m-teams-1400.png`, `t3m-teams-light.png` (light theme), and `t3m-teams-800.png`;
  - `t3m-job-metrics-card.png` (the plan job's metrics card);
  - `t3m-job-metrics-hover.png`, where hover shows the crosshair and the tooltip "From +6s to +8s: 1 agents running, 2 tasks waiting".

  After the screenshots I made one change: the waiting-bar heading now says "seconds", and the panel was rebuilt. No new screenshot was taken.
- The server was stopped (port 4541 freed) and the test Chrome processes were killed.

## Not verified

- Comparisons against live providers. A real `compare --yes` was never run, by design.
- Running eval-suite goals as an actual comparison. Only supplied goals were run, in the tests and the demo. The eval path is covered only by `--dry-run`, which builds the plan and checks budget and fixtures but copies no fixture. A team job on an eval fixture copy is untested.
- The real `waiting_for_provider_slot` producer, which is on t3-capacity's branch. It is tested with a synthetic event and a synthetic `state_reason`.
- Twin runs (`redundancy: 2`) count as one agent, because metrics use task run intervals as briefed. The demo's survey twins show peak 1 where two sessions ran.
- Linux and macOS. The light theme was checked only on `/teams`.

## Open questions or contradictions found

1. **Config keys.** None are required. Things that could become keys:
   - the default team factor of 3 (`DEFAULT_TEAM_FACTOR`) and the default single cap of 8;
   - the 500 ms poll interval for the cap.

   An opt-in key such as `qualification.comparisons_enabled` was not needed: opt-in is the explicit `compare --yes`, after the plan and budget are printed.
2. **The team cap is enforced by polling.** Requests made within one poll window can exceed it. The test saw 5 to 8 against a cap of 5 with 150 ms requests. A per-request hook in the gate would make it strict, but the gate is not mine.
3. **Duplicate constant.** `WAITING_FOR_PROVIDER_SLOT` is defined in `src/admin/job-metrics.ts`. When t3-capacity merges, point it at that worker's constant (likely `storage/tasks.ts` or `scheduler.ts`) to remove the duplicate. If the capacity worker records the reason under another event name, update `agentTimeline`.
4. **The comparison allocation is not shared both ways.** Comparisons count qualification requests against the daily allocation, but `Qualifier.start` does not count comparison requests. I left it unchanged to keep this brief's scope; making it count them is a one-line change in `runner.ts`.
5. **Comparison records are task-less `events` rows.** There is no migration, and lookup uses the `task_id` index (`IS NULL`). A dedicated table would be cleaner if comparisons grow.
6. **Docs not updated** (not owned): `decisions.md`, `operations.md`, `setup.md`, and `roles.md`. They need:
   - `switchyard metrics`, `switchyard compare`, and MCP `get_job_metrics`;
   - the Teams view;
   - the comparison budget rules.

   `CLAUDE.md`'s layout note should list `src/cli/` and `src/admin/job-metrics.ts`.
7. `insights.ts` is now 670 lines; it only gained re-exports.

```text
Outcome: Done
Changed: packages/router/src/{cli.ts, mcp.ts, index.ts, admin/insights.ts, admin/job-metrics.ts (new), cli/{terminal,args,help,session-text,plan-text,metrics-text,operations}.ts (new), cli/job-team-text.ts (moved from admin/), qualification/comparison.ts (new), qualification/runner.ts, runners/supervisor.ts}, packages/router/tests/{team-metrics.test.ts (new), mcp.test.ts}, apps/panel/{app/teams/page.tsx, app/api/comparisons/route.ts, app/api/jobs/[id]/metrics/route.ts, components/job-metrics.tsx (new); app/jobs/[id]/page.tsx, components/client/charts.tsx, components/client/shell.tsx, lib/glossary.ts, scripts/seed-demo.mjs}
Validation: `pnpm -r typecheck` -> Done x2; `npx vitest run` -> 32 files, 297 passed; `pnpm -r build` -> Done; seed ok (comparison recorded); :4541 pages/routes 200/400/404 as expected; scrollWidth===clientWidth at 1400/800/420; 215 CLI outputs byte-identical except help + sub-job line
Not verified: live providers; eval-fixture comparison runs; the real provider-slot producer (synthetic event only); twins count as one agent
Report: D:\sy-wt\s2\docs\working\agent-sessions-and-teams\reports\t3-metrics.md
Notes: cli.ts 813 -> 478 lines; job-team-text moved with git mv (rename staged); team cap is poll-enforced (small overshoot possible)
```
