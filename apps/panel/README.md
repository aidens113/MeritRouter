# SwitchYard panel

Local web panel for SwitchYard Router. It opens on a projects grid (`/`); "New project" (`/new`)
creates one and opens it. Each project's pages live under `/p/<slug>/`: overview, jobs (standalone
supervisors), teams, tasks, agent sessions (each run's event log of messages, model requests, and
tool calls), requests, the brain (the project's working documents plus the global ones, with history
and per-line attribution), and project settings. The install-wide pages live under `/all/`
("All projects"): the dashboard, every project's requests, models (and why each is or isn't used),
routing previews and overrides, provider keys (with paid spend), qualification, calibration, and
global settings. The project switcher at the top left moves between them.

URLs from before projects redirect: `/models`, `/routing`, `/keys`, `/qualification`,
`/calibration`, and `/settings` to `/all/...`; `/jobs`, `/teams`, `/tasks`, `/sessions`,
`/requests`, and `/brain` to the last project you opened (or the grid); and `/tasks/<id>`,
`/jobs/<id>`, `/sessions/<id>` to the project the task or session belongs to. An unknown or
archived project's pages are a 404 (archived projects are listed, with Unarchive, on the grid).

```bash
pnpm --filter switchyard-router build
SWITCHYARD_CONFIG=/path/to/switchyard.config.yaml pnpm --filter switchyard-panel build
SWITCHYARD_CONFIG=/path/to/switchyard.config.yaml pnpm --filter switchyard-panel start   # http://127.0.0.1:4477
```

- Binds to 127.0.0.1 only. Set `SWITCHYARD_PANEL_TOKEN` to require a login.
- The panel never runs tasks; a worker does (the MCP server inside Claude Code, or
  `switchyard worker`). Settings changes are picked up by running workers within seconds.
- Provider keys: pick a built-in provider (or add a custom OpenAI-compatible server), paste a key,
  Test it (the panel server lists the models it can use), and add it to SwitchYard's encrypted
  vault. Keys declared under `providers` in the config are shown read-only. Secrets are write-only
  and never sent to the browser; keys show only their last four characters. `/paid` redirects
  here; paid policy and budgets are in Settings (`/all/settings`).
- Starting a job only queues it; a worker runs the supervisor. Brain edits made here are committed
  as `human` and checked against the working-document protocol.

## Demo data

```bash
pnpm --filter switchyard-panel seed:demo
SWITCHYARD_CONFIG=.demo/switchyard.config.yaml pnpm --filter switchyard-panel dev
```

The seeder builds `.demo/` with three projects (`demo`, the calculator service, with `core` and
`app` repositories; `storefront`, whose repository is also aliased `app`; and `legacy-billing`,
archived), their fixture repositories, manual models, and task history recorded through the real
router with a scripted provider client. The storefront has its own finished tasks, a queued job,
and a brain note. Every demo provider (and the OpenRouter
catalog and Hugging Face lookups) points at 127.0.0.1 on a closed port, so Scan and Test never
leave the machine; they report failed listings instead. It also runs a finished standalone job and a job
paused on a question for you, fills a demo brain (`.demo/brain`: working documents, reports, a
decision, a lesson, facts) with two pending access requests, and records a small paid spend through
a fake direct client (the demo paid keys are fake). Every run records its agent session (event log
of messages, model requests, and tool calls); the interrupted demo task never ran, so its session is
recorded by hand.
Qualification rows in the demo are illustrative.
