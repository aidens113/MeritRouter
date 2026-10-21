# Report: j3-ops-docs (projects plan, phase J3)

Worker report for the brief "j3-ops-docs" in [projects.md](../../projects.md). Worktree
`D:/sy-wt/pj`, branch `feat/projects`. Nothing committed. j2-followups worked in the same
checkout at the same time; I edited none of its paths, nor `src/core/service.ts` or
`src/index.ts` (no exports were needed).

## Outcome

Done.
- **Daemon.** One daemon per install runs one worker for every project. `daemon start`,
  `daemon status`, and `daemon stop` are new. Status reports queued and running tasks per
  project. `daemon` and `service` refuse `--project`, and so do `backup` and `restore`.
- **Backup and restore.** A backup now carries the brain repository as a git bundle (backup
  format 2), and a restore brings it back. A restore over a brain with uncommitted changes is
  refused, even with `--force`, before anything changes. Brain mounts are listed in the manifest
  as not included.
- **Docs.** `setup.md`, `operations.md`, `roles.md`, `decisions.md`, and `README.md` describe
  projects as built.
- **Checks.** Typecheck and build pass for both packages. The full suite passes: 477 tests.
- **Manual run.** The built CLI ran by hand in temp dirs, and the dirs were deleted afterwards.

## What changed and why

Code (`packages/router`):

| File | Change |
| --- | --- |
| `src/operations/brain-backup.ts` (new) | Brain half of a backup. `brainPathOf(cfg)` resolves the brain path as `Brain` does. `brainMountsOf(cfg)` lists global mounts and each project's own (the tail of the project overlay after the global ones). `backupBrain` runs `git bundle create --all` plus `bundle verify`, records head, commit, commit count, and uncommitted paths (the brain lock file is ignored), or "not included" with a reason (no repository, not a git repository, no commits). `planBrainRestore` refuses, before anything changes, a dirty brain (always) or an occupied brain without `force`; it returns `skip`, `same`, `create`, or `replace`. `restoreBrain` moves a replaced brain to `<brain>.pre-restore-<time>`, then does `git init -b <head>`, sets `core.autocrlf false`, runs `fetch --update-head-ok <bundle> +refs/*:refs/*`, sets `symbolic-ref`, does `reset --hard <commit>`, and checks that HEAD equals the backup's commit. Git calls are synchronous (`execFileSync`), so `restoreStorage` stays synchronous. |
| `src/operations/backup.ts` | `BACKUP_FORMAT` is 2; the manifest accepts format 1 or 2. New optional `brain` manifest section (`BrainManifestSchema`, nullable). `BackupOptions` gains `brainPath` and `brainMounts`; `RestoreOptions` gains `brainPath`. The brain plan is decided after the storage checks and before any storage entry moves. `RestoreResult.brain` is new. |
| `src/operations/daemon.ts` | `DAEMON_STOP` (`<logs>/daemon.stop`), `DAEMON_OUT` (`<logs>/daemon.out`). `Daemon.run()` polls for the stop file (`stopPollMs`, default 500; 0 turns it off), removes a stale one at start, and calls `stop()`. New `requestDaemonStop(logsDir)` and `processAlive(pid)`. The header says one daemon per install serves every project. |
| `src/operations/daemon-status.ts` (new) | `daemonStatus(cfg)`: the daemon lock, plus per project `{project, name, configured, archived, queued, running}` and totals. It reads the store read-only and never opens a Switchyard. Configured projects come first, in config order; then any other `project_id` with work, such as `_qualification` or a removed project. Rows with `''` count toward the primary project. "Queued" and "running" are the same state sets as `admin/projects.ts`, duplicated so that operations does not import admin. |
| `src/cli/operations.ts` | `--project` is refused for `backup`, `restore`, `daemon`, and `service`, with a reason. The daemon's worker env drops `SWITCHYARD_PROJECT`. `daemon [run]` is unchanged in behaviour and prints the project list. `daemon start`, `status`, and `stop` are new (contract below). `backup` and `restore` pass the brain path and mounts and print the brain lines. `service install` adds a note that one daemon serves every project. |
| `src/cli/help.ts` (**outside the listed owned paths**) | Only the Operations block: brain bundle, dirty-brain refusal, `daemon start\|status\|stop`, and "--project is refused here". No other worker owns this file, and the help would otherwise have been wrong. |
| `tests/projects-operations.test.ts` (new, 3 tests) | See below. |
| `tests/operations.test.ts` (existing) | One expectation: `format: 1` became `format: 2, brain: null`. A backup without `brainPath` records `brain: null`. |

