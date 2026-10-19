# SwitchYard panel

Local web panel for SwitchYard Router: overview, models (and why each is or isn't used), routing
previews and overrides, tasks, requests, provider keys, qualification, and every setting.

```bash
pnpm --filter switchyard-router build
SWITCHYARD_CONFIG=/path/to/switchyard.config.yaml pnpm --filter switchyard-panel build
SWITCHYARD_CONFIG=/path/to/switchyard.config.yaml pnpm --filter switchyard-panel start   # http://127.0.0.1:4477
```

- Binds to 127.0.0.1 only. Set `SWITCHYARD_PANEL_TOKEN` to require a login.
- The panel never runs tasks; a worker does (the MCP server inside Claude Code, or
  `switchyard worker`). Settings changes are picked up by running workers within seconds.
- Provider keys for the free network are managed through FreeLLMAPI and need
  `FREELLMAPI_ADMIN_TOKEN`. Secrets are write-only and never sent to the browser.

## Demo data

```bash
pnpm --filter switchyard-panel seed:demo
SWITCHYARD_CONFIG=.demo/switchyard.config.yaml pnpm --filter switchyard-panel dev
```

The seeder builds `.demo/` with a fixture repository, manual models, and task history recorded
through the real router with a scripted gateway. Qualification rows in the demo are illustrative.
