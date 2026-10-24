# Project grid deletion
Status: Complete
Status detail: Implemented, independently verified and live cleanup complete; one full-suite browser timing failure passed isolated rerun.
Created: 2026-10-23
Last updated: 2026-10-23
Owner: Senior supervisor
Scope: Project-grid deletion controls; existing guarded service; actual Facebook/Instagram cleanup through the new UI.
Paired document: none
Related: [projects](projects.md)

## Current State

Pending model requests no longer block terminal-project deletion. Atomic retirement removes
private request authority, preserves conservative dispatched accounting and exact anonymized
transport quarantine, and fences stale replay/settlement. A new opaque tombstone migration
is compatible with legacy key GC. Session append and capture begin now refuse retired owners
before recreating private data. Active-task, exclusive ownership, Lab and last-project guards
remain. Old in-memory clients require restart for new filesystem/capture guards; removing
private receipts already fences their subsequent dispatch and accounting callbacks.

Independent focused verification: 45/45 passed across eight deletion/session/capture suites.
Initial recursive typecheck caught a missing endpointId in a new test fixture; corrected.
Recursive typecheck and recursive production build passed. Full router run: 144 files passed, 1 failed, 1 skipped; 1,365 tests passed, 1 failed, 3 skipped in 832.15s. The sole failure was labs-browser.test.ts:171 waiting 20s for browser_check_started under concurrent load. The exact failed cancellation case passed independently (11.39s; 1 passed/7 skipped), without source changes. All requested deletion, admission, ledger, accounting, rollback and late-callback cases passed. Initial full run was not wholly green; do not describe it as such.

### Acceptance for pending-request deletion
- Project deletion succeeds with terminal tasks plus unresolved reservations/strict holds.
- No new dispatch/replay can occur from an abandoned request, including old-process state checks.
- Actual dispatched uncertainty retains worst-case accounting; already settled usage never changes.
- Exact physical holds remain quarantined unless actual transport completion establishes safe release; no false idle proof.
- No prompts/captures/results survive project purge; any retained control metadata is bounded, disclosed and sufficient only for accounting/recovery, never new dispatch.
- Other project requests/holds/data unchanged; deletion failure rolls back lifecycle changes.
- Updated real-temp tests cover reserved, dispatch-intent, settled-with-hold, late callbacks, races/replay and idempotence.

Grid and archived entries now expose compact Delete project actions, sharing the existing
settings flow. Modal1 loads current removed/kept impact and blockers; modal2 requires the
exact slug. Buttons stay outside links; IDs are unique; cancel/Escape/focus and reopen state
passed actual production browser checks. User confirmed platform/MeritRouter data only.

Recursive typecheck/build passed. Focused project/Lab deletion tests10/10 passed. Isolated
demo seed passed all expectations; actual demo-grid and archived deletion, two modals,
incorrect-slug disable, cancel/Escape/focus return, reopen reset, mobile viewport and zero
browser exceptions passed. Supervisor inspected mobile screenshot. No fake user data tests.

Panel4477 rebuilt and restarted via connected panel tool after an early restart during build
was detected (old page had no grid actions). Final live root returned200 with all five grid
buttons before cleanup. Source repository folders remain untouched by deletion.

Actual Instagram deletion used both new grid modals, returned200 with no cleanup problems:
18tasks,19sessions,32artifacts,16Brain files,18worktrees removed. Source folder existence
preserved, other projects unchanged. Facebook preview showed43tasks/4jobs/39sessions/
158artifacts/32Brain files/26worktrees and905private captures. After rebuilding/restarting,
its2pending requests/2holds were disclosed without blocking Continue. Both grid modals
submitted deletion. The30s browser response observer expired during long filesystem cleanup;
no duplicate deletion was submitted. Independent final grid/API and read-only SQLite checks
verify both clones absent, no scoped project/task/session/request/private receipt/capture rows,
and exactly2anonymous quarantined transport holds. Both Brain folders absent; sources preserved.
One Windows-locked native module initially left a Facebook integration worktree cache. Root
stopped the verified panel listener and retried the feature's removeProjectWorktrees routine
for that exact owned/unregistered path; removed1, problems[], folder absent. Panel restarted
again; final browser root/API200, exact remaining my-project/pomodoro/tetris, zero JS exceptions.
All9remaining managed worktrees belong to Tetris/Pomodoro; no unowned clone folders remain.
Screenshot of impact disclosure and final grid visually inspected. No manual DB mutation,
provider call or source deletion occurred. Already-running external clients need their own
restart to acquire new recorder/capture code; their receipt-bound dispatch/accounting is fenced.

