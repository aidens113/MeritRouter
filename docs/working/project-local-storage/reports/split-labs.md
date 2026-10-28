# Split-layout Labs (worker report)

Worker: split-labs (worker-heavy). Date: 2026-10-27. Branch dev, main checkout, no commits, no
worktrees. Paths are relative to `packages/router` unless stated otherwise.

## Outcome

Partial.

- **Task 1 (split task Labs): Done**, with one contradiction for the lead (Open question 1).
- **Task 3 (`supervisor.test.ts`): Done.** The failure was a test timing defect, not a product
  defect. The test is corrected and the reason is written in it.
- **Task 2 (`labs-scripted.test.ts`): Partial.** The permit mechanism is in place and the job now
  gets past every admission inside my paths. I also found and fixed a Lab service restart defect.
  The test still fails because the next refusals are at nine admission sites in two files I do not
  own. A probe that admitted those nine sites with the same permits made the whole test pass.
  Details are in Open question 2.

## What changed and why

**Task 1: split projects drain their own task Labs**

- **`src/labs/lab.ts`**
  - New `superviseTaskAttempts()`. It runs this manager's task-attempt queue in this process: a
    200 ms unref'd timer calls `taskAttempts.schedule()`, which runs `process()` and therefore
    `recover()`.
  - It is idempotent, does nothing more when the monitor timer already runs, and stops in
    `close()`.
  - It deliberately does not monitor retained Lab services.
- **`src/core/project-runtime-host.ts`.** Each project's private executor services now get
  `ensureLabsSupervisor: () => manager.superviseTaskAttempts()`.
  - Before this, split executors had no `ensureLabsSupervisor`.
  - `labs serve` (`cli/lab-supervisor.ts`) ticks only `sy.labs`, which in split mode is the
    coordination store's manager. A project's task-Lab queue was therefore never drained.
- **`src/runners/coding/task-lab.ts`: `taskLabAuthority` was always null in split mode**, so Lab
  evidence was always refused (in verification, `acceptTask`, the host's `beforeAccept`, and
  integration). There were two causes:
  - It required `fresh.storageDir === labs.options.storageDir`. In split mode the project manager's
    storage is `<project>/.MeritRouter/state`.
  - It took the attempt's worktree root from a fresh registry context, which points at the
    installation's worktrees.

  The fix: the manager is accepted when its storage equals
  `projectRuntimePaths(<configured project directory>).state` (split), or the installation storage
  (legacy, unchanged). The worktree root is derived from that same storage.
- **New `tests/project-split-labs.test.ts`.** Split install, a fake provider and the real native
  coding runner. Two tests:
  1. **Positive.** The run's `taskLabs` is `sy.labsFor("alpha")`, not `sy.labs`, and no
     installation Labs-supervisor lease exists. The `health` check passes on the submitted commit
     with cleanup `complete`. The Lab is a stopped `task_attempt` under
     `<project>/.MeritRouter/labs`. The project store has no live services, processes or ports.
     The coordination DB has 0 rows in `labs`, `lab_task_attempts`, `task_lab_operations` and
     `tasks`. In verification, `ephemeral_lab_checks` passed. `taskLabEvidenceProblem` is null and
     `acceptTask` succeeds. The source checkout is clean.
     - This test grants supervisor authority to that one task through a partial `vi.mock` of
       `currentSupervisorAuthority`, so it does not show a worker run passing on its own (Open
       question 1).
  2. **Negative.** A plain worker run (no grant) files a `lab_check` action. No attempt, no Lab
     and no `labs` directory are created. Cancellation then works.

**Task 2: Lab root job admitted past its own services; restart defect**

- **`src/labs/command-authority.ts`.** New `servicePermits(lab, aliases)`.
  - It only applies to a retained Lab, and covers only `lab-service` rows whose declared repository
    is in `aliases`.
  - Each handle is re-verified through the existing `load` (DB row, sidecar, receipt, native Job).
  - Setup, check and task commands are never included.
- **`src/labs/lab.ts`.** New `ownServicePermits(project, name, aliases)`. It calls `require()`
  first, then the method above.
- **`src/labs/binding.ts`.** `LabRunContext` gets
  `integrationPermits(jobId, aliases)`. It throws `lab_scope_denied` unless `jobId === rootJobId`.
  Both construction sites now use one `runContext` builder. `LabRunContext` is publicly exported
  as a type, so the new member is required for any external constructor; none exists in the repo.
- **`src/runners/supervisor.ts`.** New `labAdmission(ctx, aliases)`. It returns `{ command }`
  permits only when `ctx.lab.rootJobId === ctx.taskId`. It is fetched again for each admission,
  because an integration restart replaces the service's command. It is passed at every
  `supervisor.ts` admission over the integration worktrees:
  - the outer and Lab-branch admissions in `integrationRepos`;
  - the pointer;
  - the recovered refresh;
  - the `onResponse` commit;
  - `checkHeads`;
  - `recordCandidate`.

  The fence code is untouched, and the existing `command` option is the only exemption used.
