# Capability-aware human approval wait

## Reproduced cause
await_tasks returned after one bounded service wait whenever any pending WorkerActionRequests row existed, regardless of current host policy. It then always advised decide_worker_action. Under human_only that supervisor approval is impossible; the model was repeatedly awakened instead of waiting for the real operator, leading to polling/cancellation rather than delivery.

## Changes
- harness/worker-action-tools.ts exports workerActionCapability, rereading trusted outsideRepositoryPolicy each invocation. Pending list results include approvalPolicy, canApprove and waitingFor. Tool descriptions distinguish human-only operator approval from supervisor-authorized approval and discourage cancelling solely because an approval is pending. Existing broker authorization remains unchanged.
- harness/supervisor-tools.ts await_tasks keeps waiting in existing bounded slices when a human-only action is pending. No model response is produced merely because it exists. It wakes for actual resolution of a tracked human action, worker completion, existing acceptance/budget conditions, explicit timeout/cancellation, or a pending action under current supervisor-capable policy. Policy is reread each slice.
- Explicit timeout/completed-target output labels human-only waits as awaiting human operator approval and says supervisor cannot approve; it no longer advises impossible decide_worker_action. Supervisor-capable actions retain that advice.
- Existing tests/supervisor-action-clock.test.ts fixture now explicitly uses supervisor host policy because its mock and assertions test the supervisor-capable immediate wake path. Historical clock, lease cancellation and actual operator execution assertions remain intact.
- New supervisor-human-approval-wait.test.ts uses real temporary TaskStore leases, WorkerActionRequests, actual await_tasks tool and real explicit fixture operator approve/deny decisions. Service wait polling is a bounded fake, no provider calls.

## Validation
pnpm exec vitest run tests/supervisor-human-approval-wait.test.ts tests/supervisor-action-clock.test.ts -> 2files/9tests passed,7.29s,exit0.
New cases prove human-only pending wait stays unresolved across multiple service slices with no model request or child cancellation, then wakes on actual operator completed approval/deny. Other cases prove supervisor-capable early wake, trusted policy reload despite stale in-memory cfg, explicit timeout with accurate guidance, explicit cancellation and worker-completion wake.
No other tests or builds run by worker. No app source, real runtime data, paid policy or human approval policy changes. No commits.

## Limits
This prevents the framework from repeatedly waking a supervisor merely because human-only approval is pending. It does not forbid legitimate cancellation, auto-approve commands, or guarantee the model chooses await_tasks. Explicit timeout still returns an honest pending wait, so callers should continue waiting rather than poll other model tools. Actual process approval waits through command completion before returning a resolved action; pending/running execution is not mislabeled completed.
Root owns integrated validation, publication/restart and live product acceptance.

## Scripted Lab fixture synchronization
Root authorized tests/labs-scripted.test.ts after its fixed-script race reappeared in the focused75/76 run. The fake supervisor client is now async. Before returning its predetermined integrate_task call, it waits for the actual subtract child's terminal result using the existing60-second bound and asserts no timeout with task-event diagnostics, matching the established supervisor.test.ts fixture pattern. All integration restart/revision/product/no-error assertions and outer timeouts are unchanged. No production source changes were required for this fixture race.
Validation: pnpm exec vitest run tests/labs-scripted.test.ts tests/supervisor-human-approval-wait.test.ts ->2files/7tests passed,18.23s,exit0 (session98711). No tests remain running.
