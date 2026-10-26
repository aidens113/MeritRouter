# Independent review: passive MCP startup

Reviewer: repair_hydration_review
Date: 2026-10-25
Status: Source review clear; root owns final integration and merged checks
Workspace reviewed: D:/SwitchYardRouter-mcp-passive

## Disposition

No blocking issue found in the frozen seven-file change. The change prevents future default MCP discovery connections from starting a scheduler, while preserving explicit execution and the existing task/service APIs.

## Checked behavior

- `mcp/serve.ts` adds explicit `worker` boolean parsing and changes only the parsed default to false. `--no-worker` remains compatible and passive. Supplying both flags throws a usage error before configuration/service creation.
- Standalone `mcp.ts` uses `parseMcpArgv`, while `cli.ts` registers the same flag and calls the shared `mcpOptions` before opening a generic CLI service. Thus neither entry point has a separate accidental default-worker path.
- `runMcpServer` still passes the requested `opts.worker` directly to the MeritRouter constructor and runs recovery only when true. The programmatic McpOptions interface still requires worker:boolean; explicit true retains the existing behavior. The broader library constructor was not changed.
- Passive submission/resume cannot start execution through `scheduler.kick`: the current scheduler returns when no start timer exists. The new process tests cover those write paths in addition to discovery/status.
- Explicit `--worker` remains installation-wide. `--project` is tool-default selection, not a worker isolation boundary. Help/source comments accurately state this.
- HTTP host/port/token logic and transport shutdown remain unchanged. Option conflicts are rejected before opening either transport.

## Test inspection

The new startup suite has eight cases: one shared parser/default/conflict case; four real stdio passive cases across both entrypoints with default and explicit --no-worker; two real stdio --worker cases; and one explicit programmatic MeritRouter worker compatibility case using parsed options.

Passive cases preseed queued work, initialize/list tools, submit another task and resume an interrupted one, wait1250ms beyond the normal polling interval, then assert every task queued, run_count0, no model request rows, no worker heartbeat, no claimed event and zero loopback provider requests. This is materially stronger than inspecting a boolean option.

Explicit worker cases execute through a local fake HTTP provider and assert exactly one succeeded request/charge. The existing stdio execution fixture now explicitly requests --worker, preserving its previous execution coverage; the HTTP default assertion now expects passive behavior without weakening its token/origin/transport checks.

Reviewed worker report records package typecheck/build and14/14 tests across the new suite and existing stdio/HTTP tests. This reviewer inspected source and tests rather than independently rerunning broad checks; root must observe final merged validation. No external provider, user runtime, configuration or data was accessed by this review.

## Limits and rollout

- The new passive process suite uses a single fixture project. The constructor receives worker:false before any project selection, so source inspection shows it cannot claim another project either; a dedicated two-project process fixture would provide additional exact-scenario coverage but is not a blocker to this narrow default change.
- The programmatic case directly exercises MeritRouter with parsed worker:true, not a separate programmatic MCP transport session. The unchanged runMcpServer option forwarding and actual --worker transport tests cover that path by inspection and composition.
- Existing installations that relied on implicit MCP execution must explicitly add --worker or use a separate daemon. Already running old binaries retain their old behavior and must be identified/stopped during deployment. Updating source/defaults does not retroactively replace a live process or connector-cached command.

Only this report was written. No source/test edits, broad tests, commits, deployments, provider calls or runtime/config changes.
