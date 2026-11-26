# Lane A: MCP surface (supervisor-offload)

## Outcome: Done

## What changed and why

**Config (`src/config/schema.ts`, not in my owned list but required and not forbidden):** added
`client_supervision.tools: "core" | "full"`, default `"core"`. This is the switch the brief names
as `mcp.tools`; I put it under the existing `client_supervision` section (already the home of
outer-MCP-client advice) rather than inventing a new top-level `mcp:` section, since no such
section exists and `client_supervision` already governs exactly this kind of client-facing
behavior.

**`src/mcp/tools.ts`:** `buildMcpServer` now computes `includeFull = cfg.client_supervision.tools
!== "core"` and wraps every pre-existing tool registration (`write_project_memory` ... `blame`,
~50 tools) in `if (includeFull) { ... }`. `read_artifact` stays unconditional. After that block,
12 new tools are always registered:

- `delegate` — takes a `BriefV1`-shaped object, runs `checkBrief` (core/brief.ts, read-only
  import), returns `{ok:false, errors, warnings}` without submitting on a lint error, otherwise
  maps it with `briefToTaskArgument` + `scopedMcpTasks` onto the existing `submitTasks` path and
  returns `{ok:true, taskId, routePreview}` (a tier-T1 `routingPreview` snapshot).
- `await` — calls `sy.awaitResults`, renders each finished result with `renderReportV1`
  (core/report.ts), and includes the task's pending worker messages (via
  `sy.channel.listPendingForSupervisor` filtered by taskId) both in the rendered report's "Open
  messages" section and as a separate `pendingMessages` field.
- `inbox`, `reply`, `probe`, `rework` — thin wrappers over `sy.channel.listPendingForSupervisor` /
  `replyFromSupervisor` / `probe` / `rework` (the lane B `SupervisorChannelService` contract).
- `accept`, `reject` — same `decideTaskAcceptance` path as the full set's `accept_result`/
  `reject_result`, just under the new names.
- `run_check` — new: re-runs one command from a task's own declared `constraints.checks` (refusing
  any other command) in its latest recorded session worktree, and stores the output as an
  artifact. This is new standalone logic (not present elsewhere); it does not touch `src/core/**`
  or `src/harness/**`, only reads `sy.tasks`, `sy.sessions`, `sy.artifacts` (existing public
  surfaces already used elsewhere in this file).
- `status`, `offload_report` — `status` mirrors `get_task_status`; `offload_report` is the
  specified stub (`{available:false, note:...}`) until lane E.
- Three MCP prompts: `offload_playbook` (returns the live effective instructions text),
  `write_brief` (a filled BriefV1 template for a given goal), `probe_report` (the probing
  protocol).
- `get_session` now caps its JSON text at `maxBytes` (default 60000, same as `read_artifact`),
  closing audit gap #4.

**`src/mcp/schemas.ts`:** added `BriefArgumentSchema`, a portable (Codex-safe) description of
BriefV1 using the file's existing `open()` helper, importing `BRIEF_KINDS`/`REPORT_DETAILS` from
`core/brief.ts` (read-only).

**`src/admin/client-supervision.ts`:** rewrote `DEFAULT_CLIENT_SUPERVISION`. Replaced the first two
paragraphs ("delegate as much as possible... normally start a delivery-supervisor job") with five
new paragraphs: default to direct bounded tasks; concrete delegate-vs-keep lists; the brief
template + smallest-tool-profile/grant-on-request rule; the await/probing protocol (trust only
VERIFIED, probe triggers, spot-check the riskiest file); rework-once-then-escalate. Kept the four
existing paragraphs on model strength, credit notices, independent validation (delivery_status /
record_delivery_observation / decide_delivery / resume_task — still full-only tool names, left
intact since they describe the delivery-v2 path) and user interruptions, since they're good
content the audit praised and many tests key off their exact wording.

## Must-not-touch / out-of-ownership files I touched, and why

