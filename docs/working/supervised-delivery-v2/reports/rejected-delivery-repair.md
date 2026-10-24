# Rejected delivery repair continuation

Worker: harness-v2. Bounded production change in service.ts, storage/tasks.ts, verification/product-delivery.ts and runners/supervisor.ts; new uniquely named regression only. No commits, provider calls, CLI/MCP/panel changes or full builds.

## Implementation

`resumeTask(id, project?)` retains its signature. Interrupted behavior remains; completed tasks require a current persisted FINAL rejection matching the current candidate/specification, a completed supervisor session with retained recorded workspace, and current project supervisor/repository authority. Atomic eligibility checking and task queue transition prevent duplicate/concurrent reopening. Completed accepted, undecided and nonproduct tasks remain ineligible. Direct TaskStore.resume without validated repair context cannot bypass the service check.

Repair opens a fresh session linked to the previous completed session; no completed history is reopened or terminal submission replayed. A validated delivery_repair_requested event retains prior session/workspace, original task result, specification, candidate and rejection. Runner restores the exact retained workspace and existing children/merge queue and receives explicit rejection/context instructions. Latest repair is queried directly by event type, independent of event pagination. Existing completed integrations remain persisted/idempotent; no queue recreation.

Task ID, specification/budget, cumulative admission usage and lineage remain. Only terminal timestamps/cancellation are cleared and execution deadline is renewed for this explicitly requested new run; this grants no additional model/token/paid budget. Same-candidate rejection still blocks handoff. A changed candidate invalidates old receipts through existing digest binding and must acquire fresh criterion evidence and a separate FINAL decision. Missing retained workspace fails safely rather than silently constructing another candidate.

## Validation

Initial real fake-provider supervisor runtime test passed (13.81s). Primary plus distinct project overlay (global repositories empty) and existing product-delivery regressions then passed **5/5**, 32.41s wall. This exercised actual complete -> FINAL accept refusal to resume -> FINAL reject -> explicit same-task queue -> fresh linked supervisor session -> real operator-approved structural validation -> old visual evidence missing on repaired commit -> new independent observation -> handoff with no automatic FINAL acceptance. Original completed session events unchanged; exact worktree preserved; budget totals unchanged at queue and cumulative afterward; wrong project and duplicate resume refused.

The source repair commit is supplied by a trusted fixture collaborator to isolate this control-plane boundary; actual worker dispatch/merge idempotence remains covered by existing team-nesting tests, not a new repair-specific worker integration claim.

Final runtime rerun with600 intervening task events: **2/2 passed**, 34.83s wall. Separate explicit nonproduct/other-role completed-task refusal regression: **1 passed**, 4.11s wall. Its initial fixture attempt lacked the configured supervisor profile; corrected fixture configuration and reran successfully. No production weakening. Fixed TypeScript nullable-service callback annotations after root's integration check. Narrow router `pnpm exec tsc --noEmit`: **PASS**, exit0, no diagnostics. Scoped git diff --check: **PASS** (existing CRLF normalization notice only). Production, tests and report frozen; root owns release-wide verification.
