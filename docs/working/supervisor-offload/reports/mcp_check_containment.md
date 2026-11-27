# Worker report: MCP check containment

Outcome: Done
Role: heavy worker; main checkout only; no commits or pushes.

## Changes

- `packages/router/src/mcp/tools.ts`: removed the direct shell execution from MCP
  `run_check`. Project/task, exact declaration and recorded-worktree validation remain.
  A declared check with a recorded worktree now returns an MCP error with
  `command_authority_unavailable`; it never fabricates an exit code or check artifact.
- The current MCP connection has no captured supervisor lease or exact operator approval.
  Existing harness authorization (`executeSupervisorCommand` /
  `currentSupervisorAuthority`) requires a persisted active supervisor task and its
  captured lease. A command declaration, workspace record or `supervisor` policy setting
  cannot supply that missing principal. The handler therefore fails closed under every
  existing policy rather than inventing host authority or reconstructing a lease.
- The tool description states this limitation and directs independent verification to an
  authorized harness or the supervisor's own command tool. The tool name and input schema
  remain available; successful MCP execution needs a future explicitly authorized adapter.
- Per the lead's follow-up, clarified the delegate tool's free-only task budget and removed
  obsolete placeholder wording from the implemented `offload_report` description.
- `packages/router/tests/mcp-offload.test.ts`: added three benign `node --version`
  regressions using real recorded sessions and disabled workers. Each of `disabled`,
  `human_only` and `supervisor` refuses execution without a host capability and creates no
  check artifact. Existing malformed/missing task, declaration and workspace checks remain.

## Validation

- `cd D:/MeritRouter/packages/router; npx vitest run --no-file-parallelism tests/mcp-offload.test.ts`
  — exit 0; 1 file passed, 10 tests passed; duration 35.66 seconds. Source only, no live
  providers, no dist writes.
- `git diff --check -- packages/router/src/mcp/tools.ts packages/router/tests/mcp-offload.test.ts docs/working/supervisor-offload/reports/mcp_check_containment.md`
  — exit 0; no whitespace errors observed.

## Not verified

- Recursive typecheck, aggregate suite and build are owned by the lead and were not run.
- No live providers or client integrations were used.
- No successful MCP command path exists in the present authorized API. This intentionally
  removes the previously uncontained execution path; the normal authorized harness command
  runner was left unchanged.

## Integration notes

- Authored operating docs and supervisor guidance must explain the current MCP `run_check`
  refusal. The lead was notified while the documentation worker was active.
- Only the two owned source/test files and this report were changed. Helper-cache, eval,
  shared working documents and dist files were not touched.
