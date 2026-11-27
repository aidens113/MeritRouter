# Report: windows_helper_recovery

## Outcome

Done. Windows cache installation recovers from legacy stale lock files and abandoned kernel
mutexes; concurrent installers converge on a verified executable.

## What changed and why

- `packages/router/src/harness/windows-job-executable.ts`: replaced the persistent empty
  `.lock` claim with a Windows named mutex, scoped by the normalized OS-temp cache path.
  The global namespace covers callers in different Windows sessions. An abandoned mutex
  grants ownership after `AbandonedMutexException`; a live owner is allowed ten seconds.
- Node revalidates the cache after acquisition. Only the mutex-owning PowerShell process
  performs installation mutations, after receiving an explicit `install` on stdin. A Node
  crash closes stdin; a PowerShell crash releases its mutex. This avoids an orphan installer
  mutating files after a separate lock guardian dies. A competitor's verified cache wins.
- Legacy `.lock` files are ignored and retained untouched, avoiding unsafe PID/age-based
  unlink recovery races. Existing `unverified-*` retention, fresh candidate compilation,
  hash validation, symlink/junction and hardlink refusal remain in place.
- `packages/router/tests/command-environment.test.ts`: added stale legacy lock recovery,
  genuine abandoned mutex recovery with three competing installers (a second process keeps
  the named object alive while its owner is killed), hardlinked manifest/executable refusal,
  and directory junction refusal. Existing pruning and complete-cache tampering cases pass.

## Commands run and observed results

- `cd packages/router; npx vitest run tests/command-environment.test.ts` (first iteration):
  one file passed, 8 tests passed, duration 10.48s.
- Same command after strengthening abandonment and hardlink coverage: one file passed,
  10 tests passed, duration 4.55s.
- Same command after junction coverage and final fixture cleanup: one file passed,
  11 tests passed, duration 4.97s; test execution 4.517s. Actual Windows execution, no skips.

## Not verified

Full-suite, typecheck and builds are assigned to the lead's serialized aggregate slot and
were not run by this worker. No live providers were used. Concurrent cache installation is
exercised through independent PowerShell installer processes initiated in one Node test
process; cross-Windows-session operation is a design property of the global mutex namespace,
not independently exercised here.

## Open questions or contradictions found

None. Old `.lock` files intentionally remain as inert evidence; the installer never follows
or executes them. All test cache roots are unique OS-temp directories and are cleaned up.
