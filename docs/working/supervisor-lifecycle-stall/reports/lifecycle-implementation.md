# Lifecycle implementation report

## Changes
- Added harness/supervisor-lifecycle.ts. Delivery v2 allows bounded read-only discovery, then after six physical task requests narrows offered/executable tools to coordination and explicit blockers. TaskTotals persists across sessions. An undispatched draft does not lift the restriction; a real child matching a plan label does.
- Supervisor runner supplies generic loop toolPolicy and wraps all tools at execution. Pre-plan shell checks, recipe/check commands, mixed batch commands, Lab check/restart/promote/mutating HTTP, inspect briefs with checks and integration are refused before their effects/approval creation. Safe repository batches and Lab status/logs/GET remain available during initial discovery. Existing authority/paid/human-only checks remain unchanged.
- plan_work accepts dispatch:false: validates graph, task/scope inputs and stores visible undispatched nodes without staffing, reserving budgets or running workers. Default true preserves immediate legacy dispatch. Full briefs must be resupplied when executing drafts. Replans retain dispatched definitions/idempotent task labels.
- New v2 execution briefs must match persisted profile, goal, acceptance criteria, dependencies, allowed paths, writable repository, shell checks and Lab checks. Once a plan exists, new pure review/inspection briefs must also be planned. Legacy jobs remain unguarded by these v2 rules.
- PlanNode adds labChecks with [] hydration default; no migration required. ProductDeliveries refuses v2 implement transition without actual PlanStore graph (legacy transitions preserved).
- v2 blocked/stalled exits do not run fresh automatic final shell checks and open surprise human approvals. Event/ledger explicitly says declared verification was skipped; no fabricated passing receipts.
- Existing runtime and rejected-repair test fixtures now publish actual plans and dispatch a real fixture inspection worker before advancing implementation. Product/evidence/repair assertions preserved.

## Owned files
- packages/router/src/harness/supervisor-lifecycle.ts (new)
- packages/router/src/harness/supervisor-tools.ts
- packages/router/src/runners/supervisor.ts
- packages/router/src/storage/plans.ts (approved scope expansion)
- packages/router/src/verification/product-delivery.ts (approved scope expansion)
- packages/router/tests/supervisor-lifecycle.test.ts (new)
- packages/router/tests/delivery-runtime.test.ts (approved fixture update)
- packages/router/tests/rejected-delivery-repair.test.ts (approved fixture update)
No app source, real configuration/runtime state or shared working documents edited. No commits.

## Validation so far
- pnpm exec tsc --noEmit -> exit0 after source changes including labChecks and final-check guard.
- First lifecycle7-case run had3fixture failures (bad services adapter, unread evidence, final checks blocking early exit). Fixed services/evidence fixtures and actual final-check defect; rerun7/7 passed.
- Prior focused product-delivery3/3 passed. Team-integration initially4/5 passed because newly earlier depth validation changed exact diagnostic; preserved prior diagnostic, later5/5 passed.
- Latest selected run (session22516): lifecycle8/8, team-integration5/5, delivery-runtime2/2 and rejected-delivery-repair3/3 passed: 4files/18tests,33.86s,exit0.
- Lifecycle actual runner tests demonstrate safe batch success, mixed host batch refusal, direct/check-delegation refusal, visible draft, actual planned worker completion, and immediate blocked finish with declared checks creates zero worker-action rows.
- Unit cases cover invalid scopes/budgets/graphs with no persisted draft, exact plan field mismatches including Lab checks, draft-only restriction, task-wide resume policy and non-v2 compatibility.

## Limits
- Framework can require observable planning/assignment or explicit blocked reporting; it cannot guarantee semantic quality of model-authored plans, implementation, independent reviews or product tests. Existing candidate/evidence/readiness/FINAL gates remain required.
- Six is a fixed small discovery allowance, measured in physical task requests, so provider fallback failures can exhaust discovery sooner. Child requests are separately accounted. No new quota/paid authority is granted.
- PlanStore does not persist every optional execution field (e.g. repositories context, web preference, per-child max_requests and Brain grants). These inputs are validated at draft/dispatch and existing scope/budget/ACL controls still enforce them, but equality-to-plan is limited to the listed persisted execution fields.
- A dispatched planned child is progress evidence, not completion or acceptance. Later no-progress/review behavior still depends on existing repeat/task/readiness guards.
- Offline fake-provider tests, not a completed Facebook product or live-provider acceptance. Root owns integrated full validation, demo panel view checks, documentation and publication.

