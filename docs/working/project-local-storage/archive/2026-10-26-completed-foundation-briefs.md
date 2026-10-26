# Completed or superseded foundation briefs

These are historical. MAIN checkout only; no source-repository .MeritRouter.

### c3-mutation-fence
- Role: implementation worker, existing metadata-exclusion tree, C3.0 source frozen first.
- Read Current State and C3.1 lifecycle fence contract; preserve current message helper.
- Own new workspaces/repository-mutation.ts, attribution/selected-commit.ts,
  workspaces/metadata-staging.ts, new tests/project-metadata-mutation.test.ts;
  own reports/c3-mutation-fence.md. No public wrapper/caller edits yet.
- Cross-process lifecycle locks keyed by physical common Git owner, sorted multi-owner
  acquisition, native index/ref locks retained. Check requested worktree pending publications
  under acquired lease before ANY effects. Unknown/foreign locks preserved, no timestamp theft.
- Opaque host-only reentrancy for nested trusted callers; no raw model/JSON capability.
  Track/drain nested outstanding mutation promises and revoke before releasing. Define clear
  ordering: lifecycle common-owner -> native index/ref; never await under SQLite transaction.
- Integrate selected commit and stage-only entrypoints; preserve internal prepared-receipt
  publication without blocking itself. Surface typed pending effects for future wrappers.
- Real temp concurrent processes/callers, admitted-before-intent refusal, independent owners,
  opposite-order multi-owner acquisition, forged/expired/reentrant/foreign-lock cases.
- Propose API early, focused tests then freeze. No broad checks while other source authors active.
- No live operations, existing callers/shared docs, commits/pushes/new checkouts.

### split-s0-identity
- Role: implementation worker in existing metadata-exclusion tree; no new checkout.
- Read Current State and storage-split-implementation-contract.md S0 decisions/ports.
- Own append-only storage/migrations.ts, new projects/store-identity.ts, storage/store-role.ts,
  new tests/project-store-identity.test.ts and reports/split-s0-identity.md only.
- Add stable UUID + store UUID/generation/role manifests and registration/migration journal
  tables for actual future split. Existing slugs remain public labels; deletion/recreation
  cannot inherit old request authority. Validate persisted/runtime DTOs with strict zod.
- Project role validates only own tasks and no credential/provider/global accounting rows;
  require FULL critical connection durability. Legacy opening unchanged, no activation/move.
- Temp SQLite tests wrong role/owner/generation, fresh slug reuse, malformed rows and
  appended migration upgrade. No live stores/configs/providers/source references copied.
- C3 and Labs authors own separate files; run focused tests only; root broad checks after freeze.
- No commits/pushes/shared docs. Propose API/schema early, implement then freeze exact report.

### project-local-labs
- Role: implementation worker in existing metadata-exclusion tree, no checkout creation.
- Read Current State, runtime-paths/owner config foundation and LabManager/paths/retention.
- Own labs/lab.ts, labs/paths.ts, labs/retention.ts, projects/runtime-paths.ts if necessary;
  new tests/project-local-labs.test.ts; own reports/project-local-labs.md. Propose additions first.
- Implement new Lab root/workspaces/data under owning project .MeritRouter; resolve trusted
  registered project root, never install-root fallback for new Labs. Preserve existing legacy
  rows exactly until explicit checked migration. All creation/read/remove/retention consumers agree.
- Trace Compose guards: blanket .MeritRouter source denial conflicts with owned Lab data.
  Propose minimal safe additional file ownership; only exact authorized Lab subtree may mount,
  never arbitrary project metadata/state/brain/credentials. No broad regex weakening.
- Real temp tests creation/project isolation/unsafe aliases/cleanup/legacy compatibility;
  preserve current service API via trusted project callback if possible. No physical DB split.
- Source author c3_message owns Git plumbing; no overlapping edits. Focused tests only while
  independent source edits active; root serializes broad typecheck/build after freeze.
