# Report: j2-router (projects plan, phase J2)

Worker report for the brief "j2-router" in [projects.md](../../projects.md). Worktree
`D:/sy-wt/pj`, branch `feat/projects`. Nothing committed.

## Outcome

Done. All four items are implemented and tested:

1. Qualification runs and eval-goal comparisons work in a reserved internal project,
   `_qualification`, which holds their fixture repositories. No user project, and not the global
   config, lists those repositories any more.
2. Each project has its own brain index, `projects/<p>/README.md`. The root `README.md` lists
   `global/` content and the project names only.
3. A task held by its project's `max_concurrent_tasks` gets a waiting reason, an event, and a
   `project_cap` wait in the metrics timeline.
4. The denial reasons `project_paid_budget_exhausted` and `project_allocation_exhausted` exist.
   They retry and fall back the same way as the global ones.

Checks: `pnpm -r typecheck` and `pnpm -r build` pass, and the full router suite passes: 468
tests, which is the 451 baseline plus my 7 and the other J2 workers' new tests. Every fix was
mutation-checked: 10 mutations, and each one made its test fail.

## Qualification decision: a reserved internal project `_qualification`

**What changed.** Qualification runs (purpose `qualification`) and comparison runs on eval
goals (purpose `comparison`) now go to a reserved project with the slug `_qualification`, unless
a project is named. Their fixture repositories (`q-...` and `c-...`) are registered only in that
project's context.

**Why not the primary project.** Adding the fixtures to the primary project's context would put
qualification data into a user project's views. Those views are the panel's repositories and
settings, the projects grid's "missing" badges, `doctor`, the MCP supervisor's `repos`, and the
D9 promotion check, which reads `brain.scope().repositories`. The same would happen with the
project's tasks, sessions, and supervisor working documents. The brief rules that out.

How the reserved project works:
- **The slug cannot collide.** `PROJECT_SLUG_RE` requires a user slug to start with a letter or
  digit.
