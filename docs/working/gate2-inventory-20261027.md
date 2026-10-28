# Gate 2 inventory: "Close delivery lifecycle failures" (2026-10-27, read-only)

Gate 2 (production-readiness.md:61-62): preserve model fallback, batching, valid retained source
selection, command ownership, budgets and interrupted-session recovery. Exit needs integrated
source reviewed, recursive checks and final full suite observed; real failing journeys reproduced
and corrected, no fake acceptance or usage reset.

## 1. Concrete delivery-lifecycle failures observed in the FB/IG pilots

| Symptom | Recorded cause | Status |
| --- | --- | --- |
| Supervisor dispatch deadlocked on empty `quality_evidence` | No usable supervisor default when no evidence exists | Fixed-and-tested: `supervisor-routing-default` integrated at 5e1bfe2 per supervised-delivery-v2 Current State; final schema/MCP 26/26, recursive typecheck/build passed |
| Whole tasks failed on unavailable/not-in-plan models | Gate had no finite fallback/refusal cache across eligible endpoints | Fixed, tested in isolated worktree (`model-unavailable-recovery`); present in main `gateway/gate.ts` (refusal cache at :364, free-fallback accounting :455/:497) but the worktree's own test run, not a confirmed main-branch rerun |
| Model/worker made only serial reads despite batch tools | Advertised batch schema/injection didn't induce parallel reads | Fixed, tested in isolated worktree (`harness-batch-usage`); not independently reverified on main here |
| Classifier batching test flaked (expected 1 call, got 2) | 50ms test window too tight under load, not a product bug | Fixed-and-tested per supervised-delivery-v2 ledger (classifier-batch-regression) |
| Completed/rejected supervisor had no repair path (`resume_task` only covered interrupted tasks) | Missing rejected->repair resume semantics | Fixed-and-tested per supervised-delivery-v2 ledger (rejected-delivery-repair), isolation/duplicate-refusal/budget invariants covered |
| Brain commit silently skipped a tracked-file update (`commit: null`) | Git 2.55 gives wrong `ls-files` answers with 1 positive + any exclude pathspec through the `-c`-laden process-policy wrapper | **Fixed and tested today**: `fix-brain-commit-20261027.md`, all affected acceptance files pass (attribution 4/4, brain 10/10, project-metadata-brain 17/17, etc.) |
| Lab prune threw `lock_busy` / deadlocked on its own fence | `TaskAttemptPruner.run` dropped the mutation capability it passed to `runner.prune`, which then re-acquired the same non-reentrant lock | **Fixed and tested today**: `fix-lab-lock-20261027.md`, labs-task-prune 11/11 |
| Lab task settlement rejected on foreign/forged process rows or lost leases | Typed `command_uncertain`/`ownership_changed` were rethrown instead of settling as `environment_failure`/`cleanup_blocked` | **Fixed and tested today**: labs-task-attempt 16/16 |
| Lab host crashed parsing its own process snapshot (`Bad control character`) | PowerShell `Win32_Process` JSON in the OEM code page corrupts non-ASCII argv bytes | **Fixed and tested today** (base64 round-trip); reproduced deterministically |
| Supervisor startup threw `active_command` and could never start (integration admission vs. an operator-approved check running in the same source checkout) | b87f326 (2026-10-25, "Guard repository writes until command Jobs are quiescent") added an unconditional active-command refusal to admission | **Fixed-and-tested for the one-off case**: `fix-supervisor-command-wait.md`, active-validation-ownership 18/18 |
| Same `active_command` throw, but against a Lab's own persistent service (`labs-scripted`) | Admission has no exemption for a Lab's own known service permits at the sites outside `src/labs/**` | **Open; fix in progress, uncommitted, untested** — see table 2 item 1 |
| Supervisor test timed out waiting for a question at 10s | Brain startup cost (~26-29s under load), not a product defect | Fixed-and-tested today (`split-labs.md`, Task 3): window raised, root cause documented, not silently retried |
| Lab service restart on Windows always failed after a stop | Stale `process-tree.json` proof collided with the new pid/token (`z.literal`) | **Fixed and tested today**: restart test in `labs-integration-permits.test.ts` |
| Split-project task Labs never drained (no supervisor ticked their queue) | `labs serve` only ticks the installation's `sy.labs`; split executors had no `ensureLabsSupervisor` | **Fixed and tested today**: `project-split-labs.test.ts` positive/negative cases pass |
| "Serialises overlapping coding briefs...asks the user" test fails (`expected undefined to match object`, missing `ask_user`) | Unknown; confirmed pre-existing and unrelated to today's changes (reproduced against unmodified HEAD) | **Open, unknown cause**, not addressed by any of today's reports |

## 2. Open items most likely to stall a fresh 400-request/$0 Ollama Cloud pilot, by risk

