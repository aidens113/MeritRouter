# Exact metadata-safe commit integration contract

Worker: runtime_path_contract
Date: 2026-10-26
Status: read-only design; no C2 implementation/API or staging integration accepted here.

## Source facts

- `attribution/index.ts:commitAs` stages all or caller pathspecs, then optionally runs
  `git commit --only -- <pathspecs>`. The latter builds selected content from the worktree;
  a clean published index alone does not constrain the bytes that command will read.
- Brain callers intentionally supply `:(literal)` paths and positive/negative mount scopes;
  adoptExternalEdits uses `[".",":(exclude).switchyard-brain.lock"]` for its own root.
  These are trusted Git pathspecs, not filenames. Preserve their selection via Git evaluation.
- Worktrees.collect captures the full cached diff after staging. Resume aborts cherry-pick/
  revert before staging and may reset hard; current order performs destructive effects before
  metadata contamination checks. Repository preparation initializes Git, optionally writes a
  default ignore file, stages and creates a first/empty commit; history fast-path is unchanged.
- Existing checked-candidate code demonstrates commit-tree plus expected-old update-ref,
  but does not preserve an arbitrary unrelated staged index for a path-selected commit.
  Do not reuse it as a complete commitAs transaction without extending that contract.

## Decision: C2 staging alone is not an exact commit transaction

Do not wrap `commitAs` with C2 staging and claim exact checked-candidate safety while retaining
raw `--only` worktree re-reading. A physical alias may change after staging; unrelated staged
entries must also remain staged, without entering a selected commit. A second physical
preflight narrows the window but cannot turn a later worktree read into immutable bytes.

The smallest honest weaker C3 would physically validate immediately before `--only`, preserve
trusted pathspecs and refuse contamination, with an explicit check/use race limitation.
That does not satisfy the stronger exact selected-tree contract. Prefer the following bounded
trusted candidate extension before switching commitAs; keep C2 stage-only API unchanged.

## Proposed exact selected-candidate extension (C2b prerequisite)

1. Resolve actual Git/index ownership, establish C1 excludes, acquire native index.lock and
   snapshot original bytes plus expected HEAD and symbolic branch target. Refuse sequencer/
   merge states this helper cannot reproduce; do not silently create a one-parent merge commit.
2. Have Git evaluate the original positive/negative pathspecs against tracked plus eligible
   untracked paths, with NUL-delimited names and ordinary deletion handling. Empty explicit
   selection stays empty; omitted paths means all. Bound names/arguments/fanout; use existing
   trusted index capability rather than allow raw GIT_INDEX_FILE or shell plumbing.
3. Inspect selected physical paths BEFORE copying bytes into any index/object store. Reserved
   components, junction/symlink aliases to private/outside targets and nlink>1 refuse or skip
   according to one explicit policy. Recommended: refuse selected unsafe paths, not silently
   create a partial requested commit. A missing tracked file is a deletion, not an alias failure.
4. Build an isolated candidate index from expected HEAD (empty tree for unborn), apply only
   the Git-selected worktree changes through validated literal paths. Capture its immutable
   tree and verify the complete tree contains no reserved metadata. This mirrors --only:
   selected current worktree content, HEAD content outside selection, no unrelated staged data.
5. Separately prepare the postcommit index from ORIGINAL index, applying selected changes
   while preserving unrelated staged entries exactly by mode/blob/stage. Validate full index.
   Nonselected private index contamination refuses even if it would not enter this commit.
6. Create commit object from immutable candidate tree with existing attribution/trailers and
   expected parent, using trusted Git plumbing; never re-read selected worktree via --only.
   Publish via expected-old ref compare-and-swap (or create-if-unborn), with symbolic target
   verification. No force/reset/revert to repair an unexpected external HEAD change.
7. Publish prepared postcommit index through owned index.lock. HEAD and index publication are
   NOT one atomic operation: record an owned bounded recovery receipt before publishing HEAD,
   with expected old/new identities and index digest. A failure after ref publication reports
   committed/index-reconciliation-needed; preserve original staged snapshot for explicit
   recovery. Do not claim ordinary "nothing committed" or automatically roll back HEAD.

No new permission/command capability belongs to model input. Internal Git capability extends
only trusted code paths; author/committer identity and executable-config restrictions remain.

## Outcome contract and failure handling

| Boundary | Honest result |
| --- | --- |
| Contamination/selection/lock refusal before publication | Refused, HEAD and original index unchanged; excludes may have been established |
| C2 stage succeeded, later ordinary commit fails before ref change | Staged-but-not-committed; do not describe as unchanged index |
| Commit object made but ref CAS refuses | No owned HEAD publication; object may be unreachable; original index stays unchanged |
| Ref publication completed, index publication failed | Committed, reconciliation required; identify exact new commit and preserve receipt |
| Transport dies during ref publication | Uncertain until exact ref/receipt inspection; do not retry blind or clear effects |

Public `commitAs: Promise<string|null>` cannot express all these states by return value alone.
Use typed errors/receipt IDs while preserving its success return contract; callers must not
swallow uncertainty and report success. No automatic history rollback or unknown-lock removal.

## Exact C3 file briefs after C2/C2b acceptance

### C3a — noncommit staging and initial preparation
- Own workspaces/worktree.ts, workspaces/repository-prepare.ts and new integration tests.
- Replace collect broad add with accepted C2 stage API, then capture exact cached diff.
- Initial folders: after Git init and before initial add/snapshot, establish C1 excludes;
  validate unborn state before generating default ignore/snapshot side effects where possible.
- First commit uses accepted candidate-commit API including allowEmpty. Existing history
  fast-path remains documented; it does not imply activation/exclusion is established there.
- Test plain-folder metadata, unborn/prestaged contamination, empty initial commit, normal
  deletes/renames, refused index byte identity and no ignored private object staged.

### C3b — attributed exact commit integration
- Own attribution/index.ts and new tests/project-metadata-commit.test.ts.
- Route commitAs through accepted C2b; preserve Actor, message, trailers, allowEmpty, positive/
  negative/literal Git pathspecs and unrelated staged changes. No generic raw env override.
- Cases: staged A, worktree A differs, select B; commit contains only B and A remains staged
  exactly as before relative to new HEAD. Select deleted path, wildcard plus exclude,
  Brain mount pathspecs, --only equivalents, empty selection, allowEmpty and unborn branch.
- Actual junction/hardlink selected paths refuse BEFORE object/index content import. Fault
  injection after staging, before CAS, after CAS and before index rename checks outcome states.
- Verify commit tree exactness, author identity/trailers and bounded lock/temp cleanup.

### C3c — interruption recovery (serial after C3b)
- Own harness/resume.ts and new recovery integration tests.
- Read-only contamination/physical preflight BEFORE abortSequencer, reset or staging. For
  reset, ensure metadata aliases do not permit overwriting private data; refusal preserves
  index, worktree, sequencer markers and pointer. Do not abort then discover preflight failed.
- Repeat preflight after an authorized abort because HEAD/index may change. Surface abort
  failure; existing blanket catch must not pretend successful reconciliation.
- Use C2/C2b for commit recovery and update pointer only after exact commit success. Handle
  committed-but-index-uncertain separately; avoid falsely recording previous head as complete.

## Validation limits

Only named source reads/searches and contract review; no tests, fixtures, source edits,
live operations or commits. C2 implementation was deliberately not inspected while editing.
The additional immutable commit/recovery contract is a genuine prerequisite to the strong
claim; it is not delivered by this report. Hostile filesystem swaps remain beyond the
preflight isolation guarantee even with immutable Git candidate capture.
