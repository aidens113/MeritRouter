# Report: r1-ops

Worker: r1-ops. Worktree `D:/sy-wt/r1` (branch `feat/r1-ops`). Nothing committed.

## Outcome

Partial. All four deliverables are implemented and tested, and typecheck and the full router suite
pass. Two things outside my ownership stop R1 from working end to end. Both are one-line fixes
(see Open questions):
1. `storage.durability` is parsed and `openDatabase` honours it, but `Switchyard` (`src/core/service.ts`,
   owned by s2-exec) does not pass it yet.
2. A pre-existing defect: `switchyard worker` exits by itself (code 0) about 0.4 s after it starts
   when nothing else keeps the event loop alive. Under the daemon it therefore "crashes" right away
   and the daemon gives up after `maxRestarts`. I saw this live.

## What changed and why

- `packages/router/src/config/schema.ts` (storage section only): `storage.durability: normal | full`,
  default `normal`.
- `packages/router/src/storage/db.ts`: `openDatabase(dir, { readonly?, durability? })`, a new
  `applyDurability(db, level)` (`synchronous=NORMAL|FULL`), a new `Durability` type, and
  `SCHEMA_VERSION = MIGRATIONS.length`. The default behaviour is unchanged.
- `packages/router/src/operations/backup.ts` (new):
  - `backupStorage({storageDir, targetDir, includeMasterKey?})`:
    - Takes a better-sqlite3 `db.backup()` snapshot over a plain connection, so the source is
      never migrated.
    - Switches the snapshot to `journal_mode=DELETE` so it is one self-contained file, and runs
      `quick_check` on it.
    - Copies the session logs after the snapshot. A torn last line is trimmed so a log is never
      behind its index. Artifacts are copied after that.
    - Records in the manifest any indexed file it could not find.
    - Writes `manifest.json` last and fsyncs it.
    - Refuses a non-empty target and a target inside the storage directory.
    - Never copies worktrees, agent-home, qualification, or logs. The vault `.master-key` is copied
      only with `--include-master-key`.
  - `restoreStorage({backupDir, storageDir, force?})` refuses in these cases:
    - an incomplete backup (no manifest) or a backup whose schema is newer than this build;
    - a live daemon lock on the target;
    - any task in the target with an unexpired lease (`running`/`cancel_requested`);
    - existing state when `--force` is not given.

    With `--force` it moves the db, `-wal`/`-shm`, `sessions/`, and `artifacts/` to
    `<storage>/pre-restore-<time>/`, and rolls that move back if a file is busy. It then copies the
    backup in, migrates it through `openDatabase`, and sets `lease_expires_at=0` on tasks that were
    running at backup time, so the next worker's `recover()` picks them up straight away.
  - `liveLeases(storageDir)` and `readBackupManifest(dir)`, both zod-validated.
- `packages/router/src/operations/daemon.ts` (new):
  - `RestartPolicy`, pure and zod-validated: exponential backoff (initial 1 s, x2, ceiling 60 s),
    at most `maxRestarts` (5) per `windowMs` (10 min), and a reset after a run of at least
    `stableAfterMs` (60 s).
  - `Daemon` takes an injected `spawn`, `now`, and `sleep`. It writes `<storage>/logs/daemon.log`
    and `worker.log`, rotating each at 10 MB.
  - `stop()` sends SIGTERM, then SIGKILL once the grace period has passed. A stop during a backoff
    wait ends the daemon immediately.
  - On give-up the daemon exits 1, so the service manager's own restart policy applies.
  - `acquireDaemonLock` / `readDaemonLock` keep one daemon per storage directory (`logs/daemon.pid`)
    and replace a stale lock.
- `packages/router/src/operations/service.ts` (new): `servicePlan(spec)` is pure data (the
  definition file plus install, uninstall, and status steps) for:
  - systemd user unit: `Restart=on-failure`, `StartLimitBurst`, quoted `ExecStart` with `%`
    escaped;
  - launchd agent: `KeepAlive.SuccessfulExit=false`, `bootstrap gui/<uid>`;
  - Windows Task Scheduler XML: UTF-16LE with BOM, `LogonTrigger` for the current user,
    `LeastPrivilege`/`InteractiveToken` so no administrator rights are needed,
    `RestartOnFailure PT1M x999`, `ExecutionTimeLimit PT0S`, and MSVC-quoted arguments; registered
    with `schtasks /Create /XML`, then `/Run`.

  `describeServiceSteps` prints the dry run. `runServiceSteps(plan, action, io)` takes injected io
  and stops at the first step that fails, unless that step's failure is marked tolerated.
- `packages/router/src/cli.ts` (new commands only):
  - New commands `backup <dir> [--include-master-key]`, `restore <dir> [--force]`,
    `daemon [--max-restarts n] [--window s] [--max-delay s]`, and
    `service install|uninstall|status [--name n] [--dry-run]`.
  - These commands are handled after `loadConfig` and before any `Switchyard` is constructed. A
    restore must not hold the database open, and the daemon's worker runs in a child process.
  - Added help text and flags.
  - The daemon child is started as `process.execPath [...execArgv, dist/cli.js, worker, --config <abs>]`.