Docs:

| File | Sections |
| --- | --- |
| `docs/setup.md` | §2: `init --project/--name/--repo`. New "### Projects": config shape and slug rule; the panel (grid cards, New project at `/new`, switcher, `/p/<slug>` vs `/all`, old URL redirects); the CLI (`projects` commands, `--project` and selection order, `SWITCHYARD_PROJECT`, which commands need, list, or ignore a project, operations refusing `--project`); upgrading a single-project config. §3b: `projects.<slug>.repositories`, brain path and mounts. §4: MCP `--project`, its selection order, fail-fast and why, `--no-worker`, and `daemon start/status/stop` with one daemon per install. §5b: `run --project`. §6: panel structure. |
| `docs/operations.md` | Limits table: three rows (namespaced repo keys, fairness and the project cap, project paid cap and share). New "## Projects: fairness and limits" (`priority`, `max_concurrent_tasks` and `waiting_for_project_cap`, `paid_budgets` and `project_paid_budget_exhausted`, `request_share` and `project_allocation_exhausted`) with "### Archiving a project" and "### The reserved `_qualification` project". New "## Backup and restore" (it replaces the Housekeeping bullet) and "## One daemon for every project". Brain bullet: one repository, project scope. Known limitations: `--no-worker`, and install-unique idempotency keys. Panel links now `/all/calibration`, `/p/<slug>/teams`, `/p/<slug>/sessions`. |
| `docs/roles.md` | Roles table: the supervisor reads its project plus `global/` and writes `global/` only through a promotion. Brain tree: indexes, `decisions/lessons/`, `promotions/`. New "### Project isolation (D4)": per-role reads and writes table, cross-project requests, system-managed paths, search, panel. New "### Global knowledge (D9)": supervisor-only; the deterministic check with strict alias matching; the source rules and limits; the reviewer (free, never the supervisor's endpoints, model, or families, rubric `global-lesson-rubric-1`, 4 requests, no paid); the statuses pending_review, pending_approval, approved, rejected, reverted; `brain.global_requires_approval`; `/all/knowledge`; revert; the project Promotions tab. Mounts per project. Panel links `/all/routing`. |
| `docs/decisions.md` | New "## Projects (user decision, 2026-10-20)" with D1-D9. New "### Departures recorded during the build": bare task-keyed `repo_alias` columns; install-unique idempotency keys; `/all` for the global section; `_qualification`; MCP fail-fast; the `default` legacy slug; the archive flag kept in the store; one daemon; the brain in backups. Item 21 in "Departures from the plan". |
| `README.md` | A "Many projects, one install" bullet; brain isolation and gated global knowledge in the brain bullet; the panel bullet; the quick-start `init --project`; the operations.md row. |

Grep sweep for single-project wording: the only stale panel references were "the panel's
Calibration/Teams/Sessions/Jobs page" and "(panel: Routing)". They now point at `/all/...` or
`/p/<slug>/...`. No doc still presents top-level `repositories` or `brain.project` as the way to
configure a new install. "Local, single user" in setup.md refers to users and stays.

## CLI contract changes

- `switchyard backup|restore|daemon|service ... --project <x>`: exit 1, with
  `switchyard <cmd> does not take --project: <why>`. `SWITCHYARD_PROJECT` is not refused (the
  operations dispatch runs before project selection); the daemon removes it from its worker's
  environment.
- `switchyard daemon` and `daemon run [--max-restarts n] [--window s] [--max-delay s]`: the
  foreground daemon, as before. The installed service still runs `daemon --config <file>`.
- `switchyard daemon start [policy flags]`:
  - It refuses (conflict) when a daemon is alive.
  - It spawns `node cli.js daemon run --config <file>` detached, with stdout and stderr appended
    to `<storage>/logs/daemon.out`.
  - It waits up to 20 s for the lock to name the child's pid, then prints the pid. Otherwise it
    exits 1 with the tail of `daemon.out`.
  - `--json` gives `{started, pid, logsDir, output}`.
- `switchyard daemon status [--json]`:
  - Text: the lock line (`daemon pid N running since T; config C`, or `no daemon is running for
    <storage>`), a table `project | name | archived | queued | running`, and the totals.
  - JSON: `DaemonStatus {storageDir, configPath, daemon, projects[], totals}`.
  - Exit 0 either way.
- `switchyard daemon stop [--timeout s] [--json]`:
  - It writes the stop file and waits up to `--timeout` (default 45 s) for the pid to exit.
  - When it does, the command prints `daemon N stopped`.
  - Otherwise it ends the process tree (`taskkill /T /F` on Windows, `SIGTERM` elsewhere) and
    says so.
  - When no daemon runs, it prints that and exits 0.
- `backup` text gains these lines:
  - the brain line: commit count, branch, short commit, bundle;
  - a WARNING for uncommitted brain changes;
  - one line per brain mount that is not included.

  JSON is the manifest, now with `brain`.
- `restore` text gains `brain: <detail>`, the path of a moved-aside brain, and the mounts that
  were not restored. JSON gains `brain`.
- `--force` on `restore` now also allows replacing a clean brain that has other history. It
  never allows replacing a dirty one.

## Commands run and observed results

- `npx tsc --noEmit -p .` (router): clean after each edit. The first run found one null-check
  error in my file, which I fixed.
- `npx vitest run tests/operations.test.ts`: first 1 failed (the `format: 1` expectation), then
  "Tests 23 passed (23)" after the update.
- `npm run build`, then `npx vitest run tests/projects-operations.test.ts`: "Tests 3 passed (3)"
  on the first run (12.1 s; the daemon test took 7.4 s).
- **Mutation checks.** Each file was restored from a copy, and grep confirmed the marker was
  gone.
  - With the dirty-brain refusal disabled, the "uncommitted" test failed.
  - With the `--project` refusal disabled and dist rebuilt, the daemon test failed (`expected +0
    not to be +0`, the refused start exited 0). Its cleanup ended that daemon. A process listing
    afterwards showed no `cli.js` processes of mine.
  - After restoring and rebuilding, `tests/projects-operations.test.ts` and
    `tests/operations.test.ts` gave "Tests 26 passed (26)", and dist contains the refusal string.
- `pnpm -r typecheck`: "packages/router typecheck: Done", "apps/panel typecheck: Done".
- `pnpm -r build`: "packages/router build: Done", "apps/panel build: Done". This ran with
  j2-followups' edits in the tree.
- `cd packages/router && timeout 590 npx vitest run`: "Test Files 50 passed (50)", "Tests 477
  passed (477)". That is the 468 baseline, my 3, and j2-followups' new tests. No timing test
  flaked.
- `git diff --check` on my files: clean. A CRLF count on every file I touched: 0.

New tests (`tests/projects-operations.test.ts`, temp dirs and temp brains, databases closed
before deletion):

1. **One daemon for every project.** This test needs `dist/cli.js` and is skipped without it.
   - A fake OpenAI-compatible HTTP provider serves both projects, through a custom provider
     with a `base_url`.
   - Two summarize tasks go to alpha and two to beta, from a non-worker Switchyard, which is
     then closed.
   - `daemon start --project alpha` is refused with "does not take --project: the daemon is
     install-wide", and no lock is written.
   - `daemon status --json` with no daemon gives `daemon: null`, alpha 2/0, and beta 2/0.
   - `daemon start` prints "one worker for every project (alpha, beta)", and the lock is alive.
     A second start is refused ("already running").
   - All 4 tasks complete, in projects alpha, alpha, beta, beta.
   - Status then shows the daemon's pid, alive, with totals 0/0. The text form has "one worker
     serves every project" and an `alpha  Alpha` row.
   - `daemon stop` prints "daemon <pid> stopped". The pid is gone and the lock is removed.
   - `daemon.log` has exactly one "worker started" and a "stop requested". `worker.log` has
     exactly one "worker ... running".
2. **Round trip with commits from two projects.** People write brain documents through
   `brainWrite` in alpha and beta, and the backup runs online with the store open.
   - Manifest: format 2, tasks 2, brain `{included, bundle, head: main, commit: HEAD,
     uncommitted: []}`, and commits equal to `rev-list --count --all`.
   - `mountsNotIncluded` is exactly the global mount (project null) and beta's own mount.
   - A restore into a second install with no brain gives action `create`. HEAD, the branch, the
     full `git log` subjects, and both files' bytes match, and `git status` is clean.
   - A Switchyard opened on the restored install lists 1 task per project and reads beta's
     document through `brainRead`.
   - A second restore with `--force` gives brain action `same`.
3. **Refused over a dirty brain.** The target brain has a commit, an uncommitted edit, and a
   brain lock file.
   - The restore is refused with and without `--force` ("1 uncommitted change(s) (notes.md)",
     so the lock file was not counted).
   - No database was written, and the edit is intact.
   - After a commit, a restore without `--force` is refused ("pass --force"). With `--force`
     the brain is replaced, the old one is at `.pre-restore-*` with the edit, and HEAD is the
     backup's commit.

**Manual CLI run.** Built CLI, in `scratchpad/j3manual/{one,two}`. `SWITCHYARD_CONFIG` and
`SWITCHYARD_PROJECT` were unset. `brain.path` was edited to `./brain` right after `init`; a grep
confirmed no other `~/` path in the config.

1. `init . --project a --repo app=repo-a`: "wrote …switchyard.config.yaml (first project: a)",
   then models.yaml.
2. `projects create b --repo app=repo-b`: "created project b (1 repository) …".
3. `projects`: a table with rows `a My project app` and `b b app`.
4. `submit - --project a` and `--project b` (one summarize task each): both queued.
5. `daemon status`: "no daemon is running for …", then rows a 1/0 and b 1/0, "total: 2 queued,
   0 running".
6. `daemon start --project a`: "switchyard: switchyard daemon does not take --project: the
   daemon is install-wide: …", exit 1.
7. `daemon start`: "daemon 24428 started in the background: one worker for every project (a,
   b); logs in …", exit 0.
