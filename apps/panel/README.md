# SwitchYard panel

Local web panel for SwitchYard Router: overview, models (and why each is or isn't used), routing
previews and overrides, jobs (standalone supervisors), tasks, requests, the brain (shared working
documents with history and per-line attribution), provider keys, paid routes, qualification, and
every setting.

```bash
pnpm --filter switchyard-router build
SWITCHYARD_CONFIG=/path/to/switchyard.config.yaml pnpm --filter switchyard-panel build
SWITCHYARD_CONFIG=/path/to/switchyard.config.yaml pnpm --filter switchyard-panel start   # http://127.0.0.1:4477
```

- Binds to 127.0.0.1 only. Set `SWITCHYARD_PANEL_TOKEN` to require a login.
- The panel never runs tasks; a worker does (the MCP server inside Claude Code, or
  `switchyard worker`). Settings changes are picked up by running workers within seconds.
- Provider keys for the free network are managed through FreeLLMAPI and need
  `FREELLMAPI_ADMIN_TOKEN`. Direct paid-provider keys live in SwitchYard's encrypted vault (Paid
  routes page). Secrets are write-only and never sent to the browser; paid keys show only their
  last four characters.
- Starting a job only queues it; a worker runs the supervisor. Brain edits made here are committed
  as `human` and checked against the working-document protocol.

## Demo data

```bash
pnpm --filter switchyard-panel seed:demo
SWITCHYARD_CONFIG=.demo/switchyard.config.yaml pnpm --filter switchyard-panel dev
```

The seeder builds `.demo/` with a fixture repository, manual models, and task history recorded
through the real router with a scripted gateway. It also runs a finished standalone job and a job
paused on a question for you, fills a demo brain (`.demo/brain`: working documents, reports, a
decision, a lesson, facts) with two pending access requests, and records a small paid spend through
a fake direct client (the demo paid keys are fake). Qualification rows in the demo are illustrative.
