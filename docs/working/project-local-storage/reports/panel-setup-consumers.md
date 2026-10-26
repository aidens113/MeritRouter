# Panel and setup storage consumers

Supervisor inspection, 2026-10-26. No panel source or runtime changes.

- apps/panel/app/api/projects/route.ts: POST Body and CreateProjectInput assembly currently
  carry name/slug/repositories/mounts, no project-directory owner. Add the explicit owner
  to both schema and payload when registration wiring is implemented.
- apps/panel/components/client/new-project.tsx: NewProjectForm owns project/repository inputs
  and field errors. Multi-repo registration needs a clear project folder field; single-repo
  defaults should display the actual metadata location without exposing internal machinery.
- packages/router/src/admin/projects.ts: CreateProjectInput, validateNewProject, createProject
  persist config then initialize Brain. Directory ownership validation must precede repository
  preparation side effects; a failed ownership check must not create unrelated folders.
- packages/router/src/admin/project-settings.ts: projectSettings.effective omits directory;
  ownership changes must not be ordinary hot config edits once local state exists. Require
  explicit migration rather than pointing an existing project at an empty alternate folder.
- packages/router/src/cli/setup.ts: initializeConfig currently sets brain.path relative to
  config for setup. New registration must preserve installation credentials/config while
  recording project root and initializing project-local content only through the new service.
- apps/panel/components/session-detail.tsx: workspace display labels each repository Worktree
  and prints its absolute path. Future presentation should expose readable job/version/task
  hierarchy plus the actual path and migration state, without changing stored evidence text.

Next implementation needs stable project service and path APIs first. No UI success claim;
production demo/API/screenshots are required when these components change.
