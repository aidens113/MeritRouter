# Project-local storage discovery

Worker: project_storage_discovery
Date: 2026-10-25
Scope: read-only source discovery; no source changes, commands against live state, or migration.

## Inspected facts

- `config/schema.ts:781` defaults storage to `.meritrouter`; `config/load.ts:parseConfig`
  resolves it against the configuration file directory, not the target repository.
  This explains project state appearing under the installation/configuration root.
- `projects/schema.ts`, `projects/resolve.ts:ResolvedProject` and `projects/context.ts`
  have repository mappings but no explicit project directory/runtime root. Multi-repository
  projects therefore lack an unambiguous filesystem owner today. Project overrides do not
  include storage; changing the top-level storage directory changes every project.
- `core/service.ts:173-182` creates one shared database, ArtifactStore, SessionStore,
  LabManager and KeyVault. `storage/db.ts:openDatabase` creates that storage directory and
  opens the database there. Merely overriding project context storage does not relocate
  these already-created shared services.
- `workspaces/worktree.ts:Worktrees.prepare` creates flat opaque `<task>-r<run>-<time>`
  directories under its injected root and records absolute paths in `workspaces`.
  `runners/coding/finish.ts:prepareWorkspace/resumeWorkspace` inject
  `<storageDir>/worktrees`; `finish.ts:63` separately creates `<storageDir>/agent-home/...`.
- `harness/integration-tools.ts:124` creates integration worktrees under the same flat root,
  named `job-<id>-<repo alias>`. `harness/worker-actions.ts:146` reconstructs this exact path
  as an authorization root; creation and approval containment must change together.
- `sessions/store.ts:159,167,366` writes JSONL under `<storage>/sessions`, stores paths
  relative to storage, and resolves those paths on reads. Persisted session workspace JSON
  independently contains worktree paths.
- `storage/artifacts.ts:30,44,77` uses `<storage>/artifacts/<task or _shared>` and stores
  relative file paths; artifacts with no task require a defined ownership rule.
- `core/service.ts:projectBrain` constructs per-project Brain objects with the shared DB.
  `brain/brain.ts:136` resolves `cfg.brain.path` against config location; default is
  `~/.meritrouter/brain` (`config/schema.ts:514`). `projects/resolve.ts` changes brain project
  scope but retains the global brain path. Separate project objects do not imply separate disk roots.
- `labs/lab.ts:325,390` requires `<storage>/labs/<project>/<name>`, owns marker, logs,
  persistent test data and `repos/<alias>` there. Ownership validation, creation, destruction,
  and task pruning must all adopt project roots. `labs/task-attempt-source.ts:sourcePath`
  specifically requires task source under `<storage>/worktrees`, rejecting symlinks.
- `projects/deletion.ts:projectFootprint/projectWorktrees` assumes flat immediate children
  of `<storage>/worktrees` with recognized task-derived names, plus storage-relative logs
  and artifacts. Nested readable paths would be invisible to existing cleanup discovery.
  `admin/projects.ts` coordinates footprint/deletion and task-Lab pruning.
- `harness/worker-actions.ts` stores approvals as JSON in the shared DB, including absolute
  cwd, source identity and lease generation; blindly rewriting cwd would change reviewed
  action identity. Pending approvals need explicit retirement/reissue during relocation.
- `storage/request-captures.ts` keeps private model payloads in the shared DB, including
  mixed-project captures. It joins request charges/tasks/projects to determine scope. These
  are project content, not merely global accounting metadata, and need an ownership design.
- `providers/vault.ts:loadMasterKey` writes an installation master key under storage.
  `operations/backup.ts` snapshots/restores the shared DB, sessions, artifacts and optionally
  master key; its lease/daemon safety checks and rollback are installation-scoped today.
- `context/repo-reader.ts:117` reads untracked nonignored files using `git ls-files`.
  A project-local metadata directory must be ignored/excluded before any workspace launch,
  otherwise runtime data can enter agent discovery or broad `git add -A` collection.

## Recommended design, not implemented

1. Add a validated explicit project `directory` (not inferred common ancestor of repositories).
   Single-repository registration can default to its repository folder. Multi-repository
   registration must record an explicit owner directory. Reject duplicate/nested ownership
   that could let one project's cleanup remove another's state.
2. Introduce one `projects/runtime-paths.ts` resolver (proposed new concern-owned file) with
   stable persisted layout version and labels. Use `.MeritRouter` exactly; detect lowercase
   legacy `.meritrouter` without case-only rename mistakes on Windows. Reject symlink/junction
   escape, traversal, reserved Windows names, trailing dots/spaces and excessive depth.
