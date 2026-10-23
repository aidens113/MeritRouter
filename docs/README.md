# MeritRouter documentation

Start with [setup](setup.md): build from source or a locally built package, create one project,
add a provider key in the panel, connect your MCP client and try a small read-only task.
No published npm package is assumed.

| Goal | Read |
| --- | --- |
| Install and connect Claude Code, Codex or another MCP client | [Setup and MCP connections](setup.md) |
| Understand who owns the goal and how to delegate | [Supervisors, workers and the brain](roles.md) |
| Approve a host check safely | [Repository boundaries and outside actions](operations.md#repository-boundaries-and-outside-actions) |
| Manage keys, quotas, verification, jobs and recovery | [Operations](operations.md) |
| Back up or restore an installation | [Backup and restore](operations.md#backup-and-restore) |
| Upgrade an existing SwitchYard install without losing state | [Upgrade procedure](setup.md#upgrading-from-switchyard) |
| Diagnose a first-run problem | [Setup troubleshooting](setup.md#troubleshooting) |
| Understand architecture decisions and dated provider evidence | [Decision record](decisions.md) |

In the panel, choose a project to see its jobs, tasks, sessions, requests, brain and settings.
Use **All projects** for shared provider keys, models and routing. Task and job details link
related work and show pending action approvals; job Requests includes descendant model calls.
Project Overview includes token totals and usage graphs. Agents shows formatted role/session
activity, and the Jobs page keeps its creation form collapsed below existing jobs.

The native runner enforces repository paths. Host commands need exact approvals under the
configured security policy; external coding runners currently fail closed because an accepted
OS sandbox is unavailable. Keep **Human approval only** while learning the workflow.

Plans and acceptance evidence under [working/](working/README.md) document development work.
They are historical/task records, not installation instructions.
