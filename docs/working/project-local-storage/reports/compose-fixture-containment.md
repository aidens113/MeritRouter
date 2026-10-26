# Compose virtual fixture containment

Date: 2026-10-26
Worker: selected_commit_resume
Status: frozen; supervisor acceptance pending.

## Reproduction and cause

In the existing metadata-exclusion worktree, ran:

`pnpm exec vitest run tests/compose-engine-contract.test.ts tests/compose-ownership.test.ts --maxWorkers=1`

Baseline: exit 1, 69 passed / 49 failed of 118, 957ms. Engine contract had 26 failures;
ownership had 23. Successful-proof fixtures returned `approval_mismatch`, causing later
negative tests to stop before reaching the mismatch category they intended to exercise.

Both fixtures built fictional approved roots with cwd-relative `path.resolve(...)`.
Here those paths inherited `.MeritRouter/development/metadata-exclusion` ancestors.
The existing production Compose mount checks correctly reject `.meritrouter` in a bind
source path. This is fixture location sensitivity, not a production guard defect.

## Change

Only the two assigned test files changed. Their fictional approved roots and foreign-path
examples now use `path.join(tmpdir(), ...)`, independent of checkout ancestry. Added comments
clarifying these are virtual paths only. No directories or files were created at those
paths; these suites exercise pure contracts and invoke no Docker services.

Every test assertion, test count and production check is unchanged. No runtime permission,
mount containment rule, expected error or timeout was weakened.

## Validation

- First focused rerun after approved-root correction: exit 0, 118/118 passed, 1.03s.
- Final focused rerun after also making foreign examples independent: exit 0, 118/118 passed,
  1.11s. Ownership 80/80; engine contract 38/38.
- `git diff --quiet HEAD -- packages/router/src/labs/compose-ownership.ts
  packages/router/src/labs/compose-engine.ts` -> exit 0; production guards unchanged.
- Reviewed both file diffs: only imports, explanatory comments and fixture path expressions.

No full-suite acceptance is claimed from this narrow rerun. Supervisor owns independent
verification and the prior full-suite 1801 passed / 49 failed / 4 skipped result remains
historical evidence. No provider calls, live Docker, new checkout, commit or push performed.
