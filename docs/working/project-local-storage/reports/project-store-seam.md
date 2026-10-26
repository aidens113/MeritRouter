# Project store seam implementation

Worker: project_directory_config
Date: 2026-10-26
Status: source frozen for supervisor validation and independent review

## Changed and API

- NEW `projects/runtime-store.ts` defines readonly `ProjectRuntimeStore` with project identity,
  db, tasks, sessions, artifacts and contracts; `createProjectRuntimeStore` validates project
  identity with zod and freezes handle metadata around existing trusted references.
- `projectStoresForTask` verifies handle project, config brain/project identity, supplied task
  owner and current persisted task owner. Reserved `_qualification` is explicitly supported;
  blank historical task ownership maps through the configured primary context.
- `core/service.ts`: public `projectStores(project)` resolves the configured project (unknown
  project fails), returns existing store references, and documents no isolation/relocation.
  Internal `projectDeps` now includes this handle.
- `core/executor.ts`: optional `ProjectDeps.stores`; `depsFor` validates the handle before
  selecting its db/tasks/sessions/artifacts/contracts. Omitted callback/handle retains legacy
  behavior. Runner context uses selected tasks/artifacts instead of unconditionally global refs.
- NEW `tests/project-runtime-store.test.ts`: real temporary services and executor paths.

## Observed validation

- `pnpm exec vitest run tests/project-runtime-store.test.ts` -> final10/10 PASS, exit0,
  4.67s; real executor completion with absent callback, old callback and new handle each
  performs exactly one fake-provider request. Wrong handle/unknown project fail with zero calls.
- Other checks cover same exact existing store refs for two projects, qualification, malformed
  identity, conflicting context, missing/stale task owner, and blank legacy task owner.
- Initial run7/8 passed because test expected summary to carry an error. Existing executor
  records the error in stopReason; corrected assertion, no production behavior change.
- `git diff --check -- packages/router/src/core/service.ts packages/router/src/core/executor.ts`
  -> exit0, no output.
- Root notified source is frozen; combined typecheck/build/full tests not run by this worker.
- After freeze, replaced inline corrupted-context test argument with an equivalent const
  variable to avoid TypeScript excess-property rejection. Assertion and runtime behavior
  unchanged; source re-frozen for supervisor combined checks.

## Limits and next integration work

No database created or split; no path activated, data moved, transaction boundary changed,
admission/scheduler modifications, live provider/user-state operations, commits or pushes.

Identity validation is a trusted service seam, not an ACL/sandbox. The same TaskStore continues
to expose rows of all projects; its methods are not automatically project-scoped by this handle.

Physical splitting is expressly unsafe until remaining root-fixed consumers change together:
`TaskRunLeases` captures original dependencies in Executor constructor; router/gate/admission,
record/usage, finish/review/redundancy, session cleanup and several direct SQL paths continue
to use root stores. Scheduler and service/admin methods likewise remain globally coupled.
The seam must not be described as enabling relocation or separate DB transactions by itself.

Future changes must bind store generation, request/accounting protocol and quiescent ownership
before any resolver returns different underlying store instances. Current handle metadata is
frozen; underlying store objects retain their existing mutability and lifetime.
