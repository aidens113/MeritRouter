# Report: t1-surface

Worker report for "Brief: t1-surface (after t1-graph)", with the supervisor's additions (presets,
external runner, `team.max_agents` in settings, the HelpTip overflow fix). Worktree `D:\sy-wt\v1`,
branch `feat/t1-task-graph`. Nothing committed.

## Outcome

Done. Everything in scope is implemented and was checked. Typecheck, build, the full router suite
(257 tests), the panel build, the demo seed, curls of the pages and routes, screenshots, and
overflow measurements all passed.

## What changed and why

- **Diagnosis of `src/admin/insights.ts` (824 lines).** Two sections had their own concern: jobs
  and agent sessions. I moved each, unchanged, into its own module:
  - `src/admin/jobs.ts` (JobView, jobsView, jobDetail)
  - `src/admin/sessions.ts` (SessionView, SessionDetail, sessionsView, sessionDetail)

  `insights.ts` re-exports them with `export *`, together with the new `job-plans.ts`, so
  `insights.*` and existing imports keep working. `insights.ts` is now 663 lines.
- **Plan view** (`src/admin/job-plans.ts`, new). `jobPlan(sy, jobId, { version? })` returns a
  `JobPlanView`, or null for an unknown job or version:
  - **Versions.** The shown version and a list of all versions.
  - **Nodes.** Each node joined to its task by label, with state, state_reason, planned difficulty
    and assigned tier, importance, requiresAcceptedInputs, weight, depth, onCriticalPath,
    acceptance and verification status, and start and finish times.
  - **`waiting` on each node.** One of: `dependencies` (the unfinished upstream labels),
    `acceptance` (parsed from `awaiting_acceptance:<ids>`), `file_lease` (holder task and label,
    repository, and the holder's globs), `agent_cap` (running count against `team.max_agents`),
    `capacity`, or `worker`. Each carries a plain-language `text`.
  - **Per-node history and context.** `leaseWaits` counts the node's `waiting_for_file_lease`
    events. `upstream` gives the recorded `upstream_context` artifact ref and base commits.
  - **Job-level fields.** `edges` (with external and critical-path flags), `criticalPath`,
    `running` / `maxAgents`, every lease of the job with its task label, and `otherTasks`
    (children that are not nodes of the shown version).
- **CLI** (`src/cli.ts`). New command `switchyard plan <job> [--json]`, also added to the help
  text. The text output has:
  - a header with the version, author, note, critical path, and agents running against the cap
  - a node table: critical path marked `*`, depends-on, tier as planned/assigned, importance,
    inputs, state, acceptance, task, and waiting reason
  - live leases, and tasks outside the plan

  An unknown job exits 1 with `unknown job <id>`.
- **MCP** (`src/mcp.ts`). New tool `get_plan {jobId, version?}`, which returns the same JSON view.
- **Exports** (`src/index.ts`):
  - The plan API: PlanStore, PlanNodeSchema, assertPlanGraph, criticalPath, nodeWeight,
    (default)requiresAcceptedInputs, TIER_WEIGHT, DEFAULT_NODE_WEIGHT, MAX_PLAN_NODES,
    PLAN_DIFFICULTIES, PLAN_LABEL_RE, and the types.
  - The file-lease read API: FileLeaseStore, LEASE_MODES, globsOverlap, writeGlobs, FileLease,
    LeaseMode. The write side (acquire, release, conflictingLease) stays internal, because it must
    run inside the claim transaction.
  - AWAITING_ACCEPTANCE and WAITING_FOR_FILE_LEASE.
  - UPSTREAM_CONTEXT_EVENT, UPSTREAM_RESULTS_KIND, INTEGRATED_EVENT, and the upstream types.
  - The plan-view types.
- **External coding runner** (`src/runners/coding/index.ts`):
  - `TASK.md` now includes a `## Upstream results` section holding the same
    `<upstream-results ref=...>` block the native runner renders (built with
    `loadSources`/`renderSources`).
  - Only the task's artifact refs are loaded, so no repository readers are needed.
  - With no upstream, the section is left out and `TASK.md` is unchanged.
- **Presets and example config:**
  - `examples/switchyard.config.example.yaml`: `supervisor.max_workers_per_job: 3` is removed. A
    commented `team: { max_agents: 8 }` section follows `supervisor`.
  - `scripts/build-presets.mjs`: `max_workers_per_job` is dropped from the three standalone
    `supervisor` edits. All presets inherit `team.max_agents: 8`; none had a recorded reason for a
    lower cap. standalone-paid had 4, the others 3.
  - The presets were regenerated with the script. All 4 presets and the example validate against
    `ConfigSchema` (team.max_agents 8, no alias set).
- **Panel:**
  - `components/job-plan.tsx` (new, server component). The `PlanCard` holds:
    - a header with the version, author, and note, plus a JSON link
    - a strip with the critical path, agents running out of the cap, and live lease count
    - an SVG graph laid out by depth: the critical-path nodes and edges are in the accent colour,
      the status stripe colour shows state (warn for lease, acceptance, or capacity holds), and
      nodes link to their tasks
    - a node table: tier as planned→assigned, importance with accepted/any inputs, state with
      acceptance, the waiting reason with an icon (or "waited for a file lease once"), and the
      task with "given upstream results"
    - the file leases, held and released with the release reason
    - earlier versions
  - `app/jobs/[id]/page.tsx` renders the card when the job has a plan.
  - `app/api/jobs/[id]/plan/route.ts` (new): `GET` with `?version=n` returns 200, 400 for a bad
    version, and 404 for an unknown job or version.
  - `lib/glossary.ts`: new terms plan, criticalPath, and fileLease.
  - `lib/settings-schema.ts`, Execution section: new field "Agents per job" (`team.max_agents`,
    optional int, placeholder 8). The Supervisor section's `max_workers_per_job` is now
    "Workers per job (old name)", optional, with help text saying it is used only when Agents per
    job is empty.
- **HelpTip overflow fix** (supervisor addition):
  - Root cause: the popover was `invisible` and absolutely positioned at 288 px wide, so it still
    counted toward scroll overflow next to icons near the right edge.
  - `components/client/help-tip.tsx` (new, client component): the popover is `display: none` until
    hover or focus, has `max-w-[calc(100vw-1rem)]`, and when it opens it is measured and shifted
    (margin-left) to stay 8 px inside the viewport.
  - `components/ui.tsx` re-exports it, so every existing importer is unchanged.
- **Demo seed** (`scripts/seed-demo.mjs`):
  - The config uses `team: { max_agents: 3 }` in place of `supervisor.max_workers_per_job: 2`.
  - New job "plan-divide-modulo". Its scripted supervisor calls `plan_work` with the diamond scan
    (inspect T1) → divide (implement src/app.ts, T2) and modulo (implement src/**, T3) →
    check-exports (inspect T1, requires_accepted_inputs). It then awaits (accepting any upstream
    a node waits on), integrates divide, and finishes.
  - `codingTurn` now takes the helper name from the goal.
- **Tests:**
  - `tests/team-surface.test.ts` (new, 4 tests):
    - The plan view through a real store sequence. It checks versions, critical path and edges
      on the diamond, depths, the agent_cap wait, the dependencies wait, the file_lease wait
      (holder, globs, text, leaseWaits), live leases, the acceptance wait after a `not_verified`
      upstream, released leases, older versions, unknown job and version, `otherTasks`, and the
      CLI text, `--json`, and unknown-job output.
    - A job with no plan.
    - The external runner's `TASK.md` with and without the upstream block. The "agent" is a
      command that prints `TASK.md`, read back from the agent_output artifact.
  - `tests/mcp.test.ts`: `get_plan` is added to the tool list, plus an unknown-job error.

## Commands run and observed results

- `pnpm --filter switchyard-router build` -> ok.
- `pnpm -r typecheck` -> router Done, panel Done.
- `npx vitest run tests/team-surface.test.ts tests/mcp.test.ts` -> 5 passed.
- `cd packages/router && npx vitest run` -> 27 files, 257 tests passed (38.5 s).
- `node scripts/build-presets.mjs` -> wrote 4 presets. The diff only removes `max_workers_per_job`
  and adds the team section. Each file parses with `ConfigSchema`.
- `pnpm --filter switchyard-panel build` and `pnpm -r build` -> compiled, Done.
- `pnpm --filter switchyard-panel seed:demo` -> every phase completed. The new line reads
  `job: divide + modulo (plan_work diamond) completed/not_verified; plan v1, critical path scan -> modulo -> check-exports, lease waits 1`.
- `switchyard plan <demo job>` printed:
  - critical path `scan -> modulo -> check-exports (estimated cost 6)`, agents `0 of 3`
  - modulo shows `waited for a file lease 1x`
- Production panel on 127.0.0.1:4531 against `.demo`:
  - pages: `/`, `/jobs`, `/jobs/<job>`, `/settings`, `/tasks`, `/sessions` -> 200
  - `/api/jobs/<job>/plan` -> 200; with `?version=1` -> 200
  - `?version=7` -> 404 with `No job ... with plan version 7`; `?version=x` -> 400
  - `/api/jobs/nope/plan` -> 404
  - `/settings` has "Agents per job" (value 3) and "Workers per job (old name)"
- Screenshots in the scratchpad (`t1s-job-plan.png`, `t1s-job-plan3.png` (final),
  `t1s-job-full.png`, `t1s-settings.png`, `t1s-edge-*-jobs.png`). I looked at them:
  - The diamond renders with the critical path highlighted.
  - The node table fits at 1400 px after I merged the importance and inputs columns (the first
    version scrolled inside the card).
  - The lease list shows both leases released (finished).
- Overflow check (CDP script `t1s-overflow-edge.mjs`) on the job page and `/settings` at
  1400/800/420. Page scrollWidth equalled clientWidth every time: 1385/1385, 785/785, 405/405.
- Clamp check on the job page: with a HelpTip moved to the right edge (icon at x = clientWidth−9)
  and hovered, the tooltip spans 1089–1377 / 489–777 / 109–397, ending 8 px inside the viewport,
  and scrollWidth still equals clientWidth.
- The panel server and the test Chrome processes were stopped. Port 4531 has no listener.

## Not verified

- Live file leases and a live waiting reason in the panel. The demo job is finished, so the page
  shows lease history and "waited for a file lease once". Live leases and file_lease, acceptance,
  and agent_cap waits are covered by `team-surface.test.ts` and the CLI only.
- The acceptance branch of the demo supervisor script. Both coding nodes came back `met`, so
  check-exports never waited.
- `/settings` has no `HelpTip` with the standard label, so the hover and clamp check ran on the
  job page only. Settings was checked for overflow at rest.
- No live providers.

## Open questions or contradictions found

1. **Plan timestamps ignore the service clock.** `plan_work` constructs `new PlanStore(s.db)` in
   `src/harness/supervisor-tools.ts`, which is not mine, so `createdAt` is wall-clock `Date.now`
   while tasks use `Switchyard`'s `now`. In the demo the plan reads "recorded 17:09" for a job that
   ran at 15:15. Fix: pass the service clock (`new PlanStore(s.db, s.ctx.now)` or similar).
2. **The external runner still gets no other context.** It now gets the upstream block, but its
   `TASK.md` still omits the task's inline text and file refs, which the native runner renders.
   This gap predates T1; I kept to the upstream block as briefed.
3. **The waiting reason is computed at read time.** `agent_cap` and `worker` are inferred from the
   running count and the absence of a state_reason; the scheduler records no reason for them. A
   queued node with no reason, in a job under its cap, shows "ready; waits for a worker".
4. **Docs not updated** (not owned):
   - decisions.md, roles.md, operations.md, setup.md for `switchyard plan`, MCP `get_plan`,
     `team.max_agents`, and the panel plan view
   - CLAUDE.md's layout note for `src/admin/` (now jobs, job-plans, sessions, insights)
