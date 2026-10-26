# Independent review: same-database project store seam

Reviewer: project_storage_discovery
Date: 2026-10-26
Disposition: no blocking finding in the bounded same-DB seam.
Scope: `projects/runtime-store.ts`, current diff of `core/service.ts` and
`core/executor.ts`, and `tests/project-runtime-store.test.ts`; relevant executor run paths
and registry owner handling inspected. No implementation/shared documentation/live changes.

## Findings

No source defect requiring correction found for the brief's behavior-preserving foundation.
The production service supplies its existing DB/tasks/sessions/artifacts/contracts by reference;
the new handle neither constructs a store nor creates paths, connections or transactions.
The implementation correctly describes itself as transitional and does not claim isolation.

`projectStoresForTask` validates handle identity, configured brain project, optional project
context slug, stored task snapshot project, and current persisted owner from TaskStore.projectOf.
A missing task returns null from projectOf and is rejected, including an empty-owner snapshot.
Unknown configured projects fail through service.projectContext before runner/provider routing.
Reserved `_qualification` is explicitly allowed. Empty legacy task project resolves through the
configured primary while still requiring the current stored owner to remain empty.

Executor depsFor preserves no-callback/legacy callback behavior and validates a provided handle
before Labs binding and router preparation in both runSingle and runBatch. Runner contexts now
use selected tasks/artifacts; session opening and verification receive depsFor dependencies.
The public service's handles always select the same original references, so unchanged global
run lease, Gate, router, admission, scheduler, contract compilation and final recording paths
continue to operate on the same DB and stores. No transaction ordering or persistence contract
was changed by this diff.

## Nonblocking limitations to keep explicit

- `createProjectRuntimeStore` is a trusted-reference factory, not an untrusted store validator
  or per-project authorization wrapper. Its current identity checks cannot establish that
  arbitrary caller-supplied stores all use one connection. Production construction supplies
  the exact existing references; a later external/physical-store constructor must validate
  its connection/ownership contract separately.
- This is not ready to substitute truly distinct stores. Executor's TaskRunLeases constructor,
  endSession, contractFor, upstream injection, extraRequests, Gate/router and final recording
  still retain original executor dependencies in several paths. That is consistent with this
  same-DB brief; switching only a handle later would produce a partial and unsafe split.
- Tests exercise completion behavior and owner rejection, plus production multi-project
  behavior through existing projects tests. They do not prove cross-DB routing, migration,
  permission isolation, or coding/supervisor runtime storage activation; none is claimed here.
- Service returns a fresh frozen handle on each accessor call while keeping every store
  reference unchanged. Stable handle object identity/caching is not required by the written
  implementation brief and is not needed for current correctness.

## Independent verification

Ran from `packages/router`:

```text
pnpm exec vitest run tests/project-runtime-store.test.ts tests/projects.test.ts --maxWorkers=1
```

Observed exit 0: **2 files, 19 tests passed**, 11.28 seconds.
The new seam file contributed 10 tests; existing projects tests contributed 9.
No test source was changed and no real provider was called.

Read the actual executor single/batch dependency-selection, runner context, session, contract,
lease and recording paths; did not infer correctness solely from the worker's report.
Recursive typecheck/build/full-suite verification remains the supervisor's integration check.
