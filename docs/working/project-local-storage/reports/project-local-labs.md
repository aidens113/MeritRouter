# Project-local Labs implementation

Worker: sibling_cleanup_inventory
Date: 2026-10-26
Status: source frozen in MAIN `D:/SwitchYardRouter`; supervisor integration/validation pending.

## Changed files

- `src/labs/lab.ts`
- `src/labs/paths.ts`
- `src/labs/task-attempt.ts`
- `src/labs/task-attempt-runner.ts`
- `src/labs/task-attempt-processes.ts`
- `src/labs/compose-recipe.ts`
- `src/labs/compose-engine.ts`
- `src/labs/compose-ownership.ts`
- New `src/labs/compose-mount-policy.ts`
- New `tests/project-local-labs.test.ts`

All paths above are under `packages/router/`. No retention/runtime-path module edit was needed.

## Implemented behavior

New retained and task-attempt Labs resolve the registered owning project's `projectDirectory`.
Their root is `<downstream-project>/.MeritRouter/labs/<project-slug>/<lab-name>`, with repositories,
data, logs, browser evidence and process-control files beneath that Lab. There is no new-Lab
fallback to installation storage when project ownership is absent or ambiguous.

Creation preflights project/runtime physical containment and supported Windows cwd length,
including the repository cwd. Existing `.MeritRouter` junctions or linked ancestors refuse
before persistent Lab admission or directory writes. Metadata is Git-excluded in each
configured repository before creating nested Lab worktrees.

`LabManager` now supplies one exact current-or-persisted-legacy storage resolver and one
exact-Lab child-path validator. Retained operations and task-attempt create/read/process
identity/stop/prune use those same boundaries. An existing legacy global-storage Lab is
recognized only through its exact persisted ownership row; a fabricated legacy-looking
path does not grant authority. Rows and physical roots are not implicitly moved or rewritten.

The existing `labs/<project>/<name>` depth is intentionally retained beneath the project's
metadata root. Service/browser helpers deriving the storage owner via `lab.root/../../..`
therefore continue to resolve the correct owner for both old and new layouts. Task-attempt
retention invokes the same corrected runner path validators. Ordinary coding-task worktree
relocation is a separate activation boundary and was not changed in this brief.

Configured source repository junction spelling remains supported when the project owner is
canonical. The Git-exclusion preflight uses the physical repository owner, while persisted
repository source/identity spelling is preserved. This does not permit a linked project
runtime directory or linked Lab subtree.

## Compose containment

The blanket metadata bind-source refusal now calls a shared narrow policy from canonical
validation, private engine planning and resource ownership proof. Existing nonmetadata
authority checks remain intact. Private-source admission requires the exact canonical shape
`<project>/.MeritRouter/labs/<project>/<lab>`, the host-approved `repos/<alias>` worktree and
declared `data/` roots. Sibling state/brain/sessions/credentials, other Lab roots, undeclared
data roots, nested `.MeritRouter`, `.git`, socket paths and private container targets refuse.
The existing physical `composeOwnedPath` preflight still refuses source symlinks/junctions.
No schema expansion, model-supplied override, general metadata permission or runtime Compose
activation was introduced. Pure proof routines still consume the existing host-sealed authority.

## Validation

Final MAIN checkout commands/results:

```text
pnpm exec vitest run tests/project-local-labs.test.ts tests/compose-engine-contract.test.ts tests/compose-ownership.test.ts --maxWorkers=1
```

Exit0: **135 PASS** across3 files,10.51s. New17 cases cover real temp-Git creation, two-project
isolation, clean source status, destroy preserving other project/branch, missing owner refusal,
unchanged persisted legacy root, fabricated legacy refusal, configured source junction,
runtime junction/ancestor refusal, and safe/forbidden/crafted Compose private paths.
Existing engine38 and ownership80 cases all passed without changing their assertions.

```text
pnpm exec vitest run tests/labs-task-attempt.test.ts --maxWorkers=1 -t "keeps configured junction spelling"
```

Exit0: **1 PASS /15 selection SKIP**,14.66s. This exact regression initially failed with
`environment_failure`; the dedicated new retained-Lab reproduction exposed
`Git worktree metadata does not belong to its common directory` at the exclusion preflight.
Canonicalizing only that trusted source repository's exclusion operation fixed both cases.
Project runtime alias denial and all ownership assertions remain unchanged.

Earlier isolated-tree focused snapshots passed133 then134 cases before the final source
junction correction. They are superseded by the final MAIN135-case result above. An old
three-file task-attempt/prune/project-deletion run (session25250, native12168) was interrupted
during supervisor consolidation/retired-tree cleanup: **no completed aggregate is claimed**.
The superseded last isolated focused run session47209 was not inspected after interruption;
do not infer a final aggregate from it.

No package typecheck, recursive build or full suite was run by this worker while other
source owners were editing. Supervisor must rebuild `dist/` before full Lab process-owner
kill/adoption tests, since those child fixtures import compiled modules. Full retained-Lab,
task-attempt/prune/project-deletion and browser compatibility remain supervisor checks.

Additional MAIN source-only compatibility run after consolidation:

```text
pnpm exec vitest run tests/labs-service.test.ts tests/labs-compose-validation.test.ts tests/admin-labs.test.ts tests/task-lab-validation.test.ts --maxWorkers=1
```

Exit0: **26 PASS** across4 files,24.00s (service2, read-only Compose client10, admin8,
task validation6). No existing assertions/source changed. Dist-dependent process-owner
kill/adoption tests remain pending the supervisor's rebuilt router signal.

After the supervisor rebuilt router and panel, MAIN dist-dependent regression command:

```text
pnpm exec vitest run tests/labs.test.ts tests/labs-task-attempt.test.ts tests/labs-task-prune.test.ts tests/project-task-lab-deletion.test.ts tests/labs-browser.test.ts tests/labs-scripted.test.ts --maxWorkers=1
```

Exit0: **57 PASS** across6 files,581.67s. Counts: retained Labs18, task-attempt16, pruning11,
project deletion3, actual Chrome browser8 and scripted team1. Verified real cross-process
service adoption/restart, owner death in both fault windows, process/resource cleanup,
foreign listener/source preservation and exact project deletion behavior. Workspace runtime
source remained unchanged for this entire selected snapshot; C3workspace activation began
only after this result. No whole-router aggregate claim is made here.

The approved additional owned test calls actual `validateComposeCanonical` with a real
project-local Lab data directory, then reseals an authority pointing to sibling project
state and verifies refusal. Final new-file run: **18 PASS**,10.49s. Production Lab/Compose
source did not change after the earlier135-case MAIN result.

## Limits and handoff

- Actual downstream projects own their `.MeritRouter` directories. The router source checkout
  is not used as an install-data/development-artifact owner by this work.
- Physical project database separation, ordinary task workspace relocation, live migration,
  rollback and runtime rollout are not implemented by this Lab boundary.
- Existing global Lab rows remain at their exact locations pending explicit migration.
- Physical preflight is not OS isolation against hostile concurrent filesystem swaps.
- New multi-repository projects require the already designed explicit unambiguous project
  directory; errors do not silently choose an installation root.
- No downstream app source, live project/configuration, provider request or Docker resource
  was touched. No new worktree/directory was created by the worker; tests used normal OS temp.
- No commits/pushes/shared working-document edits. Source stayed within the assigned files.
- All worker tests exited before the supervisor's native-module cleanup pause; no further
  native commands were started after that pause.
