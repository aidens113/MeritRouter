# Loop role and dynamic tool policy report
Status: Complete
Worker: loop_role_fix
Date: 2026-10-25

## Changes
- Owned packages/router/src/harness/loop.ts and new tests/supervisor-loop-role.test.ts.
- Detect actual supervisor profile mode, replacing generic implementation/write_file nudge
  with persisted planning, bounded dispatch, review and integrated verification guidance.
- Preserve ordinary coding worker nudge; no changes to approval or editing permissions.
- Added LoopOptions.toolPolicy callback returning allowedToolNames and optional notice,
  or null for unrestricted behavior. Request definitions update each turn; terminal remains.
- Wrapped actual tool execution rechecks policy, including invented calls, a policy change
  between same-response calls, and unfinished intents replayed by actual applyResume.
- Completed historical outcomes remain untouched. Exact notices are deduplicated against
  prior notices and existing user transcript. No product-specific DB dependency added.

## Validation
- pnpm exec vitest run tests/supervisor-loop-role.test.ts tests/harness-repeat-policy.test.ts
  (packages/router): 2 files, 22 tests passed, 3.00s final run.
- pnpm exec tsc --noEmit (packages/router): exit 0, no diagnostics.
- Tests cover supervisor/coding guidance, filtered definitions, invented restricted command,
  same-response policy change, evolving notices, actual resume refusal and retained outcome.

## Limits
- Lifecycle callback and policy decisions belong to the parallel lifecycle worker.
- No real model/paid requests, no app code, no commits, no broad repository validation.
- Generic hook permits terminal submission; terminal validator still owns completion criteria.
