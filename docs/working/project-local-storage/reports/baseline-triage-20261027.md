# Router test baseline triage, 2026-10-27

Worker: baseline triage (worker-heavy). Read-only: no source or test file was edited. Probes ran
from the session scratchpad against the working tree, with fixtures in OS temp.

## Outcome

Done. I re-ran the 20 files that failed in the overlapped run one at a time, with nothing else
running. 12 files pass and 8 fail. That is 213 tests passing and 11 failing out of 224. The
11 failures have three root causes. None of them depends on the uncommitted `src/admin` edits.

| Cluster | Failing tests | Kind |
| --- | --- | --- |
| A. Each Brain commit takes about 5 s (about 80 git spawns) | 9 (8 timeouts and 1 cascade) | Product performance regression; tests expose it through 10 s hook and 30 s test budgets |
| B. `git ls-files --cached <path> <exclude-pathspec>` is nondeterministic on this Git | 1 (`Brain.remove` returns `commit: null`) | Product defect: changes are silently left uncommitted |
| C. Repair hydration calls git with an already-aborted signal and loses "aborted" | 1 | Product defect in error classification |

The concurrent-run signatures named in the brief did not reproduce when files ran one at a
time: `executionStatus` of undefined, `expected undefined to be 'completed'`, and "Repository
mutation lock ownership could not be verified". Cluster A under load accounts for them (see
the end of the cluster A section). That explanation is inferred: the original run's log was
not available.

## Per-file results (serial, `npx vitest run tests/<file>.test.ts`)

| File | Result | Wall time |
| --- | --- | --- |
| projects-delete | 6 pass / 1 fail | 100 s |
| projects-followups | 4 / 2 | 59 s |
| admin-live | 20 / 0 | 47 s |
| resilience | 9 / 2 | 53 s |
| projects-operations | 3 / 0 | 68 s |
| operations | 23 / 0 | 80 s |
| team-capacity | 6 / 2 | 87 s |
| process-performance | 8 / 1 | 57 s |
| native-search | 11 / 0 | 46 s |
| attribution | 4 / 0 | 79 s |
| providers-routing | 15 / 0 | 121 s (each one-task test takes about 10 s, each two-task test about 15 s) |
| repository-prepare | 13 / 0 | 88 s |
| team-nesting | 7 / 0 | 225 s |
| projects-router-fixes | 6 / 2 | 153 s |
| project-metadata-brain | 17 / 0 | 206 s |
| labs-browser | 8 / 0 | 232 s |
| project-metadata-deletion | 7 / 0 | 118 s |
| brain | 10 / 0 | 210 s (individual tests take 20 to 31 s; several are within a second of a 30 s limit) |
| repair-hydration | 25 / 1 | 300 s |
| native | 11 / 0 | 270 s |

## Cluster A: each Brain write and worker report costs about 5 s

**Evidence** comes from a scratch probe that opens a `worker: true` service, runs 4 trivial
summarize tasks, and times each step of `close()`:

- Task 0 took 5.7 s and tasks 1 to 3 took about 80 ms each. Task 0's events were claimed at
  16 ms, contract compiled at 29 ms and completed at 5850 ms. The model request arrived at about
  5.6 s, so the delay comes before the model call. It is the first `Brain.ensure`: 5.4 s and
  172 git spawns.
- `MeritRouter.close()` took 20 s, all of it in `Executor.flush()`. That method waits for the
  4 queued `writeWorkerReport` promises (`src/core/executor.ts:128-131`, `:693-705`), and each
  report is a Brain commit of about 5 s, run one after another.
- A child-process trace of one worker report shows 81 git spawns and no single slow call
  (each spawn takes about 25 ms, plus 25 to 50 ms of JavaScript between spawns). The spawns
  are mostly repeated `rev-parse` calls: 16 `--absolute-git-dir`, 10 `--git-path`,
  9 `--git-common-dir` and 7 `--verify`. There are also 6 `ls-files --stage` / `ls-tree`
  pairs, then the selected-commit staging, `commit-tree` and `update-ref` publication.
