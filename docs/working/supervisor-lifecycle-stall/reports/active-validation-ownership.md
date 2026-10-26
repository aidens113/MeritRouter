# Active validation ownership guard

Status: Complete (worker result; root independent review/release remain)
Workspace: D:/SwitchYardRouter-active-validation
Branch: feat/active-validation-ownership

## Changes

- packages/router/src/harness/supervisor-tools.ts: INTERNAL model cancel_tasks now runs current supervisor authority, persisted direct-child/project ownership, descendant action/lease preflight and synchronous service cancellation inside one IMMEDIATE transaction. Any current-generation pending human_only approval or operator-approved running action refuses the entire batch. Exact taskId/project/owner/runCount/incarnation plus live original lease/deadline are authoritative; model reason text cannot override them. Raw guarded reads do not cancel/alter action rows. Current service cancel facade remains unchanged and synchronous.
- Same file: await_tasks includes persisted running action status/recorded deciding actor before long historical child results, explicitly execution in progress rather than pending human approval. Existing bounded wait and policy reload behavior retained.
- packages/router/src/runners/supervisor.ts: active-child finish refusal tells continue await_tasks until settled; no longer suggests cancellation as a completion shortcut. Extra file explicitly authorized by root.
- docs/roles.md: documents enforced internal policy, exact-generation cleanup and unchanged external/runtime authority.
- New packages/router/tests/active-validation-ownership.test.ts.

No core service/API changes or blanket cancellation prohibition. Explicit external service/CLI/panel/MCP cancellation and runtime deadline/policy fences retain authority. Ordinary unprotected/supervisor-policy cancellation, stale generations, foreign action rows, quiescent/denied actions and expired-source cleanup remain available. Sub-supervisor cancellation cannot bypass protected descendant work.

## Observed validation

- Offline frozen-lockfile install succeeded219packages, no downloads,1m48.9s. Initial package bin warnings preceded first dist build; no manifest/lock changes.
- First dedicated12/12 tests passed20.44s. Initial typecheck found an incomplete test HarnessEnv cast, corrected to a complete typed fixture environment (no runtime assertion weakened).
- Final `pnpm --filter meritrouter typecheck` passed.
- Final `pnpm --filter meritrouter build` passed.
- Final `cd packages/router; pnpm exec vitest run tests/active-validation-ownership.test.ts tests/supervisor-human-approval-wait.test.ts tests/supervisor-action-clock.test.ts tests/supervisor.test.ts --maxWorkers=1`:4files28/28 passed68.74s. New ownership suite16/16 passed22.885s; existing supervisor3, humanwait6, actionclock3 all passed.
- `git diff --check` passed (CRLF normalization warnings only).

Real temporary operator-approved Node command runs until a trusted test release marker. Internal cancellation is refused without changing child/action state; await reports running approval; external cancellation still stops and quiesces it. The actual SupervisorRunner integration attempts cancel_tasks, receives refusal, attempts finish_job blocked, receives active-child refusal, then completes the command and finishes normally. Tests also exercise pending approval, mixedbatch all-or-nothing, expired/stale/foreign rows, exact caller generation, descendant human-only pending action, operator-approval/cancel race, own supervisor-policy approved action cancellation, and quiescent-action cleanup.

## Boundaries and remaining review

Only isolated source/tests and this own main report were written. No application code, live runtime/store/config/provider state, approvals, commits or pushes changed. Fake provider calls use fixture transport only; Node commands run inside temporary test repositories under explicit fixture operator decisions.

This narrow guard prevents the actual approved-check cancellation escape. It does not add a general typed external-blocker contract to every finish_job blocked report, or prove all unfinished plan semantics. Product acceptance still needs real checks and independent FINAL review.

Root independently identified the same stale-running observation nuance and explicitly authorized a follow-up after its prior frozen checks completed. Follow-up now resolved: currentActionGeneration reads exact row/task/project/lease owner/runCount/incarnation, cancellation flag, live lease and deadline. Only current running rows report execution in progress; inactive rows say persisted running from inactive generation; unresolved, requires operator reconciliation. No row is deleted, protected or reconciled by this display classification; accounting is untouched. docs/roles.md explains the distinction.

Final follow-up verification supersedes the prior16case snapshot: `pnpm --filter meritrouter typecheck` and router build passed; `cd packages/router; pnpm exec vitest run tests/active-validation-ownership.test.ts --maxWorkers=1` passed17/17 in25.00s. New regression takes a persisted running row through current identity then five stale identity dimensions (owner/run/incarnation/project/task) plus an expired deadline, checking distinct labels and byte-identical stored action/no cancellation. Earlier four-file28/28 run remains valid historical evidence before the observation-only follow-up. Root owns the fresh existing humanwait/actionclock checks after final freeze.
