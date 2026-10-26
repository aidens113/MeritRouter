# Project metadata exclusion implementation plan

Worker: runtime_path_contract
Date: 2026-10-26
Scope: read-only source inspection; no source/tests/live state changed.

## Findings

1. `context/repo-reader.ts:normalizeRelPath` refuses Git internals, but not `.MeritRouter`.
   `readFile` reads directly even when a path is ignored. Pinned reads use Git show and
   therefore expose metadata already tracked at an old commit. `resolveWorktreePath`
   checks only realpath containment: an ordinary symlink to metadata inside the repository
   can bypass a lexical metadata-name filter unless its resolved target is checked too.
2. `RepoReader.listFiles` runs ls-tree or ls-files cached+untracked; it returns tracked
   ignored files too. `search` runs Git grep over tracked and untracked source, including
   pinned tracked metadata. Ignore rules alone do not enforce either read boundary.
3. `context/sources.ts:loadSources` uses RepoReader for explicit fileRefs, so a guarded
   RepoReader covers source injection through that route as well as legacy repo tools.
4. `harness/tools.ts:workspacePath` centralizes legacy write/replace/delete authority.
   `harness/edit-operations.ts:apply_edits` calls it during batch preflight and each edit.
   It currently prevents symlink/hard-link mutations and config-file writes, not metadata
   paths. No separate move/rename tool was found in inspected harness operation files;
   any future move must validate BOTH source and destination, including directory ancestors.
5. `workspaces/worktree.ts:collect` executes `git add -A` BEFORE examining scope/protection.
   Thus adding protected-path globs merely detects leakage after the index contains it.
   `attribution/index.ts:commitAs`, `harness/resume.ts:reconcileRepo` and
   `workspaces/repository-prepare.ts:prepareLocked` also stage broadly. Every route matters,
   including first repository snapshot and interruption recovery.
6. `harness/worker-actions.ts:workerSourceIdentity` hashes HEAD, binary tracked diff, and
   untracked nonignored files read through RepoReader. Metadata currently can enter the diff
   or untracked payload, invalidate approvals as runtime logs change, or hit file-size limits.
   `harness/checked-task-candidate.ts` and `attribution/checked-candidate.ts` additionally rely
   on exact index/tree/diff/untracked checks. Those checks must retain exact application
   identity while refusing contaminated candidates; silently dropping a tracked metadata
   path from the identity would incorrectly weaken checked-source evidence.

## Proposed file partitions and order

### A. Shared metadata policy plus repository reads
- Own NEW `projects/metadata-policy.ts`, `context/repo-reader.ts`, focused new tests.
- Expose pure segment/path predicates and assertion; keep the policy separate from runtime
  directory creation. Match `.MeritRouter` case-insensitively, include legacy lowercase,
  normalize separators and refuse Windows trailing-dot/space aliases and relevant short-name
  access through physical containment. Decide explicitly whether any matching segment is
  reserved globally; recommendation: reserve it at any depth, avoiding nested-project leaks.
- Direct reads refuse lexical AND resolved physical metadata targets, including pinned reads.
  Listing filters before truncation; search must exclude before returning any text. Prefer
  Git negative pathspecs plus defensive output-path filtering rather than only output filtering
  after metadata has consumed buffer/limits. Preserve legitimate grep/pathGlob behavior.
- Audit read-operations/batch adapters to confirm all repository input routes use this guard.

### B. Harness mutation boundary (after A freezes its API)
- Own `harness/tools.ts`, `harness/edit-operations.ts` only if needed, new harness tests.
- Reject metadata before mkdir/read/hash/write/delete, irrespective of allowedPaths/guard.
  Batch with one metadata edit fails preflight without earlier file effects. Keep existing
  link and hard-link safeguards. Metadata-policy requests cannot grant extra capability.

### C. Git exclusion and staging boundary
- Own NEW `workspaces/metadata-exclusion.ts`, `workspaces/worktree.ts`,
  `workspaces/repository-prepare.ts`, `attribution/index.ts`, `harness/resume.ts`, new tests.
- Establish validated Git-local exclusions BEFORE runtime files or initial snapshots.
  Resolve actual Git info/exclude through trusted Git plumbing, preserve existing bytes,
  handle linked worktree/common-directory semantics and locking; do not trust ignore alone.
- Add a shared safe staging preflight: refuse metadata already tracked/indexed, exclude
  metadata from broad staging, verify index before commit. Do not silently unstage/delete
  user files, rewrite history, or mutate an existing contaminated index as a side effect.
- Explicit paths supplied to commitAs must also be guarded; broad pathspec exclusions must
  not accidentally ignore unrelated app files. Negative .gitignore rules and forced staged
  metadata cannot bypass the index gate. Existing metadata-bearing HEAD requires an explicit
  repair/migration path, not broad commit or hard-reset rescue.

### D. Source identity and exact-candidate proof (serial after C)
- Own `harness/worker-actions.ts`, `harness/checked-task-candidate.ts`,
  `attribution/checked-candidate.ts` and new focused tests as needed.
- Refuse tracked/indexed metadata contamination before diff/source capture; ignore only
  proven private untracked runtime state. Keep HEAD/exact checked application tree unchanged.
- Runtime log writes alone must not expire approval source identity or dirty a valid candidate;
  application edits must still invalidate it. Recheck contamination at sealing/publishing.
- Introduce no reuse of approvals with changed cwd/source. Preserve historical digests.

## Required real-Git verification

- Root/nested metadata, mixed case, backslashes, direct read, fileRefs, pinned tracked files,
  root list, explicit metadata directory/glob, grep, batch reads and resolved in-root symlink.
- Create/patch/replace/delete refusal; one forbidden batch element causes no mutation.
- New repo snapshot, worker collect, per-response commit, recovered edits and candidate seal:
  metadata never staged; pre-staged/tracked metadata refuses before additional index mutation.
- Existing excludes retained, negative ignore rules, linked worktree, Windows casing and
  junction/short-name alias where supported; no accidental app exclusion.
- Approval identity unchanged by private untracked log update, changed by app edit; exact
  candidate never accepted with private content in index or HEAD.

These are recommendations, not implemented or tested behavior. Ignoring filesystem paths
does not stop an approved arbitrary shell command from reading them or printing them into
model-visible output. Stronger command containment/output isolation is a separate boundary;
do not claim metadata can never reach ANY model input from repository filters alone.
Explicit authorized Brain/artifact tools are intentional project-memory access and should
remain scoped rather than be confused with unrestricted repository metadata access.