1. **Lab-rooted job vs. its own persistent service never settles admission.** `labs-scripted`
   waits out a fixed 60s cap then fails; a real pilot job would stall with `outcome.pending`
   non-empty rather than erroring fast, burning wall-clock (and, on retry, request budget) before
   anyone notices. A fix is mid-flight right now (uncommitted, per `git status`): `src/labs/binding.ts`
   (`teamSource`), `src/runners/coding/finish.ts` (`workspaceSource`), `src/workspaces/merge-queue.ts`
   (`MergeHooks.admission`/`withMutation`), `src/harness/integration-tools.ts` (`admission` hook).
   Confirmed uncommitted and not yet run by this session (another agent is validating). Test idea:
   `npx vitest run tests/labs-scripted.test.ts` once that diff lands, plus a live-shaped smoke that
   runs a worker brief with `labChecks` against a retained Lab service end to end.
2. **`active_command` wait has a hard 60s cap with no visibility into the blocking command's own
   deadline.** On a loaded host (today's reports repeatedly note other agents saturating the CPU),
   an approved install/check could legitimately run past 60s, so a fresh supervisor's very first
   admission throws instead of waiting the right amount. Owned: `src/runners/supervisor.ts`
   (`awaitingActiveCommand`, `ACTIVE_COMMAND_SETTLE_CAP_MS`). Test idea: a fixture whose active
   command settles at 55-90s under simulated load, asserting the job starts rather than throwing.
3. **Split-install retained Labs have no service supervisor.** `labs serve` only ticks the
   installation's `sy.labs`; a split project's own long-lived Lab service gets no crash restart,
   idle stop, or adoption unless opened with `labsMonitor`. A pilot using the project-local layout
   with a retained Lab could leak an unmonitored service that later collides with admission. Owned:
   `src/cli/lab-supervisor.ts` (explicitly out of scope for today's split-labs brief). Test idea:
   kill a split project's Lab service process out-of-band and assert it is detected/restarted.
4. **Worker runs never execute task Labs by design** (`runTaskLabChecks` requires supervisor-mode
   lease + `security.outside_repository: supervisor`). If the pilot's plan assumes a plain worker's
   `labChecks` constraint runs automatically, it will instead file `lab_check` and throw on every
   attempt, consuming requests on repeated failed/re-dispatched attempts. This is confirmed
   deliberate (dates to 1092881), not a bug, but needs an explicit decision before the pilot is
   planned around it. Test idea: dry-run the pilot's planned worker briefs against this gate before
   spending live requests.
5. **`processOwnership`'s single-PID PowerShell query is still OEM-lossy** (only the bulk snapshot
   was fixed). A single-PID ownership check against a process with non-ASCII argv (plausible if
   a model/provider name or a path contains non-ASCII characters) could silently mis-match on
   substring comparison. Owned: `src/labs/process-ownership.ts`. Test idea: extend the non-ASCII
   argv reproduction from `fix-lab-lock-20261027.md` to the single-PID path.
6. **The pre-existing, unexplained `supervisor.test.ts` "serialises overlapping coding briefs...
   asks the user" failure** is still open with no recorded cause. If the pilot dispatches two
   workers that lease-conflict on the same file, the user-facing question this depends on may not
   surface, stalling the job waiting on an approval that was never asked. Test idea: isolate and
   re-run that one test with tracing before the pilot starts any multi-worker brief.

## 3. Claims the docs make that source contradicts (or that remain unverified despite phrasing)

- **supervised-delivery-v2.md Current State** lists a long "Implemented:" paragraph (FINAL
  initiator, quality-evidence selection, defensive batched harness, typed memory, Brain flows,
  etc.) in the same register as fully-done work, but the **Implementation phases table** two
  screens later (P0-P10) still shows most of that same work assigned to a "future owner" with
  unmet dependencies (harness v2 H1-H6, memory-v2, interactive-runtime, Brain panel P8,
  delivery-contracts P0). The two sections describe different things (corrective-patch delivery
  vs. the full v2 rebuild) but read, on a single pass, as if the whole v2 plan were finished; it
  is not — only the corrective patch (5e1bfe2) is confirmed integrated.
- **b87f326 ("Guard repository writes until command Jobs are quiescent", 2026-10-25)** is recorded
  in the ledger as an applied, committed fix, but it introduced the `active_command` supervisor-
  startup deadlock (Cause 3) that was only found and partly fixed today, a day later. The
  `fix_lab_lock` worker explicitly notes the prior worker's own report said the "full prior 27
  task/prune aggregate" was "not rerun" — i.e., the regression landed because the stated
  validation at the time did not actually cover it. Treat prior "PASS" ledger lines for Labs/
  command-ownership work as not covering this interaction until re-confirmed.
- **handoff.md** is written in a heavily compressed, near-unparseable shorthand throughout (e.g.
  "Root final commit15/15 and combined broker/identity/defaults/ workspace63/63 PASS"). It is
  technically present but not usable as a reliable source of current status without cross-checking
  every claim against the effort's own `Current State` — which this inventory did.
- **No gate-2 claim found of a "final full suite" run covering today's four fixes together.** Each
  report ran its own narrow acceptance set; none ran `pnpm -r build` or the full router suite. Gate
  2's exit criterion ("recursive checks and final full suite observed") is not yet met for today's
  combined changes, and this session was explicitly told not to run tests to verify that.

Return contract follows.