8. `daemon status`, twice (3 s apart): "daemon pid 24428 running since 2026-10-21T06:04:12.403Z;
   config …", then a 0/0 and b 0/0. Both tasks had failed: this environment has no provider
   keys, and `status` showed `failed`, 0/8 requests.
9. `daemon stop`: "daemon 24428 stopped", exit 0.
10. `daemon status`: "no daemon is running …".
11. The logs:
    - `daemon.log`: "daemon 24428 started: … cli.js worker --config …", "worker started (pid
      25268, start 1)", "stop requested (daemon stop)", "stopping worker", "daemon stopped".
    - `worker.log`: one "worker … running".
    - `daemon.out`: the run banner, then "daemon stopped: stop requested".
    - Neither pid was alive afterwards.
12. `git -C brain log --oneline`: 3 commits: "Report t_…" and "Initialise brain" twice.
13. `backup ../backup1`: "schema 19; 2 task(s), 2 session(s) with 2 log(s), 2 artifact(s)",
    then "brain …\one\brain: 3 commit(s), main at 97d3f1e0c2f2 (bundle brain.bundle)", exit 0.
    The manifest has `format: 2`, `brain.included: true`, `head: main`, `commits: 3`, and empty
    `uncommitted` and `mountsNotIncluded`.
14. `backup ../backup1b --project a`: refused, exit 1.
15. Copied the config and models.yaml into `two/`. `restore ../backup1`: "restored … into
    …\two\.switchyard; schema 19", then "brain: restored the brain (3 commit(s), main at
    97d3f1e0c2f2) into …\two\brain", exit 0.
