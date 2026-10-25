# Bounded model handoff after genuine stalls

Status: Ready for supervisor review and integrated validation.

## Observed cause

`runAgentLoop` previously returned `stalled` immediately after detecting a repeated
observation/effect. The coding runner turned that into task failure, even if another
eligible endpoint and request budget remained. A supervisor's new task could then pick
the same endpoint again. Existing `ask`/Gate already supports hard endpoint exclusions
and checks current eligibility before physical dispatch.

## Changes

- `packages/router/src/harness/stall-handoff.ts`: task-local strict zod receipts of actual
  Gate endpoint stalls. Restores receipts by task/event type without timeline pagination.
  They are observed task failures, not global model grades. Recovery avoids previously
  stalled endpoints and all priced/native-paid-search candidates. Receipt writes recheck
  current task authority after awaited response commits.
- `packages/router/src/harness/loop.ts`: after quiesced calls and response commits, records
  the actual endpoint and hands the same transcript/workspace to another eligible free
  candidate. Preserves effect deduplication, original task charges, authority and deadline;
  resets only observation history, endpoint stickiness and serving-context allowance.
  Each endpoint can stall once per task; interruption does not clear exclusions. A sole
  candidate retains the legacy `repeated_tool_call:*` result. Exhausted alternatives return
  `model_handoff_exhausted:*` without another provider charge. Gate remains the routing,
  size, supervisor-quality, capacity and admission boundary. Host compaction that removes
  structured proof for a protected effect records a typed receipt. A resumed handoff with
  that receipt throws `model_handoff_unprovable_effect_history` before `applyResume`, model
  requests, or native final-check execution, even when the new route plan is empty.
  Read-only compaction does not create an effect-proof loss receipt.
- `packages/router/tests/model-stall-handoff.test.ts`: 21 regressions including actual
  native execution with fake providers, finite endpoint exhaustion, request ceilings,
  cancellation/deadline, priced alternative refusal, unchanged effect dedupe, and persisted
  exclusions/effects after interruption and more than 500 unrelated events. Actual native
  resumed execution with a pending command confirms zero model requests/actions/checks and
  unchanged retained source when effect history is unprovable.

No app, live state, configuration, paid settings, budget limits, commits or builds changed.

## Validation observed by worker

- `pnpm exec vitest run tests/model-stall-handoff.test.ts --maxWorkers=1`: initial10/10,
  8.81s. Real native task requested first endpoint3times, then second endpoint2times,
  wrote its file and completed; result charged exactly5physical requests.
- `pnpm exec vitest run tests/harness-repeat-policy.test.ts tests/native.test.ts tests/caching.test.ts --maxWorkers=2`:
  48/48,41.10s, before final single-endpoint receipt/context-exhaustion coverage additions.
- Intermediate `pnpm exec vitest run tests/supervisor-loop-role.test.ts tests/supervisor-lifecycle.test.ts tests/session-faults.test.ts tests/caching.test.ts --maxWorkers=2`:
  42/42,47.97s. Actual scope/role guards, interruption/fault recovery and cache/truncation
  behavior remained intact before the final compaction-resume guard additions.
- Final `pnpm exec vitest run tests/model-stall-handoff.test.ts tests/harness-repeat-policy.test.ts --maxWorkers=2`:
  42/42,12.99s (new21/21 plus repeat21/21).
- Final `pnpm exec tsc -p tsconfig.json --noEmit`: exit0.

Full router, recursive build/typecheck and actual live continuation are supervisor work.
No claim that an alternate model always succeeds; recovery is finite and preserves a
typed stop when no eligible alternative can progress.

The broader preexisting non-handoff compaction/resume restoration limitation is not redesigned
here. This unit adds a conservative stop for handoff continuations when new authoritative
compaction receipts show lost effect proof, not a general effect-journal snapshot/replay
system. Existing error classification wraps this typed error as `internal_error`; its stable
code is also included in the message so stored task failure remains diagnosable.
