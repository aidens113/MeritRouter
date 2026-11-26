# Worker-side tool restriction from a brief's resolved grant

## Outcome: Done

Closed the contract gap lane C flagged: `WorkerTaskSchema` now carries a brief's resolved tool
grant onto the task the runners actually receive, and `native.ts`/`readonly.ts` enforce it
dynamically (channel grants take effect the worker's next turn) instead of only offering the
full tool surface regardless of brief kind.

## What changed and why

**`src/core/task.ts`** — additive, optional `tools?: { profile?: string; allow: string[] }` on
`WorkerTaskSchema`. `allow` is the full set of tool names initially offered (the resolved
profile/explicit grant); `profile` names which profile it came from, when it did (absent for an
explicit tool list). Both fields are optional/the whole field is optional, so every existing
stored task row (and `StoredTaskDTOSchema`, which embeds `WorkerTaskSchema` directly) still
parses unchanged — verified by the untouched `tests/task-queue.test.ts` passing.

**`src/core/brief.ts`** — `briefToTaskArgument` now sets
`task.tools = { profile?, allow: resolveBriefTools(brief) }`: `profile` is the kind-default or
explicit profile name when `brief.tools` names one, and absent when the brief lists tools
explicitly (array). `resolveBriefTools` already existed (adds `ALWAYS_ON_WORKER_TOOLS`); no
change to its logic.

**`src/harness/tools.ts`** — new `workerToolPolicy(ctx)`: returns `undefined` when
`ctx.spec.tools` is absent (legacy task, no restriction), else a closure matching
`LoopOptions.toolPolicy`'s shape (`src/harness/loop.ts`, pre-existing, used today by
`src/runners/supervisor.ts`'s discovery-exhausted policy). Each call recomputes
`allow ∪ ctx.channel.grantedTools(taskId) ∪ ALWAYS_ON_WORKER_TOOLS` fresh, so a mid-run channel
grant (`SupervisorChannelService.grantedTools`) is reflected starting the very next turn without
restarting the loop — `loop.ts` already calls `toolPolicy()` once per turn to filter the tool
defs actually sent to the model (`requestDefs`) and to refuse an invented out-of-set call before
running it (`tool restricted by current workflow policy: <name>`, unchanged wording — see Design
decision below), and already pushes `policy.notice` into the conversation once per distinct
notice text. I did not touch `loop.ts`: its existing dynamic-policy mechanism already does
exactly what this feature needs.

**`src/runners/coding/native.ts` and `src/runners/readonly.ts`** — both still build the same full
tool catalog they did before (so a later channel grant can reveal any of it); the only change is
`...(workerToolPolicy(ctx) ? { toolPolicy: workerToolPolicy(ctx) } : {})` passed into
`runAgentLoop`. A legacy task (no `spec.tools`) gets no `toolPolicy` key at all, so its behaviour
is byte-for-byte unchanged (verified: `tests/worker-tool-profiles.test.ts`'s two tier-gating
tests, which submit tasks with no `tools` field, still pass unmodified).

**`src/harness/worker.ts`** — `submitResultTool`'s `accept` now requires `selfCheck` (a clear
validation error, not a thrown exception) when `spec.tools` is set (brief-originated), leaving
the existing softer contract (missing `selfCheck` renders as "NOT PROVIDED", not a rejection)
for every legacy task. This is the one place lane C's report flagged as a deliberate deviation
from "submit_result requires selfCheck" for *all* tasks — tightening it project-wide would have
required rewriting every hand-rolled `submit_result` fixture across the suite; scoping it to
`spec.tools` makes it strict exactly where the new contract applies, without touching any of
those other files.