- **`src/labs/services.ts`: defect.** Restarting a retained service on Windows always failed:
  1. A stop verified kernel retirement but left `logs/<name>.process-tree.json` behind.
  2. The next start's `captureOwnedProcessTree` parsed that file with `z.literal(newPid)` and
     `z.literal(newToken)`, and threw.

  This broke `after_integrate` (labs-scripted), crash restarts and routed restarts. Now,
  `stopProcess` removes the proof only after `authority.stop` verifies retirement, and only when the
  file is a plain file holding exactly the retired pid and token. Anything else is kept as evidence.
- **New `tests/labs-integration-permits.test.ts`.** Two tests:
  1. **Permits.**
     - The fence refuses the Lab worktree while the service runs.
     - The root's permits admit it.
     - A team child's binding is refused, as is the root binding asked for the child's id. Another
       alias gets no permits.
     - While the Lab's own transient check is active, the root's permits are still refused with
       `active_command`.
     - Once the Lab stops, it issues no permits and the worktree is admitted normally.
  2. **Restart.** A restart gives a new pid and token. The proof holds the new identity and is
     removed after the stop.

**Task 3**

`tests/supervisor.test.ts`, "serialises overlapping coding briefs...". The test gave the question
10 s to appear, but the question only comes after supervisor startup and two model turns. With
temporary timing probes in `supervisor.ts` (removed afterwards), on a host saturated by other
agents' full-suite runs:

| Step | Time from run start |
| --- | --- |
| `integrationRepos` | 1.2 s |
| pointer | 2.0 s |
| `brain.ensure` | 10.6 s |
| working-document commits done | 28.5 s |
| first model turn starts | 28.6 s |

With a longer wait, every original assertion passed: the question and its options, the answer echo,
`supervisor_blocked`, and b's `waiting_for_file_lease` held by a. The test now waits on a 90 s
deadline (with job status in the failure message), `awaitResults` waits 120 s, and the test timeout
is 240 s.

## Commands run and observed results

All from `D:/MeritRouter/packages/router`, after the final edits.

| Command | Result |
| --- | --- |
| `npx tsc --noEmit` | exit 0 |
| `npx vitest run tests/project-split-labs.test.ts tests/labs-integration-permits.test.ts tests/labs-task-prune.test.ts tests/labs-task-attempt.test.ts` | 4 files, 31/31 passed |
| `npx vitest run tests/active-validation-ownership.test.ts tests/supervisor.test.ts` | 21/21 passed (supervisor 3/3) |
| `npx vitest run tests/supervisor-lifecycle.test.ts` | 46/46 passed |
| `npx vitest run tests/project-runtime-activation.test.ts tests/project-service-activation.test.ts` | 12/12 passed |
| `npx vitest run tests/labs-browser.test.ts` | 8/8 passed |
| `npx vitest run tests/labs-scripted.test.ts` | **1 failed** in 24 s (it used to time out at 72 s). The job completes; the child is `not_verified` because its workspace admission was refused by the Lab's service |
| labs-scripted probe (throwaway test, deleted): a `vi.mock` of `withRepositoryMutation` that adds the Lab's own service permits only to refusals that are `active_command`, carry no `command` option, and touch the Lab's repos | **passed** (52 s), including the integration restart and the revision check |
| Mutation checks (each fix disabled temporarily, then restored) | without the split `ensureLabsSupervisor`: the positive split test fails ("Required task Lab checks did not complete"). Without the `taskLabAuthority` split branch: `ephemeral_lab_checks` is `failed`. Without the proof retirement: the restart test fails with the zod pid/token error |
| `npx vitest run tests/labs.test.ts` (idle host) | 16/18. Before the services fix it was 14/18; the crash-restart and routed-restart tests now pass. The 2 remaining failures expect `/ownership/` and `/live processes/` but get "Lab process has no durable repository command owner" (command-owner fence from 5cb43f9); I did not change this |
| 10 neighbouring Lab files (lab-check-evidence, lab-config-guard, lab-supervisor, labs-compose-validation, labs-service, project-local-labs, task-lab-caller, task-lab-validation, task-lab-verification, worker-lab-authority) | 53/58 |

The 5 failures in the neighbouring files are all pre-existing:

- **`task-lab-caller` (3).** They fail identically with every file I changed swapped back to its
  HEAD content (`git show HEAD:...`, then restored):
  - one hand-built context lacks `signal`, which `assertRunAuthority` reads in `finish.ts`;
  - two use 10 s `awaitResults` windows.
- **`worker-lab-authority` (1).** It expects `runProcess`, but Lab checks have run through
  `commands.run` since 5cb43f9 (2026-10-26). The test dates from 2026-10-23.
- **The fifth** was the timeout-sensitive `task-lab-caller` case under load; it passed alone.

Throwaway files (deleted): `tests/zz-split-labs-debug.test.ts`, `tests/zz-split-labs-sup-debug.test.ts`.

## Not verified

