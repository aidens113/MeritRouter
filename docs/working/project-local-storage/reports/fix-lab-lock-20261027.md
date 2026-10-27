# Fix: Lab lock_busy and task-attempt failures (2026-10-27)

Worker: fix_lab_lock (worker-heavy). Branch dev, main checkout. No commits.

## Outcome

Partial. Three separate causes were found, not one.

- **labs-task-prune (3 failures):** fixed. 11/11 pass.
- **labs-task-attempt (2 failures):** fixed. 16/16 pass. This took two fixes, because an environmental process-listing bug made it fail intermittently.
- **active-validation-ownership (1 failure):** a separate cause, introduced by b87f326 (2026-10-26, "Guard repository writes until command Jobs are quiescent"). It is not fixed. It needs a fence-policy decision in files I don't own.
- **labs-scripted (1 failure):** the same `active_command` class. It fails identically with HEAD versions of my files, so it is pre-existing and not caused by this change.

## Cause 1: prune self-deadlock and waiting on a live fence (introduced by 5cb43f9)

5cb43f9 wrapped `TaskAttemptPruner.run`'s claim and `runner.prune` in one `withGitMutation` scope. It also passed the capability to `runner.prune` as a new optional 4th argument (`control`).

Instrumentation recorded the lock holder's and the waiter's call sites:

- **Holder:** `TaskAttemptPruner.run` (task-attempt-prune.ts:69).
- **Waiter:** `admitLabRepository` with no capability, entered about 430 ms later from inside the holder's scope.

Two failure paths followed from this:

- **"fences lease loss" and "recovers partial Git removal":** their spies are `(request, attempt, fence) => original(request, attempt, {...fence, ...})`. That drops the 4th argument, so `runner.prune` re-acquired the same non-reentrant per-common-dir lock inside the pruner's own scope. It waited out the 10 s deadline and threw `lock_busy`.
- **"serializes automatic and project prune":** the first prune is legitimately paused inside the fence. The concurrent `prune()` and `pruneProject()` calls should only refuse, based on the live durable generation. Instead they waited for the fence and timed out, and the afterEach then hung.

Fixes:

- `src/labs/task-attempt-runner.ts`: the mutation capability is now a required field of the prune fence (`TaskPruneFence.mutation`). The optional `control` argument is removed, so a wrapper can't drop it. The `{...fence}` spies keep it.
- `src/labs/task-attempt-prune.ts`: added a read-only pre-admission refusal. If the attempt has a `pending` operation, or a `running` one with `lease_until > now`, it counts as blocked without taking the fence. Expired generations still go through admission, where the existing under-lock `eligible()` re-check is unchanged. Nothing is removed on this path.

The fence itself (src/workspaces/repository-mutation.ts) is unchanged. No deadlines were raised.

## Cause 2a: typed ownership uncertainty escaped task settlement (introduced by 5cb43f9)

5cb43f9's report says it converted ownership refusals from plain `Error` to typed `ownership_changed`. It also made native grant and observation failures throw typed `command_uncertain`. However, `TaskAttemptRunner.run` and `.stop` still rethrow every `RepositoryMutationError`. That bypass was meant for admission refusals ("typed pending/publication failures bypass failure-row conversion"). As a result, uncertainty about a Lab's own processes was no longer recorded as `environment_failure` or `cleanup: blocked`. The operation stayed unsettled, and `process()` and `processControls()` rejected.

- **"retains reservations… foreign recorded process ownership":** a forged process row with no command owner caused `command_uncertain` in `LabRepositoryCommands.row`.
- **"never resurrects an expired operation lease":** lease loss before the grant caused an authority error. `startRepositoryServiceCommand` wraps it as `command_uncertain`.

Fix: `src/labs/repository-mutation.ts` adds `labMutationLeavesUnsettled(error)`. It returns true only for `SelectedCommitError` and the `RepositoryMutationError` kinds `pending_publication`, `active_command`, `lock_busy`, `invalid_capability` and `unawaited_mutation`. Those still propagate unsettled, as before. `runner.run` and `runner.stop` use it, so `command_uncertain` and `ownership_changed` now follow the existing retained paths:

- status `environment_failure`;
- cleanup `blocked` / `cleanup_blocked`, with reservations and receipts retained;
- no process killed without kernel proof.

`recover()` already retries `cleanup_blocked`. `TaskLabLifecycle.execute` and the pruner's catch are unchanged.

## Cause 2b: the Windows process snapshot breaks on foreign command lines (latent, environmental)

`windowsProcessTree` (src/labs/process-ownership.ts, unchanged since before 5cb43f9) parses `Get-CimInstance Win32_Process | ConvertTo-Json` for every process on the host. Windows PowerShell 5.1 writes stdout in the OEM code page. Characters it can't represent arrive as raw control bytes (0x1A), and `JSON.parse` fails with "Bad control character … position ~93000". `captureOwnedProcessTree` then fails inside `beforeGrant`, so every task service spawn fails while such a process exists.

