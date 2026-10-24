# Delivery attention and compact project report

Status: Implemented; focused source tests passed. Integrated build, compiled CLI smoke and production UI review belong to root.

## Changes

- `admin/deliveries.ts` exports `projectDeliveryReport(sy, input)` and strict `ProjectDeliveryReportInputSchema`. Requires a real project, defaults to25 entries, accepts1–100, and uses stable ascending task-ID keyset pagination (`after` / `nextAfter`). SQL scopes both delivery and owning task to the project before limit. Returns metadata only: task state, stage, stored readiness, historical FINAL decision, effective acceptance, attention flag, bounded deduplicated reason codes. No goals, specification/evidence bodies, actor details or raw rejection text returned.
- `projectAttention` now uses the same read model: legacy task acceptance `met` cannot hide missing product candidate/evidence, pending FINAL, rejection or historical acceptance invalidated by later evidence. It inspects at most100 delivery records; if more exist it explicitly warns that additional statuses remain to review rather than claiming nothing needs attention. Current accepted stored evidence clears product attention within inspected records.
- CLI adds `meritrouter delivery-report --project <slug> [--limit 1..100] [--after <task-id>] [--json]`; existing `status` remains unchanged. Normal CLI project resolution still applies. Text output includes stored-only freshness and next-page guidance.
- MCP adds `project_delivery_report` with the same service contract, current explicit/default project resolution, strict object schema, bounded arguments and no mutation authority. Public index exports the report/schema. Existing single-task `delivery_status` remains the source-refresh path before FINAL review.

## Freshness and bounds

`freshness: stored_candidate_and_evidence`, `sourceRevalidated: false` are explicit. Effective acceptance here means the stored candidate/evidence still satisfies readiness and the owning task is completed; it is distinct from a historical accept decision. This compact synchronous report does not perform fresh Git/Lab calls. A later observed failure/expiry blocks effective acceptance. Changed files not yet observed by runtime require single-task `delivery_status` or runtime refresh; this report does not claim otherwise.

Attention uses the report's exact reason codes. It may conservatively flag uninspected records beyond100 even when they later prove accepted. This bounds synchronous page work and prevents a false clear from truncated data. Pagination is live metadata, not an immutable catalog snapshot; new records sorting before the current cursor appear on restarting traversal.

## Validation

Observed `pnpm exec vitest run tests/delivery-attention-report.test.ts`: **4/4 passed**, including real in-memory MCP transport. Covers legacy-met missing candidate, rejection, accepted-current clear, later observed failure preserving historical acceptance while effective acceptance becomes false, no private-body exposure, project-scoped disjoint keyset pages, missing-project/unknown-key/range/empty-cursor rejection, MCP default project and strict bounds/unknown argument rejection. Initial fixture syntax/missing constraints corrected before successful runs; no production check weakened.

No full tests or broad builds run by this worker per brief. Root owns exact MCP inventory update and authored operator/help documentation. Root/panel worker notified of stable read-model contract. No panel edits, runtime data edits, shared-document changes, commits or pushes by this worker.