- No source caller activation outside owned Lab boundary, live data/providers/commits/pushes.

### sibling-worktree-cleanup-inventory
- Role: read-only inventory; own reports/sibling-worktree-cleanup-inventory.md in main checkout.
- User explicitly authorizes cleaning sibling variant folders; never delete or move yourself.
- Inventory twelve D:/SwitchYardRouter-* registered worktrees plus SwitchYardPanelBaseline
  and sy-wt; inspect Git merged identity, tracked/untracked/ignored unique data and link topology.
- Check process command lines, services/tasks known launch references without printing secrets.
- Return exact safe Git-aware removal candidates vs retained-data blockers; do not infer that
  all D:/SwitchYard* paths are disposable. Preserve SwitchYard config and project source roots.
- Root owns cleanup. No source/shared doc edits, builds/tests/live calls or new directories.

### c3-message-implementation
- Role: implementation worker in existing .MeritRouter/development/metadata-exclusion.
- Read Current State and metadata-caller-activation-contract.md C3.0 and compatibility matrix.
- Own new attribution/commit-message.ts, attribution/selected-commit.ts, workspaces/git.ts,
  workspaces/git-process-policy.ts and new tests/project-metadata-commit-message.test.ts only.
- Preserve native commit -m/--trailer bytes under supported safe config; use exact bounded
  stripspace/interpret-trailers plumbing if needed; fail closed for unsupported configurations.
- Native real temp-Git reference matrix: blanks/comments/CRLF/Unicode/existing/duplicate/multiline
  trailers, cleanup modes, safe trailer config, encoding. Preserve setup identity and messages.
- No caller activation yet. Keep raw stdin/env/model authority closed and executable config denied.
- Run meaningful focused tests/package typecheck, freeze, own reports/c3-message-implementation.md.
- No commits/pushes/live operations/new worktrees/shared docs. Report dependencies/blockers promptly.

### storage-split-implementation-contract
- Role: read-only planner in existing metadata-exclusion tree; source author active elsewhere.
- Read Current State, state-service-contract.md and ownership-inventory.md reports.
- Trace service/store/project runtime handle construction and current same-DB seam only.
- Own reports/storage-split-implementation-contract.md; no source/tests/shared docs/build changes.
- Produce exact file-partitioned next implementation briefs for project store split, durable
  global reservations/local preparation/settlement, path activation and migration/rollback.
- Resolve routine design choices, preserve all usage/charges, credentials remain global.
- Prefer smallest complete single-machine boundary; no Postgres/multi-host or live mutation.
- Return actual dependencies, concrete acceptance and any genuinely unresolved authority.

### compose-fixture-containment
- Role: focused fixture investigation/fix, existing metadata-exclusion tree; no new checkout.
- Own tests/compose-engine-contract.test.ts, tests/compose-ownership.test.ts only;
  own reports/compose-fixture-containment.md. No production/shared-document edits.
- Root full result:1801PASS/49FAIL/4SKIP of1854 in1040.21s, failures only these two files,
  chiefly approval_mismatch. Reproduce focused; trace actual refusal before changing anything.
- Hypothesis: pure fictional path.resolve fixtures inherit .MeritRouter checkout ancestry
  and correctly hit metadata policy. If confirmed, use neutral OS-temp virtual fixture paths,
  preserving every assertion and production guard. No writes to user paths or live Compose.
- Verify both full test files; compare unchanged baseline source behavior where practical.
- If production defect instead, report before source edits. No commits/pushes/live calls.

### metadata-caller-activation-contract
- Role: read-only planner in existing metadata-exclusion tree during frozen-source validation.
- Own only reports/metadata-caller-activation-contract.md there; no checkout/source/shared docs.
- Read Current State, metadata-commit-contract report and resumed C2b review limits.
- Trace actual mutation callers: attribution/index.ts, harness/resume.ts, harness collection,
  workspace creation/integration/deletion and project setup; follow direct references only.
