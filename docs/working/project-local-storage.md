# Project-local runtime storage
Status: Active
Status detail: Reviewed storage foundation passes90 focused tests, recursive typecheck/build; full suite and physical migration pending.
Created: 2026-10-25
Last updated: 2026-10-26
Owner: Senior supervisor agent
Scope: Keep every project's runtime data inside its own directory with readable workspace hierarchy.
Paired document: none
Related: [working index](README.md), [delivery investigation](supervisor-lifecycle-stall.md)

## Current State

2026-10-26: user authorized continuing execution. Initial discovery is complete;
report: project-local-storage/reports/storage-discovery.md. Shared DB/store construction
makes complete project-data relocation a service/accounting boundary change, not a rename.
Standalone validated path contract and additive directory metadata are implemented.
Root independently read source, requested/followed up Windows-path fixes, and observed
combined51/51 tests passing (final paths28, directory14, existing projects9).
Foundation recursive typecheck and build passed; final seam/source checks still required.
Independent reviews drove drive-qualified Windows paths, case-safe repository identities,
and canonicalized device namespace rejection. State-service contract report is complete;
same-DB project store seam implemented with independent19/19 seam+projects tests passing.
Ownership inventory maps all70 logical tables and55 literal direct SQL caller files.
Read and write metadata boundaries implemented. Review exposed actual Windows junction/
hardlink leakage; corrected bounded physical preflight now excludes unsafe aliases BEFORE
Git grep reads content. Root final combined90/90 PASS23.50s and recursive typecheck PASS.
Independent final metadata12/12 and actual alias probes PASS; root rebuilt-dist probe confirms
only app.txt/PUBLIC returned and both aliases refused. Final recursive build PASS; full
suite not yet run on this exact source. No physical separation or migration implemented.
Live Facebook job is interrupted (watchdog); profile completed, people and notifications
failed deadline_exceeded. No pending/running command approvals at inspection. Preserve
all retained source and accounting; do not represent the app as delivered.

User requires project-owned runtime data under the project folder, rather than the
MeritRouter installation/root folder. Proposed metadata directory: `.MeritRouter`.
Workspaces must have readable job, branch/version, and attempt hierarchy; opaque task IDs
may remain collision-resistant suffixes, not the only navigation labels.
Existing live worktrees must not be moved while agents or commands are using them.
Foundation and same-DB seam exist; no physical storage activation/migration performed.
Discovery must cover databases, sessions, artifacts, brain, approvals, workspace receipts,
Labs, cleanup/deletion, recovery, panel links, and configuration defaults.
Current deletion code explicitly assumes `<storage>/worktrees`; changing creation alone
would leave cleanup and recovery inconsistent.
Shared installation configuration/provider credentials and cross-project routing services
need explicit ownership boundaries; project data must not remain globally stored merely
because the current database is shared. Never copy shared secrets into project folders.

## Intended layout

```text
<project>/
  <delivered application source>
  .MeritRouter/
    project.json
    state/
    brain/
    sessions/
    artifacts/
    jobs/
      <readable-job-name>--<stable-id>/
        versions/
          <readable-branch-or-version>--<stable-id>/
            repositories/<repo-alias>/
        tasks/
          <readable-task-name>--<stable-id>/
            attempts/<attempt-number>/repositories/<repo-alias>/
```

Layout is a design proposal pending source discovery. Delivered source remains visible at
project root; `.MeritRouter` is private runtime state and must be excluded from Git and
recursive agent file discovery. Slugs must be bounded, Windows-safe, stable after renames,
and collision resistant. Multi-repository projects use the registered project directory.

## Implementation phases

1. Map path ownership and every consumer; settle project root resolution and shared-state
   boundaries before writing source. Record exact migration and compatibility contracts.
2. Add one validated project-path resolver, readable stable labels, containment checks,
   metadata exclusion, and new-project defaults. Partition implementation briefs by file.
3. Migrate existing projects with stopped/quiescent owners, backup, dry-run manifest,
   Git-aware worktree relocation, typed reference updates and rollback. Preserve charges,
   history, approvals, source identity and original Git attribution. Refuse ambiguous roots.
