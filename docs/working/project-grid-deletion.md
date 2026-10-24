# Project grid deletion
Status: Blocked
Status detail: Grid feature verified and deployed; Instagram deleted through it. Facebook deletion correctly blocked by two unresolved request/transport holds without supported safe recovery.
Created: 2026-10-23
Last updated: 2026-10-23
Owner: Senior supervisor
Scope: Project-grid deletion controls; existing guarded service; actual Facebook/Instagram cleanup through the new UI.
Paired document: none
Related: [projects](projects.md)

## Current State

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
preserved, other projects unchanged. Facebook impact preview reported43tasks/39sessions/
158artifacts/32Brain files/26worktrees, but2unresolved model requests and2transport holds
block Continue. It was not deleted. Read-only source review confirms no supported recovery
operation and no durable process/quiescence proof for legacy holds. Never clear DB rows or
forge settlement to bypass this. See project-grid-deletion-holds-report.md for required
recovery service and acceptance; this is a genuine backend recovery prerequisite.

QA results/screenshots/scripts remain in the system temp directory with meritrouter-grid-delete
and meritrouter-live-instagram-clone-deletion-results names. Temporary QA server4483 must be
stopped; keep authorized live4477 running. Existing live MCP processes were preserved.

## Worker Briefs

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

## Open Questions

- Facebook cleanup requires a supported, proof-gated request recovery operation; legacy transport quiescence cannot be inferred from age or task completion. Backend design in holds report; deletion guard remains intact.