- `packages/router/tests/operations.test.ts` (new): 23 tests.
  - Durability: config default, `full`, and rejection of other values; the `synchronous` pragma is
    1 for normal and 2 for full.
  - Backup/restore round trip while a worker is open: after restore, the task status and result,
    artifact content, and session ids match, and session logs read with no corrupt lines, an event
    count equal to `last_seq`, and `ended` last.
  - Torn-line trim, target refusals, and master key handled only on request.
  - Live-lease refusal (even with `--force`), refusal without `--force`, `--force` moving state
    aside, release of running leases, incomplete backup, and newer schema.
  - Restart policy: backoff, ceiling, window, reset, and invalid config.
  - Daemon with a fake child: give-up with the backoff sequence and log lines, spawn error, stop,
    SIGKILL after grace, stop during backoff, lock, and restore refused while a daemon is live.
  - Service plans for all three platforms, an unsafe name, and step execution through fake io.

## Commands run and observed results

- `pnpm -r typecheck` (from `D:/sy-wt/r1`): router Done, panel Done.
- `cd packages/router && npx vitest run tests`: `Test Files 17 passed (17)`, `Tests 145 passed (145)`.
- `npx vitest run tests/operations.test.ts`: 23 passed.
- `npx tsc -p tsconfig.build.json`, then a CLI smoke test in a scratch directory (deleted afterwards):
  - `init --preset standalone-free` followed by `status`: exit 0.
  - `backup bk1`: exit 0, schema 8, master-key notice printed.
  - `restore bk1`: refused with "pass --force", exit 1.
  - `restore bk1 --force`: exit 0, previous state moved to `pre-restore-...`.
  - `service install --dry-run`: printed the Windows XML and the schtasks steps, exit 0.
  - `service bogus`: usage error, exit 1.
- Real `Daemon` with the default spawn running the built CLI worker:
  - The worker exited with code 0 after about 390 ms. The daemon logged a restart after 1000 ms,
    then 2000 ms, which shows the backoff live.
  - `stop()` terminated the third worker with SIGTERM, and `process.kill(pid, 0)` afterwards
    confirmed it was gone.
  - `worker.log` captured the worker's stdout.
- `timeout 6 node dist/cli.js worker < /dev/null` printed "running" and exited 0 on its own, before
  the timeout. This confirms defect 2 independently of the daemon.
- The generated task XML, written through `systemServiceIo`, parses with .NET `XmlDocument`. It
  starts with the bytes `255,254` (UTF-16LE BOM), and `Arguments` reads `"C:\x y\cli.js" daemon --config ...`.

## Not verified

- No service was installed anywhere: `schtasks /Create`, `systemctl --user`, and `launchctl` were
  never run. That the XML, unit, and plist are accepted is inferred from their documented formats,
  not observed. In particular, I have not confirmed that `schtasks /XML` accepts a task with a
  LogonTrigger from a non-admin account.
- Linux and macOS were not run at all; only the plan text is tested.
- A real kill-and-restart that resumes sessions (the R1 acceptance) was not run. It depends on S2
  and on defect 2.
- `storage.durability: full` has no effect through `Switchyard` until `service.ts` passes it.
- The progress watchdog (stuck agents) is part of Phase R1 in the plan, but this brief did not list
  it, and it was not implemented.

## Open questions or contradictions found

1. **Durability wiring (one line in `src/core/service.ts`, owned by s2-exec):**
   `this.db = openDatabase(cfg.storageDir, { durability: cfg.storage.durability });`.
   A reload cannot change durability: it is per-connection, and the setting is applied only at
   open. Restart to change it.
2. **`switchyard worker` does not stay alive (pre-existing; `cli.ts` `worker` case, outside "new
   commands only"):**
   - Cause: the scheduler, reload, and scan timers are all `unref()`'d, and
     `process.once("SIGINT"/"SIGTERM")` listeners do not hold the event loop, so the process drains
     and exits 0.
   - Suggested fix in the `worker` case: create a ref'd keep-alive before awaiting the signals and
     clear it once they arrive, e.g.
     `const keep = setInterval(() => undefined, 1 << 30); try { await ... } finally { clearInterval(keep); }`.
     The `submit --wait` path is unaffected because its await loop keeps the process alive.
3. **Orphaned worker on Windows:**
   - The daemon cannot stop its child cleanly when the daemon is hard-killed, for example by
     `schtasks /End`, Task Manager, or a crash. A Windows child process outlives its parent, so the
     worker keeps running.
   - Two workers sharing the queue is safe, because leases prevent double execution, but it is
     wasteful. systemd (`KillMode=control-group`) and launchd (which kills the process group) clean
     up on their own.
   - Suggested follow-up, also in the `worker` case: an opt-in parent watch, where the daemon
     passes a pipe on stdin and the worker exits when stdin closes.
   - Related: on Windows, `child.kill("SIGTERM")` terminates the process without letting it clean
     up. Recovery then relies on lease expiry and S2.
4. **Visible console window on Windows:** the scheduled task runs `node.exe` with an interactive
   token, so a console window will probably appear at logon. This is not verified. Hiding it would
   need a wrapper (for example `conhost --headless` or a `.vbs` launcher). Left for a decision.
5. **Master key policy:** it is excluded by default because it would let anyone holding the backup
   decrypt the paid keys. Without it, after a restore on a new machine the paid keys need
   `SWITCHYARD_MASTER_KEY` or the original `.master-key`. Restore copies a key from the backup only
   when the target has none.
6. Documentation (`docs/operations.md`, `docs/setup.md`) is not updated, because the brief did not
   assign it. The new CLI commands, `storage.durability`, and the logs directory need documenting
   under the repository's documentation rule.