- The full router suite, `pnpm -r build`, MCP tests and `dist/`. I did not rebuild `dist/`, and
  legacy `ensureLabSupervisor` spawns `dist/cli.js` but is unchanged.
- POSIX: the proof file is Windows-only, and the restart test's proof assertions are gated on win32.
- Multi-process split cases: a second process draining the same project queue (the lease and
  generation checks should hold, but this is untested).
- Split retained Labs: there is still no service supervisor for project-local retained Labs (Open
  question 3).
- **Processes still running.** I did not kill them, and I cannot attribute them to my runs:
  - service host 29444 with server 34720 (port 56000, labs-scripted's range), started 6:22 PM;
  - service host 24672 with server 34848 (port 57000, outside my ranges), started 6:23 PM;
  - task hosts 23732 and 39784 with servers 15964 and 30704 (ports 58001 and 58000), started
    1:40 and 1:48 PM, before this session.

  Other agents were running full suites at the time.

## Open questions or contradictions found

1. **Plain worker runs never execute task Labs, in either layout.**
   - **What happens.** `runTaskLabChecks` requires the run's own lease to hold live supervisor
     authority and `security.outside_repository: supervisor`. A worker-profile run (for example
     `implement`) never has it, so it always files a `lab_check` action and then throws.
   - **This is deliberate.** It dates from 1092881 (see
     `correctness-and-panel-flows/reports/queued-lab-authority.md`). Only a coding run under a
     supervisor-mode lease reaches the Lab, which no executor route produces.
   - **What my wiring covers.** It makes that gated path work in split projects, and the positive
     test grants the authority explicitly.
   - **Impact on the pilot.** If the pilot needs worker briefs with `labChecks` to run, that needs a
     product and security decision from the lead or user. It is not a wiring bug. App checks bound
     to a supervisor job through a retained Lab (the labs-scripted path) do not depend on this gate.
2. **labs-scripted needs the same permits at nine sites outside my ownership.** From the probe:
   - **`src/runners/coding/finish.ts` :37, :38, :109 (and the nested :111), :153.** These are the
     Lab-team child's workspace prepare, collect and status admissions. The child's `sourcePath` is
     the Lab worktree (`labConfiguration`).
   - **`src/workspaces/merge-queue.ts` :479, :499, :638, :671.** These are `withMutation` for the
     root job's integration into the Lab worktree.

   Proposals:
   - **Merge queue (root integration scope, within the brief's policy).** Give `MergeQueue` an
     optional per-item admission hook, wired in `mergeHooks` to `labAdmission`.
   - **Children (outside "integration scope").** Decide between:
     - (a) issuing the permits to Lab-team children for their source admissions only; or
     - (b) making children's source the configured checkout, pinned to the Lab head commit, so they
       never admit the Lab worktree.

   Either way, the brief must own `finish.ts` and `merge-queue.ts` (and possibly
   `workspaces/worktree.ts`, plus `harness/integration-tools.ts` or `supervisor-tools.ts` for the
   hook). The fence files would not need changes.
3. **`labs serve` cannot supervise split projects.** It ticks `sy.labs` only, so project-local
   *retained* Lab services in a split install have no crash restart, idle stop or adoption, unless
   the service is opened with `labsMonitor`. The fix belongs in `src/cli/lab-supervisor.ts` (ticking
   each host project manager), which this brief forbids. The in-process drain added here covers
   task Labs only. The lead should confirm that an in-process task-Lab drain is acceptable for
   split projects; the legacy path spawns a detached `labs serve`.
4. **Startup cost.** Supervisor startup spends most of its time in Brain git work (about 26 of
   29 s under load). It is not a correctness defect, but it makes every supervisor test sensitive to
   machine load.

## Return contract

```text
Outcome: Partial
Changed: packages/router/src/labs/{lab.ts,binding.ts,command-authority.ts,services.ts}, src/runners/supervisor.ts, src/runners/coding/task-lab.ts, src/core/project-runtime-host.ts, tests/supervisor.test.ts, tests/project-split-labs.test.ts (new), tests/labs-integration-permits.test.ts (new)
Validation: `npx tsc --noEmit` -> exit 0; split-labs+permits+task-prune+task-attempt -> 31/31; active-validation+supervisor -> 21/21; supervisor-lifecycle -> 46/46; project-runtime/service-activation -> 12/12; labs-browser -> 8/8; labs-scripted -> 1 failed (child workspace admission at non-owned sites; passes under a probe admitting those sites)
Not verified: full suite, build/dist, MCP, POSIX, multi-process split drain, split retained-Lab supervision
Report: docs/working/project-local-storage/reports/split-labs.md
Notes: Plain worker runs never execute task Labs by design (supervisor-authority gate), so the positive split test grants that authority; pilot reliance on worker labChecks needs a decision.
labs-scripted needs permits at finish.ts x5 and merge-queue.ts x4 (exact lines in report); fixed a real Windows Lab restart defect (stale process-tree proof).
supervisor.test.ts failure was a 10 s window vs about 29 s startup under load; test corrected.
```