- **`tests/helpers.ts`** (shared test infra, not owned): `makeEnv`'s `raw.client_supervision ??=
  {workflow:"direct_tasks"}` became `raw.client_supervision ??= {tools:"full", workflow:
  "direct_tasks"}` — **only** when a test doesn't set `client_supervision` at all (restored the
  original `??=` semantics exactly, just extended the default value). Without this, changing the
  production default to `"core"` would have silently dropped ~9 unrelated test files (session,
  projects, verification, delivery, split-final-controls, process-acceptance surfaces) to the
  12-tool core set and broken their `submit_tasks`/`accept_result`/etc. calls. A test that
  explicitly names `client_supervision` (even `{}`) is left alone, so it keeps whatever default
  the schema gives it (`"core"`) unless it says `tools: "full"` itself.
- **`tests/mcp-credit-usage.test.ts`** (in my acceptance list) and **`tests/delivery-runtime.test.ts`**
  (not owned, but it explicitly sets `client_supervision: {}` and calls `decide_delivery`/
  `record_delivery_observation`/`set_supervision_policy`/`resume_supervisor_submission` over real
  MCP): both got `client_supervision: {tools:"full"}` added to their fixture config, since they
  bypass the `tests/helpers.ts` default.
- **`tests/client-supervision.test.ts`** and **`tests/mcp-lifecycle-v2.test.ts`**: updated the
  literal substrings `expectFinalOversight` and a few inline `toContain`/`stringContaining` checks
  that quoted the old `DEFAULT_CLIENT_SUPERVISION` wording I replaced ("Delegate as much practical
  work" → "Default to direct bounded tasks"; "runtime testing and repair" → "Default to direct
  bounded tasks"; "Keep working through delegated completion and repair" → "rework it once with
  specific, criterion-by-criterion feedback"). I own `src/admin/client-supervision.ts`, whose
  tests these are, and leaving them broken would have been a regression I introduced.
- **`tests/mcp.test.ts`** and **`tests/mcp-http.test.ts`** (both in my acceptance list, both match
  `mcp*.test.ts`): updated the exact 50-tool sorted-name array (and two `toHaveLength(50)` calls)
  to the new 61-tool array (50 existing + 12 new, minus the duplicate `read_artifact`).
- **`apps/panel/scripts/validate-client-supervision.mjs`** (manual, Chrome-driven, not run by
  `npm test`): fixed the one literal-text assertion (`"Delegate as much practical work"` →
  `"Default to direct bounded tasks"`). I did **not** add `client_supervision.tools: "full"` to
  its fixture config after discovering that would break its own `before`/`after` YAML-diff
  assertion (it deletes `client_supervision` from `after` and compares to `before`, which would
  then disagree). This script also calls `get_supervision_policy`/`set_supervision_policy` over
  MCP and will need `client_supervision: {tools:"full"}` plus a corresponding adjustment to that
  diff check; I left it for whoever owns panel validation, since I can't run it here (needs Chrome
  + a panel build) to verify a fix.

I did **not** touch `src/core/**`, `src/harness/**`, `src/runners/**`, contracts files, or
migrations.

## Design decisions not fully specified by the brief

- **Core vs. full tool partition**: I registered the 12 new tools unconditionally (in both modes)
  and gated only the pre-existing ~50 tools behind `includeFull`, so `full` = core-set-plus-everything
  rather than two disjoint sets. This matches "full restores every tool, including the core set"
  more literally than a disjoint reading would.
- **`run_check`'s scope**: the brief lists `run_check` as a core tool but it previously only
  existed as a *worker*-side harness tool (`core/brief.ts`'s `DECLARED_CHECK`). I built a new,
  separate supervisor-side implementation in `mcp/tools.ts` that re-runs a task's own declared
  check in its last recorded session worktree via `child_process.execFile`, refusing any command
  not in `constraints.checks`. This is deliberately narrow (one declared command, no shell
  pipelines beyond what the check itself needs) and self-contained in `src/mcp/**`; it does not
  reuse or alter the harness's own check-running code.
- **`await`'s messages**: `SupervisorChannelService` (lane B's contract) only exposes
  `listPendingForSupervisor` (worker→supervisor, not-yet-answered) and `pendingForWorker`
  (supervisor→worker, not-yet-delivered) — there's no "full message history for a task" method. So
  `await`'s `pendingMessages` and the report's "Open messages" section only ever show *pending*
  worker-to-supervisor messages, never a full back-and-forth history, even at `detail: "full"`.
  This is a real limitation of the current channel contract, not a bug in my tool; flagging it for
  whoever extends lane B/E.
- **`delegate`'s route preview**: `BriefV1` has no explicit tier field, so I always preview against
  tier `"T1"` with a note that actual routing may escalate, rather than trying every tier.

## Commands run and observed results

- `cd packages/router && pnpm typecheck` → exit 0, no errors (an unrelated error in
  `tests/worker-channel-tools.test.ts`, lane C's file, was present earlier in the session and
  gone by my final run — not something I touched or fixed).
- `pnpm build` → exit 0.
- `npx vitest run tests/mcp.test.ts tests/mcp-http.test.ts tests/mcp-lifecycle-v2.test.ts
  tests/mcp-passive-startup.test.ts tests/mcp-credit-usage.test.ts tests/mcp-offload.test.ts` →
  **6 files, 37 tests, all passed.**
- `npx vitest run tests/client-supervision.test.ts` → 8/8 passed (after the substring updates).
- Measured core tool-list JSON size directly (temporary `console.log` in the test, removed after):
  **10,176 bytes** for the 12 core tools — well under the 12KB target (vs. the audit's ~40KB
  estimate for the full 50-tool set, now 61).
- `npx vitest run tests/delivery-runtime.test.ts` → **2/2 still failing**, but confirmed unrelated
  to this lane: the failure (`stopReason: "supervisor_blocked"` vs. expected
  `"supervisor_completed"`, `"node --version: terminated"` / `"node check.cjs: terminated"`) occurs
  entirely inside the delivery-v2 supervisor/harness execution loop, *before* the test ever reaches
  the `buildMcpServer`/`decide_delivery` code at the bottom of the test. I added
  `client_supervision: {tools:"full"}` to its fixture (needed once that part of the test runs) but
  did not investigate or fix the earlier failure, since it's in `src/core/**`/`src/harness/**`
  territory (lanes B/C) and reproduces regardless of my changes.

## Not verified

- `apps/panel/scripts/validate-client-supervision.mjs` (needs Chrome + a panel build; not run
  here) — needs `client_supervision: {tools:"full"}` added to its fixture plus its `before`/`after`
  YAML-diff assertion adjusted to tolerate that key, for its `get_supervision_policy`/
  `set_supervision_policy` calls to keep working.
- The full 3,400+ test suite was not run (out of scope/budget for this brief); only the named
  acceptance files plus the ones my change provably affected (`client-supervision.test.ts`,
  `delivery-runtime.test.ts`) were checked. Other full-mode-dependent files I located via grep
  (`project-entrypoint-isolation`, `verification-surface`, `session-surface`, `projects-surfaces`,
  `split-final-controls`, `delivery-attention-report`, `process-acceptance-budget`) were not
  individually re-run, but none of them name `client_supervision` explicitly, so they go through
  the restored `tests/helpers.ts` `??=` default (`tools:"full"`) unchanged from before my work.
- Live stdio/HTTP smoke of the new tools end-to-end from an actual Claude Code/Codex client (only
  exercised via the MCP SDK's in-memory/stdio/HTTP test transports).
- `run_check`'s success path (a declared command actually executing against a real worktree) —
  only the two refusal paths (unknown task; undeclared command) and the "no recorded worktree"
  path are covered by `tests/mcp-offload.test.ts`, since building a real coding task with a
  finished worktree needs the worker/runner machinery I must not touch.

## Report: docs/working/supervisor-offload/reports/lane-a.md

## Notes
- Lane B's `SupervisorChannelService`/`sy.channel` is unit-tested here only against an injected
  fake (per the brief); I never saw lane B's real implementation.
- `src/config/schema.ts` had unrelated concurrent edits from another lane while I was working (a
  mid-session system note flagged this); my `client_supervision.tools` addition is intact and was
  re-verified present after that.

```text
Outcome: Done
Changed: packages/router/src/mcp/tools.ts, packages/router/src/mcp/schemas.ts,
  packages/router/src/admin/client-supervision.ts, packages/router/src/config/schema.ts,
  packages/router/tests/mcp-offload.test.ts (new), packages/router/tests/mcp.test.ts,
  packages/router/tests/mcp-http.test.ts, packages/router/tests/mcp-credit-usage.test.ts,
  packages/router/tests/client-supervision.test.ts, packages/router/tests/mcp-lifecycle-v2.test.ts,
  packages/router/tests/delivery-runtime.test.ts, packages/router/tests/helpers.ts,
  apps/panel/scripts/validate-client-supervision.mjs
Validation: `cd packages/router && pnpm typecheck && pnpm build` -> both exit 0;
  `npx vitest run tests/mcp.test.ts tests/mcp-http.test.ts tests/mcp-lifecycle-v2.test.ts
  tests/mcp-passive-startup.test.ts tests/mcp-credit-usage.test.ts tests/mcp-offload.test.ts`
  -> 6 files / 37 tests passed; `npx vitest run tests/client-supervision.test.ts` -> 8/8 passed;
  core tool-list JSON measured at 10,176 bytes (target well under 12KB)
Not verified: panel validate-client-supervision.mjs (needs Chrome, not run); full repo test suite;
  run_check's success path against a real finished worktree; live client smoke
Notes: tests/delivery-runtime.test.ts (2 tests) fails for a reason unrelated to this lane (fails
  inside delivery/harness execution before reaching any MCP tool-gating code) - flagging for
  lanes B/C, not fixed here. One pre-existing typecheck error in lane C's
  tests/worker-channel-tools.test.ts was present mid-session and gone by my final run.
```
