# Fix: never act on an enclosing repository; no futile repair after a Lab policy refusal (2026-10-27)

Worker: fix-enclosing-repo-and-retry (worker-heavy). Branch `dev`, main checkout, no commits.

## Outcome

Partial. Both fixes are done inside my owned paths and validated. One gap remains: a
repository walk-up in `src/projects/store-provision.ts` is still open. It is the most likely
writer of the real `C:\Users\mrjoh\.git\info\exclude` entry. The file is outside my ownership,
and an existing test (`project-store-provision.test.ts:99`) explicitly encodes the old behaviour,
so it needs your decision. See Open questions, item 1. The patch is ready to apply.

## What changed and why

### 1. Exact-root rule (safety)

- **New `src/workspaces/repository-root.ts`.**
  - It provides `EXACT_ROOT_REV_PARSE`, `parseExactRepositoryRoot`, `exactRepositoryRoot`,
    `isExactRepositoryRoot` and `EnclosingRepositoryError`.
  - One `git rev-parse --absolute-git-dir --git-common-dir --is-bare-repository
    --is-inside-git-dir --is-inside-work-tree --show-prefix` call returns the Git dirs and proves
    the folder is the repository's own root:
    - non-bare: it must be inside the work tree, not inside the Git dir, and the prefix must be empty;
    - bare: the real Git dir must equal the folder.
  - I did not use `--show-toplevel` because it exits 128 in a bare repository, which I probed.
- **`src/workspaces/repository-mutation.ts` (`resolveOwners`).**
  - It uses the exact-root probe in place of the old two-field `rev-parse`, so the process count
    is unchanged.
  - A folder that is not a repository root is refused with
    `RepositoryMutationError("ownership_changed", "... is not a Git repository root; MeritRouter never acts on an enclosing repository")`.
    This happens before any lock is taken.
  - A folder that is not inside any repository still raises the same GitError as before.
  - **Reason:** this one choke point covers all 51 `withRepositoryMutation` callers. Among them
    are `createRepositoryEffects().withWrite`, `runRepositoryCommand` and service-command
    admission, which used to create `meritrouter-mutation.lock` and `meritrouter-commands/` in
    an enclosing `.git`.
- **`src/harness/tools.ts` (`withRepositoryToolWrite`).**
  - The ancestor walk-up is removed. Only the workspace root's own `.git`, or a bare layout at
    the root, creates a fence. That fence then proves exactness itself and fails closed: a broken
    `.git` at the root refuses the write.
  - A root that is not itself a repository gets a plain, unfenced write.
  - **Reason:** every MeritRouter Git effect now refuses non-root folders, so no MeritRouter
    operation on the enclosing repository can race with this write. Writes are still contained by
    `workspacePath`. Real runs inject `repositoryEffects` explicitly (`native.ts:69`,
    `supervisor.ts:344`), so they are unaffected.
- **`src/workspaces/metadata-exclusion.ts` (`ensureProjectMetadataExcluded`).**
  - The exact-root check now runs first, before the index is read or `info/` is touched. Bare
    repositories are refused.
  - It reuses the probe's Git dirs, which saves two `rev-parse` processes per call.
- **`src/workspaces/git-write-topology.ts` (`assertGitWriteTopology`).** It uses the same exact
  probe, also one process fewer.

Sites I reviewed and left alone because they are read-only comparisons or already exact:

| Site | Why it is safe |
| --- | --- |
| `worktree.ts:57` | read-only comparison; the mutation scope that follows now enforces exactness |
| `repair-hydration.ts:131` | read-only comparison; the mutation scope that follows now enforces exactness |
| `worktree-removal.ts:10` | read-only marker scan |
| `repository-command.ts` `gitDirectory` | a cwd subfolder comparison by design |
| `repository-prepare.ts` `trackingRepository` | read-only diagnosis; it refuses `inside_repository` |
| `git-process-policy.ts:180` | already root-verifies every content command |
| `labs/repository-mutation.ts` | already exact |
| `projects/deletion.ts` | already exact |
| `admin/project-settings.ts` | read-only inspection |

### 2. No repair after a deterministic Lab policy refusal (budget)

