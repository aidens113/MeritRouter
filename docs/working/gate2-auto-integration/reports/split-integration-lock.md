# Report: split-integration-lock

## Outcome

Done within brief, source frozen for supervisor review and wider validation. No live runtime access, provider calls, or application source edits.

## Root cause and repair

The merge queue holds its cross-process branch mutex in `meta` while invoking service callbacks. A split callback re-enters the project registry's role assertion, which previously permitted only the project Brain generation key. Therefore the queue's own lock caused `Project store contains unclassified or shared metadata` during integration.

Changed only:

- `packages/router/src/storage/merge-branch-lock.ts` (new): narrowly shared strict owner/binding schemas and pure metadata ownership validation; no workspace-module import or Git subprocess.
- `packages/router/src/workspaces/merge-queue.ts`: acquisition computes the actual canonical physical Git owner once, binds its hashed branch key to the exact queue item, worktree, queue owner and project-store manifest/generation, and persists the same binding on the queue row atomically with its lock. Queue detail updates retain that binding. Existing nonce-checked heartbeat/release and local-dead-process takeover rules remain. Legacy owner payloads remain readable for mutex contention/takeover but gain no split metadata authority.
- `packages/router/src/storage/store-role.ts`: unknown metadata still fails closed; the only added admission is an exact strict bound lock matching its own supervisor/project, own queue row, stored binding and current store generation. No prefix allowlist, schema bypass, or role-check disabling.
- `packages/router/tests/split-job-auto-integration.test.ts` (new): actual split service, fake provider and real temporary Git project; accept_task integrates A/B and B starts at A's integrated head; no coordination-store queue rows or leaked lock keys. Negative checks reject wrong physical hash/key, job, owner, item, physical owner, branch, project UUID/generation, unknown fields, malformed owner and unrelated shared metadata.
- `docs/operations.md`: documents the bound local mutex and continuing role checks.

## Validation

- Initial fixture incorrectly used the legacy-only `openWithTestSupervisor` helper: failed before product execution (`Private task tools require a project store, not coordination`); switched new fixture to plain `open`, with no host commands requiring approvals. No product source changed for this fixture error.
- Actual red: `pnpm exec vitest run tests/split-job-auto-integration.test.ts --maxWorkers=1` -> **1 failed**, 24.63s, exact metadata refusal through `assertProjectContents -> assertStoreRole -> ProjectRuntimeRegistry.assertPinned/assertCurrent -> ProjectStoreRouter.ofTask`.
- First repair green: same command -> **1 passed**, 40.76s.
- Final identity-bound tree: `pnpm exec vitest run tests/split-job-auto-integration.test.ts tests/project-store-identity.test.ts --maxWorkers=1` -> **20 passed / 2 files**, 46.40s.
- `git diff --check` -> exit 0 (CRLF normalization warnings only).

## Limits and retained artifacts

Supervisor still owns independent typecheck/build, broader queue concurrency/recovery checks, code review and live restart/resume. No full suite rerun by this worker. A pre-existing unbound legacy mutex left in a split store by a crash remains fail-closed on role assertion; this repair does not silently authorize or delete it. Clean failed integration releases its own lock through the existing finally block.

Initial erroneous helper fixture retained `C:/Users/mrjoh/AppData/Local/Temp/meritrouter-test-hXi6rw` after its cleanup encountered EBUSY. Automatic approval review rejected a subsequent verified-path recursive removal; no removal or alternate-tool retry performed. Other successfully completed fixture runs cleaned up normally.

## Independent verification follow-up: refused admission

Supervisor's wider run found six unchanged `project-metadata-merge-queue.test.ts` failures: provisional binding persistence changed queue detail/timestamp before refused target/source admission, recovery or foreign-owner checks. These are real evidence-preservation regressions, not assertions to weaken.

The queue now snapshots the exact raw row before and after provisioning its binding. On `RepositoryMutationError`, nonce-owned lock release restores only this invocation's provisional detail/timestamp if the entire current row still exactly matches that provisional snapshot; cleanup and lock removal share one transaction. Queue progress, changes by another owner and actual persisted side-effect evidence are never rolled back. Added split-service fixture coverage that rejects a foreign source and confirms exact queue-item equality, no metadata lock leak and continued valid store identity. Existing tests were not edited.

Validation command: `pnpm exec vitest run tests/project-metadata-merge-queue.test.ts tests/split-job-auto-integration.test.ts tests/project-store-identity.test.ts --maxWorkers=1` -> **31/31 passed, 3 files**, 72.90s; metadata suite 11/11 (24.21s), actual split integration plus split refusal 1/1 (38.96s), identity 19/19 (5.94s). `git diff --check` exit 0. Final source frozen for supervisor acceptance; no tests running.

Scoped compatibility follow-up: lock metadata validation currently admits the standard `supervise` profile. A custom configured profile with `mode: supervisor` can execute but still cannot use split integration under this validator. Supervisor confirmed the pilot uses standard `supervise`; this pre-existing compatibility gap was deliberately not broadened during the frozen pilot repair.
