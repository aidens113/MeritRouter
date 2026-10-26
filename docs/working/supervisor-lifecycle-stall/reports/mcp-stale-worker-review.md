# MCP stale worker activation review

Read-only investigation; no runtime, configuration, provider or source changes. No tests executed.

## Finding

This is ordinary default MCP startup, not a special side effect of tool metadata discovery. `mcp.ts` calls `runMcpServer(parseMcpArgv(...))`. `mcp/serve.ts:59` sets worker=true unless --no-worker; line86 constructs `MeritRouter` with that value BEFORE project selection (89), explicit recover (95) and transport handshake (109/114). Constructor `core/service.ts:281` immediately calls startWorker, which starts scheduler plus repository preparation/discovery timers. An MCP client auto-launching the configured command merely to discover tools therefore also starts an installation-wide worker. tools/list itself has no extra scheduler-start path. Normal tool handlers revive the panel, not workers (`mcp/tools.ts:56-59`).

`--project my-project` scopes tool defaults, NOT the scheduler: scheduler.claim uses the installation queue with fair claiming across all projects. Thus a normally launched old my-project MCP process can claim Facebook work while the canary daemon serves the same storage. SQLite leases prevent simultaneous ownership of one attempt; they do not select the newest binary or forbid a different process claiming the next runnable task.

`--no-worker` is already meaningful in current source: scheduler.kick returns if no timer (`core/scheduler.ts:103-105`), so submit/resume calls to kick (`core/service.ts:595,876,898`) cannot start a passive service. Scheduler.tick is deliberately callable for tests/internal explicit use; do not mistake that for tool-triggered startup. This review does not assert that an old compiled dist necessarily contains the current guard.

## Smallest root correction recommended

Make MCP parsed CLI options passive by default and add explicit --worker opt-in in BOTH entry points (standalone mcp.ts via MCP_FLAGS and cli.ts flags). Retain --no-worker compatibility, reject contradictory worker/no-worker choices clearly, and preserve programmatic `runMcpServer({worker:true,...})` and explicit CLI --worker behavior. Update help/startup comments and the current option default assertion (`tests/mcp-http.test.ts:80`). Default passive MCP must communicate that an existing daemon/explicit worker executes queued jobs; do not silently claim work or auto-start a daemon on tools discovery.

This deliberately changes the historical implicit MCP-worker default. Existing installations depending on MCP as their only worker must opt in with --worker or run the daemon. Explicit worker mode remains installation-wide unless separately designed; do not falsely promise project isolation.

Do not solve this with a blanket single-worker lock or only daemon heartbeat detection: explicit multiprocess workers are supported, heartbeat snapshots race, and absent/restarting daemon detection would still start stale MCP execution unexpectedly. A passive default prevents accidental activation without removing explicit worker behavior. It cannot retroactively stop already running old worker-enabled MCP binaries; rollout must identify and retire those processes, and update/restart connector commands.

## Precise validation needed

1. Parser tests: mcpOptions({})/parseMcpArgv([]) worker=false, --no-worker false, --worker true, contradictory flags rejected; CLI and standalone agree; HTTP host/port/token behavior unchanged.
2. Actual stdio process: preseed a queued task in a temporary installation, launch default MCP, initialize/listTools/read-only status, wait beyond poll interval; task remains queued, run_count0, no physical requests/worker heartbeat/repository preparation. Repeat explicit --no-worker.
3. Passive write regression: default/no-worker MCP submit and eligible resume persist queue changes but never claim locally; use a fake-provider temporary fixture, assert no request ledger entries and no worker marker. Separately explicit worker:true executes via unchanged accounting.
4. Explicit --worker actual process executes queued fixture through fake local provider; default MCP beside a worker/daemon cannot acquire any task while the explicit worker owns all execution. Use two projects to prove --project is tool scope and passive server cannot claim the other project.
5. Connection/project failure: ambiguous project or failed handshake must not leave an accidentally started worker (passive default inherently helps; verify explicit worker shutdown remains clean).
6. Run relevant MCP HTTP/stdio/service scheduling tests, recursive typecheck/build and full router suite. No live provider or user's private data in tests.