- **New `src/verification/task-lab-policy.ts` (`taskLabPolicyRefusal`).** It mirrors the gate
  `runTaskLabChecks` applies first, reading the trusted config file. It returns a reason when:
  - `security.outside_repository` is `disabled`;
  - the policy is not `supervisor`;
  - the task's profile mode is not `supervisor`. Lab checks are only valid on coding profiles, so
    a worker run never holds supervisor Lab authority.

  An unreadable config is not treated as deterministic, so the old behaviour is kept.
- **`src/verification/phase.ts`, `verifyRecorded`.** When a refusal applies and the result has no
  Lab evidence, it decides as if no quality retry remained, using the same path as `settle`. The
  refusal reason goes first in `verification.reasons`. The decision is `unmet` with action
  `none`.
- **`src/verification/phase.ts`, `planRetry`.** The same refusal returns `null` before any quality
  repair or execution-failure escalation, and records a `retry_refused` task event with
  `{ reason, tier }`. Under the refusal no retry can produce acceptance, because acceptance needs
  Lab evidence.

### Tests

- **New `tests/enclosing-repository.test.ts` (8 tests).**
  - **Setup.** An enclosing repository is created inside OS temp, with a commit and a pre-filled
    `info/exclude`, and a bare `work/space` folder sits under it. Because it is nearer than the home
    repository, discovery stops there.
  - **Snapshot.** The test hashes every file under the enclosing `.git` before and after each
    operation: `info/exclude`, `index`, `HEAD`, refs, and any lock or receipt.
  - **Refusals proven.** The following refuse, and the snapshot is unchanged afterwards:
    - mutation scope;
    - `createRepositoryEffects().withWrite`;
    - the exclude writer;
    - the write-topology guard.
  - **Unfenced writes.** File tools (write, replace, delete) write unfenced and leave the snapshot
    unchanged.
  - **Positive controls.** An own-root workspace is still fenced, and the exclude writer still
    works there, leaving no lock behind. Linked worktrees and bare roots are accepted. Subfolders,
    `.git` and `.git/refs` are refused. A broken root `.git` fails closed.
- **`tests/task-lab-caller.test.ts`, the "operator-run ordinary checks ... Lab execution refused"
  test.** It now also asserts:
  - `client.requests` has length 2, meaning one attempt and zero extra model requests;
  - the events include `retry_refused`;
  - no `quality_repair`, `retry_started` or `escalated` events;
  - the refusal reason appears in `verification.reasons`.
- **New `tests/verification-lab-policy.test.ts` (3 tests).** It covers the predicate: no Lab
  checks, worker mode, `disabled`, `human_only`, and an unreadable config.

## Commands run and observed results

