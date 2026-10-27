# A3 minimal legacy migration and rollback (wave A)

Worker: a3-migration (worker-heavy). Date: 2026-10-27. Revised the same day after the supervisor's follow-up: session log and artifact files are now migrated too.

## Outcome

Done. Three new files:

- `packages/router/src/projects/store-export.ts`
- `packages/router/src/projects/store-migration.ts`
- `packages/router/tests/project-store-migration.test.ts`

The new test file passes 19/19. The three named regression files pass 59/59. Router `tsc --noEmit` exits 0. The previously known error in `tests/brain-commit-performance.test.ts` no longer appears. No schema change was needed, and no file outside my ownership was touched.

Session log files (`sessions.log_path`) and artifact files (`artifacts.rel_path`) are now copied into `<project>/.MeritRouter/{sessions,artifacts}`. Their sha256 digests are part of verification and of the rollback checksum. Missing, outside or corrupt files are refused. Brain content stays out of scope (see Open questions, item 1).

## API

### store-export.ts

- `PROJECT_EXPORT_TABLES`: table -> SQL predicate (named parameter `@slug`) selecting the project's rows. There are 56 tables. Rows are selected by `project_id`, or through the project's tasks, sessions, Labs, attempts or protocol keys.
- `PROJECT_EXPORT_SKIPPED`: table -> reason it is not exported:
  - `store_identity`, `meta` (brain index markers), `classifications` (cache), `brain_files`/`brain_fts` (index), `lab_target_locks`
  - `project_execution_claims` and `_members` (bound to a split-store generation)
  - all shared coordination tables and qualification tables
- `unclassifiedExportTables(db)` and `missingExportTables(db)`: a table the module does not know becomes a blocker, so no table is dropped silently.
- `projectExportOrder(db)`: tables in foreign-key order, by topological sort over `pragma_foreign_key_list`.
- `projectExportClosureViolations(db, slug)`: every exported foreign key must point to an exported row.
- `projectExportManifest(db, slug, "project" | "store")`: `{format:1, slug, tables:[{table, rows, sha256}], files?}`.
  - `project` digests the export projection of a legacy store's rows.
  - `store` digests whole tables of a project store, so extra rows also change the digest.
  - Reads use one transaction.
- `projectExportManifestSha256(m)` covers tables and files. `differingExportTables(a, b)` and `differingExportFiles(a, b)` name what differs.
- `exportProjectRows(source, target, slug, {afterTable?})`. Everything runs in one IMMEDIATE target transaction (the source is read inside one read transaction):
  - It asserts that the target's export tables are empty.
  - It drops every trigger, inserts in foreign-key order, then recreates the triggers verbatim and checks they match. Without this, `product_delivery_insert_history` would add duplicate history rows.
  - It finishes with `PRAGMA foreign_key_check`.
