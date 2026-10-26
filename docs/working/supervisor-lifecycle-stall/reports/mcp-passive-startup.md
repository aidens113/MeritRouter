# Passive MCP startup implementation

Status: Complete (worker result; independent supervisor review required)
Workspace: D:/SwitchYardRouter-mcp-passive
Branch: feat/mcp-passive

Implemented passive MCP CLI startup by default. Both standalone `dist/mcp.js` and `meritrouter mcp` accept explicit `--worker`; historical `--no-worker` remains passive; simultaneous flags fail with an explicit usage error. Programmatic McpOptions.worker=true still flows unchanged to MeritRouter. CLI help and source comments explain daemon/separate-worker execution and explicit install-wide worker behavior. Existing stdio execution fixture now requests --worker; HTTP default expectation now passive.

Owned changes (all in isolated worktree):
- packages/router/src/mcp/serve.ts
- packages/router/src/mcp.ts
- packages/router/src/cli.ts
- packages/router/src/cli/help.ts
- packages/router/tests/mcp-http.test.ts
- packages/router/tests/mcp.test.ts
- packages/router/tests/mcp-passive-startup.test.ts (new)

Actual process regressions cover both entry points with no flags and --no-worker: queued work exists before startup; initialize/listTools then submit and resume calls persist correctly; after1250ms (beyond polling interval), every task remains queued with run_count0, request ledger empty, no worker heartbeat and zero loopback provider calls. Explicit --worker through each actual entry executes one request using a local fake HTTP provider and charges exactly once. Programmatic explicitly requested worker:true remains operational. Option tests exercise default, each flag and conflicting flags.

Validation in isolated worktree:
- `pnpm install --offline --frozen-lockfile` succeeded,219packages reused/no downloads,1m43.4s. No manifest/lockfile edits.
- Initial typecheck/build were attempted before install finished and failed missing node type definitions; final checks after successful installation passed.
- `pnpm --filter meritrouter typecheck` passed.
- `pnpm --filter meritrouter build` passed.
- `cd packages/router; pnpm exec vitest run tests/mcp-passive-startup.test.ts tests/mcp.test.ts tests/mcp-http.test.ts --maxWorkers=1` passed3files/14tests in27.97s. New startup suite8/8 in15.138s.

No shared authored docs, real runtime/config/provider state, live approvals, app source, commits or pushes changed. Root owns release docs, integration and broader checks.

Limits: change prevents future accidental default worker startup after deployment; it cannot retroactively alter an already running old binary or connector-cached command. Root must deploy updated dist and retire old worker-enabled MCP processes. Users depending on implicit MCP execution need explicit --worker or a daemon. Explicit workers intentionally remain install-wide; no singleton lock or false project-isolation promise introduced.
