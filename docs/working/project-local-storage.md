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
Latest root combined90/90 covers paths31, owner config14, store seam10, metadata reads12,
metadata writes14 and existing projects9. Recursive typecheck/build both passed.
Independent reviews drove drive-qualified Windows paths, case-safe repository identities,
and canonicalized device namespace rejection. State-service contract report is complete;
same-DB project store seam implemented with independent19/19 seam+projects tests passing.
Ownership inventory maps all70 logical tables and55 literal direct SQL caller files.
Read and write metadata boundaries implemented. Review exposed actual Windows junction/
hardlink leakage; corrected bounded physical preflight now excludes unsafe aliases BEFORE
Git grep reads content. Root final combined90/90 PASS23.50s and recursive typecheck PASS.
Independent final metadata12/12 and actual alias probes PASS; root rebuilt-dist probe confirms
only app.txt/PUBLIC returned and both aliases refused. Final recursive build PASS.
Foundation committed locally87feb17; full suite completed exit1:1788PASS/1FAIL/3SKIP
of1792. Only failure: team-integration redundancy plan stub rejects empty parent project
in delegatedSourceSnapshot. Root reproduced unchanged narrow test deterministically.
Fixture corrected only: explicit project on parent/children and no unused source alias;
all original assertions retained plus owner assertions. Root guard/team/store51/51 PASS83.82s
and recursive typecheck PASS. Production guard unchanged; final full rerun pending.
Original JSON output moved after completion into this project's ignored metadata directory:
.MeritRouter/validation/storage-foundation-87feb17/full.json (copy/fsync/SHA256 verified,
then removed own temp original; C:->D: rename refused EXDEV). Not a green aggregate.
No physical separation or migration implemented; nothing from this effort pushed yet.
Next exclusion/preflight helper in isolated feat/project-metadata-exclusion tree under
D:/SwitchYardRouter/.MeritRouter/development/metadata-exclusion. Root established a
Git-local exclude block (preserving prior bytes) before creating that development tree;
git check-ignore confirms it is ignored. This operator setup is NOT product migration.
Full main source run finished; only assigned fixture correction may edit main now.
Windows launch probe found267-character generated cwd fails Node spawning absolute Git,
while short-directory control succeeds, even with core.longpaths=true. Before activation,
compact hierarchy/cwd acceptance must be resolved; see reports/windows-workspace-launch.md.
C1 helper accepted/committed only on isolated feature branch2cb0e0e: root18/18 PASS33.30s,
root isolated package typecheck PASS, independent corrected ignore/capacity probes clear.
It remains unwired and does not guarantee staging. C2 transactional index implementation
assigned in same isolated tree; main source/dist remains frozen for its full suite.
C2 author31PASS/1POSIX-only SKIP (C1+C2) plus typecheck; independent13PASS/1POSIXskip
and expiry/HEADchange/file-redirection probes clear. Root source review read full implementation;
root tests/acceptance still pending. No callers or commit behavior changed.
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

### metadata-exclusion-foundation
- Role: implementation worker, isolated feat/project-metadata-exclusion worktree owned by root.
- Read: Current State; reports/metadata-staging-contract.md C1/exclude/preflight sections.
- Own: NEW workspaces/metadata-exclusion.ts, NEW tests/project-metadata-exclusion.test.ts,
  own reports/metadata-exclusion-foundation.md. No existing source edits/callers yet.
- Implement assertNoTrackedProjectMetadata (HEAD/index, explicit unborn detection, NUL paths,
  fail closed on unreadable/corrupt/unmerged relevant state) and ensureProjectMetadataExcluded.
- Resolve actual Git/common dirs, validate exclude ancestry/file no symlink/junction escape,
  exclusive info/exclude.lock, preserve bytes/newline/idempotency and foreign locks.
- Reject contamination before exclude writes; no index mutations or stage API in this unit.
  Case-insensitive any-depth ignore pattern; linked-worktree shared exclude correctness.
- Real temp-Git tests including pretracked/indexed/forced metadata, staged deletion,
  byte-preserved index on refusal, initial/unborn repo, existing excludes, concurrent calls,
  linked worktree and redirected exclude paths. Keep promise limited to this API.
- Install locked dependencies offline if needed, no source manifest edits. No commits/push,
  live projects/providers or shared docs. Focused checks in isolated tree; report limits.

### metadata-exclusion-review
- Role: independent read-only reviewer in isolated metadata-exclusion tree.
- Read: Current State and C1 brief; inspect new helper/tests and author report.
- Own isolated report reports/metadata-exclusion-review.md only; focused tests permitted.
- Verify contamination refusal before writes, unborn/corrupt/unmerged semantics, Git common/
  worktree directory ownership, links/foreign locks, byte preservation and pattern precedence
  limitations. Check existingpattern pluslaternegation, bare repo and missing info handling.
- Distinguish helper foundation from transactional staging/activation; no source/live edits,
  commits or shared docs. Main full suite source must remain untouched.

### metadata-index-transaction
- Role: implementation worker in isolated metadata-exclusion feature tree, after root C1 commit.
- Read: Current State; reports/metadata-staging-contract.md C2; accepted exclusion helper;
  git.ts/git-process-policy.ts. Preserve their executable config/hook/filter protections.
- Own: workspaces/{git,git-process-policy}.ts; NEW workspaces/metadata-staging.ts;
  NEW workspaces/git-index-transaction.ts if needed; NEW tests/project-metadata-index-transaction.test.ts;
  own report reports/metadata-index-transaction.md. No existing callers or C1 helper edits.