- **Reproduced deterministically:** I spawned a node process with `✓|×|→\u0001` in its arguments. The old listing failed; the new one parses and keeps the exact characters.
- **Seen in practice:** another worker's `grep -E "✓|×|…"` shell triggered it, and so did my own monitoring commands.
- **Effect on a full run:** it turned a full labs-task-attempt run into 8 failures. This is very likely part of the "flakiness" seen in earlier bisects.

Fix: PowerShell now emits the UTF-8 JSON as base64. Node checks that the output is base64, then decodes it. `maxBuffer` is 32 MB. As a side effect, stored `CommandLine` values are now exact rather than lossy.

## Cause 3, not fixed: active_command refusal of supervisor startup (introduced by b87f326)

"actual supervisor cannot cancel approved validation…" and labs-scripted both fail the same way: `Repository command rc_… is active or lacks verified process quiescence`.

In the active-validation test:

- the fixture (82a8e0e, 2026-10-25) runs an operator-approved check with `cwd: env.repo`, the source checkout;
- `SupervisorRunner.run` then calls `integrationRepos` (supervisor.ts:127/204), which takes `withRepositoryMutation` over that same source;
- b87f326 added `assertNoActiveRepositoryCommand` to admission, so the active receipt refuses it by design;
- the check is released only by the supervisor's own third model turn, so the supervisor can never start.

Not lock-related and not Lab code. Fixing it needs one of these decisions:

- (a) supervisor integration-worktree creation waits or retries while a source command is active;
- (b) the fence exempts linked-worktree creation (refs and worktrees/ only) from an active source-worktree command;
- (c) the fixtures run the approved command in a linked worktree rather than the source checkout.

These touch src/runners/supervisor.ts, src/workspaces/repository-command.ts, or shared fixtures, none of which I own. The test files were not edited.

## Commands run and observed results

**Reproduction (before any fix):**
- `npx vitest run tests/labs-task-prune.test.ts` -> 3 failed / 8 passed. The 3 failures were `lock_busy` at repository-mutation.ts:84, plus an afterEach hook timeout. 220.6 s.
- `npx vitest run tests/labs-task-attempt.test.ts -t "retains reservations|never resurrects"` -> 2 failed (`command_uncertain`).
- `npx vitest run tests/active-validation-ownership.test.ts` -> 1 failed / 16 passed (`active_command`).

**Typecheck and build:**
- `npx tsc --noEmit` -> exit 0, no output. This covers the whole package, including the concurrent worker's in-flight edits.
- `npx tsc -p tsconfig.build.json` -> exit 0. I rebuilt `dist/` because the killed-owner fixture runs `dist/` in a child process. Both fixes were confirmed in `dist`.

**Final serial acceptance** (each file alone, default timeouts, all instrumentation removed):

| Test file | Result | Time |
| --- | --- | --- |
| `tests/labs-task-prune.test.ts` | 11/11 passed | 233 s |
| `tests/labs-task-attempt.test.ts` | 16/16 passed | 447 s |
| `tests/active-validation-ownership.test.ts` | 1 failed / 16 passed (Cause 3) | 32 s |
| `tests/labs-browser.test.ts` | 8/8 passed | 182 s |
| `tests/labs-compose-validation.test.ts` | 10/10 passed | 10 s |
| `tests/labs-scripted.test.ts` | 1 failed / 1 (Cause 3 class; also fails with HEAD labs files) | 14 s |
| `tests/labs-service.test.ts` | 2/2 passed | 6 s |
| `tests/project-task-lab-deletion.test.ts` | 3/3 passed | 54 s |
| `tests/project-local-labs.test.ts` | 18/18 passed | 17 s |

`tests/command-guards*.test.ts` does not exist.

**Leaked processes:** none. job.exe and node.exe lists match my starting snapshot. The pre-existing PIDs 18812, 4124, 19192 and 15016 were left alone.

**Instrumentation:** all temporary instrumentation is removed. src/workspaces/repository-mutation.ts was restored from a backup identical to HEAD; `git status` shows it clean.

## Not verified

- The full router suite was not run, and neither was `pnpm -r build`.
- Proof files written by the old lossy listing, for live processes whose command lines contain non-OEM characters, will no longer merge with an exact snapshot. They fail closed with "stored process command identity changed". This was not tested.
- `processOwnership`'s single-PID PowerShell query is still OEM-lossy. It only does ASCII substring checks, so it was left unchanged.
- The pruner's catch and `TaskLabLifecycle.execute` still rethrow every `RepositoryMutationError`. That is unchanged; consistency there is a follow-up.
- No non-Windows run.

## Open questions or contradictions found

- Cause 3 needs a decision on fence policy (see above).
- 5cb43f9's report states "full prior27 task/prune aggregate … not rerun". That is consistent with these regressions landing unverified.
- The concurrent B1 worker's files appear in `git status` (service.ts, project-*.ts, projects/*). I did not touch them.
