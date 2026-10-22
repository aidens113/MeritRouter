# Report: external-runner-tools

## Outcome
Complete and frozen for supervisor review. No commits or shared-document edits.

## What changed and why
- External command/OpenCode agents need code-enforced declared checks and budget requests, using the existing native implementations and shared live RunContext budget.
- New task-scoped bridge uses authenticated loopback MCP, not install-wide tools. Calls are serialized, current task/lease/deadline checked, waits interrupted on ownership loss, and session intents/outcomes journaled.
- Command agents receive connection metadata through environment variables; OpenCode receives a named remote MCP entry with an environment-expanded bearer token. TASK.md never contains that token. Only declared checks and request-more-budget capabilities are registered.
- The model gateway waits while task-tool calls are pending, reads the shared updated request cap after approval, and aborts/drains outstanding requests on shutdown. Bridge shutdown interrupts checks and approval waits and closes its HTTP listener.
- Owned files: runners/coding/index.ts, runners/coding/policy-gateway.ts, new runners/coding/task-tools.ts, new tests/external-task-tools.test.ts, and this report. No admission or public-export changes required.

## Commands run and observed results
- `pnpm install --frozen-lockfile --offline`: passed (5m58.8s); expected missing prebuild CLI-bin warnings.
- `pnpm --filter switchyard-router typecheck`: passed.
- `pnpm exec vitest run tests/external-task-tools.test.ts tests/coding.test.ts tests/budget-control.test.ts tests/native.test.ts --maxWorkers=2`: 33/33 passed across four files (44.07s).
- `pnpm --filter switchyard-router build`: passed.
- `git diff --check`: passed (line-ending notice only).
- Five real subprocess fixture tests demonstrate human approval and supervisor approval continuing from a one-request cap to three requests; denial without another provider request; an approval wait with a concurrently queued model request spending nothing until approval; token cap remaining enforced; stale lease refusal; bad bearer token and foreign task argument refusal; declared-command enforcement and per-task check-run cap; journal intents/outcomes; and unreachable listeners after cleanup.
- During development two test assertions used a nonexistent journal reader; corrected to the public session events API, then observed the complete passing run above.

## Not verified
- Supervisor independently observed all five subprocess tests pass in 52.89s (23.21s test time). An earlier cold run under concurrent installs passed four but exceeded the fixture's 15s startup wait on human approval. An unchanged focused retry passed; supervisor then bounded startup at30s and test deadlines at45–60s without changing behavior assertions, and reran all five successfully. Integrated whole-suite acceptance remains pending.
- No installed OpenCode binary or real provider was run; subprocess fixtures speak the actual MCP SDK transport and gateway HTTP protocols. No user installation/configuration or quota was touched. No panel changes or repository-wide suite run in this isolated worker.
- Labs native-tool append remains a separately coordinated hook; these changes preserve RunContext fields and do not depend on that API.

## Open questions or contradictions found
- Official [OpenCode MCP documentation](https://opencode.ai/docs/mcp-servers/) specifies named remote MCP entries, headers, oauth:false and prefixed tool names. [Config documentation](https://opencode.ai/docs/config/) documents inline OPENCODE_CONFIG_CONTENT and environment substitution; managed settings can override inline settings. The existing adapter follows this /docs config family, not the different /v2/docs mcp.servers schema. No installed OpenCode version or live execution is claimed.
- Supervisor owns authored decisions/docs update; this report records verified external contracts without editing shared docs.