3. Use job label + stable ID, task label + stable ID, attempt number, repository alias.
   Preserve readable version/branch metadata in a manifest; avoid embedding full branch
   names with slashes or letting later labels rename active filesystem locations.
   Keep top-level delivered application source separate from managed job candidates.
4. Project-local SQLite should own task/session/plan/channel/approval/delivery/workspace
   state and private captures; global installation storage should own provider secrets,
   aggregate request/spend authority, model catalog and cross-project capacity coordination.
   This is a database/service separation, not just a path-string patch. Define idempotent
   request IDs and a durable accounting handoff/outbox before splitting transactions; never
   duplicate spend authority. Alternative transitional global indexes must not retain copies
   of project prompts, logs or application content and must be explicitly documented.
5. Installation daemon logs/config may remain installation-owned, but project-scoped logs,
   agent homes, request captures, previews/Labs data, evidence and backups belong locally.
   Shared mixed-project captures need partitioning/redaction or refusal, not arbitrary placement
   in one project's directory. Never copy master keys into projects.

## Safe migration sequence

- Inventory through typed services: owner project, source/destination, file hashes, Git common
  directory, branch/HEAD, dirty state, sessions, artifacts, Labs, outstanding actions/holds.
- Quiesce daemon scheduling and all relevant sessions, actual command processes, Labs and
  integrations. Refuse live leases/uncertain effects. No opportunistic move of active workers.
- Back up database and files, write a versioned resumable migration journal and dry-run manifest.
- Establish Git exclusions and destination ownership marker before creating any nested worktree.
- Use `git worktree move`/Git-aware recovery with dirty-state preservation; do not recursively
  move folders and assume linked `.git` references remain valid. Verify each worktree's source,
  HEAD, branch and contents after relocation; cross-volume moves need an explicit safe strategy.
- Migrate state and typed path references together: workspace rows, session workspace JSON,
  integration receipts/artifacts, Lab roots/repositories, approval cwd and persisted check cwd.
  Enumerate remaining path-bearing records before implementation; do not replace substrings
  across arbitrary historical log/model output. Keep immutable historical text historical.
- Retire/reissue unresolved approvals with exact new cwd/source; preserve actor decisions and
  audit records. Never reuse an approval against a changed identity.
- Verify accounting hashes, charges, paid spend, source identity and evidence digests unchanged.
  Only switch authoritative config/layout marker after checks; retain old data until confirmed.
- Make partial failure replay/rollback explicit and test it. Disk moves and SQLite commits are
  not one atomic transaction; journal recovery is required before normal resume.

## Proposed file partitions (serial dependencies)

1. Configuration/path owner: `config/schema.ts`, `config/load.ts`, `projects/schema.ts`,
   `projects/resolve.ts`, `projects/context.ts`, proposed runtime-path resolver; config/setup tests.
2. State/service owner (after stable resolver/API): `core/service.ts`, storage/session/brain
   stores, request captures and admission/accounting adapter. This needs a separate bounded
   design and explicit transactional contract before coding; broad shared-DB callers exist.
3. Workspace owner: `workspaces/worktree.ts`, `runners/coding/finish.ts`,
   `harness/integration-tools.ts`, `harness/worker-actions.ts`, managed-source consumers.
4. Labs/cleanup owner: `labs/lab.ts`, task-attempt-source/prune, `projects/deletion.ts`,
   `admin/projects.ts`; only after path API and workspace records stabilize.
5. Migration/backup owner: operations migration/backup and typed migration services;
   avoid editing same stores as partition 2 concurrently.
6. Panel/setup/docs owner: display readable location/version hierarchy, configuration
   registration and migration status; inspection of exact panel components remains outstanding.

## Required verification and remaining unknowns

Test default single/multi-repo registration, Windows casing/long paths/reserved names,
cross-project containment, ignore behavior, retry/resume, exact approvals after migration,
Lab cleanup, project deletion, backup/restore, quota reconciliation and crash/replay at every
migration boundary. Test no project-owned writes beneath installation/global root. Run required
recursive checks/full tests and demo-panel/browser checks after implementation.

No tests executed: discovery only. Searches/reads observed the facts above; several guessed
entrypoint filenames did not exist and were corrected to the actual files listed here.
This is not an exhaustive reference inventory: all persisted JSON path fields, panel components,
external runner-owned caches and cross-project request batching need a second targeted pass.
No live state was inspected or changed; no claim that migration is currently supported.