- **Cause:** `commitAs` (`src/attribution/index.ts:20`) now goes through
  `commitSelectedApplication` (`src/attribution/selected-commit.ts`: owned index transaction,
  metadata staging, receipts, guarded ref publication) inside `withRepositoryMutation`
  (`src/workspaces/repository-mutation.ts`). It used to make 4 git calls: `add`,
  `diff --cached`, `commit`, `rev-parse`.
- **Introducing commit:** `96d4a86` "Guard attributed commits and captured candidate
  publication" switched `commitAs` to the selected-commit pipeline. The pipeline itself came
  from `b9d866f` (owned index transactions) and `f26b974` (selected commit publication), and
  `d332c6b` added the mutation fence's extra `rev-parse` calls. Report draining in `close()`
  and the 10 s default `hookTimeout` are old (`8d5da61` and `4a728aa`). The timing claim is
  inferred from the diff, not bisected: a bisect needs an older tree, and the worker hook
  blocks both `git archive` and `git cat-file`.
- **Confirmation that the failures are pure slowness:** with `--testTimeout=300000
  --hookTimeout=300000`, these all pass:
  - projects-delete "purges private owned…" in 28.8 s (it failed at 30.05 s);
  - resilience "the gate skips a failing provider…" in 29.5 s;
  - projects-router-fixes "per-project brain index" in 44.7 s and "paid cap" in 25.0 s;
  - team-capacity "holds tasks beyond a provider's slots" in 32.3 s.

**Tests in this cluster:**

| Test | How it fails |
| --- | --- |
| projects-delete: "purges private owned and mixed captures…" | 30 s timeout, then `ENOTEMPTY` in cleanup |
| projects-followups: "a revert goes through the brain's lock…" | 30 s timeout, then `ENOTEMPTY` |
| resilience: "the gate skips a failing provider…" | `afterEach` `sy.close()` exceeds the 10 s hook budget |
| resilience: R1 "a native coding run killed mid-request…" | `Cannot read properties of undefined (reading 'prepare')` at `tests/resilience.test.ts:462`. A cascade: the timed-out `afterEach` from the previous test keeps running and sets `db = undefined` (line 37) after this test assigned it (line 459) |
| team-capacity: "holds tasks beyond a provider's slots…" | hook timeout on close |
| team-capacity: "never holds a supervisor back…" | 60 s timeout, then `EBUSY` on `meritrouter.db`. Not re-run with long budgets, because its explicit timeout overrides the CLI flag |
| process-performance: "bounded task throughput…" | 45 s timeout. 24 tasks give 24 serialized reports of about 5 s each, all drained in `close()` |
| projects-router-fixes: "per-project brain index" | 30 s timeout (5 Brain commits) |
| projects-router-fixes: "a project's paid cap…" | hook timeout on close |

**How cluster A explains the overlapped-run signatures (inferred):**

- Under the full parallel run, the first task in each fixture spends at least 5.6 s in Brain
  initialization before its model call. Tests that call `awaitResults(…, {timeoutSeconds:
  10|15})` then get `completed[0] === undefined`. That gives `executionStatus` of undefined
  in providers-routing, native and native-search, and `expected undefined to be 'completed'`
  in `runIn` (projects-delete) and operations. All of these pass when the file runs alone.
- "Repository mutation lock ownership could not be verified"
  (`src/workspaces/repository-mutation.ts:105`) is what `release()` reports for any
  non-`RepositoryMutationError`, such as `ENOENT` once the fixture directory is gone.
  Vitest timeouts do not cancel running effects (`tests/brain.test.ts:15-16` says so). After a
  timeout, `env.cleanup()` deletes the fixture while a Brain mutation still holds its lock,
  which also explains the `ENOTEMPTY`/`EBUSY` cleanup errors.

**Suggested fix scope (product):**

- Cut git spawns per commit by caching git-dir, common-dir and `--git-path` lookups within one
  mutation or index-transaction scope, and by not re-running the `ls-files --stage`/`ls-tree`
  HEAD-equivalence checks several times. Files: `src/attribution/selected-commit.ts`,
  `src/attribution/selected-ref-publication.ts`, `src/workspaces/git-index-transaction.ts`,
  `src/workspaces/metadata-staging.ts`, `src/workspaces/repository-mutation.ts`,
  `src/brain/brain.ts` (`mutate`, `ensure`).