16. In `two/`: `git log` shows the same 3 commits and `git status` is clean. `projects` lists a
    and b (repositories "missing", as expected in the copy). `status` lists both tasks in
    their projects.
17. After appending to `two/brain/README.md`, `restore ../backup1 --force`: "refusing to
    restore: the brain at …\two\brain has 1 uncommitted change(s) (README.md); commit or
    discard them first …", exit 1.
18. `rm -rf scratchpad/j3manual`. A process listing found no node process with `j3manual` in
    its command line.

## Not verified

- **The service manager.** `service install` was not run against systemd, launchd, or Task
  Scheduler; only the note text changed, and that output was not run.
- **`daemon stop` against an unresponsive daemon.** The forced-kill path, after the 45 s wait,
  was never exercised.
- **POSIX.** `daemon start` with the detached child was exercised on Windows only.
- **Live providers.** No live provider: the manual run's tasks failed for lack of keys, and the
  daemon test used a fake HTTP provider.
- **Restore edge cases.** A bundle from a brain with a detached HEAD, a brain at the "same"
  commit on a different branch, and a brain with several branches were not tested. All refs are
  fetched, but only HEAD's branch is checked out.
- **A brain path that is not a git repository** (`brain.commit` off and never initialised). The
  backup records "not included" with a reason, but this path has no test.