- **It is not listed.** `ProjectRegistry` keeps it apart from the configured projects. `list`,
  `slugs`, `get`, `require`, and `forWrite` never return it, so it never appears in the grid, the
  switcher, `doctor`, or the panel API. Users cannot submit into it by name ("unknown project
  _qualification").
- **Tasks still reach it.** `ProjectRegistry.qualification` returns its context, and
  `context(slug)` returns it for its slug. `Switchyard.projectContext` and the per-project brain
  lookup use `context`, so the executor, validation, delegated children, and the brain all resolve
  its tasks.
- **Its context.** It has no configured repositories. Its `repositoryPaths` are the runtime
  registry (`repository_registry`). Its brain project is `_qualification`, so the team runs'
  supervisor working documents go to `projects/_qualification/`. Everything else is read from the
  global config. After a reload it keeps its registered fixtures, and its brain section is
  rebuilt.
- **Comparison goals.** A supplied goal (`--goals`, which uses a configured repository) still runs
  in the primary project; `runOne` names it explicitly. An eval goal runs in `_qualification`.
- **Audits** still go to the primary project when no project is named. The auditor already names
  the audited task's project.
- **Fairness and budgets.** `projectLimits` gives `_qualification` priority 1 with no caps, so it
  takes its fair share against user projects. The global caps and
  `qualification.max_requests_per_day` still apply.

**Premise of the brief, corrected.** Before this change qualification did not fail in a
projects-shaped config. j1-core's `syncRuntimeRepositories` merged the fixtures into every
project's context before each submit. I checked this by applying mutations M1 and M2 together,
which approximates J1 behaviour: a qualification run still graded both evals, but its tasks
landed in `alpha`, and every user project listed the fixtures. The real defect was that leak, and
this change fixes it.

## repositoryPaths / repositories audit (src/)

| Reader | Verdict |
| --- | --- |
| `config/load.ts:17,48,63` | Intentionally global. It is the legacy top-level map, which is empty with `projects`. Nothing writes to it at runtime any more; the registry used to. |
| `projects/resolve.ts`, `projects/registry.ts` (`overlayFor`) | Correct. They build each project's own map. |
| `projects/registry.ts` `syncRuntimeRepositories` | **Fixed.** It merged fixtures into the global config and every project; now it merges into `_qualification` only. |
| `qualification/registry.ts` `registerRepository` / `syncRepositoryRegistry` | **Fixed.** Callers now pass `sy.projects.qualification`, not `sy.cfg`. |
| `qualification/runner.ts:163` | **Fixed.** Registers in the qualification context. |
| `qualification/comparison.ts:116` (`planComparison`, supplied goals) | Correct. It uses `sy.projects.primary`, and supplied goals now run there explicitly. |
| `qualification/comparison.ts` `repositoryFor` (eval goals) | **Fixed.** Registers in the qualification context. |
| `core/validate.ts:39,50,69` | Correct. `submitTasks` passes the submission's `ProjectContext`. |
| `context/sources.ts:46` (`readersFor`, `loadSources`) | Correct. All callers pass a ProjectContext: `router.prepare(…, project)`, runners via `ctx.cfg`, `validateTask`, `rulebookTier(s.ctx.cfg)`, and review via `verifyWithReview(depsFor(task))`. |
| `context/upstream.ts:169` | Correct. `withUpstreamContext({ cfg: depsFor(task).cfg })`. |
| `runners/coding/finish.ts:22,46`, `runners/supervisor.ts:99` | Correct. `ctx.cfg` is the task's project context (executor `depsFor`). |
| `brain/brain.ts:153` (`scope()`), `brain/promotion.ts` | Correct. The Brain is built per project from its context. |
| `admin/projects.ts:56,100` | Correct. `ctx` comes from `sy.projects`. |
| `admin/project-settings.ts:89-93` | Correct. `sy.projects.get(slug)`. This is j2-project's file. |
| `cli/doctor.ts:161`, `cli/project-select.ts:54`, `cli.ts:423` | Correct. They use `sy.projects.require(slug)`, `projectList`, or `sy.projectContext(project())`. |
| `mcp.ts:425,467` | Correct. `sy.projectContext(project)`. |
| `routing/staffing.ts:29` | Correct. Its caller passes the supervisor's `ctx.cfg`. |
| `harness/supervisor-tools.ts:273,373`, `scoring/*`, `core/watchdog.ts` | Not config readers. They read tool input or feature counts. |

Outside `src/`, I found one panel reader and did not change it (it is not my file):
`apps/panel/app/p/[slug]/jobs/[id]/page.tsx:222` reads `sy.cfg.repositoryPaths[b.alias]`. That map
is empty in the projects shape, so the "run it in" hint shows the alias instead of the path. It
should use `sy.projectContext(slug)`. `apps/panel/app/all/settings/page.tsx:99` reads the global
map, but the page shows it only for a legacy config, which is the intended global use.

## What changed and why

| File | Change |
| --- | --- |
| `src/qualification/registry.ts` | `QUALIFICATION_PROJECT`, `qualificationOverlay(cfg)`; doc comments. |
| `src/projects/registry.ts` (**not in my owned list**, see Open questions) | Internal `_qualification` context: built in `refresh()`, which keeps registered fixtures across a reload. Adds the `qualification` getter and `context(slug)`. `syncRuntimeRepositories` now fills only that context. |
| `src/qualification/runner.ts`, `src/qualification/comparison.ts` | Register fixtures in the qualification context. Supplied comparison goals name the primary project. |
| `src/core/service.ts` (shared, 4 small hunks) | `QUALIFICATION_PURPOSES` sends runs to `projects.qualification`. `projectContext` and `projectBrain` resolve through `projects.context`. Doc comments updated. |
| `src/brain/brain.ts` | `projectIndexPath(p)`. `kindOf` returns `index` for `projects/<p>/README.md`. `ensure()` creates the project index. `renderIndex` (root) lists `global/` entries and the projects (configured ones, plus any folder under `projects/`), each linking to its index. New `renderProjectIndex`. `regenerateIndex` writes both indexes; it runs when a working document is created, as the root index did before. |
| `src/brain/access.ts` | `isBrainIndex(path)`. Agents may read but never write the generated indexes (root and per project), with the message "brain indexes are generated by SwitchYard". |
| `src/mcp.ts` | `brain_list` description only: names `projects/<project>/README.md` and `global/`. |
| `src/storage/tasks.ts` | `WAITING_FOR_PROJECT_CAP` and `projectCapReason(project, cap)`. When the project cap holds a worker task, the claim sets `state_reason` to `waiting_for_project_cap: project <slug> is at its limit of N running tasks` ("task" when N is 1) and records a `waiting_for_project_cap` event `{ project, limit, running }`, once while the reason holds. A claim clears it, as it clears the other reasons. |
| `src/admin/job-metrics.ts` (**not in my owned list**) | Wait reason `project_cap` in `WAIT_REASONS`, set from the event or from the state reason, the same way as `provider_slot`. |
| `src/admin/job-plans.ts` (**not in my owned list**) | The plan graph's waiting text for such a node is "waits for a slot: project <slug> is at its limit of N running tasks". It uses the existing `capacity` kind, because a new `PlanWait` kind would break the panel's exhaustive `shortWait` switch, which is not my file. |
| `src/core/errors.ts` | Two new `AdmissionDenialReason`s, plus `PAID_BUDGET_DENIALS`, the set of reasons that mean "skip this paid endpoint". |
| `src/core/disposition.ts` | `project_paid_budget_exhausted` is final and failed, like `paid_budget_exhausted`, and keeps its own reason in the stop reason. `project_allocation_exhausted` defers to `retryAt`, like the package reasons. |
| `src/admission/admission.ts` | A project share denial uses `project_allocation_exhausted`, still with `retryAt`. A project paid cap denial uses `project_paid_budget_exhausted`. |
| `src/gateway/direct.ts`, `src/gateway/gate.ts` (**not in my owned list**) | Required for "paid falls back to free": the direct route skipped a paid endpoint only on `=== "paid_budget_exhausted"` and now uses `PAID_BUDGET_DENIALS`. `GateAttempt` gets an optional `denial`. When every candidate was skipped only by the project's paid cap, the gate's final denial is `project_paid_budget_exhausted`. |
| `src/index.ts` (shared, one-line edits) | Exports `isBrainIndex`, `projectIndexPath`, `QUALIFICATION_PROJECT`, `PAID_BUDGET_DENIALS`, `WAITING_FOR_PROJECT_CAP`, and `projectCapReason`. |
| `tests/projects-router-fixes.test.ts` (new, 7 tests) | See below. |
| `tests/brain.test.ts`, `tests/projects-fairness.test.ts`, `tests/team-metrics.test.ts` | Expectations updated for the intended changes: the root index no longer lists working documents; the share reason is `project_allocation_exhausted`; `byReason` gains `project_cap: 0`. |

New tests, all with temp dirs and brains, in a two-project config with no top-level repositories:
- **Qualification grades.** `fix-range` (hidden tests) and `locate-validator` (citations) both
  pass. Their tasks are in `_qualification`. Alpha's and beta's `listTasks` are empty. No `q-`
  alias appears in alpha's context, beta's context, or `sy.cfg`. `_qualification` is not in
  `slugs()`, and submitting into it by name is refused.
- **Comparison plans and runs an eval goal.** A team run plus a single run, with the delegated
  worker. All three tasks are in `_qualification`, both runs complete, and no `c-` alias appears
  in alpha.
- **Brain index.** A supervisor of alpha reads `projects/alpha/README.md`, which lists both alpha
  documents and nothing of beta, even after beta created one in between. It cannot read beta's
  index or the root, and cannot write its own index. The root has `global/glossary.md` and links
  `[Acme Storefront](projects/alpha/README.md)` and `[beta](projects/beta/README.md)`, with no
  `working/` paths.
- **Waiting reason.** Alpha has a cap of 2 and 3 tasks. The third task's `state_reason` is exact,
  one event is recorded across two claims, `agentTimeline` contains a `project_cap` wait, and
  after a slot frees it is claimed with the reason cleared.
- **Share denial.** The reason is `project_allocation_exhausted`. `retryAt` is in the future.
  `classifyFailure` gives `{ kind: "defer", at: retryAt }`, the same as the package reason.
- **Paid cap.** Alpha (paid preferred) is served free with "skipped (paid budget) … project alpha
  weekly paid budget". Alpha pinned to the paid model fails with `project_paid_budget_exhausted:
  …`. Beta pinned to it is served by the paid model.
- **Global paid.** It keeps `paid_budget_exhausted`.

## Commands run and observed results

- `npx tsc --noEmit -p .` (router), several times while working: clean.
- `pnpm -r typecheck`: "packages/router typecheck: Done", "apps/panel typecheck: Done".
- `pnpm -r build`: "packages/router build: Done", "apps/panel build: Done".
- `npx vitest run tests/brain.test.ts tests/projects-brain.test.ts tests/mcp.test.ts`: 16 passed.
- `npx vitest run tests/qualification.test.ts tests/team-metrics.test.ts tests/projects.test.ts
  tests/projects-panel-scope.test.ts tests/projects-fairness.test.ts tests/paid.test.ts`: 42
  passed and 1 failed. The failure was team-metrics' exact `byReason` object, which lacked the
  new `project_cap` key. I fixed the expectation.
- `npx vitest run tests/projects-router-fixes.test.ts`: 7 passed. The first version of the
  qualification test failed with `invalid_output` for `locate-validator`, because the scripted
  worker cited a file without reading it. It now reads the file first.
- **Full suite** (`cd packages/router && npx vitest run`) after the build: "Test Files 48 passed
  (48) / Tests 468 passed (468)". No timing test flaked.
- **Mutation checks**, run by the scratchpad script `j2router_mutate.py`. Each mutation is a
  unique snippet replacement, reverted by the reverse replacement rather than a whole-file
  restore, so the other workers' edits to shared files survive. Each line shows the mutation and
  then the result of its filtered test run.
  - M1, qualification purposes routed to primary: 2 failed.
  - M2, fixtures merged into every project: 2 failed.
  - M3, no project index written: 1 failed.
  - M3b, root lists every entry: 1 failed.
  - M4, no project-cap state reason or event: 1 failed.
  - M5, share denial using the package reason: 1 failed.
  - M6, `project_allocation_exhausted` removed from the defer cases: 1 failed.
  - M7, project paid cap using the global reason: 1 failed.
  - M8, the direct route skipping only on `paid_budget_exhausted`: 1 failed.
  - M9, the gate's final reason always global: 1 failed.

  All were restored. `grep -rn J2ROUTER-MUTATION src` finds nothing.
  - **Incident during the checks.** In the first script version, M1's revert failed. The
    deletion-style mutation had an empty replacement string, so the revert step could not find
    anything to replace, and the `QUALIFICATION_PURPOSES` line in `service.ts` stayed deleted. I
    restored that one line by a targeted insert and confirmed it with `git diff` (only my hunks
    are in the file), then rewrote the script with marker replacements.
- Pre-fix comparison, M1 plus M2 together: grading passed, and only the project assertion failed
  (`['alpha','alpha']`). This is the evidence for the corrected premise above.

## Not verified

- Panel pages were not started or screenshotted, and `seed:demo` was not run: the other J2
  workers were editing the panel and the seed script. Effects the supervisor should check:
  - Eval-goal comparisons now land in `_qualification`. `app/p/[slug]/teams/page.tsx:61` shows a
    comparison only when its runs are in the page's project, or, before results, on the primary
    project. Finished eval comparisons therefore show on no project's Teams page. They probably
    belong on a global page.
  - `/tasks/<id>` for a `_qualification` task redirects through `lib/legacy.ts`
    `toItemProject`, which 404s because `findProject` does not know `_qualification`.
  - `/all/requests` and `globalDashboard` may show `_qualification` as a project in their
    per-project columns, because they group by `project_id`.
- The MCP test runs from `dist/` and passed after the build, but nothing checks the new
  `brain_list` description text.
- The plan-graph waiting text for the project cap (`job-plans.ts`) has no test, because a test
  would need a supervised job with a plan.
- No live provider or paid provider. Paid behaviour was checked only with the scripted client.
- In-flight upgrade: a qualification or comparison task submitted before this change, still
  queued or interrupted, has `project_id` set to the primary project. Its fixture alias is no
  longer in that project's context, so it would fail at prepare. This was not exercised.
- Multi-process: another process's registered fixtures reach this one through
  `syncRuntimeRepositories`, which runs on each scheduler tick and each submit, as before. No
  test covers two processes.
- Hot reload of the config while `_qualification` has registered fixtures. `refresh()` keeps
  them, but no test covers it.

## Open questions or contradictions found

1. **Files outside my owned list.** I edited these because the task required them, each
   minimally:
   - `src/projects/registry.ts`: the fixture leak is in `syncRuntimeRepositories`, and the
     internal context belongs with the registry. No J2 worker owns `src/projects/`.
   - `src/gateway/direct.ts` and `src/gateway/gate.ts`: without them, `project_paid_budget_exhausted`
     would fail the task instead of falling back to free.
   - `src/admin/job-metrics.ts` and `src/admin/job-plans.ts`: these are where slot and lease waits
     are shown. No J2 worker owns them.
   - Three existing tests whose exact expectations the intended changes alter.
2. **The brief's premise was outdated.** Qualification already graded in the projects shape,
   through j1-core's merge into every project. The defect was the leak into user projects; see
   the decision section.
3. **Panel follow-ups** (not my files): comparisons on the Teams page; `/tasks/<id>` for
   `_qualification` tasks; the `jobs/[id]` "run it in" path reading the global map. Where should
   qualification and comparison work appear: `/all/qualification`, or a hidden project page?
4. **Brain indexes.** The root index is still regenerated only when a working document is
   created, as before. The per-project index is created by `ensure()` and regenerated at the same
   points. It lists working documents only; reports and decisions are not listed, matching the
   old root index.
5. **Docs.** Nothing in `docs/` was updated. J3, or the supervisor, should describe the following:
   - `_qualification`;
   - the per-project brain index and the read-only generated indexes;
   - `waiting_for_project_cap`;
   - the two new denial reasons (`docs/operations.md`, `docs/roles.md`).