- Optionally, close could stop awaiting worker-report Brain commits serially.
- A test-side stopgap (raising `hookTimeout` in `vitest.config.ts`, raising per-test budgets)
  only hides a regression of roughly 5 s per Brain write that users also pay on every worker
  report.

## Cluster B: `git ls-files --cached` with an exclude pathspec is nondeterministic

**Symptom:** projects-followups "removes with a recorded reason…" fails at
`tests/projects-followups.test.ts:184` with `git log … null`. `Brain.remove` deletes the file
but returns `commit: null`, and leaves ` D projects/alpha/decisions/old.md` uncommitted. This
reproduced 4 times out of 4 in an instrumented copy of the test.

**Trace:** before the remove, the native index, the HEAD tree and a clean status all contain
`old.md`. Inside `stageSelectedIntoOwnedIndex` (`src/workspaces/metadata-staging.ts:19-23`):

- `ls-files --cached -z -- :(literal)projects/alpha/decisions/old.md
  :(icase,exclude,glob)**/.MeritRouter :(icase,exclude,glob)**/.MeritRouter/**` returned
  empty, against an owned index that did contain the path.
- `--with-tree=HEAD` returned empty, and `--others` returned empty because the file was
  deleted.
- So `paths` is empty, the tree equals the baseline, and the outcome is `unchanged`.

Replaying the identical argv and env at that moment returned empty, while the same query
without the second exclude returned the path.

**Isolated in temp repos (Git 2.55.0.windows.3, installed 2026-09-27):** repeated identical
`git ls-files --cached -- <path> <exclude-pathspec>` calls return different results with exit
code 0 and no stderr.

- `:(literal)<path>` with `:(icase,exclude)x` missed 107 of 200 and 125 of 200 calls, at
  random from call to call.
- In some runs, every exclude form failed often, `:(icase,exclude,glob)**/.MeritRouter`
  included: 12/30, 5/30, 8/30 and 10/30 matched. Other runs matched 30/30.
- Without an exclude, 200/200 matched. In one run, these matched 20/20 with an exclude:
  `ls-files --cached .`, `ls-files --others`, `diff --name-only`, `status`, and `git grep`.

I did not establish the mechanism inside Git; the inconsistency is observed.

**Cause in code:** `src/workspaces/metadata-staging.ts:19-23` adds
`PROJECT_METADATA_SEARCH_EXCLUDES` to explicit-path `ls-files --cached` and `--with-tree`
queries. Line 24 already filters with `isProjectMetadataPath` in JavaScript.

**Introducing commit:** `b9d866f` (staging through owned index transactions with the
excludes). `f26b974` added `headSelections`, and `96d4a86` made every `commitAs`, Brain
included, depend on it.

**Risk beyond this test:** this is inferred from the code path, not observed. A tracked file
that was modified or deleted is selected only through those two flaky `--cached` queries, so
a commit can silently report `unchanged` and leave the change uncommitted. That covers Brain
working docs, indexes and worker reports. New files are still found by `--others`.

**Suggested fix scope (product):** in `src/workspaces/metadata-staging.ts`, drop the exclude
magic from explicit-path `ls-files` queries and rely on the JavaScript
`isProjectMetadataPath` filter that already runs. Then audit the other exclude users:
`src/context/repo-reader.ts:192-195` (grep and ls-files) and
`src/projects/metadata-policy.ts:12`. Add a regression test that repeats a tracked deletion
or modification commit many times.

## Cluster C: repair hydration with an already-aborted signal

**Symptom:** repair-hydration "cancellation refuses hydration before effects" fails because
the rejection is `git rev-parse failed in …\worktrees\t_…: ` with an empty reason, not
`/aborted/`. It is deterministic: it also failed when re-run alone.

**Cause:** `hydrateRepairWorkspace` (`src/workspaces/repair-hydration.ts:130-134`) runs
`git rev-parse --git-common-dir` with `options(ctx)`, which carries `ctx.signal` (line 23),
before any abort check. Node rejects at once with an `AbortError` whose `stderr` is `""`.
`src/workspaces/git.ts:46` builds the message from `(e.stderr ?? e.message)`, so the empty
string wins and the abort reason is lost.