- **Export projection (the one row rewrite).** `sessions.log_path` becomes `sessions/<id>.jsonl` (`canonicalSessionLog`).
  - The rewrite applies only to the target rows. The legacy rows are never written.
  - Rows already in canonical form are unchanged. That is every row the current `SessionStore.create` writes.
  - Rows with other forms, for example an absolute pointer, are rewritten. Such a pointer resolves in the legacy layout (`path.resolve(storageDir, log_path)`), but the split runtime would not resolve it. In split mode `ProjectEvidenceScope.rootFor` resolves to `<project>/.MeritRouter`, and `SessionStore` requires `log_path` to resolve exactly to `<root>/sessions/<id>.jsonl` (sessions/store.ts:369-370).
  - `artifacts.rel_path` is never rewritten. Both layouts resolve it as `<root>/artifacts/<rel_path segments>` (artifacts.ts:34,86). A non-canonical value (absolute, `..`, `\` or `:`) never resolved in the legacy store either, so it is a blocker.
- `inspectProjectFiles(db, slug, { legacyStorageDir } | { runtimeRoot })` returns `{ files: [{kind, id, path, bytes, sha256, source}], problems }`.
  - With `legacyStorageDir`, it reads the project's legacy rows and resolves files the way the legacy stores do.
  - With `runtimeRoot`, it reads all rows of a project store and resolves files the way the split runtime does.
  - Problem codes are `file_missing`, `file_outside_storage`, `file_path_invalid` and `artifact_digest_mismatch`. The last one is raised when an artifact's file size or sha256 differs from its row.
  - Symlinks and non-regular files count as missing.
  - Path segments are validated with `ProjectEvidenceScope`'s component rule.
- `fileSha256(file)`, `fileDigests(entries)`.

Canonical row digest:

- Columns are sorted by name.
- Rows are ordered by primary key.
- Values are read with `safeIntegers`:
  - INTEGER becomes `i:<decimal>`.
  - REAL becomes `r:<IEEE-754 hex>`.
  - TEXT becomes `t:<text>`.
  - BLOB becomes `b:<base64>`.
  - NULL stays `null`.
- Storage classes and integers beyond 2^53 round-trip exactly. The test checks 9007199254740993.

File digest entries hold `{kind, id, path, bytes, sha256}`, sorted by `path`. `path` is the canonical runtime-relative path, `sessions/<id>.jsonl` or `artifacts/<rel_path>`. The legacy and target manifests are therefore directly comparable.

### store-migration.ts (all inputs are zod-validated and strict)

```ts
planProjectMigration(coordinationDb, legacyDb, { slug, projectDirectory, installationRoots, legacyStorageDir }): ProjectMigrationPlan
  // { slug, projectDirectory, ready, blockers: {code,message,remedy,sample[]}[], source:{storeId,generation:1,schema,bound},
  //   manifest (tables + files), checkpointSha256, files (with legacy source paths) }  -- writes nothing
migrateLegacyProject(coordinationDb, legacyDb, { slug, projectDirectory, installationRoots, legacyStorageDir, backupDir, now? },
  options?: { afterPhase?, afterExportTable?, provision?: ProjectStoreProvisionOptions }): Promise<ProjectMigrationResult>
  // { migrationId, identity (generation 2), registration, journal, paths, backupFile, manifestFile, backupSha256, checkpointSha256, manifest }
rollbackProjectMigration(coordinationDb, legacyDb | null, { migrationId, legacyStorageDir?, now? }): Promise<ProjectMigrationRollback>
  // { migrationId, projectId, slug, previousState, targetRemoved, legacyIntact }  (legacyIntact is null without legacyDb + legacyStorageDir)
listProjectMigrationRecovery(coordinationDb): ProjectMigrationRecoveryEntry[]   // startup helper, read-only
openProjectMigrationRecoveryStore(coordinationDb, migrationId): Db               // readonly handle; caller closes
legacyProjectFence(coordinationDb, slug): { fenced, projectId, state }          // legacy-row dispatch fence
class ProjectMigrationRefusedError { slug; blockers }
type ProjectMigrationPhase = "planned"|"backup"|"prepared"|"store"|"copying"|"exported"|"files"|"verified"|"committed"
```

`legacyStorageDir` is the legacy storage folder, which holds the legacy database, `sessions/` and `artifacts/`. A live plan refuses with `legacy_storage_mismatch` when the legacy database file does not lie directly in it, and with `legacy_storage_missing` when it does not exist.

Journal field choices:

- **Source store id.** For an unbound legacy store there is no identity, so `sourceStoreId` is derived: a v8-format UUID from sha256 of the installation id and the legacy file path. For a coordination-bound legacy store it is that store's `storeId`.
- **Generations.** `sourceGeneration` is 1 and `targetGeneration` is 2.
- **Schemas.** `sourceSchema` and `targetSchema` are both `SCHEMA_VERSION`. Any other legacy schema is refused.
- **`checkpointSha256`.** It is the sha256 of the canonical manifest: the backup's projected project rows plus the digests of the payload files.

## Flow and state machine

1. Plan on the live legacy DB, including the payload-file scan. Any blocker throws `ProjectMigrationRefusedError`, and nothing is written.
2. Take an online SQLite backup to `<backupDir>/<slug>-<migrationId>.legacy.db`.
   - The backup is converted to `journal_mode=DELETE`, passes `quick_check`, and is fsynced.
   - The plan is re-run on the backup, which becomes the row source. Its file scan uses the legacy storage folder and fixes the checkpoint file digests.
   - The sidecar `<slug>-<migrationId>.manifest.json` is written atomically. It holds the backup sha256, `legacyStorageDir`, source info, checkpoint, per-table and per-file digests, and the file source paths.
   - A failure here deletes the backup files.
   - The legacy files themselves are not copied into `backupDir`: they are never modified, and the commit-time drift check proves they still match.
3. Write the journal first: one coordination IMMEDIATE transaction re-checks conflicts, inserts the registration as `migrating` (generation 2), and inserts the journal as `prepared`.
   - I took the brief's allowed variant "reuse prepare's projectId": the journal and registration are written before `prepareProjectStore(identity)`. Every file created on disk is therefore owned by a journal row.
4. `prepareProjectStore(..., identity)` creates and binds the store, then the journal moves `prepared -> copying`.
5. Rows are exported in one target transaction (phase `exported`).
6. Payload files are copied (phase `files`). Each file goes to `<project>/.MeritRouter/<canonical path>` with `COPYFILE_EXCL`, is fsynced, and its copy must reproduce the planned size and sha256. A mismatch means the legacy file changed during migration, and the migration fails.
7. Verify:
   - written row digests equal the checkpoint;
   - the whole-store rows plus the files resolved from the target rows under `<project>/.MeritRouter` (`inspectProjectFiles({runtimeRoot})`, with no problems) equal the checkpoint;
   - `quick_check` passes;
   - `foreign_key_check` is empty;
   - `assertStoreRole(project)` passes.

   The journal then moves `copying -> verified`.
8. Commit in one coordination IMMEDIATE transaction:
   - The live legacy project, its rows and its files, must still be quiescent and still equal the checkpoint.
   - The registration moves `migrating -> registered` (CAS on store, generation and slug).
   - The journal moves `verified -> committed`.

Failure and rollback:

- **Failure after step 3.** A failure before commit sets the journal to `recovery_required`, and the registration stays `migrating`. A hard crash leaves the last journaled state. The registry refuses `migrating` in both cases.
- **Re-running a migration** while a pending journal exists is refused with `migration_pending`, naming the `migrationId`.
- **Pre-commit rollback.** It first proves ownership of `<project>/.MeritRouter`: the DB identity equals the journal target, or the DB is unbound and empty, or (with no DB) only entries `prepare` creates are present. Then one transaction retires the registration and marks the journal `rolled_back`, and the whole directory is removed, including the copied `sessions/` and `artifacts/`.
- **Committed rollback.**
  1. A fence moves the registration `registered -> migrating`.
  2. The target's whole-store rows plus resolved payload files must equal `checkpointSha256`. A changed, missing or extra file, or any changed row, restores the registration to `registered` and refuses the rollback.
  3. Retire the registration, mark the journal rolled back, and remove the directory.
- **Rollback idempotency.** Rollback is idempotent. On a `rolled_back` journal it removes the directory only if the DB there still carries that journal's identity.
- **Legacy rows and files are never written.** `legacyIntact` compares the live legacy rows and files with the checkpoint.

## Quiescence and exportability checks (blocker codes)

| Group | Codes |
| --- | --- |
| Tasks and sessions | `tasks_not_terminal`; `task_leases_live`; `sessions_running` (new: a running session's log could still grow) |
| Labs | `labs_present` (any `labs` row in any state, Lab operations, command or capacity owners, Lab teams on project jobs, `lab_attempt_processes`) |
| Worktrees and attempts | `worktrees_retained`; `worktrees_on_disk`; `workspace_attempts_open`; `merge_pending` |
| Holds, requests and questions | `file_leases_held`; `job_questions_open`; `budget_requests_pending`; `brain_access_pending`; `requests_unresolved`; `request_holds_active`; `execution_claims_unresolved` |
| Payload files (new) | `file_missing`; `file_outside_storage` (a session log resolving outside `legacyStorageDir`, or an absolute or `..` artifact `rel_path`); `file_path_invalid`; `artifact_digest_mismatch`; `legacy_storage_missing`; `legacy_storage_mismatch` |
| Exportability | `shared_execution`; `shared_protocol_record`; `ownership_conflict`; `foreign_key_closure`; `unclassified_tables`; `missing_tables`; `schema_mismatch`; `legacy_is_project_store`; `legacy_identity_unreadable`; `legacy_foreign_installation`; `no_legacy_rows` |
| Directory | `project_directory_missing`; `project_directory_not_real`; `project_directory_metadata`; `installation_overlap`; `target_exists` |
| Coordination | `already_registered`; `migration_pending` |

Every blocker carries a remedy sentence and up to 10 sample references. For example, a missing file says: "Restore them from a backup of the legacy storage folder (and check legacyStorageDir is the folder holding the legacy database), then retry."

The backup directory must lie outside the project directory.

**Legacy fencing (fresh-install scope).**

- Legacy rows and files stay as they are.
- `legacyProjectFence(coordinationDb, slug)` returns `fenced:true` from `migrating` onwards.
- **The fence is not wired into any caller yet.** B1 must call it before any legacy dispatch, resume, retry or write for that slug.

## Crash matrix (each case is tested, then recovered)

| Crash after | Coordination | Disk | Recovery tested |
| --- | --- | --- | --- |
| planned | nothing | nothing, no backup | re-run succeeds |
| backup | nothing | backup files deleted | re-run succeeds |
| prepared (journal written) | recovery_required / migrating | none | rollback, then re-run |
| provision step `database` | recovery_required / migrating | DB without an identity | rollback (allowlist proof), then re-run |
| store | recovery_required / migrating | bound empty store | rollback, then re-run |
| copying | recovery_required / migrating | bound empty store | rollback, then re-run |
| mid-export (after table `sessions`) | recovery_required / migrating | target transaction rolled back | rollback, then re-run |
| exported | recovery_required / migrating | rows copied, no files | rollback, then re-run |
| files (new) | recovery_required / migrating | rows and files copied | rollback removes the files with the target, then re-run |
| verified | recovery_required / migrating | verified copy | rollback, then re-run |
| hard crash at exported (coordination connection closed) | copying / migrating | rows copied | startup report, read-only handle, rollback, re-run |
| committed | committed / registered | complete | `openRegistered` works; re-run refused |

In every case:

- no registration is `registered` before commit;
- `openRegistered` refuses `migrating`;
- the legacy DB digest over all tables is unchanged.

## Commands run and observed results

- `npx vitest run tests/project-store-migration.test.ts` -> 19 passed, about 41 s.
  - The new and changed tests are:
    - **Happy path.** One session's legacy `log_path` is made absolute first.
      - The plan manifest lists both payload files with the legacy sha256 values.
      - The target row reads `sessions/<id>.jsonl`.
      - `new SessionStore(target, paths.state).get(id).logPath` is `<project>/.MeritRouter/sessions/<id>.jsonl`, and `events(id)` returns `started`, `ended`.
      - `new ArtifactStore(target, paths.state).read()` returns the content and passes its integrity check, with the path under `paths.artifacts`.
      - The copied files' sha256 values equal the legacy ones.
      - The legacy files and the legacy absolute `log_path` row are unchanged.
      - The rows-only digest differs from the checkpoint, while rows plus files equal it.
    - **Payload-file refusals.**
      - A deleted artifact file gives `file_missing`; `migrateLegacyProject` rejects with the remedy and leaves no registration, target or backup.
      - A tampered artifact gives `artifact_digest_mismatch`.
      - A session log outside storage, and an artifact `rel_path` of `../escape.txt`, give `file_outside_storage`.
      - A running session gives `sessions_running`.
      - A wrong `legacyStorageDir` gives `legacy_storage_mismatch`.
    - **Crash case "files"** is added to the crash matrix.
    - **Rollback after commit** also asserts both copied files are gone and `legacyIntact` is true.
    - **Rollback is refused** after a line is appended to the copied session log on the target; the registration stays `registered`.
  - The earlier one-off Vitest `Channel closed` (`ERR_IPC_CHANNEL_CLOSED`) from the first round did not recur.
- `npx vitest run tests/project-store-provision.test.ts tests/project-store-identity.test.ts tests/project-runtime-registry.test.ts` -> 3 files, 59 passed.
- `npx tsc --noEmit -p .` (packages/router) -> no output, exit 0.

## Not verified

- **POSIX.** Everything ran on win32 only.
- **A real `MeritRouter` service, or `createProjectRuntimeServices`.** The registry used a stub bundle factory. Real sessions and artifacts were tested through `SessionStore` and `ArtifactStore` on the target DB directly.
- **Concurrent writers on the legacy DB or its files during migration.** This is covered by the per-copy digest check and the commit-time drift check.
- **Large stores.** Files are hashed synchronously (1 MiB reads). The commit-time drift check re-hashes all payload files while holding the coordination write lock.
- **A legacy DB that is also the coordination DB.**
- **The full router suite.** Not run.

## Open questions or risks

1. **Brain content is out of scope.** The legacy brain is one shared repository, not owned by any project, so it is not migrated. The brain index tables (`brain_files`, `brain_fts`, `meta` markers) are skipped and rebuild from the project brain.
2. **The legacy fence is a helper only.** It is not active until B1 calls `legacyProjectFence`.
3. **Conservative blockers.**
   - `shared_execution`, `shared_protocol_record`, any `labs` row and `ownership_conflict` refuse rather than split data.
   - Artifacts with `task_id` NULL (`_shared`) are not project-owned and are not exported.
   - Lab service logs are covered by the Lab blocker.
4. **Duplicated checks.** I re-implemented A1's installation-overlap and metadata-path checks as plan blockers. `store-provision.ts` could export `assertOutsideInstallation` to remove the duplication.
5. **Committed rollback on Windows.** It needs the runtime bundle closed. If `.MeritRouter` cannot be removed, the journal is already `rolled_back`, and re-running rollback retries the removal.
6. **Leftovers outside `.MeritRouter`.** Rollback leaves the Git `info/exclude` entry and the `backupDir` files, deliberately.
7. **Extra files are not proven absent.** Only files referenced by rows are digested. An extra, unreferenced file in the target `sessions/` or `artifacts/` would not block a committed rollback; rollback deletes it with the directory.