4. Update panel path presentation, cleanup/deletion, recovery, CLI/MCP and authored docs.
5. Verify fresh creation, multi-repo jobs, retries, restart/resume, migration failure/rollback,
   deletion containment and Windows paths. No project-owned writes under install root.
   Run required full checks and demo-panel visual verification for touched UI.

### State/accounting decision

Use explicit project runtime handles before physical store separation. Current request
reservation, task generation checks, provider slots, task charges and paid holds share
one SQLite transaction. WAL does not make multiple independent databases crash-atomic.
The proposed split must use durable local preparation/global reservation/settlement receipts,
idempotent IDs, conservative unresolved holds, and fenced dispatch; no network awaits inside
transactions. Preserve same-project batching and existing accounting authority.
Detailed proposal: reports/state-service-contract.md. Full schema/caller ownership inventory
is underway before approving physical DB split implementation. Do not copy global credentials
or private payloads into a misleading partial project store and call migration complete.

## Worker Briefs

### runtime-path-contract
- Role: worker; implementation foundation only, no live migration or service wiring.
- Read: Current State and discovery report; projects schema/context for conventions.
- Own: NEW src/projects/runtime-paths.ts and tests/project-runtime-paths.test.ts;
  own report project-local-storage/reports/runtime-path-contract.md only.
- Build a zod-validated versioned path contract for an explicit absolute project directory,
  .MeritRouter root and readable stable job/task/attempt/repository hierarchy.
- Inputs have bounded safe labels and stable IDs; reject traversal, reserved names,
  Windows ambiguities and escaping existing symlinks/junctions. Labels must not silently
  change established paths: expose a persisted identity/manifest contract for consumers.
- No automatic mkdir/migration/config defaults; separate pure construction from any
  filesystem validation. Document unsupported cases rather than claim complete containment.
- No edits to existing source/config/stores/shared docs, commits, paid calls or user data.
- Run proportional focused tests and package typecheck; return exact checks and API.

### state-service-contract
- Role: read-only design worker; no source or live state edits.
- Read: Current State/discovery, core/service.ts and actual stores/accounting consumers.
- Own report project-local-storage/reports/state-service-contract.md only.
- Specify executable staged separation of project DB/content from global credentials,
  provider coordination and authoritative accounting; map transactions and crash boundaries.
- Cover request charges/holds/captures, task/session/delivery/approval references, migration
  journal and backup/restore; identify atomicity that cannot survive naive DB splitting.
- Recommend precise file-partitioned implementation steps and acceptance tests; distinguish
  facts from design and list unresolved blockers. No commits or broad test execution.

### project-directory-config
- Role: implementation worker; additive ownership metadata, no storage relocation.
- Read: Current State/discovery; projects schema/resolve/context/registry, config/load.
- Own: projects/{schema,resolve,context,registry}.ts; NEW projects/directory.ts if needed;
  tests/project-directory.test.ts and own report reports/project-directory-config.md.
- Add optional explicit project directory resolved against config location; expose resolved
  directory through project context. A single distinct repository path may supply default;
  ambiguous/no-repo legacy projects remain null until storage activation, preserving compatibility.
- Validate supplied directory using zod; no filesystem writes or creating .MeritRouter.
- Reject conflicting explicit project owners where containment would mix project metadata;
  document legacy ambiguity. Do not infer a common ancestor for multi-repo projects.
- No changes to config/schema.ts, config/load.ts, existing tests, runtime-paths.ts,
  stores, service, setup/panel or shared docs; no commits/live data/provider use.
- Add focused config/context tests; coordinate package validation with root. Return exact
  API and verification. This foundation alone must not be described as project-local storage.

### project-store-seam
- Role: implementation worker; behavior-preserving same-DB service seam only.
- Read: Current State, reports/state-service-contract.md and current executor ProjectDeps/depsFor.
- Own: core/{service,executor}.ts; NEW projects/runtime-store.ts; NEW tests/project-runtime-store.test.ts;
  own report reports/project-store-seam.md. No other source or existing tests/shared docs.
- Define typed project store handle for db/tasks/sessions/artifacts/contracts with explicit
  project identity. Have service.projectDeps supply same existing store instances through
  this handle; executor depsFor consumes it, preserving omitted ProjectDeps fallback.
