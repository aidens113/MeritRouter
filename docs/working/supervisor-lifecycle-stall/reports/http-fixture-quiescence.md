# HTTP transport fixture shutdown lock

Status: Complete; test-only source frozen for supervisor verification.

The first HTTP transport test submitted a task through a separately spawned MCP server
whose default worker was enabled. It asserted submission and HTTP access behavior, never
worker completion, then killed the server process during cleanup. That unrelated worker
could still have background Brain/Git work holding the temporary brain directory on Windows.
The child had no injected fake provider, so running that task was also outside this
transport fixture's intended scope.

Changed only `packages/router/tests/mcp-http.test.ts`:

- `startHttp` explicitly passes `--no-worker`.
- After submission, `get_task_status` verifies the actual persisted task is queued with
  zero model requests. Existing host, origin, bearer/path token, tool inventory and
  submission assertions remain intact.
- No cleanup sleeps, retries, timeout changes, ignored failures, or weaker assertions.

Observed exact check:

`pnpm exec vitest run tests/mcp-http.test.ts --maxWorkers=1` passed4/4 in5.68s
(first run). A second separate execution passed4/4 in5.55s, with the same assertions
and source. Both runs completed cleanup without EBUSY.

This is a transport-fixture correction, not a claim that arbitrary process termination
proves production worker shutdown quiescence. Production model-handoff and lifecycle
source, application files, live state/configuration and commits were unchanged.