- Propose precise file partitions for C3 wrapper activation with unchanged identity/message/
  trailer semantics, typed uncertain/pending handling and pending guards on every mutation.
- Distinguish must-fix preactivation gaps from later migration/state-service work; no fake
  transparent replacement of raw commit-tree message semantics. Include exact acceptance tests.
- Do not implement, run broad tests, call providers, touch live data or commit/push.
- Return actionable contract and any genuine unresolved user decision; preserve frozen source.

### metadata-selected-commit-resume-review
- Role: independent read-only reviewer, existing metadata-exclusion tree; no new checkout.
- Read root Current State, C2b brief, prior metadata-selected-commit-review report and draft diff.
- Own only reports/metadata-selected-commit-resume-review.md in that isolated tree.
- Verify under-lock pending gate, ref/log/object topology, terminal retention/crash semantics
  and complete/refused outcome classification. Run independent real temp-Git probes as useful.
- Check ordinary commit message/trailer compatibility; report source blockers separately
  from unsupported backend/hostile filesystem limitations. Tests/source remain author-owned.
- Coordinate with author if source changes during review; report exact reviewed snapshot.
- No source/shared-doc edits, commits, live data, providers or repository-wide validation.
- Return findings by severity, exact checks and remaining acceptance limits; freeze report.

### metadata-selected-commit-resume
- Role: implementation worker; continue existing C2b draft, no new checkout.
- Directory: D:/SwitchYardRouter/.MeritRouter/development/metadata-exclusion.
- Read Current State and existing metadata-selected-commit brief; inspect local draft first.
- Own only the C2b source/tests already assigned there and reports/metadata-selected-commit-resume.md.
- Finish under-index-lock pending receipt gate, bounded Git write topology checks, and
  unresolved-only receipt scan with sharded terminal retention. Preserve original guarantees.
- Reproduce both prior review blockers and add real temp-Git regressions before acceptance.
- Run focused C1/C2/C2b tests and package typecheck; report exact outputs and freeze changes.
- No existing caller integration, shared docs, live data, provider calls, commits or pushes.
- No directories outside this checkout; temp Git fixtures only in normal OS temp.
- Final report: changed files, verified behavior, exact checks, remaining risks/blockers.

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

### metadata-selected-commit
- Role: implementation worker in same isolated staging branch after root C2 commit.
- Read: Current State, metadata-commit-contract.md and accepted C2 API/source.
- Own: workspaces/git-index-transaction.ts, metadata-staging.ts, git.ts, git-process-policy.ts as necessary;
  NEW workspaces/git-write-topology.ts for bounded native Git write ownership preflight;
  NEW attribution/selected-commit.ts and specifically named publication/recovery module if needed;
  NEW tests/project-metadata-selected-commit.test.ts; own report. No existing caller/Actor edits.
- Build a trusted exact selected-commit API preserving Git positive/negative/literal selection,
  unrelated original staged blobs, ordinary deletions, staged-new/deleted paths and allowEmpty.
  No raw commit --only reread after candidate seal. Two indexes: HEAD+selected current content
  for immutable commit tree, original index+selected changes for final preserved staging.
- Refactor owned C2 lock/cap internals only if needed, retaining all its existing tests/guarantees.
  Reuse bounded selected staging/physical checks; stage worktree bytes once into preserved index,
  derive HEAD-based candidate from immutable selected cached binary diff, never reread worktree.
  Capabilities remain closed host-only with no raw env access; bounded trusted stdin Git plumbing
  may be added for ref transaction. Validate runtime/stored DTOs with zod.
- Create commit-tree from immutable bytes and publish expected-old ref transaction; support
  attached and detached HEAD and unborn. Verify symbolic target atomically where supported;
  detect unavailable Git transaction capability and fail closed, no weak fallback.
- Durably record owned publication intent and preserved index before ref publication. On
  later index failure report exact committed/reconciliation-needed state and retain receipt;
  never auto rewrite/reset HEAD, delete foreign locks, or call uncertain results ordinary refusal.