- Reject a handle whose project identity disagrees with the stored task/project context.
  Unknown project must fail closed before runner/provider use. No new database creation,
  runtime-path activation, store constructors, scheduler/admission changes or transaction split.
- Demonstrate two projects receive correct config/identity and identical existing store refs;
  optional legacy caller behavior, mismatched handles and qualification stay correct.
- Do not claim handles isolate stores yet. No commits, live data or providers. Coordinate
  freeze with root; run focused tests only, root owns combined validation.

### metadata-read-boundary
- Role: implementation worker; exclude private runtime metadata from repository tools.
- Read: Current State and reports/metadata-exclusion-plan.md.
- Own: NEW projects/metadata-policy.ts; context/repo-reader.ts;
  NEW tests/project-metadata-read.test.ts; own report reports/metadata-read-boundary.md.
- Reserve .MeritRouter (case-insensitive component match, including legacy casing).
  Direct committed/worktree reads refuse; listings/search filter before limit/truncation.
  Protect in-repository symlink aliases resolving into metadata for actual worktree reads.
- Keep authorized Brain/artifact APIs separate; do not claim arbitrary commands cannot read
  metadata. No staging/writes/permission changes; no source-identity weakening or string redaction.
- Real temp-Git tests cover tracked/ignored/untracked metadata, pinned read/list/search,
  safe ordinary files and symlink alias. Reuse existing path containment rules.
- No edits to other files/shared docs, commits/live data or providers. Notify source freeze;
  focused tests only, root combined checks after all workers freeze.

### project-store-seam-review
- Role: independent read-only reviewer, author of design/inventory rather than implementation.
- Read: Current State and project-store-seam brief; inspect runtime-store.ts, core service/
  executor diff and new project-runtime-store.test.ts.
- Own report reports/project-store-seam-review.md only; focused tests permitted.
- Confirm same-instance store selection, no admission/lease/scheduler transaction changes,
  correct persisted task/context identity validation, legacy callback and qualification behavior.
- Report blockers separately from future physical-separation requirements. No source/live
  changes, commits or shared document edits.

### metadata-write-boundary
- Role: implementation worker; protect reserved runtime metadata from repository mutations.
- Read: Current State, metadata-exclusion-plan.md partition B, projects/metadata-policy.ts.
- Own: harness/tools.ts; harness/edit-operations.ts only if necessary;
  NEW tests/project-metadata-write.test.ts; own report reports/metadata-write-boundary.md.
- Use assertNotProjectMetadataPath in canonical workspacePath BEFORE filesystem effects;
  physical alias safety must preserve existing symlink/hard-link checks. Check all edits
  during batch preflight so mixed safe/private batch produces no changes.
- Cover write/replace/delete and nested/mixed-case/backslash/trailingdot/space metadata;
  ordinary app files and roots under ancestor .MeritRouter must remain usable.
- No grant/permission/staging/command changes, no other source/shared docs/live data/commits.
  Run focused tests, notify freeze; root owns combined validation.

### metadata-boundary-review
- Role: independent read-only reviewer; no implementation edits.
- Read: Current State and read/write briefs; metadata-policy.ts, RepoReader diff,
  harness/tools.ts diff and both new metadata test files.
- Own report reports/metadata-boundary-review.md only; focused tests permitted.
- Check pinned/direct/physical read paths, Git grep pathspec semantics, truncation,
  mixed batch atomic refusal, existing link guards and workspaces under metadata ancestor.
- Distinguish repository-tool protection from approved commands/Brain permissions.
  No source/live edits, commits or shared document changes.

### metadata-staging-contract
- Role: read-only design worker; no source or live repository changes.
- Read: metadata-exclusion-plan partition C and actual four staging consumers.
- Own report reports/metadata-staging-contract.md only.
- Specify shared staging/ignore helper API, contamination refusal before index mutation,
  explicit commitAs paths, initial snapshot, resume, linked Git excludes locking and tests.
- Preserve user index/exclusion bytes on refusal; classify remaining race/ownership limits.
  No broad tests, commits, live mutations or shared docs.

### storage-discovery
- Role: read-only worker; do not change source or live runtime state.
- Read: this Current State; start at src/workspaces/worktree.ts, src/projects/deletion.ts,
  configuration schema and core service; follow only relevant storage consumers.
