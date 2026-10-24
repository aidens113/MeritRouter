# Supervisor quality routing and upward budgets (P2)

Status: Complete — focused validation passed; awaiting supervisor integration
Owner: delivery-contracts-implementation worker
Date: 2026-10-23

## Current State

Implemented live quality-floor routing and nested supervisor request extensions. No live
provider calls, user configuration changes or commits. Parent owns config schema wiring,
supervisor runner tool registration, fixture-helper updates and public documentation.

## Changes and public seams

- `routing/supervisor-quality.ts` exports versioned evidence/routing Zod schemas and
  `assessSupervisorQuality`. Current configured provenance, at least 0.75 confidence and
  every relevant capability at least 0.75 are required. Visual inputs additionally require
  visual capability. Evidence includes source, checked/expiry times, trials and separate
  planning/architecture/supervision/integration/review/product scores. Vendor names and
  parameter counts never establish quality.
- `routing/select.ts` applies this floor only to supervisor profiles and exposes quality
  assessment in candidate explanations. It replaces worker qualification/parameter floors
  for those profiles, preserves paid eligibility, ranks quality across providers, and returns
  `supervisor_quality_unavailable` when nothing is eligible. Forced endpoints cannot bypass.
  Explicit free-exhaustion routing remains free-first among qualified models. With paid
  preference authorized, capability quality precedes marginal price preference.
- `routing/router.ts` stops actual supervisor preparation with the structured blocker.
- Narrow parent-authorized `gateway/gate.ts` seam ignores weaker sticky preference and
  revalidates quality provenance per physical dispatch, including revocation/expiry. No
  quality evidence means no dispatched request. Workers retain existing sticky behavior.
- `harness/budget-tools.ts` permits supervisor upward requests, resolves immediate parent
  or external FINAL approver, preserves human-only policy, and excludes verification runs.
- `admission/budget-requests.ts` includes approved extras in supervisor pool capacity and
  atomically grows nested supervisor carves with grants. Parent headroom, parent identity,
  missing carve and duplicate decisions are checked. Paid authorization/budgets are untouched.

## Validation observed

`pnpm exec vitest run tests/supervisor-quality.test.ts tests/supervisor-budget-extension.test.ts`
passed **22/22 tests**. Coverage includes cross-provider quality ordering, unknown parameter
sizes, forced weak-route refusal, paid-disabled/free-exhaustion/preferred behavior, worker
compatibility, stale/future/low-confidence/weak-capability/missing-visual evidence, actual Gate
dispatch ignoring weaker stickiness then refusing expired session evidence without another
HTTP call, nested grant conservation, sibling over-allocation/duplicate decisions, missing
carve rollback, root grants, persisted router close/reopen, three-level ancestor holds,
actual upward-tool FINAL resolution despite worker auto grants, and 600-request version2
delivery pools protecting 80 supervisor plus 80 validation requests without raising lower caps.
No full-repository validation while other workers edited; parent owns that combined gate.

## Remaining integration and limitations

Parent must register `requestBudgetTool()` in supervisor runner (it previously was absent),
export schemas through public API and document configured provenance/onboarding. Existing
budget waits use bounded 500ms database polling with zero model calls. This does not implement
the planned durable cross-process event-driven wait service; do not claim that phase complete.
Store `decide` receives trusted actor attribution from existing authority-checked adapters;
arbitrary `by` strings are not authentication. The existing external/human decision boundary
must remain enforced by those adapters. This unit does not implement routing benchmarks,
model discovery qualification probes, protected delivery-stage reserves or automatic user
quality evidence. Empty evidence intentionally blocks supervisor execution.

Tests use fake providers only; no model superiority or production usability claim follows.
