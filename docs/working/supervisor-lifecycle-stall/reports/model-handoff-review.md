# Model handoff safety review

Status: Source review complete; no remaining source-review blocker identified.
Role: read-only framework reviewer. No application, configuration, runtime, or shared-document changes.

## Source inspected
- packages/router/src/harness/loop.ts
- packages/router/src/harness/stall-handoff.ts
- packages/router/tests/model-stall-handoff.test.ts
- Relevant existing ask/Gate request selection, requestPaid, native onResponse and task-authority implementations.

## Findings
- Endpoint exclusion uses GateResponse.endpoint.id, not provider-reported model text.
- Same task/session messages, captured worktree, existing effect cache, terminal-only final turn, and original request budget remain in place. No request ceiling is increased.
- Only observation history and endpoint stickiness/context sizing reset at handoff. Nonrepeatable completed and uncertain effects retain their existing deduplication, including resume reconstruction; explicitly repeatable tool contracts are unchanged.
- Typed task-scoped receipt rows are read by event type without timeline pagination; malformed receipt JSON/schema fails closed.
- Distinct stalled endpoints are excluded permanently within this task; no alternate keeps a finite terminal result. No eligible/context-fit Gate outcome becomes typed handoff exhaustion without a new charge.
- Paid model/native-search candidates are included in hard avoidEndpointIds after handoff; existing Gate quality, scope, key, lease and admission checks remain the actual dispatch boundary. No paid policy is enabled.
- Existing measured-await progress receipts remain separate, preserving legitimate async waits rather than treating them as model stalls.

## Requested correction
The loop checks authority before awaited onResponse, then writes a handoff receipt afterward. An onResponse callback may yield across cancellation or lease loss. Requested assertRunAuthority in StallHandoff.record immediately before event mutation, plus a cancellation-during-onResponse regression. Resolved: record-level assertRunAuthority now immediately precedes the receipt mutation. Read direct actual-loop regressions for cancellation and lease loss during awaited onResponse, asserting one request/edit and zero persisted stall receipts.

A second issue arose in existing compaction/resume effect restoration: compaction can remove old effect messages while live effect cache still protects the current run; a later interruption restores only compacted messages. Smaller-context handoff can expose this existing gap. Parent requested a narrow fail-closed guard for resumed handoffs with authoritative compaction and lost effect proof. The guard must run before applyResume, because applyResume can replay pending tools/effects. This also means malformed stored handoff receipts must be parsed before resume effects. No broad journal redesign requested.

The proof-loss guard must also prevent native finalization checks: finishCoding currently runs declared checks even when a loop returns stalled. Requested a typed throw before applyResume, or an exact-reason final-check skip, so a nominal loop refusal cannot still trigger host command effects. Resolved: the handoff/compaction receipt constructor and loss guard now run before applyResume. The guard throws typed model_handoff_unprovable_effect_history, preventing native runner finalization from executing checks. Read the actual native resumed-run negative test: retained changed source plus pending run_check yields failure with zero model requests, zero worker action rows, no command sentinel and unchanged retained HEAD/source.

## Validation
No tests executed by reviewer. Read the new fake-provider and negative-control tests, including exact five-request native handoff, effect dedupe, paid refusal, unique endpoint exhaustion, resume exclusion persistence, context refusal and malformed receipt refusal. Worker reports are not independent execution evidence. Root owns final integrated checks and live validation.

## Limits
Final integrated test/build output and live repair remain the parent supervisor's responsibility. This review makes no global model-quality claim, grants no additional requests or paid authority, and does not establish Facebook MVP completion. No tests were executed or application/runtime/configuration data changed by reviewer.

## Final empty-plan follow-up
Reviewed parent-requested final initialization guard: a real TaskStore database always
loads and validates persisted handoff/compaction safety receipts before applyResume,
even when the current routing plan has zero candidates. Minimal standalone callers with
neither a store nor candidates retain their legacy path. Read the new empty-plan regression:
actual persisted stall/lost-proof receipts produce the typed refusal before resume replay,
with zero requests. No unconditional no-candidate bypass remains. No tests executed by
reviewer; no additional source-review blocker identified.
