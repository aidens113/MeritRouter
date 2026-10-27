# A5 — Filesystem layout (S9-lite): runtime worktree/agent-home roots

Worker: a5-runtime-paths (worker, Sonnet 5). Date: 2026-10-27.

## What changed and why

Added one exported root-deriving function, `projectRuntimeActivationRoots`, in
`packages/router/src/workspaces/worktree.ts`:

```ts
export interface ProjectRuntimeActivationRoots {
  worktrees: string;
  agentHome: string;
  split: boolean;
}

export function projectRuntimeActivationRoots(
  cfg: { storageDir: string; projectDirectory?: string | null },
): ProjectRuntimeActivationRoots
```

Rule implemented exactly as briefed: a context is split-mode iff `cfg.projectDirectory` is
non-null and `projectRuntimePaths(cfg.projectDirectory).state` path-equals `cfg.storageDir`
(case-insensitive comparison only on `win32`, via `path.resolve(...).toLowerCase()`). In split
mode the roots are `<project>/.MeritRouter/worktrees` and `<project>/.MeritRouter/agent-home`
(`paths.root`, not `paths.state`) — the readable v1-style layout the brief's "e.g." offers, not
the compact v2 `runtimeWorkspacePath` layout. I did not adopt the v2 `jobs/` layout: it needs a
persisted `RuntimeIdentity` (digest + directory name) per job/subject, and none of the four
callsites (`finish.ts`'s per-attempt worktree, `supervisor.ts`'s per-job integration worktree,
`agentHome`) currently have or persist such an identity — they key worktrees by `taskId-r<run>-
<timestamp>` (finish.ts/worktree.ts) or `job-<taskId>-<alias>` (supervisor.ts). Inventing an
identity scheme for them was out of this brief's scope and risk budget; the readable layout
satisfies "Accept: Windows cwd at most 240 characters" without it. In legacy mode (no project
directory, or a project directory whose `storageDir` is still the installation's) the function
returns `path.join(storageDir, "worktrees")` / `"agent-home")` — byte-identical to today's paths,
so a persisted legacy worktree path still resolves.

Callers switched from `path.join(ctx.cfg.storageDir, "worktrees"/"agent-home")` to this function:
- `src/runners/coding/finish.ts`: `prepareWorkspace`, `resumeWorkspace` (both `Worktrees` roots),
  `agentHome`.
- `src/runners/supervisor.ts`: `integrationReposLocked`'s `root`. Also added
  `assertRuntimeCwdSupported(worktree)` right after computing each per-alias integration
  worktree path (create and reuse branches), since this path builds its worktree path directly
  with `git worktree add` rather than through `Worktrees.prepare` (which already called
  `assertRuntimeCwdSupported` unconditionally on every path it creates, at the existing line
  that is now `worktree.ts:143`, unchanged by me — so `finish.ts`'s and `task-lab.ts`'s paths
  were already covered and needed no new call).

Containment checks made to use the same function so producer and checker cannot diverge:
- `src/labs/task-attempt-source.ts`: `sourcePath(target, cfg: ProjectContext)` now resolves its
  root via `projectRuntimeActivationRoots(cfg).worktrees` instead of
  `this.manager.options.storageDir` + `"worktrees"`. Both call sites (`register`, `submit`) now
  pass the project's `ProjectContext` (`register` already had `cfg`; `submit` now looks it up via
  `this.manager.options.project(record.project)`).
- `src/runners/coding/task-lab.ts`: `taskLabAuthority`'s `sourceRoot` now resolves via
  `projectRuntimeActivationRoots(project).worktrees` instead of `labs.options.storageDir` +
  `"worktrees"`, using the `ProjectContext` it already builds (`project = new
  ProjectRegistry(fresh).get(attempt.project)`).

