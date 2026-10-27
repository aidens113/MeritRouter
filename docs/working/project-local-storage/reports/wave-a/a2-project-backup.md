# A2: project backup and restore

Worker report. Scope: `src/operations/backup.ts` (edited), new `src/operations/project-backup.ts`,
new `tests/project-backup.test.ts`. No other files touched; no git mutations.

## API

```ts
backupProjectStore(coordinationDb: Db, {
  projectId?: string; slug?: string;  // exactly one required
  targetDir: string;
  includeMasterKey?: boolean;         // accepted for symmetry; project stores have no vault, always false in the manifest
}): Promise<ProjectBackupManifest>

restoreProjectStore(coordinationDb: Db, {
  backupDir: string;
  force?: boolean;
  now?: number;
}): ProjectRestoreResult
```

Both option objects are zod-validated (`.strict()`). `backupProjectStore` resolves the project
by `projectId` or `slug` through `readProjectStoreRegistration`/a `slug` lookup query on
`project_store_registrations`, which already enforces (inside `store-identity.ts`) that
`coordinationDb` is a bound, full-durability coordination store and that the registration belongs
to this same installation. `restoreProjectStore` takes **no** project selector: the target project
directory is read only from the backup manifest's identity, resolved against the **current**
registration for that `projectId` — never from a path stored in the backup, and never from a
caller-supplied slug/dir that could point restore somewhere else.

## Manifest shape (`manifest.json`, `PROJECT_BACKUP_FORMAT = 1`)

```ts
{
  format: 1,
  createdAt: string,                 // ISO
  identity: { installationId, projectId, slug, storeId, generation },
  sourceProjectDirectory: string,
  schemaVersion: number,
  tasks, sessions, artifacts, sessionLogs, artifactFiles: number,
  includesMasterKey: false,
  missing: string[],                 // indexed session logs / artifact files the copy could not find
  brain: BrainManifest | null,        // reused from brain-backup.ts, unmodified
  digests: { db: sha256hex, projectManifest: sha256hex | null },
}
```

