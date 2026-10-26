# C3 workspace and initial-preparation activation

Worker: sibling_cleanup_inventory
Date: 2026-10-26
Status: frozen in MAIN `D:/SwitchYardRouter`; supervisor review/integration pending.

## Files

Changed:
- `packages/router/src/workspaces/worktree.ts`
- `packages/router/src/workspaces/repository-prepare.ts`
- New `packages/router/tests/project-metadata-worktree.test.ts`

Owned `projects/repository-setup.ts` and existing `tests/repository-prepare.test.ts` needed
no edits: propagation from preparation already prevents event writes when a typed error
escapes. Existing assertions remain intact and the new event-boundary regression verifies it.

Frozen SHA256:

| File | SHA256 |
| --- | --- |
| worktree.ts | 72098C121D1B232CE11E0E3EA0F4895295717C870B33A4880857E1C75587C8FD |
| repository-prepare.ts | 2DAB77AA63FA77BEE66D0073117E12C6CBE0251929C6E7766230FD7DCC67D940 |
| project-metadata-worktree.test.ts | C10E9A15F02EEE00F8028F7F7770DDC06473A777FC4F77CB394DEB51637F2593 |

## Behavior

Worktree preparation, collection and removal acquire the authorized physical source Git
common-owner lifecycle lease first. They prove each target/retained worktree shares that
owner before using an opaque reentrant scope to check its own pending publication journal.
A forged target Git owner therefore does not gain a lifecycle lock write in that foreign
owner. Actual effects occur only after source and relevant target admission checks.

Prepare reads the latest persisted workspace pointer UNDER the lease. A caller admitted
before another attempt creates an unresolved receipt cannot overwrite that newer pointer
after waiting. Source identity, managed directory ancestry and native cwd limits are checked;
an upsert comparison protects against concurrent foreign source/alias replacement. Existing
retained worktrees remain evidence. Configured source junction spelling stays in persisted
workspace identity, while trusted Git operations use its physical owner.

Collection uses C2 `stageWithoutProjectMetadata` with the active host capability, then reads
the exact cached binary patch and no-renames status under the same scope. Allowed/protected
globs are validated snapshots; existing rename/deleted-evaluator handling remains unchanged.
Private metadata is excluded before source inspection/worktree creation and cannot be
imported as a staged blob by collection.

Removal verifies managed location, persisted tuple and common Git owner before native Git.
It uses ordinary nonforce worktree removal: dirty/unowned/failed removal retains filesystem
evidence and does not claim `removed`. It rechecks the current pointer after waiting and
updates only the exact task/worktree pair after native removal succeeds. No swallowed Git
error or unconditional removed status remains.

The public host methods have optional final control `{ mutation?, timeoutMs? }`; capabilities
remain opaque and nonserializable, timeout uses the existing bounded lifecycle-lock options.
This lets C3.4 hold an outer fence around a larger trusted runner operation without reacquiring
its own lock. All nested mutation promises register before asynchronous effects.

Repository preparation gates the existing-history fastpath under the lifecycle lease rather
than returning an apparent unchanged success over unresolved intent. Non-Git initialization
retains a canonical-path OS-temp folder lock until it can acquire the new repository's Git
lifecycle lease. Folder locks are never stolen merely by timestamp; release verifies exact
owned inode/content and preserves foreign replacements. Busy diagnostics now disclose that
an interrupted setup can retain a lock. Initial Gitignore/exclusion and snapshot effects run
under lifecycle ownership after Git initialization.

Fixed initial snapshots call `commitInitialApplicationSnapshot` with the active capability
and preserve its setup identity/message. Pending/uncertain `RepositoryMutationError` or
`SelectedCommitError` propagates unchanged through both preparation catch boundaries;
it is not converted into ordinary `git_failed`. A helper `unchanged` result maps to actual
unchanged preparation. C3 attribution author owns the created-empty and independently
published-existing-HEAD helper semantics; their coordinated API names were stable for this run.

Stored workspace rows and relevant runtime DTOs now receive bounded zod validation before
use. No SQLite transaction is held across awaits; Git lifecycle ordering remains outside
individual synchronous row effects.

## Verification

Final MAIN command:

```text
pnpm exec vitest run tests/project-metadata-worktree.test.ts tests/worktree-evaluator-paths.test.ts tests/repository-prepare.test.ts --maxWorkers=1
```

Exit0: **26 PASS**,3 files,182.64s: new12 cases, legacy preparation13, evaluator rename1.
Real temp Git/SQLite cases verify source-pending refusal before directory/row effects;
retained pending pointer preservation; already-admitted caller waiting while a new attempt
gains a real head-published/index-pending receipt; collection/removal preserving that receipt,
HEAD/index bytes and status; no private metadata Git object ingestion; scope/protected output;
configured source junction identity; dirty/forged removal refusal; private initial-snapshot
exclusion/fixed setup identity; history-fastpath/event-boundary refusal; unborn aliases.

The admitted-waiter test uses bounded host timeout30s, not a relaxed production guard or
timed sleep: a real outer source lease admits the waiter, creates a real second workspace
through reentrant prepare, publishes its pending selected commit, then releases the lease.
The waiting call must reject specifically as pending publication and preserve the latest
workspace pointer. Existing default timeout remains unchanged for ordinary callers.

Earlier selected snapshot before final source-first gate/extra concurrency case:25/25 PASS,
188.56s. Superseded by the final26-case result above. `git diff --check` exit0 after freeze.
No broad typecheck/build/full suite was run by the worker during other authors' edits.

## Dependencies and limits

- Ordinary task workspace ROOT activation is S9; this phase does not relocate old or new
  task roots into project metadata by itself. New Lab paths are a separate completed brief.
- Direct synchronous `Worktrees.setStatus` calls in `runners/coding/finish.ts` remain C3.4
  ownership. That caller must hold the outer fence across pointer/status/sealing transitions;
  this phase does not claim all runner writes are already fenced.
- Raw Lab create/refresh/destroy/task-prune mutations and backup/restore also need the C3.8
  remaining-caller audit before broad commitAs activation is accepted. Dirty checks alone
  do not protect an unresolved empty-commit receipt.
- Missing retained worktrees refuse replacement until explicit recovery; no automatic index
  restore/HEAD rewind or foreign-lock deletion is introduced. Crash-retained setup folder
  locks require explicit owner inspection; no dead-owner takeover protocol is claimed here.
- Cooperative locks/physical preflight do not provide an OS sandbox against hostile concurrent
  filesystem swaps or native Git writers bypassing lifecycle locks. No power-loss guarantee.
- No live project/configuration/provider/app code, shared working documents, or source-repo
  `.MeritRouter` directory was touched/created. Tests used ordinary OS-temp fixtures.
- No commits, pushes, alternate checkouts or broad validation; supervisor owns acceptance.
