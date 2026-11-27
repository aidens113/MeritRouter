# Free fixture container grader

Outcome: Done

## Changes

- Added `gradeCodingFixture(taskId, fixtureDir, { image })` in `packages/router/evals/offload/lib/container-grader.mjs`. It supports the five coding fixture IDs and returns actual check output with a fail-closed verdict.
- The host copies data only. The input must be an absolute directory under resolved OS temporary storage outside this repository. Only `src`, `tests`, `package.json`, and `tsconfig.json` are staged. Links, special files, over 256 input entries, and input over 4 MiB are refused. Fixture `.git`, `.env`, dependencies and existing `dist` are not staged.
- Trusted checks and `fixture-build.mjs` are copied from package source. Installed TypeScript, Node declarations and undici declarations are resolved through their package manifests into regular staged trees. No repository directory or package dependency directory is mounted directly.
- Docker receives exactly two read-only staging mounts, no host secrets or inherited Docker host configuration, no network, non-root UID/GID, read-only root filesystem, all capabilities dropped, no-new-privileges, init, one CPU, 512 MiB memory with no additional swap, 64 PIDs, 256 file descriptors, and bounded disposable tmpfs working storage. Only the caller-selected local image can run (`--pull=never`), with a Node 22 runtime check and explicit entrypoint.
- Existing fixture scripts run against the disposable container copy. Their compiler and tests never execute on the host. The inner check has a 100-second timeout and bounded output; host Docker execution has a 120-second timeout and 2 MiB output cap. Finally, only this invocation's UUID-named container is forcibly removed; inability to verify removal fails the result. Host staging is then removed.

## Validation

- `cd packages/router; npx vitest run --no-file-parallelism tests/offload-container-grader.test.ts` -> 12 passed, one file; final rerun at 14:50:31 Phoenix, 1.44 seconds. Docker was mocked for these boundary tests, so no engine, startup, image pull, model call or source execution occurred.
- The tests inspect the staged host paths and their contents during the mocked Docker call, confirm trusted compiler/type/check assets, assert containment arguments and sanitized environment, reject unsafe fixture inputs/images/links/size, inspect exact owned-container cleanup, and cover nonzero checks, unavailable engines, timeout, and cleanup failure.
- `cd packages/router; pnpm typecheck` -> exit 1 after owned strict-index issues were corrected. Remaining observed diagnostics were only another active workstream's `tests/offload-local-baseline.test.ts:43` (possibly undefined iterable) and `:87` (possibly undefined access). Reported to lead; do not edit that file from this brief.

## Not verified / integration limitations

- Actual Docker grading of the reference and broken fixtures awaits the lead's already downloaded Node 22 Linux image and running engine. This worker did not start Docker or pull images, per the brief.
- Full recursive build/typecheck and integration tests are owned by the lead. No runtime or built `dist` changes were made here.
- The grading semantics remain those of the existing trusted fixture check scripts. The container contains model-written execution; this is a synthetic task-quality grader, not a stronger adversarial proof of source correctness. The caller must supply the trusted image. The Docker CLI uses its default local context with inherited Docker configuration variables omitted.

No commits or pushes were made.
