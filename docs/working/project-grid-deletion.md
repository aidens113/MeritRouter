# Project grid deletion
Status: Active
Status detail: User requests visible grid deletion with multiple confirmation modals, followed by removal of clone leftovers through the UI.
Created: 2026-10-23
Last updated: 2026-10-23
Owner: Senior supervisor
Scope: Project-grid deletion controls; existing guarded service; actual Facebook/Instagram cleanup through the new UI.
Paired document: none
Related: [projects](projects.md)

## Current State

Existing settings DangerZone already provides impact preview and typed-slug confirmation,
but the project grid exposes neither. Reuse the same service and dialog components, with
grid buttons outside navigation links. Existing deletion preserves source repositories;
User confirmed platform projects and MeritRouter data only; repository folders must stay. Do not silently
weaken deletion guards or add repository deletion. Root owns validation/live UI cleanup.

## Worker Briefs

### Brief: grid-delete-ui
- Repository: D:/SwitchYardRouter on dev.
- Task: Add visible Delete project action on live grid cards and archived entries, reuse existing staged deletion flow.
- Required reads: Current State; apps/panel/app/page.tsx, components/client/delete-project.tsx, confirm-dialog.tsx; existing API deletion routes only to verify contract.
- Owns: apps/panel/app/page.tsx and components/client/delete-project.tsx; own docs/working/project-grid-deletion-ui-report.md.
- Must not touch: other source/docs/tests, live config/data, commits/pushes, builds; root handles integration and browser checks.
- Definition of done: Shared DeleteProjectAction renders compact grid trigger or settings DangerZone; two actual modals show fresh removed/kept impact/blockers then typed slug permanent confirmation. Unique useId labels per card; reset stale state on reopen; prevent nested button/link and accidental navigation. Cancel/Escape/focus behavior preserved. Include archived entries. Do not change repository-preservation/backend contract. Report source changes and checks; no claim browser validated.

## Work Ledger

- User explicitly requests actual clone deletion using the new UI; existing source repository preservation was disclosed and scope clarification is pending.

## Open Questions

- None: user confirmed source repositories stay. Root must delete both projects through the new UI after isolated acceptance.
