# Check commands ending as environment_failure (exitCode null)

Worker: worker-heavy (Opus 5.5, high). Date: 2026-11-26. Branch: dev, main checkout. Nothing committed.

## Outcome

Partial. That means the root cause is found and fixed, and 10 of the 11 failing acceptance tests now pass.
The one still failing (`delivery-runtime` "mutating false") has a separate cause: a config-default
change in 4cd1ad2. The file involved is outside my ownership, so I left it for the supervisor.

## Root cause

The source changes and the Next.js lockfile bump are not the cause. The trigger is this machine's
OS temp cleanup, and the defect is in how the native helper cache handles it.

1. Every check command runs through a C# Windows-job helper. The helper is compiled once into
   `%TEMP%\meritrouter-command-job-<hash>\job.exe`, and `manifest.json` (source and exe SHA-256)
   sits beside it. Service launches use a second cache, `%TEMP%\meritrouter-service-job-<hash>\`.
2. Windows Storage Sense is on, including "delete temporary files apps aren't using"
   (`HKCU\...\StorageSense\Parameters\StoragePolicy` `01=1`, `04=1`). The `SilentCleanup` task
   also runs (last run 2026-11-26 00:23). These sweeps remove temp files one at a time. Older
   `meritrouter-*` temp directories have been emptied of files while the directories stay
   (directory mtimes 11-10 16:49, 11-11 02:32, 11-12 13:44). Read-only git objects survived.
3. Both caches had lost `manifest.json` but kept `job.exe` (dated 11-04). The service cache's
   directory mtime, 2026-11-25 23:34:43, is when its manifest was removed.
4. `windows-job-executable.ts` treated that state as permanently fatal. It recompiled, then
   under the lock found `job.exe` with no manifest and threw
   `"Incomplete command helper cache is retained for inspection"` on every call, in every
   process, until someone fixed it by hand. The reverse case (manifest kept, exe removed) and an
   empty or truncated manifest were also permanent failures. In a long-lived process the per-call
   re-verification never cleared its memo either, so a sweep made helper failure permanent until
   restart.
5. `command-process.ts` swallowed that error into `exitCode: null, killed: "containment_unavailable"`
   with a fixed message. `checks.ts:105` then maps exitCode null to `environment_failure`, which
   gives `declared_checks = environment_failure` and `needs_supervisor`. The service path (same
   cache) showed up as `node --version: terminated`.

Why 2026-11-05 passed: the manifests still existed then. Nothing in `git log de3d28d..HEAD`
touches `src/harness/command-process.ts`, `windows-command-job.ts` or `windows-job-executable.ts`.

### Evidence (observed)

- Direct probe of `dist/harness/command-process.js` returned `{"exitCode":null,"stderr":"Verified command helper could not initialize; ...","killed":"containment_unavailable"}` for both `node -e "process.exit(0)"` and `echo hi`.
- `windowsCommandJobExecutable()` threw `Incomplete command helper cache is retained for inspection`.
- `ls` of both cache directories showed only `job.exe`, with no `manifest.json`. No `job.exe` process was running.
- `fsutil behavior query disablelastaccess` returned `2 (System Managed, Disabled)`. Storage Sense policy values and the SilentCleanup task are as quoted above.
- After the fix, the first test run repaired both caches on its own. Each now has a fresh `job.exe` and `manifest.json`, and the old exe is kept as `unverified-<token>-job.exe`.

## What changed and why

- `src/harness/windows-job-executable.ts`
  - `inspect()` now returns three results: the verified path; `null` when the cache is
    incomplete (manifest missing, empty or unparseable, or exe missing); or a throw when the cache
    is unsafe or altered (symlink, hard link, oversize, source mismatch, exe hash mismatch against
    an intact manifest). Tamper refusal is unchanged.
  - When the cache is incomplete, it compiles from the trusted static source as before. Under the
    existing exclusive `manifest.json.lock` claim it renames any remnants to `unverified-<token>-*`.
    They are kept for inspection and never executed. The manifest moves first, then the exe. It then
    installs the candidate at the same `job.exe` path (the service path compares helper image paths)
    and writes a new manifest.
  - A competitor waiting on the lock now polls until it sees a complete cache. Before, an empty
    manifest seen mid-installation caused a JSON parse crash.
  - An exe whose hash differs from a manifest that changed during the read is treated as a
    concurrent installation, not as tampering.
  - The factory no longer keeps a resolved path that can never recover. Concurrent callers share one
    in-flight verification, and each later call verifies and repairs afresh, so a long-running
    process recovers after a sweep. Per-call cost is the same as before: one manifest read and one
    exe hash.
- `src/harness/command-process.ts`: the unsent result's stderr now names the initialization cause
  (whitespace-collapsed, at most 300 characters) instead of discarding it. This defect took
  instrumentation to find.
- `tests/command-environment.test.ts` (new, skipped off Windows). It compiles its own trivial helper
  source, unique per run, so it never mutates the shared caches other test files use. It covers:
  repair of a cache pruned to its exe; repair of a cache pruned to its manifest; repair of an empty
  manifest; two factories (standing in for two processes) repairing concurrently and ending at one
  verified helper with no stale lock; an altered exe under an intact manifest still refused on every
  call and left in place; and the initialization cause appearing in `runCommandProcess` stderr.
  Against the HEAD `windows-job-executable.ts` (swapped in temporarily, then restored and confirmed
  with `cmp`), 5 of these 6 tests fail.

No timeouts were raised and nothing was masked. Instrumentation was a scratchpad probe script
only, now deleted. No source instrumentation was added.

## Commands run and observed results

- `npx vitest run tests/native.test.ts -t "confines edits"` (before) failed with `expected 'needs_supervisor' to be 'met'`.
- Before, the acceptance set plus `project-metadata-command.test.ts`: `Test Files 7 failed (7)`, `Tests 16 failed | 35 passed (51)`. In the six acceptance files: 11 failed, 33 passed. Failures: native 2, session-recording 1, task-lab-caller 2, project-task-lab-deletion 3, external-task-tools 1, delivery-runtime 2. The other 5 were in project-metadata-command.
- `pnpm typecheck` (tsconfig includes `src` and `tests`) printed `tsc -p tsconfig.json --noEmit` with exit 0.
- After, the six acceptance files: `Test Files 1 failed | 5 passed (6)`, `Tests 1 failed | 42 passed (43)`.
- After, the six acceptance files plus `command-environment.test.ts`: `Tests 1 failed | 48 passed (49)`.
- `npx vitest run tests/project-metadata-command.test.ts tests/command-environment.test.ts` gave `Tests 14 passed (14)`.
- With HEAD `windows-job-executable.ts` swapped in, `npx vitest run tests/command-environment.test.ts` gave `Tests 5 failed | 1 passed (6)` (ENOENT on the manifest forever, and `Unexpected end of JSON input`).
- `npx vitest run tests/delivery-runtime.test.ts` was run twice separately. "mutating false" failed both times and "mutating true" passed both times, so the remaining failure is deterministic.

## Remaining failure (separate cause, not owned)

`tests/delivery-runtime.test.ts > ... (mutating false)` expects `acceptanceStatus: "not_verified"`
and receives `"met"`. Command execution now works in this test: the evidence shows
`node --version: exit 0`. Cause: 4cd1ad2 changed `ClientSupervisionSchema.workflow`'s default
from `"delegated_delivery"` to `"direct_tasks"` (`src/config/schema.ts`; confirmed with
`git show 4cd1ad2^:` versus `4cd1ad2:`). The test's config sets only `client_supervision:{tools:"full"}`,
so `core/service.ts:1071` no longer stamps `deliveryVersion: 2`, and `runners/supervisor.ts:600`
returns `met` for a non-v2 job whose checks pass. This was hidden: after 4cd1ad2, every run of the
test stopped earlier on the broken cache. Likely fix for the supervisor: add
`workflow:"delegated_delivery"` to that test's `client_supervision`, or revisit the default. I edited
neither, since they are outside my ownership.

## Not verified

- The full router suite and `pnpm -r build` were not run. Only the named files were.
- The exact Storage Sense rule that removed `manifest.json` but spared `job.exe` is inferred from
  the observed effect, not from a Storage Sense log.
- Renaming aside the `job.exe` of a live service helper, in the incomplete-cache case only, was not
  exercised. Under the old code that state was already fatal.
- Non-Windows platforms: the new tests are skipped there, and both caches are Windows-only.

## Open questions

- If a process dies while holding it, the `manifest.json.lock` claim stays forever and the cache
  reports "installation is busy" permanently. This is the same class of defect (a state only manual
  cleanup can clear) and was not changed here. Detecting a stale holder needs a design decision.
- Keeping the helper cache in OS temp means a recompile (about 0.3 s per helper, measured) after
  each sweep. That is now harmless. Moving the cache to a non-swept location would be a placement
  decision for the lead.
- Each repair keeps a ~12-15 KB `unverified-*` remnant in the cache directory. The two from this
  session's repair are still in `%TEMP%`.
