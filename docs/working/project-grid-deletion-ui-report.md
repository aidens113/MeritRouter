# Project grid deletion UI worker report

Status: Implemented; supervisor verification pending.

Changed `apps/panel/app/page.tsx` and `apps/panel/components/client/delete-project.tsx`.

- Live project cards have a compact Delete project footer, outside the navigation link.
- Archived project entries expose the same action alongside Unarchive.
- Settings DangerZone and grid actions share the existing two-modal flow: current removed/kept counts and blockers, then exact typed-slug permanent confirmation.
- Per-instance React IDs connect labels, confirmation inputs, and error messages. Reopening resets typed/error/preview state; obsolete preview requests cannot overwrite a newer dialog's counts.
- Existing ConfirmDialog supplies native modal isolation, Escape/Cancel/backdrop handling, focus trapping, and return focus. The second dialog retains typed-input focus and explicitly returns to its trigger on close.
- Backend deletion guards and source repository preservation remain unchanged.

Validation: inspected deletion API contracts and component structure; `git diff --check` passed. No builds, browser checks, live data changes, commits, or source repository deletions performed. Supervisor must verify grid/settings flows and actual UI cleanup.
