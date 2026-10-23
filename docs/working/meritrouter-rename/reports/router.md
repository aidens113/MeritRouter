# Router rename report

Status: Complete, source frozen for supervisor acceptance
Worker: worker_containment
Date: 2026-10-23

## Changes

- Renamed the public class/options/error to `MeritRouter`, `MeritRouterOptions`, and `MeritRouterError`; renamed CLI, MCP identities, environment variables, defaults, help, service names, scripts, charters, examples, and test fixtures throughout the owned router tree.
- Canonical defaults are `meritrouter.config.yaml`, `.meritrouter`, `meritrouter.db`, `MERITROUTER_*`, and new Git branches under `meritrouter/`. Explicit configuration paths preserve configured relative storage/repository/brain paths and branch prefixes.
- Renamed the example to `examples/meritrouter.config.example.yaml`. Ran `node packages/router/scripts/build-presets.mjs` to regenerate all four generated presets.
- Existing explicit-storage databases open in place: `meritrouter.db` wins when present; otherwise `switchyard.db` is selected only within the chosen storage directory. No automatic discovery, copy, move, or deletion of old installation data. Backup and daemon status use the same selection; new backups use the canonical filename. Explicit forced restore preserves legacy databases and sidecars in its existing previous-state directory.
- Existing Lab ownership markers are accepted only when the canonical marker is absent, through the same path and exact persisted identity guards. Both process-host marker generations still require the exact persisted token and process identity proof. Exact old task-Lab branch names remain eligible for cleanup only when project, attempt, repository, and target match.

## Deliberate compatibility identifiers

- `switchyard.db`: fallback in the explicitly selected storage only.
- `.switchyard-lab.json`: read fallback; new Labs write `.meritrouter-lab.json`.
- `SWITCHYARD_LAB_HOST_V1`: existing process proof only; new wrappers use `MERITROUTER_LAB_HOST_V1`.
- `switchyard/task-lab-*`: exact derived persisted task-attempt ownership only; new branches use `meritrouter/`.
- `.switchyard-brain.lock` and `switchyard-prepare-<hash>.lock`: stable cross-version exclusion protocols, retained deliberately to prevent concurrent old/new writers. Brain Git and backup exclusions use the actual retained legacy lock. No new brain lock name is written.
- `--sy-lab-token`: stable internal process ownership protocol flag, retained with exact-token checks.
- Regression fixtures explicitly reference the above old identifiers and an old configuration filename/storage/branch prefix. Remaining active branding and public contracts use MeritRouter.
- Applied storage migrations are unchanged (verified no diff).

## Validation

- First focused run exposed an incorrect test-only placement of `branch_prefix` under `coding`; corrected fixture to the existing `supervisor.branch_prefix` contract.
- `pnpm --filter meritrouter exec vitest run tests/rename-compatibility.test.ts tests/packaging.test.ts tests/operations.test.ts tests/brain.test.ts`: **43/43 passed**, four suites. Covers discovery and platform defaults, portable fake panel launch, backup/restore, daemon/service behavior, and brain locking/Git scope.
- Added exact old/new task-Lab branch ownership regression; reran `pnpm --filter meritrouter exec vitest run tests/rename-compatibility.test.ts`: **7/7 passed**. Canonical public symbols, explicit old config preservation, legacy DB reuse, canonical DB precedence, backup/forced-restore preservation, marker precedence, process-token proof, and derived branch cleanup are covered. Total distinct focused cases: **44**.
- Remaining old-name inventory inspected with `rg`; only the documented compatibility protocols and their tests remain in owned source/examples/scripts/charters/tests.

## Boundaries and outstanding supervisor checks

No commits, broad build/typecheck/full test suite, paid providers, live user configuration, user panel, external project operations, or checkout directory rename were performed. Parent owns package.json and package README; those were excluded from worker edits. Parent must run integrated router/panel builds, full suite, and packaged CLI/MCP acceptance after source freeze. Hosted repository rename is parent-owned and not verified by this worker.
