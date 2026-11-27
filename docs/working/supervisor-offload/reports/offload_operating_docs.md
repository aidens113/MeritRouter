# Offload operating documentation report

Outcome: Done

Updated `docs/setup.md`, `docs/operations.md`, and `docs/roles.md` to describe direct-task guidance and the distinct delivery-job default, core/full MCP surfaces, brief and channel loop, verification, probe and rework semantics, metrics limits, connection and Claude hooks. Removed conflicting claims that delivery supervision is the default client workflow.

Validation: Source inspection against `packages/router/src/admin/client-supervision.ts`, `packages/router/src/mcp/tools.ts`, `packages/router/src/admin/offload-metrics.ts`, `packages/router/src/cli/connect.ts`, and `packages/router/src/cli/exchanges.ts`; `git diff --stat -- docs/setup.md docs/operations.md docs/roles.md` showed three intended documents. No builds, tests, or providers run, per brief.

Not verified: live Claude Code or Codex connection, hooks, and provider execution; lead should review the diff and documentation accuracy during integration.
