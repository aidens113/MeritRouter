# Delivery status panel implementation

Status: Implemented — awaiting supervisor validation
Owner: release-scope-audit worker
Date: 2026-10-23

## Changes

- Added `components/product-delivery-status.tsx`: scoped server-rendered job delivery summary
  with specification revision, stage, recorded readiness and FINAL decision, invalid historical
  acceptance, bounded blockers, and link to task evidence. Explicitly labels stored evidence
  and directs the initiating supervisor through freshly inspected `delivery_status`, independent
  observations and digest-bound `decide_delivery`; task acceptance is explicitly separate.
- Project overview displays a bounded 25-row delivery report using
  `insights.projectDeliveryReport`, filters unresolved products and exposes keyset continuation.
  Summary is visible on either overview tab. Attention items link to this section. The healthy
  attention message now qualifies its claim as recorded state without runtime revalidation.
- Job detail reads its root task's project-scoped `deliveryView` and displays the new card above
  ordinary execution details; a green task badge cannot replace product status.
- No acceptance/observation endpoint introduced. Existing Resume action is offered for an
  interrupted task. A completed FINAL-rejected delivery additionally offers a confirmed
  Request repair action. The existing resume endpoint now delegates eligibility and project
  checks to `sy.resumeTask`, whose owner added the narrow retained-workspace repair guard.
  Invalid state errors remain HTTP409; project mismatch remains the shared service's404.
  This is a scheduling action preserving remaining budget, never product acceptance.

## Checks and limitations

- Read stable report API and coordinated fields with its owning worker.
- Checked tab query format, project-safe task links and existing resume endpoint authority.
- `git diff --check` passed; shared checkout reports unrelated CRLF normalization notices.
- No builds, tests, providers or demo/runtime mutations run by this worker, as brief requires.
  FINAL owns typecheck/build and production seeded UI/API/screenshots.
- Only the three original panel files, explicitly authorized resume route, and this report
  changed. No commits or shared-doc edits.
- Current task-detail legacy summary is intentionally untouched; its broader replacement and
  full evidence inspector are outside this bounded visibility brief.