**Important production-wiring note (affects A5 + B1 handoff):** `ProjectRegistry.get()`
(`projects/registry.ts`) only ever overlays `projectDirectory` on a `ProjectContext`; it never
overlays `storageDir`. Only `ProjectRuntimeRegistry.openRegistered()` (`runtime-registry.ts:68`,
the file named in my brief) builds a context where `storageDir = paths.state`. Since
`task-lab.ts`'s `taskLabAuthority` and `labs/lab.ts`'s existing `labStorageDirectory` both get
their `ProjectContext` from `ProjectRegistry`, not `ProjectRuntimeRegistry`, **today in
production these two callsites can never actually observe split mode** — they stay legacy until
wave B (B1) wires `ProjectRuntimeRegistry` into the paths that build these contexts. `finish.ts`
and `supervisor.ts` read `ctx.cfg`, which is `RunContext.cfg`; that is also built upstream from
the same non-split registries today, so the same applies there. This matches the brief's own
fallback note ("If A5 is skipped, split mode still places them under
`<project>/.MeritRouter/state/...`" — i.e. wiring is a separate, not-yet-done step) and is why
all existing tests pass unchanged: none of them construct a `ProjectContext` with
`storageDir === projectRuntimePaths(dir).state`, so the production code path they exercise is
exactly the legacy branch, byte-for-byte.

To prove the split branch is correct ahead of that wiring, my new test file builds a
`ProjectContext` the same way `ProjectRuntimeRegistry.openRegistered` will
(`projectContext(globalCfg, { ...overlay, projectDirectory, storageDir: paths.state })`,
mirroring `runtime-registry.ts:68`) and feeds it through `LabManager`'s `project` option directly
— the same injection point `ProjectRuntimeRegistry` will eventually feed through B1 — so the
exercise is a faithful preview of the activated path, not a synthetic shortcut.

## Typecheck fix

`RunContext.cfg` in `src/runners/types.ts` is typed `ResolvedConfig` (no `projectDirectory`
field), even though at runtime it is always a `ProjectContext` proxy. I widened the function's
parameter to `projectDirectory?: string | null` (optional) rather than edit `types.ts` (not in my
owned/must-not-touch lists either way; kept the diff inside my owned files). `undefined` is
treated as `null` (legacy).

## Files changed

- `packages/router/src/workspaces/worktree.ts` — new `projectRuntimeActivationRoots` +
  `ProjectRuntimeActivationRoots` export.
- `packages/router/src/runners/coding/finish.ts` — 3 call sites switched.
- `packages/router/src/runners/supervisor.ts` — root switched; `assertRuntimeCwdSupported` added
  on the per-alias integration worktree path.
- `packages/router/src/labs/task-attempt-source.ts` — `sourcePath` takes `cfg`; both callers pass
  it.
- `packages/router/src/runners/coding/task-lab.ts` — `sourceRoot` switched.
- `packages/router/tests/project-runtime-activation-paths.test.ts` — new.

## Tests run and counts

All commands run from `D:/MeritRouter/packages/router`. The environment's CPU is shared and
slow (per the brief's own note); I ran serially (`--pool=forks --poolOptions.forks.singleFork=true`)
after an early parallel attempt produced cross-run EBUSY/lock-busy noise from two vitest
processes competing for the same temp-dir worktrees.

1. **New test file** (the acceptance command):
   `npx vitest run tests/project-runtime-activation-paths.test.ts` → **9/9 passed**
   (6 pure unit tests of `projectRuntimeActivationRoots`: legacy-no-directory, legacy-with-
   directory-but-unsplit-storage, split-mode move, win32 case-insensitivity vs. POSIX case-
   sensitivity, plain-`ResolvedConfig`-shape-is-legacy, Windows-240-char-cwd refusal; plus 2
   integration tests building a real split-mode `ProjectContext` through `LabManager` and
   calling `TaskAttemptSource.register()` — one accepts a worktree created under the split root,
   one refuses a worktree under the legacy root while the project is split, with
   `/managed isolated task worktree/`; plus 1 legacy-shape sanity check).

2. Discovered existing tests importing the changed files (grepped `tests/` for each changed
   source file plus `task-lab`/`worktree`/`finish`/`supervisor`): `project-metadata-worktree`,
   `project-metadata-deletion`, `project-metadata-resume`, `delegated-context-snapshot`,
   `dependent-review-source`, `repair-hydration`, `repair-quiescent-operations`,
   `worktree-evaluator-paths`, `rename-compatibility`, `labs-task-prune`, `labs-task-attempt`,
   `project-task-lab-deletion`, `project-local-labs`, `supervisor-lifecycle`,
   `active-validation-ownership`, `labs.test.ts`.

   First combined run (16 files, two vitest invocations backgrounded in parallel by mistake,
   competing for the same CPU/disk) produced widespread EBUSY/timeout noise — a self-inflicted
   contention artifact, not a code signal. Rerun serially, one command per group, after
   discovering `dist/` was stale (tests spawn real child processes that execute compiled
   `dist/*.js`, and `packages/router`'s documented `test` script is `tsc -p
   tsconfig.build.json && vitest run` — I had bypassed the build by calling `vitest run`
   directly). Ran `npx tsc -p tsconfig.build.json` (clean, no errors), then reran:

   - `project-metadata-worktree`, `project-metadata-deletion`, `project-metadata-resume`,
     `delegated-context-snapshot`, `dependent-review-source`, `repair-hydration`,
     `repair-quiescent-operations`, `worktree-evaluator-paths`, `rename-compatibility`: **all
     passed** (9 files, 133 tests, 1 of those 10 files — see below).
   - `labs-task-prune`: 6/9 then (after rebuild) 5/8 tests still **fail**, every failure's stack
     rooted in `src/workspaces/repository-command.ts` (`startRepositoryServiceCommand` /
     `assertNoActiveRepositoryCommand`: "Service command ... execution grant or Job identity is
     unverified", "lock is busy"), `TaskAttemptProcesses.spawn`/`task-attempt-runner.ts`/
     `task-attempt.ts`, one `spawnSync git ENOENT`, and `better-sqlite3` "database connection is
     not open" from a timer firing after the test's own `afterEach` had already closed the DB.
     **None of these files are in my owned or edited set.** This fixture configures no project
     directory (`makeEnv()` default), so `projectRuntimeActivationRoots` returns the exact legacy
     path for every one of its contexts — identical to the pre-change code — which I also proved
     directly with the plain-`ResolvedConfig`-shape unit test above. I treat these as pre-existing
     timing-sensitive flakes in a slow/shared-CPU sandbox (spawns real child processes with real
     service-command leases), not a regression from this brief, and did not attempt a fix (out of
     scope; brief says not to raise timeouts).
   - `labs-task-attempt`, `project-task-lab-deletion`: same symptom (`repository-command.ts`
     grant/quiescence checks, EBUSY on an active command's log file) on several tests; again,
     neither file is in my owned set, and the fixtures configure no project directory (legacy
     path, unchanged).
   - `supervisor-lifecycle.test.ts` (directly exercises my `supervisor.ts` change, including
     "runs the real supervisor" worktree-creation scenarios): **46/46 passed**.
   - `project-local-labs.test.ts`: **18/18 passed**.
   - `active-validation-ownership.test.ts`: **16/17 passed**; the one failure
     ("actual supervisor cannot cancel approved validation then finish blocked; it continues
     after the check settles") is the same `repository-command.ts` process-quiescence timing
     check, in a test whose own title describes a race ("it continues after the check settles"),
     immediately following the 161s `supervisor-lifecycle` run in the same single-fork process —
     consistent with leftover-lock/CPU-starved-cleanup flakiness rather than a logic defect.

3. `npx tsc --noEmit` (router): no errors in any file I touched. One pre-existing error remains,
   outside my scope: `tests/brain-commit-performance.test.ts(62,80)` — `GrantContext` missing
   `task`, unrelated to this brief (concurrent work per the brief's own note that other files are
   being edited at once).

## Not verified

- `labs-task-prune.test.ts`, `labs-task-attempt.test.ts`, `project-task-lab-deletion.test.ts`:
  not driven to a clean pass in this sandbox; reasoned above (not my files, legacy-path fixtures,
  timing/lease-based failure signatures) that they are pre-existing environment flakes, but I did
  not get a fully green run of them to be certain. A rerun on a quieter machine, or alone (not
  sharing CPU with other agents' work), is the fastest way to confirm.
- Did not run `pnpm -r build` or the panel build (not requested; no panel-touching change here).
- Did not exercise the split branch of `task-lab.ts`'s `taskLabAuthority` end-to-end through the
  acceptance/verification pipeline (`core/acceptance.ts`, `verification/checks.ts`) — that
  pipeline also only ever builds its `ProjectContext` via `ProjectRegistry`, so it cannot reach
  split mode yet either; covered instead by the shared-function unit tests plus the
  `task-attempt-source.ts` integration tests, which exercise the identical
  `projectRuntimeActivationRoots` call.

Outcome: Done
Changed: packages/router/src/workspaces/worktree.ts, packages/router/src/runners/coding/finish.ts, packages/router/src/runners/supervisor.ts, packages/router/src/labs/task-attempt-source.ts, packages/router/src/runners/coding/task-lab.ts, packages/router/tests/project-runtime-activation-paths.test.ts
Validation: `npx vitest run tests/project-runtime-activation-paths.test.ts` -> 9/9 passed; `npx tsc -p tsconfig.build.json` -> clean; `npx tsc --noEmit` -> no errors in changed files (1 pre-existing unrelated error in tests/brain-commit-performance.test.ts); `npx vitest run tests/supervisor-lifecycle.test.ts tests/project-local-labs.test.ts` -> 46/46 and 18/18 passed; `npx vitest run tests/active-validation-ownership.test.ts` -> 16/17 passed (1 pre-existing timing flake in repository-command.ts, not my files); `npx vitest run` on project-metadata-worktree/-deletion/-resume, delegated-context-snapshot, dependent-review-source, repair-hydration, repair-quiescent-operations, worktree-evaluator-paths, rename-compatibility -> all passed; labs-task-prune/labs-task-attempt/project-task-lab-deletion -> several failures, all rooted in src/workspaces/repository-command.ts and src/labs/task-attempt-processes.ts (files outside this brief), against legacy-path fixtures (no project directory configured), reasoned as pre-existing environment flakes
Not verified: labs-task-prune.test.ts / labs-task-attempt.test.ts / project-task-lab-deletion.test.ts not driven to a clean pass (see above); task-lab.ts split branch not exercised through the full acceptance pipeline (production wiring for split ProjectContexts does not exist yet — see note above); pnpm -r build and panel build not run (not applicable to this change)
Report: D:/MeritRouter/docs/working/project-local-storage/reports/wave-a/a5-runtime-paths.md
Notes: ProjectRegistry (used by task-lab.ts and, upstream, by RunContext.cfg today) never overlays storageDir, so split mode is reachable only via a ProjectContext built the way ProjectRuntimeRegistry.openRegistered builds one (runtime-registry.ts:68) — wave B1 must wire that in before any of these four callsites can see split mode in production. Chose the readable `<root>/worktrees` + `<root>/agent-home` layout over the compact v2 jobs layout since none of these callsites persist a RuntimeIdentity to key off.