| Command | Result |
| --- | --- |
| `npx tsc --noEmit` (final) | exit 0, no output |
| `npx vitest run tests/enclosing-repository.test.ts` | 8/8 passed |
| Mutation check: exact-root predicate disabled (temporary env guard, removed) | 4 of 8 failed. Mutation scope and topology resolved to the enclosing `.git`; the action ran |
| Mutation check: old walk-up restored in `withRepositoryToolWrite` (temporary, removed) | "write without any repository fence" failed (bound to the enclosing repo, then refused) |
| `npx vitest run tests/task-lab-caller.test.ts --maxWorkers=1 --minWorkers=1` | 6/6 passed (61 s) |
| Mutation check: `taskLabPolicyRefusal` disabled (temporary, removed) | failed with "expected ... length of 2 but got 4". The repair doubled the requests before the fix |
| `npx vitest run tests/verification-lab-policy.test.ts` | 3/3 passed |
| Serial acceptance: `npx vitest run tests/enclosing-repository.test.ts tests/verification-lab-policy.test.ts tests/security.test.ts tests/project-metadata-*.test.ts tests/verification*.test.ts tests/task-lab-caller.test.ts tests/native.test.ts tests/coding.test.ts tests/project-runtime-activation.test.ts --maxWorkers=1 --minWorkers=1` | 29 files: 28 passed, 1 failed. 350 tests passed, 1 failed, 1 skipped (1080 s) |
| The one failure: `project-metadata-lab.test.ts` "does not equate parent exit with a detached descendant's kernel quiescence" (`service fixture deadline`, a 10 s wait for a detached child's marker) | Rerun alone: passed in 618 ms. A load timing flake in Lab Job process code, which my changes do not touch. That file is in the `project-metadata-*` glob but is not on the brief's named list |
| `ls -la --time-style=full-iso C:/Users/mrjoh/.git/info/` (read-only), before and after the 18-minute acceptance run | Directory mtime stayed 21:44:11 throughout. `exclude` is unchanged since 13:34 |

## Not verified

- The full router suite, `pnpm -r build` and `dist/`.
- `tests/project-store-provision.test.ts`. I did not change store-provision, so it should behave
  as before; it was not run.
- Whether `taskLabPolicyRefusal` stays in step with `runTaskLabChecks`. The two are separate code;
  see Open questions, item 3.
- Other workers had uncommitted edits in the tree during my runs: `src/gateway/capacity.ts`,
  `src/gateway/direct.ts` and `tests/split-slot-settlement.test.ts`.
- What changed `C:\Users\mrjoh\.git\info` at 21:44:11. That was between my two first test runs and
  matches no code path in my tests. The likely cause is another agent's store-provision test; see
  item 1.

## Open questions or contradictions found

1. **Live leak path, outside my ownership.** `src/projects/store-provision.ts:178-186`
   (`excludeFromGit`):
   - It runs `rev-parse --show-toplevel` from the project directory and passes the enclosing
     top-level to `ensureProjectMetadataExcluded`.
   - That top-level is an exact root, so my writer check cannot catch it.
   - For any project directory under `%TEMP%` (every test fixture) it writes or locks
     `C:\Users\mrjoh\.git\info\exclude`. This matches the 13:34 entry, and `exclude.lock`
     creation explains the later `info/` mtime changes.
   - `tests/project-store-provision.test.ts:99` ("excludes metadata in the enclosing repository
     when the project is a subdirectory") encodes the opposite of your rule.

   Proposed patch:
   - In `excludeFromGit`, after the `isGitRepo` branch, add
     `if (!(await isExactRepositoryRoot(projectDirectory))) return;` and call
     `ensureProjectMetadataExcluded(projectDirectory)`. `isExactRepositoryRoot` comes from
     `../workspaces/repository-root.js`.
   - To keep a nested project's enclosing `git status` clean without touching its `.git`, have
     provisioning write `.MeritRouter/.gitignore` containing `*`. The file ignores itself, and it
     sits inside the authorized project directory.
   - Change test :99 to assert that the enclosing `.git` is unchanged (reuse the `snapshot`
     helper from `enclosing-repository.test.ts`) and that status is clean.
2. **Brain walk-ups, outside my ownership.**
   - `src/brain/brain.ts:294-303` (`effectRepository`) walks up from a non-committing mount target
     to any ancestor `.git` and fences that repository. It passes the exact top, so my check
     allows it.
   - `src/brain/mount-git.ts:21` deliberately commits to a parent repository ("even when Git's
     root is its parent").
   - Both conflict with the exact-root rule. Decide whether a brain mount's configured path counts
     as an authorized root.
3. **Lab gate duplication.** `taskLabPolicyRefusal` duplicates the first gate of
   `runTaskLabChecks` (`src/runners/coding/task-lab.ts:162-168`, not owned). I suggest
   `runTaskLabChecks` call it, so the gate and the no-retry decision cannot drift. Two related
   points:
   - `finish.ts` turns the specific refusal error into a generic finding. A structured
     `taskLabRefusal` field on the result would make the decision evidence-based rather than
     recomputed.
   - As the gate is written, a valid Lab-check task (coding profile) can never obtain supervisor
     Lab authority, so every such task is now refused. Before this fix each one spent a full T3
     repair first.
4. **Interpretation choice.** For a workspace root nested inside a repository that it is not the
   root of, file tools now write without a fence instead of refusing. The brief allowed this. The
   cost is that a direct tool call in a subfolder of a real worktree does not serialize with
   MeritRouter Git operations on that worktree. Runner-injected effects still fence normal runs.