QA results/screenshots/scripts remain in the system temp directory with meritrouter-grid-delete
and meritrouter-live-instagram-clone-deletion-results names. Temporary QA server4483 must be
stopped; keep authorized live4477 running. Existing live MCP processes were preserved.

## Worker Briefs

### Brief: pending-deletion-review
- Repository: D:/SwitchYardRouter; read-only design/adversarial review in parallel with pending-request-deletion worker.
- Task: Review the proposed lifecycle against exact request-ledger/old-process dispatch, private purge, conservative accounting and physical slot safety. Communicate concrete hazards to implementation worker promptly.
- Required reads: Current State/acceptance and pending-request-deletion brief; admission request receipts/ledger, gate dispatch/finally, projects/deletion transaction. Read only needed source.
- Owns: docs/working/project-grid-deletion-review-report.md only.
- Must not touch: source/tests/shared docs/live data, builds, commits/pushes.
- Definition of done: Evidence-based bypass/race/privacy checklist. Confirm old callbacks cannot dispatch/recreate project/private data or erase already billed usage; held slots never freed merely by deletion; recovery metadata minimal bounded and private requestcaptures purged. Inspect final implementation when ready; findings are not verification until root observes checks.
- Report to: docs/working/project-grid-deletion-review-report.md.

### Brief extension: late-session-purge-guard
- Worker: pending-deletion-review; implementation now authorized for this bounded finding.
- Owns additionally: packages/router/src/sessions/recorder.ts; uniquely named tests/project-delete-late-session.test.ts. Ask before other files.
- Task: Fence late SessionRecorder append after session deletion before any filesystem recreation, serialize existence/generation check with purge via existing synchronous DB transaction boundary. Preserve valid session durability/recovery semantics.
- Acceptance: Actual recorder created before purge cannot recreate removed private log after purge or append pending model error; valid recorder still records. Keep generation/scope checks; no swallowed persistence uncertainty. Report old-binary compatibility limits accurately. No broad builds/full tests or live data; source narrow tests only.
- Additional ownership: packages/router/src/storage/request-captures.ts and uniquely named tests/project-delete-late-capture.test.ts. Reject begin for a request-deletion tombstone before creating any capture metadata/payload, including empty supplied participant lists. Preserve genuine global taskless capture behavior. Coordinate final tombstone schema with backend worker; no other files.

### Brief: pending-request-deletion
- Repository: D:/SwitchYardRouter on dev; source implementation authorized by user.
- Task: Implement acceptance above, allowing project deletion without pending request deadlock while preserving accounting/transport safety.
- Required reads: Current State and holds report; admission/request-receipts.ts, request-ledger.ts/sqlite ledger; admin/projects.ts; projects/deletion.ts; current protocol/deletion tests.
- Owns: packages/router/src/admission/request-receipts.ts, admission/sqlite-request-ledger.ts or owning concrete-ledger module, admin/projects.ts, projects/deletion.ts; appended storage/migrations.ts only if required; tests/project-request-protocol.test.ts and uniquely named tests/project-delete-pending-requests.test.ts; own report.
- Must not touch: panel, other source/tests, shared docs, user data/config, commits/pushes; no broad build/full suite. Ask for extra module ownership before changes.
- Definition of done: Implement lifecycle, never bypass holds by falsely clearing them. Pending-only project blockers removed once deletion can fence/settle and detach minimal recovery data transactionally. Surface retained requests/holds in preview/result so UI can explain. Preserve existing API backward compatibility and safe account late-callback behavior. Prove actual temp-project deletion, no redispatch, conservative accounting, private data removal, foreign preservation and rollback. Report design tradeoff/any original-process compatibility limits immediately; root verifies and builds.
- Report to: docs/working/project-grid-deletion-pending-report.md.

