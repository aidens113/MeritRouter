# Report: classifier-project-isolation

## Status
Complete and frozen for supervisor review on feat/classifier-project-isolation from 002865d. Own scoring/classifier.ts, new tests/classifier-project-scope.test.ts and this report only. Shared master brief is supervisor-owned. No migrations, core, providers, Labs, panel, live quota or user data touched.

## Reproduction
Four pre-fix real-Gate/fake-provider regressions failed as expected: simultaneous alpha/beta goals shared one classifier payload; identical spec hashes reused another project's rationale; legacy unscoped cache returned private rationale; task project mutation while queued still dispatched. Tests use actual persisted/claimed tasks, admission/request charges and session journals.

## Implementation
Derive project from persisted task before cache lookup. Normal project must still exist unarchived in lifecycle rows and current config; missing/unassigned/deleted/malformed scope resolves null with no cache/provider access. Reserved _qualification is explicitly supported as its existing private internal scope without a public project row. No alias/current-primary inference. Queue captures authoritative project and selects same-project batches; per-project count drives max-batch triggering and remaining scopes retain FIFO scheduling. Revalidate project before building payload and before Gate invocation; discard/cache nothing for a task that changed projects during the provider response. Cache keys use explicit classifier-project-v1 namespace plus SHA256 of [project,specHash], with existing rulebook version unchanged; old unscoped keys cannot hit. Cached verdicts pass zod validation. Timer policy/storage failures resolve null rather than leak rejections or strand queued callers.

## Validation
- Initial four regressions failed before source changes: mixed-project batch (one HTTP instead of two), cross-project rationale cache hit, legacy unscoped cache hit, queued project-change dispatch.
- Final new classifier-project-scope8 + existing scoring6 + projects-fairness10 + providers-limits13:37/37 passed,8.78s,maxWorkers=2. Real fake-provider/Gate requests persist request/charge rows and actual JSONL classifier journals. Assertions cover separate per-project prompts/journals, same-project batching with original per-item output allowance, identical-spec cross-project misses/same-project hits/rulebook invalidation, ignored legacy cache, missing/unassigned/deleted/archived/malformed project refusal before cache, queued/late project change, explicit internal qualification scope, cancellation with no partial charges.
- Router typecheck and router build passed after final source/test changes.
- git diff --check passed (normal CRLF conversion warnings). No broad repository/panel tests, live providers or services.

No scoring.test.ts changes were needed. Integrate only classifier.ts, new classifier-project-scope.test.ts and this report. Supervisor-owned master brief diff is separate.

## Limits
No historical mixed session rewrite, new payload capture, task generation protocol or R2/PG completion. Classifier still uses existing Gate/accounting and per-member journals; active project changes after entering asynchronous Gate remain governed by service lifecycle/admission boundaries and future capture scope guard. Root owns full integrated validation and authored docs.