**Introducing commit:** `71dbf2a` "Fence retained repair hydration before workspace effects"
added the pre-fence `common()` check. The test dates from `4dd523d`.

**Suggested fix scope (product):** check `ctx.signal.aborted` (or `assertRunAuthority`) at the
top of `hydrateRepairWorkspace`, and/or change `git.ts:46` to `e.stderr?.trim() || e.message`
so that abort and spawn errors keep their reason. The test is correct as written.

## Uncommitted `src/admin` edits

The edits are in `jobs.ts`, `job-metrics.ts`, `job-plans.ts` and `job-team.ts`, plus the new
`project-job-reads.ts`, `project-reads.ts` and `project-usage.ts`. I read them with
`git diff`. They change admin read views: per-project store fan-out, and `jobsView` now
returns `RowsWithAvailability` (an array with a non-enumerable `unavailable`). No failing test
calls those functions.

The only runtime importer outside `src/admin` and `src/cli` is
`src/qualification/comparison.ts` (`jobMetrics`), and the comparison test passes. All three
causes are in committed code (`96d4a86`, `b9d866f`, `71dbf2a`) and reproduce in probes that do
not touch `src/admin`.

`npx tsc --noEmit -p tsconfig.json` (in `packages/router`) printed no errors. `dist/` was
built at 12:07 and includes the new admin files.

## Processes left running

Three processes were already running when this session started. None of my serial runs or
probes added any.

- PID 19192 `…\Temp\meritrouter-service-job-b589757a1c6d8f8fd560\job.exe`, created 12:19:04.
  Its parent, 15644, is gone.
- PID 18812 is `node.exe -e "// MERITROUTER_LAB_HOST_V1 …" -- --sy-lab-token=339d…`, a child
  of 19192.
- PID 15016 is `cmd.exe /d /s /c "node.exe server.cjs"`, and PID 4124 is `node.exe server.cjs`,
  listening on 127.0.0.1:57000.

Port range 57000 plus `server.cjs` match `tests/labs-browser.test.ts:48`, so this is almost
certainly a Lab service leaked when labs-browser failed or timed out in the overlapped 12:19
run. labs-browser passed alone and leaked nothing. I did not kill these processes.

Fixture directories in `%TEMP%` left by failing tests in my runs (cleanup hit
`ENOTEMPTY`/`EBUSY`):

- `meritrouter-test-n7op2s`, `ryT5j1`, `DCOHOk`, `9QA5D7`, `RGgDqK`, `4ZeZT4`, `Bl04ku`,
  `sWG4td`.
- `%TEMP%` holds 97 `meritrouter-test-*` directories dated today and 198 in total.

I removed only my own probe fixture, `meritrouter-test-buRHk9`.

## Commands run and observed results

- Serial loop over the 20 files with `timeout 600 npx vitest run tests/<f>.test.ts`. Results
  are in the table above; logs are in the scratchpad `runs/`.
- Scratch probes using `vitest --config <scratchpad>/probe/vitest.probe.config.ts`, with root
  `packages/router` and tests in the scratchpad: the throughput/close timing, the child-process
  trace, the deletion `commitAs` probe (an isolated tracked deletion committed correctly in that
  run), and an instrumented copy of projects-followups.
- Node scripts in temp repos that measure `ls-files` pathspec match rates (cluster B).
- Long-budget re-runs of the 5 timed-out tests (all passed) and a re-run of the
  repair-hydration cancellation test (failed the same way).
- `npx tsc --noEmit -p tsconfig.json` printed no errors.

## Not verified

- A full-suite run. Only the 20 named files were re-run.
- The commit that made Brain commits slow was not confirmed by bisect: `git archive` and
  `git cat-file` are blocked for workers.
- Git's internal mechanism for cluster B, and whether other Git versions behave the same way.
- Whether modifications, not only deletions, are silently skipped in practice.
- team-capacity "never holds a supervisor back…" was not re-run with a larger budget.
- The original overlapped-run log, so the three concurrent-only signatures are attributed by
  inference.
