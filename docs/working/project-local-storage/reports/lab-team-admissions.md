# Lab team admissions, Lab process leaks, split `labs serve` (worker report)

Worker: lab-team-admissions (worker-heavy). Date: 2026-10-27. Branch dev, main checkout, no
commits. Paths are relative to `packages/router` unless stated otherwise. All my test runs used
an isolated `TEMP`/`TMP` (`%LOCALAPPDATA%\Temp\mrlw`), so every Lab Job helper my runs started
was identifiable by its path (`...\mrlw\meritrouter-service-job-*\job.exe`).

## Outcome

Done, with one ownership deviation (a 3-line wiring edit in `src/harness/integration-tools.ts`,
explained below) and one pre-existing failure outside the brief's list (Open question 4).

1. labs-scripted passes. The merge queue admits with the root job's permits (policy a); team
   children are based on the configured checkout pinned to the Lab head (policy b), so they never
   admit the Lab worktree. No child permits were needed.
2. Process leaks: no current Lab test leaked in any of my runs. I traced the one recent live leak
   to a labs.test.ts teardown under a loaded full-suite run, and fixed both the test-side causes
   and a product-side cause in `LabManager.close()`. labs-scripted and the new labs-serve-split
   assert that none of their Lab hosts, Job helpers or descendants survive teardown.
3. `labs serve` now supervises every split project's own Lab manager. A new test covers crash
   restart and idle stop.
4. `tests/execution.test.ts` passes alone (16/16). It passed again in the serial batch.
5. Lead addition: the single-PID process query now uses the UTF-8/base64 transport. A new
   non-ASCII test covers both the single-PID path and the host snapshot.

## What changed and why

### 1. Lab team admissions

**Merge queue (policy a).** `src/workspaces/merge-queue.ts`:

- `MergeHooks` gets an optional `admission(item)` that returns permits.
- `withMutation(item, hooks, action)` fetches the permits afresh for every admission, because a
  restart replaces the service's command. It passes them as the fence's existing `command` option
  and hands them to the action.
- Nested `abortInProgress` calls on the integration worktree get the same permits through a new
  `command` control option. Without them a conflicting pick fails with `active_command`; a
  mutation check confirmed this.
- Source-worktree aborts and `rebase` deliberately get no permits. A permit outside the admitted
  worktree is refused by `assertRepositoryCommandPermitScope`.

**Wiring (outside my owned paths).** In `src/harness/integration-tools.ts`, `integrationHooks`
sets:

```ts
admission: async item => s.ctx.lab && s.ctx.lab.rootJobId === jobId && item.jobId === jobId ? s.ctx.lab.integrationPermits(jobId, [item.repo]) : []
```

- The merge queue cannot reach the `LabRunContext` any other way. `MergeQueue` is constructed and
  run only from integration-tools/supervisor.
- The scope is exactly the root job's own `integrationPermits`, as in `supervisor.ts`.
- No fence file was touched.
- **This edit is outside my owned paths. Please review it.**

**Children (policy b, feasible, so no child permits).**

- `src/labs/binding.ts`: `LabRunContext.teamSource(taskId, alias)` returns the configured checkout
  path and the Lab branch head.
  - The head is read through the configured checkout (`rev-parse refs/heads/<lab branch>`), using
    the shared object store. The Lab worktree is never touched.
  - It refuses the root job (`taskId === rootJobId`), an alias outside the Lab, a replaced Lab, and
    a configured checkout that is no longer the Lab's recorded `source` (compared physically).
- `src/runners/coding/finish.ts`: a new `workspaceSource(ctx, alias)` is used by
  `prepareWorkspace` and by `resumeWorkspace`'s fallback.
  - For a Lab member below the root, the source is `teamSource`. The base is the explicit
    `baseCommits[alias]` (which supervisors always pin at dispatch, by `delegatedSourceSnapshot`)
    or else the Lab head.
  - Every later admission in `finish.ts` uses `ws.sourcePath`, so all five sites now admit the
    configured checkout and the child worktree, never the Lab worktree.
- The child worktree and the Lab worktree share one git common dir, so the merge queue's
  same-owner check and the cherry-picks work unchanged.

**Tests.**