Backup contents written to `targetDir`: `meritrouter.db` (SQLite online-backup snapshot of
`<project>/.MeritRouter/state`), `sessions/`, `artifacts/`, `project.json` (copy of the project's
manifest file), `brain.bundle` (via the existing `backupBrain`, no mounts passed — a project's own
brain folder only, never another project's or the global mounts), and `manifest.json`.

Before the online backup even starts, the snapshot's own `store_identity` row is read back and
checked against the registration (role `project`, matching `projectId`/`storeId`/`generation`/
`slug`); a mismatch throws `internal` rather than producing a manifest that lies about what it
backed up.

`restoreProjectStore` re-verifies the snapshot and `project.json` against the manifest's
`digests` before touching anything, in addition to the existing SQLite `quick_check` performed at
backup time.

## Refusal matrix

| Condition | Where | Error substring |
| --- | --- | --- |
| Neither/both of `projectId`/`slug` given | backup | zod (`Exactly one of...`) |
| No registration for the id/slug | backup/restore | `not_found` |
| Registration not `registered` (migrating/retired) | backup/restore | `conflict`, `"... is {state}, not registered"` |
| `targetDir` inside the project's own `.MeritRouter` | backup | `"own runtime directory"` |
| `targetDir` inside the installation storage directory (`path.dirname(coordinationDb.name)`) | backup | `"installation storage directory"` |
| `targetDir` not empty | backup | `"not empty"` (zod/fs, same pattern as `backupStorage`) |
| No project database at `<state>/meritrouter.db` | backup | `not_found` |
| Backup snapshot/`project.json` digest mismatch | restore | `"failed its digest check"` |
| Backup schema newer than this build | restore | `"newer than this build"` |
| Current registration missing | restore | `not_found` |
| Current registration's `installationId`/`storeId`/`generation`/`slug` differs from the backup's `identity` (also catches "another installation": `readProjectStoreRegistration` itself throws if the registration belongs to a different installation than `coordinationDb`'s own) | restore | `conflict`, message includes `"generation"` and both sides' values |
| Current registration not `registered` | restore | `conflict`, `"not registered"` |
| Live task lease in the project's own store (`liveLeases`, reused unmodified from `backup.ts`) | restore | `"live leases"` |
| Live `project_execution_claims` row (`phase != 'terminal'`) — new `liveExecutionClaims` export | restore | `"execution claim"` |
| Existing `.MeritRouter/{state,sessions,artifacts,project.json}` content without `force` | restore | `"pass --force"` |
| Brain at the project's brain path has uncommitted changes, or is occupied without `force` | restore | delegated unmodified to `planBrainRestore` (`brain-backup.ts`) |

Restore stages everything (db copy + migration/role check, sessions, artifacts, `project.json`,
staged brain) in a temp directory under the project's own `.MeritRouter` root before any existing
entry moves; on any failure, installed entries are rolled back and moved-aside entries are
restored, mirroring `restoreStorage`'s pattern exactly. The staged database is opened with
`openDatabase(..., { durability: "full" })`, has stale leases expired, and is checked with
`assertStoreRole` against the expected project identity before the swap — so a corrupt or
foreign-identity backup is caught before anything in the live project directory moves.

## Installation-backup guard (`backup.ts`)

`backupStorage` now reads the snapshot's `store_identity` row. When the role is `coordination`,
the manifest gets a new optional field `installationRole: "coordination" | null`, and the function
refuses (throws `usage`) if the coordination store's own `tasks`/`sessions`/`artifacts` tables
hold any rows — the defensive invariant that a true coordination store never carries a project's
private rows (those live only in that project's own `.MeritRouter/state`). For every existing
(legacy, unbound) installation this field is simply `null`/absent, and `BackupManifestSchema` is
still `.strict()` with the field `.optional()`, so old manifests (and `backupStorage`'s format-1/
format-2 compatibility) are unaffected — confirmed by the four pre-existing `operations.test.ts`
backup/restore assertion tests that passed.

The directory separation that makes this guard almost always true by construction: a project's
sessions/artifacts/db live under `<project>/.MeritRouter/...`, a different filesystem tree from
the installation's `storageDir`, so `backupStorage(installationStorageDir)` never walks into a
project directory at all. The row-count guard catches the one way that could still fail: a
coordination-role DB that (incorrectly) still carries project rows in its *own* tables.

## Test counts

- `npx vitest run tests/project-backup.test.ts`: **5 passed** (round trip incl. mutate-then-restore
  of tasks/session-log/artifact/project.json/brain; generation-mismatch refusal; live-lease then
  live-execution-claim refusal; canary-byte absence from an installation backup of the
  coordination store, with a project backup of the same canary shown to contain it as a control;
  targetDir-inside-project/installation refusal).
- `npx vitest run tests/operations.test.ts` (existing `backupStorage`/`restoreStorage`): **19
  passed, 4 failed** on first run (7 failed), rerun once per the brief's CPU note. All 4 remaining
  failures are in the shared `runOneTask()` helper's `await sy.awaitResults(..., { timeoutSeconds:
  10 })` — a live-task-execution timeout under this run's CPU contention, not in any
  backup/restore assertion, and not touched by this brief's edits. Every assertion that actually
  checks `backupStorage`/`restoreStorage` behavior (manifest shape, master-key handling, missing
  backup, lease refusal/`--force`, schema-version refusal, `installationRole`-unrelated paths)
  passed both runs.
- `npx vitest run tests/projects-operations.test.ts`, `tests/rename-compatibility.test.ts`,
  `tests/roadmap-project.test.ts`: all three fail at **collection** (0 tests run) with `esbuild:
  Unterminated regular expression` in `src/workspaces/repository-mutation.ts:50` — a concurrent
  worker's file, mid-edit, outside this brief's scope (I did not touch `workspaces/*`). Not caused
  by this brief's changes; re-running after that file settles is the next step, not something I
  can fix without touching another worker's owned file.
- `npx tsc --noEmit` (router): **1 error outside my files**, in
  `tests/brain-commit-performance.test.ts:62` (`GrantContext` missing `task`), unrelated to
  `operations/backup.ts`, `operations/project-backup.ts`, or `tests/project-backup.test.ts` — none
  of which produced any tsc error. No schema change was needed in
  `src/storage/migrations.ts`.

## Not verified

- Full repo `pnpm -r build` / `pnpm -r typecheck` (only the router's own `tsc --noEmit` was run,
  as instructed).
- `tests/projects-operations.test.ts`, `tests/rename-compatibility.test.ts`,
  `tests/roadmap-project.test.ts` could not be exercised this run due to the concurrent-edit
  collection failure above; their own backup/restore assertions are therefore unverified by me
  this run (they were not touched by this change).
- No real provider/network calls were made (none needed).
- `src/projects/store-provision.ts` does not exist yet in this checkout, so fixtures were built
  entirely by hand as the brief allowed; `provisionProjectStore` was not used.

## Open questions / contradictions

- None found that block this brief. One note for the composition-root/entrypoint waves (B1/B2):
  once `deleteProject`/`retireProjectStoreRegistration` exist, a retired project's backup/restore
  story (can a retired project still be backed up for archival? can it ever be restored back to
  `registered`?) is undecided — `restoreProjectStore` currently refuses any registration that
  isn't exactly `registered`, which seems right for now but may need revisiting once deletion
  lands.

Outcome: Done
Changed: packages/router/src/operations/backup.ts (edited); packages/router/src/operations/project-backup.ts (new); packages/router/tests/project-backup.test.ts (new)
Validation: `cd D:/MeritRouter/packages/router && npx vitest run tests/project-backup.test.ts` -> 5 passed; `npx vitest run tests/operations.test.ts` -> 19 passed / 4 failed (unrelated runOneTask timeout under shared CPU, rerun once per brief, no backup/restore assertion failed); `npx vitest run tests/projects-operations.test.ts tests/rename-compatibility.test.ts tests/roadmap-project.test.ts` -> failed to collect (esbuild syntax error in src/workspaces/repository-mutation.ts, a concurrent worker's in-progress file, not touched by this brief); `npx tsc --noEmit` -> 1 pre-existing error outside my files (tests/brain-commit-performance.test.ts), none in my files
Not verified: pnpm -r build/typecheck (router-only tsc run per brief); the three backup test files that failed to collect because of another worker's in-progress edit to src/workspaces/repository-mutation.ts
Report: D:/MeritRouter/docs/working/project-local-storage/reports/wave-a/a2-project-backup.md
Notes: Added a minimal, additive guard+field to backup.ts (installationRole) rather than restructuring it, to keep BACKUP_FORMAT/legacy behavior untouched. restoreProjectStore takes no project selector by design — it resolves the target solely from the manifest's identity matched against the CURRENT registration, so a backup can never be restored to the wrong or a stale project directory.