**Design decision — the refusal message.** The brief asked for a message that tells the worker
to use `request_tools`. `loop.ts`'s generic per-call refusal (`tool restricted by current
workflow policy: <name>`) is asserted verbatim by an existing, unowned test
(`tests/supervisor-loop-role.test.ts:144`), so I did not reword it. Instead `workerToolPolicy`'s
`notice` field (`"Your current tool grant for this task: ...; ... call request_tools ..."`) is
injected as a one-time orientation message the first turn the policy is active (and again,
freshly, whenever the allowed set actually changes, e.g. after a grant) — the same pattern
`src/runners/supervisor.ts`'s own discovery-exhausted policy already uses (generic per-call
refusal + a separate `notice`). An out-of-set call is still refused (the model never even sees
it offered, and a call anyway is rejected); the `request_tools` guidance is proactive context
rather than embedded in that one error string. Flagging for the lead in case the literal wording
in a per-call refusal is wanted badly enough to justify editing `loop.ts` and that test together
(outside this brief's ownership).

**New tests: `tests/worker-tool-restriction.test.ts`** (11 tests):
- `workerToolPolicy`: undefined for a legacy task; resolves `allow ∪ ALWAYS_ON` with no channel;
  a channel grant (`grantedTools()`) is picked up on recomputation.
- `briefToTaskArgument`: sets `tools.profile`+`allow` for a kind-default grant; `tools.profile`
  absent for an explicit tool list.
- End-to-end through the real `runAgentLoop` (mirroring `tests/supervisor-loop-role.test.ts`'s
  own dynamic-policy fixture): a brief-restricted task offers only its granted tools on turn 1;
  a tool's own side effect (standing in for a supervisor's grant reply) changes
  `channel.grantedTools()` between turns, and the newly granted tool is offered and callable
  starting the next turn; an out-of-set call is refused (`restricted by current workflow
  policy`) and the conversation carries a `request_tools` notice; a legacy task (no `spec.tools`)
  gets no policy at all and its tool call runs normally.
- `submit_result`: rejects a brief-originated task's result with no `selfCheck` with a clear
  message; accepts it once supplied; a legacy task is unaffected.

**Updated existing test**: `tests/offload-contracts.test.ts` — the one exact-shape assertion of
`briefToTaskArgument`'s output (`"maps a clean implement brief onto the existing task contract
and submit_tasks shape"`) now also expects the new `tools: { profile: "implement", allow:
resolveBriefTools(...) }` field; everything else in that test (including re-parsing the result
through both `WorkerTaskSchema` and the MCP `TaskArgumentSchema`) is unchanged and still passes,
confirming the additive field round-trips through both schemas without further edits (the
`TaskArgumentSchema` is a `looseObject` with `additionalProperties: true`, so it already accepts
the new key with no schema edit needed — `src/mcp/schemas.ts` was not touched).

## Commands run and observed results

- `cd packages/router && npx tsc --noEmit -p .` -> clean, no errors (run twice, after the task.ts/
  brief.ts/tools.ts/native.ts/readonly.ts/worker.ts changes and again after the test file).
- `npx vitest run --no-file-parallelism tests/worker-tool-restriction.test.ts` -> 11/11 pass.
- `npx vitest run --no-file-parallelism tests/worker-tool-restriction.test.ts
  tests/worker-tool-profiles.test.ts tests/worker-channel-tools.test.ts
  tests/offload-contracts.test.ts tests/mcp-offload.test.ts tests/task-queue.test.ts` ->
  **59/59 pass**, 6/6 files (run twice to confirm stability; both runs green, ~48-50s total).
  This included the one necessary update to `tests/offload-contracts.test.ts`'s exact-shape
  assertion (failed before the update, with the diff showing exactly the new `tools` field;
  passed after).

## Not verified

- The full router suite (`npx vitest run`) and `pnpm -r build`/`pnpm -r typecheck` at the repo
  root were not run (out of this brief's acceptance checks; only the six named files plus
  `tsc --noEmit -p .` inside `packages/router` were run, per the brief).
- `tests/worker-channel-tools.test.ts` and `tests/mcp-offload.test.ts` were not modified; I only
  confirmed they still pass alongside my changes (no claim they exercise the new `tools` field).
- `src/mcp/schemas.ts` and `src/storage/task-queue.ts` were read but not edited: `delegate`
  (the brief-dispatch MCP tool) submits straight through `sy.submitTasks`/`WorkerTaskSchema`,
  bypassing `TaskArgumentSchema` entirely, and `StoredTaskDTOSchema` embeds `WorkerTaskSchema`
  directly, so the additive field needed no change in either file. If a future legacy
  `submit_tasks` caller should be able to pass `tools` explicitly through that tool's portable
  description, that is a separate, unrequested change.
- I did not verify behaviour against a live/real `SupervisorChannelStore`-backed executor run
  (full `NativeCodingRunner`/`runReadOnly` through `MeritRouter.submitTasks` with a brief that
  sets `tools` and a real grant reply) beyond the targeted test files above; the new unit/loop
  tests exercise `workerToolPolicy` and `runAgentLoop` directly and faithfully (same fixture
  style as `tests/supervisor-loop-role.test.ts`), but not the full native/readonly runner wiring
  end to end. `tests/worker-tool-profiles.test.ts`'s existing two tests do exercise the real
  runner, confirming the `toolPolicy` wiring compiles and runs without regressing them (no
  `tools` field on those tasks, so `toolPolicy` is simply absent there).

## Open questions or contradictions found

1. **Refusal-message wording** (see Design decision above): the literal "use request_tools"
   guidance lives in the policy's `notice` (shown proactively, once per distinct text), not in
   the per-call refusal string itself, to avoid touching `loop.ts`'s shared generic message
   (asserted verbatim by an unowned test). If the lead wants the exact wording inside the refusal
   itself, that needs a coordinated edit to `loop.ts` and `tests/supervisor-loop-role.test.ts`
   together.
2. None of the files in the other worker's concurrent-edit list (`command-process.ts`,
   `windows-command-job.ts`, `windows-job-executable.ts`, `service-command-process.ts`,
   `command-timeout.ts`, `check-evidence.ts`, `src/verification/checks.ts`) were read or touched.

```text
Outcome: Done
Changed: src/core/task.ts (additive `tools` field on WorkerTaskSchema); src/core/brief.ts
  (briefToTaskArgument sets task.tools); src/harness/tools.ts (new workerToolPolicy); src/harness/
  worker.ts (submitResultTool requires selfCheck when spec.tools is set); src/runners/coding/
  native.ts; src/runners/readonly.ts (both pass workerToolPolicy(ctx) as toolPolicy);
  tests/worker-tool-restriction.test.ts (new, 11 tests); tests/offload-contracts.test.ts (updated
  one exact-shape assertion to include the new field)
Validation: `cd packages/router && npx tsc --noEmit -p .` -> clean; `npx vitest run
  --no-file-parallelism tests/worker-tool-restriction.test.ts tests/worker-tool-profiles.test.ts
  tests/worker-channel-tools.test.ts tests/offload-contracts.test.ts tests/mcp-offload.test.ts
  tests/task-queue.test.ts` -> 59/59 pass (6/6 files), run twice, stable
Not verified: full repo-root `pnpm -r typecheck`/`pnpm -r build`/full router suite (out of this
  brief's acceptance checks); a full live executor run through MeritRouter.submitTasks with a
  real channel grant reply (the new tests exercise workerToolPolicy and runAgentLoop directly,
  same fixture style as the existing supervisor dynamic-policy test)
Report: docs/working/supervisor-offload/reports/tool-restriction.md
Notes: Closed lane C's flagged gap (WorkerTaskSchema had no tool-grant field) exactly as it
  suggested. Chose not to touch harness/loop.ts to keep the refusal message's exact wording
  stable for an existing unowned test; the request_tools guidance instead rides the policy's
  existing `notice` channel. Flagged for the lead in Open questions #1.
```
