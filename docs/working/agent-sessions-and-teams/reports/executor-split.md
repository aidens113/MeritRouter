# Executor split (worker report)

## Outcome

Done. `packages/router/src/core/executor.ts` went from 842 to 616 lines. The code was moved as is,
with thin seams and no behaviour change. No test was edited, and all 288 tests pass.

## Diagnosis (original `executor.ts`, 842 lines)

| Lines | Responsibility | Owning concern | Decision |
|---|---|---|---|
| 1-38 | Imports | n/a | Updated |
| 40-46 | `effortFor` (which brain working document a task belongs to) | brain effort selection | Kept. It is 7 lines, `src/brain` is outside my ownership, and the context and record paths use it |
| 48-51 | `AbortReason`, `WATCHDOG_STOP` | failure disposition | Moved to `core/disposition.ts` |
| 53-78 | `CodingRunner`, `ExecutorDeps` | executor core | Kept |
| 80-83 | `Disposition` type | failure disposition | Moved to `core/disposition.ts` |
| 85-90 | `Routing` (per-run routing record) | executor core | Kept |
| 92-134 | `DELEGATED_BY_SESSION`, `ResumeDirectiveSchema`, `RESUMABLE_MODES`, `sessionEnd`, `authorSessions`, `authorOf`, `jobIdFor` | run-session lifecycle | Moved to `sessions/run-sessions.ts` |
| 141-145 | `watched` map type | watchdog | The type became `WatchedRun` in `core/watchdog.ts` |
| 154-247 | `openSession`, `resumeDirective`, `resumeFor`, `interruptedTier`, `endSession` | run-session lifecycle | Moved to `sessions/run-sessions.ts` as `openRunSession`, `resumeFor`, `interruptedTier`, `endRunSession`. `openSession` and `endSession` stay as one-line private wrappers |
| 249-256 | `endForDisposition` | disposition to session-end mapping | Made pure as `dispositionSessionEnd` in `core/disposition.ts`. A 4-line wrapper stays |
| 258-297 | `context` (builds the `RunContext`) | executor core | Kept |
| 299-314 | `supervise` (lease heartbeat, cancel, deadline) | executor core (lease) | Kept |
| 316-325 | `runMode` dispatch | executor core | Kept |
| 327-341 | `contractFor` | acceptance wiring (calls `record`) | Kept. The logic already lives in `acceptance.ts` |
| 343-363 | `reviewRun` (verification-phase hooks) | executor wiring | Kept |
| 365-377 | `withUpstream` | context wiring | Kept |
| 379-410 | `redundancy`, `runTwins` | redundancy wiring (`redundancy.ts` holds the logic) | Kept |
| 412-420 | `tooDifficult` | executor core | Kept |
| 422-578 | `runSingle` | executor core | Kept. Calls the moved functions now |
| 580-685 | `runBatch` | executor core | Kept |
| 687-739 | `classify` (error or abort to `Disposition`) | failure disposition | Moved to `classifyFailure` in `core/disposition.ts`. A one-line wrapper stays |
| 741-769 | `settle` | executor core | Kept. Calls `requeueStuck` from watchdog |
| 771-798 | `record` (finishes the task, brain report) | executor core | Kept |
| 800-825 | `checkWatchdog` body | watchdog | Moved to `abortStuckRuns` in `core/watchdog.ts`. A one-line delegating method stays |
| 827-837 | `requeueStuck` | watchdog | Moved to `core/watchdog.ts` |
| 839-841 | `abortAll` | executor core | Kept |

**Why it had grown:** three concerns had piled into the executor. These were run-session
lifecycle (~140 lines), failure classification (~60) and watchdog policy (~40). The run loops
themselves (`runSingle` and `runBatch`, ~265 lines) are executor core and stayed. I did not move
any retry or escalation policy, because it already lives in `verification/phase.ts`
(`continueRun`, `planRetry`) and `core/acceptance.ts`.

## Moves

- **New `src/sessions/run-sessions.ts` (167 lines):** the session lifecycle of a task's runs.
  - It holds `DELEGATED_BY_SESSION`, `ResumeDirectiveSchema` / `ResumeDirective`, `sessionEnd`,
    `authorSessions`, `jobIdFor`, `openRunSession`, `resumeFor`, `interruptedTier` and
    `endRunSession`.
  - It adds two types, `RunSessionDeps` and `RunResume`. `RunResume` replaces
    `ReturnType<Executor["resumeFor"]>`.
  - Its imports are config, storage, roles, `runners/types` (type only) and other `sessions/`
    files. It imports nothing from `core/`.
- **New `src/core/disposition.ts` (90 lines):**
  - It holds `AbortReason`, `WATCHDOG_STOP`, `Disposition`, `classifyFailure(err, signal, {cfg, now(), deadline()})` and `dispositionSessionEnd(d)`.
  - `now` and `deadline` are lazy callbacks. The clock and the task row are therefore read only
    after the abort-reason checks, exactly as before.
- **`src/core/watchdog.ts` (71 to 126 lines):** adds `WatchedRun`, `abortStuckRuns(deps, watched)`
  (the old `checkWatchdog` body, verbatim) and `requeueStuck(tasks, owner, task, watched)`. It now
  imports `MAX_AUTO_RESUMES` from `scheduler.ts`, which `executor.ts` already did. `scheduler.ts`
  imports only the `Executor` type, so this adds no runtime cycle.
- **Re-exports kept in `executor.ts`:** `authorSessions`, `DELEGATED_BY_SESSION`,
  `ResumeDirectiveSchema`, `sessionEnd`, `ResumeDirective`, `WATCHDOG_STOP` and `AbortReason`.
  - `service.ts` (`DELEGATED_BY_SESSION`) and `verification/trail.ts` (`authorSessions`) still
    import from the executor unchanged.
  - I made no edit to `service.ts`.
  - I made no change to `src/index.ts`, because it never exported any executor name.

## Final line counts

| File | Lines |
|---|---|
| `src/core/executor.ts` | 616 (was 842) |
| `src/sessions/run-sessions.ts` | 167 (new) |
| `src/core/disposition.ts` | 90 (new) |
| `src/core/watchdog.ts` | 126 (was 71) |

All files use LF line endings, as the originals did.

## Commands run and observed results

- `pnpm --filter switchyard-router build` (from `D:\sy-wt\v1`): `tsc -p tsconfig.build.json`
  finished with no errors.
- `pnpm -r typecheck`: router reported `Done` and panel reported `Done`.
- `cd packages/router && npx vitest run`: 31 test files passed, **288 tests passed**, in 48.4 s.
- `git status --short` shows the changes are limited to `core/executor.ts` and `core/watchdog.ts`
  (modified) and `core/disposition.ts` and `sessions/run-sessions.ts` (new).

## Not verified

- I did not run `pnpm -r build`, which includes the panel production build. The panel typecheck
  passes.
- The other worker's files were unmodified when I validated. The run reflects this tree state
  only.

## Open questions or contradictions found

- `effortFor` concerns the brain and could belong in `src/brain/`. I left it in place because
  `src/brain` is outside this brief.
- `verification/trail.ts` could import `authorSessions` from `sessions/run-sessions.ts` directly.
  The executor's re-export could then be dropped once nothing else uses it.
- `service.ts` could likewise import `DELEGATED_BY_SESSION` directly.