- **labs-scripted** passes (50 s).
- **labs-integration-permits** has a new third test. It checks:
  - `teamSource` for the child and refusal for the root or a foreign alias;
  - admission of the configured checkout while the service runs;
  - a merge-queue run without permits refused with `active_command` (item stays `queued`);
  - the same item integrated with the root's permits;
  - a conflicting pick that aborts and restores under the permits, ending in `conflict` with the
    Lab head unchanged and the worktree clean.

### 2. Process leaks

**Evidence.** Before my runs, five live job.exe -> host -> cmd -> server trees (ports 55000,
56000, 57000, 58000 and 58001) were running, plus about ten childless job.exe helpers, all under
the default TEMP. None are mine.

I found the 55000 tree's store in a leftover test directory:

- `%TEMP%\meritrouter-test-WcBIJa` holds Lab `candidate`, still `running` with service pid 2060.
  That is labs.test.ts "manual promotion checks an exact candidate…" from another agent's full
  run at 7:00 PM.
- Its events end at `service_started` and `started` (7:00:56), with no `check_finished` or
  `service_stopped`.
- The Lab was started at about 23 s of that test's 30 s budget on a loaded host.
- Teardown never stopped the service.

**Causes found.** I can only infer how the four older trees leaked. Causes found:

- **Test side.**
  - labs.test.ts, labs-browser, labs-scripted, labs-task-attempt and labs-task-prune had the
    default 10 s hook timeout. A verified Windows service stop takes several PowerShell and
    Job-helper round trips per service. On a loaded host that can exceed 10 s.
  - Their hooks read and reset module globals (`db`, `env`, `manager`, `managers`) after awaits.
    A timed-out hook keeps running and can close or clean the *next* test's state.
  - labs.test.ts swallowed every `close()` error.
  - labs.test.ts killed hosts directly (`stopOwnedProcess`) *before* `close()`. That bypasses Job
    release, so if `close()` then fails, the detached `job.exe` waits forever for its release
    file: the childless helpers.
  - labs-task-attempt and labs-task-prune skipped db and env cleanup when an attempt stop or close
    threw.
- **Product side, `LabManager.close()`.**
  - It stopped Labs in a plain loop. The first Lab that threw (for example `stopLab` refusing
    because another live manager owns one of its services, or a proof or ownership refusal)
    aborted the loop.
  - Every later Lab's services that this manager owned were then left running.
  - The final `owner_until=0` release was skipped too.

**Fixes.**

- **`src/labs/lab.ts` `close()`.**
  - Each Lab is now attempted independently, and the first failure is rethrown after all Labs
    and the owner release are done.
  - When some other live manager owns one of a Lab's services, only this manager's own services
    are stopped (through `services.stop`, so Jobs are retired). Previously the whole Lab was
    refused.
  - The fence and ownership checks are unchanged.
- **Test teardowns** in labs.test.ts, labs-browser, labs-scripted, labs-task-attempt and
  labs-task-prune:
  - module state is taken into locals first;
  - every step runs even if an earlier one fails;
  - the hook timeout is 120 s.
- **labs.test.ts** now closes managers first, which retires their Jobs. The direct
  `stopOwnedProcess` kill is kept only as a safety net for what `close()` could not stop.
- **New `tests/fixtures/lab-hosts.ts`.**
  - `labTokens(db)` collects the store's Lab command tokens.
  - `observeLabProcesses(tokens)` takes one base64 UTF-8 CIM snapshot and returns exactly the
    hosts carrying those tokens, their job.exe helper and their descendants, each with PID and
    creation time.
  - `survivingLabProcesses(observed)` re-checks PID plus creation time.
  - It never matches another test's or agent's processes.
- **Assertions.**
  - labs-scripted observes its live host and Job helper at the end of the test, then asserts in
    teardown that none survives.
  - labs-serve-split asserts the same after `sy.close()`.

### 3. `labs serve` in split layout

`src/cli/lab-supervisor.ts`:

- `serveLabs(sy, { onProjectError? })` still ticks `sy.labs`. In a split installation it also
  enumerates `sy.projects.slugs()` through the public `sy.labsFor(slug)`, skipping projects
  without a live store and retrying them on later passes.