- Keep all receipts/index backups within owned project/Git metadata, bounded and link-checked;
  no installation-root data. Respect existing Git config/filter/hook restrictions and identities.
- Real temp-Git tests compare exact trees/index entries, author/message/trailer payload,
  paths selecting only B with unrelated staged A, partial B, deletes/newfiles, empty/null cases,
  HEAD/symref races, junction/hardlink before-copy refusal, crash/fault boundaries and recovery
  receipts. No source point may copy unsafe private bytes into Git objects.
- Preserve stage-only API; no migration/runtime/model tool exposure/caller integration/commits.
  Propose API and any genuine blockers before broad refactor; focused tests/typecheck then freeze.

### metadata-selected-commit-review
- Role: independent read-only reviewer in metadata-exclusion isolated tree after author freeze.
- Own report reports/metadata-selected-commit-review.md only; bounded temp probes/tests allowed.
- Inspect new selected-commit,receipt,ref-publication modules and Gitindex/staging/policy diffs.
- Confirm staged-A/partial-B/deletions/newfiles preserve original Git semantics, immutable
  binary/Unicode candidate, no selected private alias bytes, no global renormalization, setup
  identity/message compatibility and Actortrailers. Check copied-index racy state regressions.
- Inspect interactive literalHEAD prepare proof, attached/detached/unborn/sameOID races,
  child death/timeouts/lock ownership, typed uncertain or committed-index-pending states and
  durable bounded validated receipts/backups. No automatic HEAD rollback or foreign-lock cleanup.
- Check host-only capabilities, raw stdin/env denial, callback quiescence and cleanup/faultpaths;
  Windows longpaths flag remains trusted process-local. No source edits/live projects/commits.
- Separate unsupported backend, physical-race and no-caller integration limits from defects.

### compact-runtime-paths
- Role: implementation worker in separate isolated feat/compact-runtime-paths tree.
- Read: Current State, reports/windows-workspace-launch.md and existing runtime-path module/tests.
- Own: projects/runtime-paths.ts; tests/project-runtime-paths.test.ts;
  own report reports/compact-runtime-paths.md only. No Git helper/policy/caller/shared docs edits.
- Resolve actual Windows267-character cwd spawn failure with compact human-readable layoutv2:
  bounded readable labels, shorter structural segments and lowercase case-safe encoding retaining
  at least128bits of stable identity digest. Persist version and names; never rename parsed v1.
- Preserve existing v1 manifest/identity parsing and workspace paths exactly; explicit migration
  required to relocate existing identities. New identities/layout may defaultv2 with strict
  version agreement and manifest collision checks. Propose clean compatibility API before edits.
- Validate supported Windows cwd length before directory creation, fail with actionable shorter
  project root guidance. Keep path containment/alias/namespace protections and Unix support.
- Real temp-Git process launch with typical project root/job/task names, maximal safe names,
  deep application filename and Windows too-long root refusal. Distinguish cwd launch from
  deepGit core.longpaths support; no policy edit (another worker owns it). No globalconfig changes.
- Keep existing safety tests, add v1 roundtrip/unchanged path, v2 encoding/version/alias conflicts,
  actual cwd/process cases. Focused checks only; offline locked deps if needed, no source manifests.
- No commits/live projects/providers or main source/dist edits; notify freeze/report limits.

### compact-runtime-paths-review
- Role: independent read-only reviewer in compact-runtime-paths isolated tree.
- Own report reports/compact-runtime-paths-review.md only; focused tests/probes allowed.
- Read Current State/compact brief and frozen runtime-paths source/test/report. Verify exact
  v1 identity/schema/path compatibility, strict v2/manifest agreement, full128bit case-safe
  encoding, Windows cwd preflight, alias/namespace/link/unknownversion handling and real launch.
- Check ordinary readable names stay recognizable and no implicit migration/source activation.
  Report blockers versus Gitpolicy/deep-path activation prerequisites. No source/live changes,
  commits/main-tree edits or redundant broad builds.

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