- Implement host-owned opaque active alternate-index capability; raw/env/forged/replayed/
  cross-repo index overrides remain denied. Never generally allow GIT_INDEX_FILE from callers.
- stageWithoutProjectMetadata holds native index.lock, snapshots original index/HEAD,
  uses owned temp index, pre/postflights, fsync/publishes only on success and preserves original
  index bytes on every staging refusal/failure. No commit/HEAD mutations in this unit.
- Validate Git metadata ancestry and lock ownership, unborn/no-index cases, cleanup only own
  temp/locks, old foreign locks untouched. Keep original positive/negative pathspec semantics;
  explicit empty selection must not stage all. No unbounded arguments/scan or filesystem fanout.
- Name exclusions alone do NOT stop Windows junction/hardlink aliases (reader repro): inspect
  selected physical worktree inputs before staging, refuse/skip private aliases without copying
  their bytes, preserve ordinary tracked deletions. Revalidate temp-index candidates before publish.
- Real Git tests: raw/forged capability refusal, success/revoke/wrongrepo, staged unrelated files,
  actual junction/hardlink private aliases, metadata force/negated ignore, wildcard selection,
  pre/postflight failure index-byte preservation, native foreign lock, concurrent calls, deleted
  files, unborn, linked worktree independent indexes, cleanup. Use fakes/temp only.
- Root reviews commitAs --only integration design separately; do not claim C3/commit transaction
  or full physical isolation is done. No permission broadening/source-identity changes/live
  projects/providers/commits/shared docs. Focused tests/typecheck then freeze for review.

### metadata-commit-contract
- Role: read-only design worker in isolated metadata-exclusion tree.
- Own report reports/metadata-commit-contract.md only; no source/fixtures/live changes.
- Read frozen attribution/index.ts, harness/resume.ts, workspaces/worktree.ts,
  workspaces/repository-prepare.ts and C1/C2 staging contract. C2 implementation in progress;
  do not infer stable API from its partially edited files.
- Proposed C2 only stages via host-owned temp-index capability, never commits/updates HEAD.
- Resolve C3 commitAs --only behavior: preserve positive/negative trusted pathspec semantics,
  unrelated staged app changes and attribution; Git --only rebuilds from worktree, so a clean
  temp index alone is insufficient. Cover physical junction/hardlink aliases too.
- Recommend smallest safe integration with exact selected candidate validation and clear
  distinction among refusal, staged-but-not-committed failure and uncertain HEAD update.
  Do not propose automatic history rewrite or clearing unknown effects. No permission changes.
- Specify ordering before resume abort/reset and initial snapshot; provide bounded file briefs,
  actual Git proof tests and any genuine architectural blockers. No tests/builds/commits.

### team-plan-fixture-correction
- Role: focused worker, MAIN tree only; C2 remains isolated and must not be edited.
- Own: packages/router/tests/team-integration.test.ts ONLY and
  reports/team-plan-fixture-correction.md. No production source/shared docs changes/commits.
- Root reproduced only full failure via -t 'plan_work records and passes redundancy'.
  Raw TaskStore stub inserts parent with empty project; actual service registers/backfills
  project before run, new source guard correctly requires matching nonempty parent identity.
- Verify cause, correct fixture project/service behavior. Redundancy-only test should not
  fake source provenance: use valid no-repository setup if no files needed, or real tempGit
  if keeping repositories. Preserve all existing redundancy/supervise assertions.
- Do not weaken guard, skip test, increase timeout or change unrelated cases. Run exact
  regression then complete team-integration file. Report what changed/verified and freeze.

### metadata-index-review
- Role: independent read-only reviewer in isolated metadata-exclusion tree.
- Own report reports/metadata-index-review.md only; focused tests/probes allowed temp only.
- Read C2 brief and frozen git-index-transaction.ts,metadata-staging.ts,Git helper/policy
  diff,new tests/author report. Check opaque cap origin/lifetime/repo/commands, no env escape,
  pending-command drain, native lock/temp ownership, index-byte preservation and HEAD CAS.
- Probe actual selected physical aliases/metadata before Git object ingestion, deletions,
  positive/negative/literal pathspecs, cleanup/faultpaths and linked-worktree indexes.
- Distinguish stage transaction from commit publication/hostile FS race; preserve existing
  Git executable-config restrictions. No source/live changes/commits or main validation edits.

### storage-discovery
- Role: read-only worker; do not change source or live runtime state.
- Read: this Current State; start at src/workspaces/worktree.ts, src/projects/deletion.ts,
  configuration schema and core service; follow only relevant storage consumers.
- Scope: map project-owned versus shared paths, relocation consumers and migration risks.
- Report: docs/working/project-local-storage/reports/storage-discovery.md only.
- Return: concrete file/function references, recommended file partitions, checks needed,
  unknowns; distinguish inspected facts from proposed design. No commits or pushes.

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

## Work Ledger

### 2026-10-26 — Verify and commit isolated exclusion preflight
- Agent: supervisor; workers project_directory_config and runtime_path_contract
- Changed: isolated feature branch2cb0e0e adds metadata-exclusion helper/tests/reports only.
- Why: Protect existing tracked/indexed data and preserve effective private ignore rules before staging integration.
- Validation: root isolated18/18 PASS33.30s and package typecheck PASS; independent effective-negation/maxsize probes clear after two corrections.
- Outcome: Partial
- Follow-up: C2 host-owned transactional staging, C3 caller integration and exact-source guards; no activation yet.

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