- Each project manager is recovered once when first seen, then ticked every pass. That gives
  crash restart, adoption, idle stop and queued controls.
- A project's error is reported once per distinct message (to stderr by default) and does not stop
  the other projects. Failures of `sy.labs` still end serve, as before.
- On stop, serve closes `sy.labs` and every project manager it supervised (with the default
  `stopServices`, matching legacy behaviour).

`src/cli.ts` needed no change.

**New `tests/labs-serve-split.test.ts`.** It runs a split install with a retained Lab in project
`alpha`:

- killing the service host leads to a restart with a new pid and a `service_crashed` event, and
  the old identity is `missing`;
- setting `last_activity=0` leads to `idle_stopped` with state `stopped`, and the restarted
  identity is `missing`;
- `stopLabSupervisor` ends serve, no project errors are reported, and the coordination store has
  0 Labs;
- no observed process survives `sy.close()`.

As a mutation check, with project managers excluded the test fails with "timed out waiting for
crash restart".

### 4. execution.test.ts

It passes alone (16/16, 60 s) and in the serial batch (16/16). I could not reproduce the EBUSY or
"reading 'stopReason'" failure on the current tree. It was most likely the transient mid-edit
state the brief describes, so nothing was changed.

### Lead addition: single-PID process query

`src/labs/process-ownership.ts`:

- New exported `windowsCommandLine(pid)`. PowerShell emits the CIM `CommandLine` as base64 of
  UTF-8. `'-'` means the process or its command line is missing, and the output is checked as
  base64 before decoding.
- `processOwnership` uses it on Windows, with the same ASCII marker and token checks as before.

**New `tests/labs-process-ownership.test.ts`** (Windows only). It spawns a host-marker process
whose argv contains `\u2713|\u00d7|\u2192|\u00e9\u4e2d`, then checks:

- the single-PID path returns those exact characters;
- ownership is `owned`, or `foreign` for a wrong token;
- `captureOwnedProcessTree` stores the identical command line;
- `stopOwnedProcess` makes the process `missing`;
- a missing PID yields `null`.

There was no committed non-ASCII test to extend; fix-lab-lock's reproduction was manual. As a
mutation check, with the old OEM query the test fails, receiving the mangled command line instead
of `✓|×|→|é中`.

## Commands run and observed results

All from `D:/MeritRouter/packages/router`, with TEMP/TMP set to `%LOCALAPPDATA%\Temp\mrlw`.

| Command | Result |
| --- | --- |
| `npx tsc --noEmit` (final) | exit 0 |
| `npx vitest run tests/labs-scripted.test.ts` before the fix | 1 failed: child `not_verified`, as reported earlier |
| `npx vitest run tests/labs-scripted.test.ts` after the fix | 1/1 passed (48 to 50 s), including the teardown leak assertion |
| Serial batch: `npx vitest run --no-file-parallelism` over labs-browser, labs-compose-validation, labs-integration-permits, labs-process-ownership, labs-scripted, labs-serve-split, labs-service, labs-task-attempt, labs-task-prune, project-split-labs, labs.test, lab-supervisor | 73/76. The failures were the 2 pre-existing labs.test.ts failures (Open question 3) and 1 failure in my new permits test (a CRLF assertion, then a missing task row) |
| `npx vitest run tests/labs-integration-permits.test.ts` after fixing the new test | 3/3 passed |
| Serial batch: active-validation-ownership, supervisor, supervisor-lifecycle, team-nesting, execution, project-metadata-merge-queue, dependent-review-source, repair-hydration, team-surface, process-acceptance-integration | 156/157. Every file in the brief's list passed: active-validation 18/18, supervisor 3/3, supervisor-lifecycle 46/46, team-nesting 7/7, execution 16/16. The 1 failure is process-acceptance-integration "hard-kill: true" (Open question 4) |
| `npx vitest run tests/execution.test.ts` alone | 16/16 |
| `npx vitest run tests/labs-serve-split.test.ts` | 1/1 (18 s) |
| `npx vitest run tests/labs-process-ownership.test.ts` | 2/2 |
| `npx tsc -p tsconfig.build.json` | exit 0. `dist/` was rebuilt with these changes; dist is git-ignored and process-acceptance needs it |