- **A brain in use during a restore.** The `.pre-restore` rename of a brain that an editor or
  the panel holds open on Windows can fail. The command says so, but that is not exercised. The
  store has by then been restored, because the brain step runs after it, so a failure there
  leaves the new store with the old brain.
- **The FTS index after a restore.** The brain search index in the restored database refers to
  the restored brain's files. I did not check whether it is refreshed before the next search; it
  is refreshed on the next search through the panel or CLI.
- **The panel was not started.** I changed no panel files. The docs' panel descriptions come
  from the j2 reports and a read of the current `app/p/[slug]/layout.tsx`, `lib/legacy.ts`, and
  `lib/qualification.ts`, which j2-followups was still editing.

## Open questions or contradictions found

1. **`help.ts` was outside my owned list.** I edited only its Operations block; no one else owns
   the file.
2. **j2-followups changed behaviour I document.** It landed during my run: an archived
   project's Settings page renders read-only with Unarchive, and `_qualification` work is viewed
   under `/all/qualification`, with old item URLs redirecting there. I updated
   `docs/operations.md` to match the code I read at the end. If j2-followups changes those
   again, recheck "Archiving a project" and "The reserved `_qualification` project".
3. **`init --project a` without `--name` keeps the preset's name "My project".** The project is
   `a`, but its display name is "My project". `initConfigText` renames the key but keeps the
   preset's `name`. That looks unintended (it is j1-surfaces' code, not mine); the fix would be
   to default the name to the slug when `--name` is absent.
4. **Example config and presets.** `examples/switchyard.config.example.yaml` (and the generated
   presets) still do not show the fairness fields (`priority`, `max_concurrent_tasks`,
   `paid_budgets`, `request_share`). They are documented in operations.md and the project
   settings page; the example is not in my owned paths.
5. **Restore is not atomic across the store and the brain.** All refusals happen before
   anything changes. A git failure during the brain step itself (after the store is restored)
   leaves the store restored and the brain unrestored, with an error.