- Scope: map project-owned versus shared paths, relocation consumers and migration risks.
- Report: docs/working/project-local-storage/reports/storage-discovery.md only.
- Return: concrete file/function references, recommended file partitions, checks needed,
  unknowns; distinguish inspected facts from proposed design. No commits or pushes.

## Work Ledger

### 2026-10-26 — Close alias leak and verify corrected foundation
- Agent: supervisor; workers runtime_path_contract,project_directory_config,project_storage_discovery
- Changed: reader physical preflight/hardlink refusal and regressions; independent review updated.
- Why: Git traversed ordinary Windows junction aliases into private metadata.
- Validation: final combined six-file tests90/90 PASS23.50s; recursive typecheck PASS; rebuilt-dist temp probe returned only app.txt/PUBLIC and refused junction+hardlink reads. Independent12/12 and actual probe PASS.
- Outcome: Partial
- Follow-up: final build/full checks, commit foundation; staging guards and physical store/migration remain.

### 2026-10-26 — Independently reproduce metadata alias exposure
- Agent: supervisor
- Changed: no source; disposable temp-Git fixture created and cleaned.
- Why: Verify review finding through actual built RepoReader rather than a worker claim.
- Validation: Node ESM fixture importing dist RepoReader/git ->list returned alias/private.txt and hard-alias.txt; search returned PRIVATE_FIXTURE under both aliases; direct hardlink read returned PRIVATE_FIXTURE.
- Outcome: Blocked
- Follow-up: fix reader physical filtering/hardlink policy, regressions and independent recheck before acceptance.

### 2026-10-26 — Inventory ownership and review store seam
- Agent: supervisor; workers project_storage_discovery and project_directory_config
- Changed: state/accounting design,70-table inventory, same-DB handle and executor/service wiring.
- Why: Avoid breaking atomic accounting while introducing project-specific service ownership.
- Validation: disposable migrated SQLite schema compared with report ->70 tables,70 ownership rows,missing=[],extra=[]; independent seam/projects tests19/19 PASS11.28s.
- Outcome: Partial
- Follow-up: metadata write boundary, final combined checks and physical-store protocol implementation.

### 2026-10-26 — Implement and verify foundation contracts
- Agent: supervisor; workers runtime_path_contract and project_directory_config
- Changed: runtime-paths.ts, project schema/resolve/context/registry and two focused test files; setup documentation.
- Why: Establish validated readable paths and explicit project ownership before changing storage services.
- Validation: `pnpm exec vitest run tests/project-runtime-paths.test.ts tests/project-directory.test.ts tests/projects.test.ts --maxWorkers=1` ->45/45 PASS,10.73s.
- Outcome: Partial
- Follow-up: independent reviews, recursive checks, state/accounting contract and service wiring.

### 2026-10-25 — Capture project-local ownership requirement
- Agent: supervisor
- Changed: new working document and proposed execution phases.
- Why: User requires readable project-local runtime hierarchy.
- Validation: `rg -n 'worktrees|stateDir|dataDir|databasePath' packages/router/src/projects packages/router/src/workspaces packages/router/src/config` -> confirmed deletion hard-codes storage/worktrees.
- Outcome: Partial
- Follow-up: read-only discovery, then concrete implementation plan; no live relocation.

## Open Questions

- Supervisor: determine how shared request accounting stays reconciled while project records
  and artifacts become project-local; preserve audit history without duplicating authority.
- Supervisor: determine explicit project-directory ownership for multi-repository projects.

<!-- Additional read-only brief; no source ownership overlap. -->

### ownership-inventory
- Role: read-only worker; use state-service-contract.md rather than rediscover architecture.
- Own report reports/ownership-inventory.md only; no source/live edits/commits/tests.
- Enumerate every applied schema table and content-bearing columns; classify authoritative
  project/shared/mixed ownership, reference keys and schema validation gaps. Trace direct SQL
  callers of tasks/charges/model_requests across source and group implementation file sets.
- Explicitly flag transaction cross-ownership, content leaked by diagnostics, internal
  qualification/project ownership, global promoted knowledge and captured path fields.
- Propose the smallest same-DB service seam that can be implemented next without changing
  behavior or claiming split storage is complete. Provide concrete constructor/caller APIs.
- Keep report navigable with tables and exact file references. No broad code extraction.