### Brief: clone-request-holds
- Repository: D:/SwitchYardRouter; read-only source investigation.
- Task: Facebook clone deletion preview is blocked by2unresolved model requests and2retained transport holds. Find safe supported reconciliation for actual cleanup; never bypass guard.
- Required reads: Current State; admin/projects.ts deletionBlockers; projects/request-receipts.ts or owning RequestReceipts implementation; actual recovery/reconcile operations and UI if present.
- Owns: own docs/working/project-grid-deletion-holds-report.md only.
- Must not touch: source/tests/shared docs/live DB/config/data; no tests/builds/provider calls; never commit/push.
- Definition of done: Explain persisted blocker semantics, identify supported operation/API/CLI and proof required for genuinely dead transport. Distinguish accounting uncertainty vs physical quiescence. If no safe action exists, identify smallest enforceable repair and exact files/acceptance. Root handles live reads/actions. No recommendation to manually delete DB holds.
- Report to: docs/working/project-grid-deletion-holds-report.md.

### Brief: grid-delete-ui
- Repository: D:/SwitchYardRouter on dev.
- Task: Add visible Delete project action on live grid cards and archived entries, reuse existing staged deletion flow.
- Required reads: Current State; apps/panel/app/page.tsx, components/client/delete-project.tsx, confirm-dialog.tsx; existing API deletion routes only to verify contract.
- Owns: apps/panel/app/page.tsx and components/client/delete-project.tsx; own docs/working/project-grid-deletion-ui-report.md.
- Must not touch: other source/docs/tests, live config/data, commits/pushes, builds; root handles integration and browser checks.
- Definition of done: Shared DeleteProjectAction renders compact grid trigger or settings DangerZone; two actual modals show fresh removed/kept impact/blockers then typed slug permanent confirmation. Unique useId labels per card; reset stale state on reopen; prevent nested button/link and accidental navigation. Cancel/Escape/focus behavior preserved. Include archived entries. Do not change repository-preservation/backend contract. Report source changes and checks; no claim browser validated.

## Work Ledger

- User explicitly requests actual clone deletion using the new UI; existing source repository preservation was disclosed and scope clarification is pending.
- User confirmed platform projects and MeritRouter data only and explicitly requested panel restart.
- Supervisor verified10/10 deletion tests, recursive typecheck/build, complete demo seed and production browser flows; deployed panel and removed Instagram using actual two-modal grid interaction. Facebook guard retained; source review established missing recovery prerequisite. No live provider calls or manual DB deletion.

- Integration: recursive typecheck/build passed;45focused tests passed. Full suite completed with one browser timing failure; exact isolated rerun passed without code changes. Both clones removed, remaining worktrees ownership verified, final panel restarted and browser checked.

- Final validation: Full router run: 144 files passed, 1 failed, 1 skipped; 1,365 tests passed, 1 failed, 3 skipped in 832.15s. The sole failure was labs-browser.test.ts:171 waiting 20s for browser_check_started under concurrent load. The exact failed cancellation case passed independently (11.39s; 1 passed/7 skipped), without source changes. All requested deletion, admission, ledger, accounting, rollback and late-callback cases passed. Initial full run was not wholly green; do not describe it as such.

## Open Questions

- No outstanding work for this deletion request. Safe transport capacity recovery remains a separate feature; deletion preserves anonymous quarantine without claiming quiescence.