Mutation checks (each disabled temporarily, then restored and confirmed by diff):

| Disabled | Result |
| --- | --- |
| Permits on the conflicting pick's abort | New permits test fails with `active_command` |
| Project managers in `serveLabs` | Serve test fails: crash restart timed out |
| Old OEM single-PID query | Non-ASCII test fails |
| Original labs-scripted teardown, with `--hookTimeout=1500` | The hook timed out, but no tree leaked in an isolated run. A hook timeout alone does not leak when the worker lives on; the leak needs the timed-out hook to then fail or race the next test's globals |

Process inventory after my final runs:

- No `job.exe` under `mrlw`.
- No Lab host, cmd or server created after 7:04 PM.

These were still running and **are not mine**. I did not touch them.

| PIDs (host / cmd / server) | Port | Started | Origin |
| --- | --- | --- | --- |
| 23732 / 21904 / 15964 | 58001 | 1:40 PM | labs-task-attempt range |
| 39784 / 31788 / 30704 | 58000 | 1:48 PM | labs-task-attempt range |
| 29444 / 8392 / 34720 | 56000 | 6:22 PM | the previous worker's labs-scripted probe |
| 24672 / 23104 / 34848 | 57000 | 6:23 PM | |
| 2060 / 24892 / 25296, under job.exe 20796 | 55000 | 7:00 PM | another agent's labs.test.ts, store at `%TEMP%\meritrouter-test-WcBIJa` |

There are also 15 `job.exe` processes host-wide, all under the default TEMP. The only process I
stopped was my own expired monitor's `tail.exe`.

## Not verified

- The full router suite, `pnpm -r build`, MCP tests and the panel.
- POSIX behaviour. The new process and serve tests are Windows-only, which is where the Job
  helpers exist.
- The leak fixes against a loaded parallel full-suite run, which is where the leak actually
  happened. I verified them only with serial and single-file runs.
- A Lab team child whose resume falls back to `workspaceSource`.
- Nested sub-supervisors inside a Lab team (Open question 1).
- Lab team children with `labChecks`: `task-lab.ts` still uses `ctx.cfg.repositoryPaths` for
  attempt sources.

## Open questions or contradictions found

1. **Sub-supervisors inside a Lab team.** A non-root supervisor bound to the Lab has
   `cfg.repositoryPaths` pointing at the Lab worktree, and its `integrationRepos` admission in
   `supervisor.ts` gets no permits (`labAdmission` is root-only). So I expect it to be refused by
   the Lab service, as children were. The fix is the same `teamSource` idea in `supervisor.ts`,
   which I do not own. I have not reproduced this.
2. **`sourceDirty` for Lab children** now describes the configured checkout, not the Lab worktree.
   The Lab worktree must already be clean at dispatch (`delegatedSourceSnapshot`), so the old
   value carried no information. A dirty user checkout will add an informational finding to Lab
   children.
3. **labs.test.ts, 2 pre-existing failures.** The tests expect `/ownership/` and `/live processes/`
   but get `command_uncertain` "Lab process has no durable repository command owner" (since
   5cb43f9). The refusal still happens, but earlier, so the orphan-proof path is no longer
   exercised. I did not loosen the assertions because that would lose the coverage. This needs a
   decision.
4. **process-acceptance-integration "hard-kill: true" fails deterministically** (`exitCode` 1, not
   0, for the second integrator).
   - It fails with my merge-queue change, and also with `src/workspaces/merge-queue.ts` and
     `integration-tools.ts` at HEAD, each built into `dist/` and run. So my change did not cause
     it.
   - It was not in the brief's list, and I did not investigate it further.
   - `dist/` was left rebuilt from the current tree.
5. **Orphaned Job helpers.** A launch-mode `job.exe` waits indefinitely for its release file once
   its Job is empty, so any non-manager kill leaves it behind (`src/harness/service-command-process.ts`,
   not owned). Recovery by a manager releases it. A bounded self-exit when the Job is empty and
   the release never arrives would need a security review of the release proof.
6. **`src/labs/lab.ts` is now 811 lines**, just over the roughly 800-line guidance, from the
   `close()` hardening.
