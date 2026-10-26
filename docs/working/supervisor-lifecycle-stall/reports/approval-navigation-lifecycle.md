# Approval navigation lifecycle investigation

Worker: approval_navigation_lifecycle
Date: 2026-10-25
Status: Investigated; implementation not performed

## Findings

The panel couples an approved command's cancellation signal to the browser request. The exact chain is:

1. `apps/panel/app/api/worker-actions/[id]/route.ts:18` awaits `insights.decideWorkerAction(..., req.signal)`.
2. `packages/router/src/admin/worker-actions.ts:15` forwards that signal with the trusted operator actor. Actor identity is not supplied by the HTTP body.
3. `packages/router/src/harness/worker-actions.ts:187` registers an abort listener that forwards the signal's reason to its execution controller. Line194 passes that controller to `runProcess`.
4. `packages/router/src/runners/coding/process.ts` reacts by terminating the process tree, waiting for close/termination, and returning the abort reason as `killed`.
5. `WorkerActionRequests.decide` records `uncertain`, null exit code, output containing the abort reason, and `quiescedAt` after the process runner returns.

The brief's actual API action `wa_0mvof4jkp61f355563ee4` therefore matches the code path: `ResponseAborted` after a panel refresh, with persisted quiescence. This is not a model availability failure or an install success. The separate UI action `wa_0mvof7is3de7bc88131ab` used an approximately29-second remaining execution budget and ended `timeout`; changing browser ownership does not increase that budget.

Approval already persists `running` before spawn, claims once in an immediate transaction, checks exact source before claim, and watches the original task lease, cancellation and current policy every100ms. These are useful guards to preserve. The current executor is the panel request process; persistence of `running` is not a durable command owner capable of completing execution after that process disappears.

## Immediate operation

Use one retained browser tab per running approved command. Do not reload, navigate or close that tab until an authoritative terminal action receipt is present. A disconnected CDP control socket is different from navigating the page. Before retrying an uncertain action, confirm persisted quiescence and inspect resulting worktree/install state; retain the failed receipt and use a fresh exact request rather than treating the earlier approval as transferable.

This workaround does not fix the product contract. Merely removing `req.signal` would stop browser navigation from explicitly killing the process on a long-lived local Node server, but would still leave execution owned by an HTTP handler and would not provide durable restart/shutdown ownership. It is an interim mitigation, not the durable design below.

## Recommended bounded implementation

Separate recording an operator decision from executing the approved command. The approval endpoint should validate the same actor, scope, source, lease and policy, persist a one-shot approved/queued state transactionally, and return promptly. A trusted host action service in the existing daemon/runtime should own execution; this is not a model tool or a worker capability grant.

The service must claim exactly once with a persisted execution identity and recheck source, original task/project/incarnation, cancellation, deadline and current policy immediately before spawn. It must retain the existing bounded environment, output cap, command timeout and explicit cancellation watcher. Record execution start when execution actually begins, not when approval is queued; pending and approved-but-not-started time must not consume the command's active execution clock, while the task deadline remains active.

Persist service ownership/heartbeat and enough process identity to reconcile shutdown/crash. Never replay a running/uncertain command automatically. A dead owner alone must not produce a false quiescence receipt; prove process-tree stop or retain an unquiesced uncertain state that prevents unsafe retry/integration. Pending/approved cancellation must prevent spawn; running cancellation must ask the owning service to stop and persist confirmation. Browser disconnect after the decision must have no cancellation authority. A pre-decision abandoned request may still abort before approval is persisted.

Keep supervisor-provided operation responses distinct: those rows currently finish synchronously as explicitly unexecuted operator reports. Do not turn them into fabricated host execution evidence.

Panel changes should show queued approval execution, running and terminal states from persisted records and poll/read them independently of the POST response. Preserve required decision reason and exact request binding. The user's broader approval discoverability work remains a separately deferred UX effort.

## Required verification

- Abort/navigate the actual panel POST after the decision commits; the separately owned bounded command completes once with exit0 and one durable result.
- Disconnect before decision commit; no approved execution appears accidentally. Duplicate/concurrent approve requests cannot spawn twice.
- Source changes between approval and executor claim, original task lease loss/incarnation change, deadline, policy tightening and wrong project/actor all refuse execution.
- Cancel approved-but-not-started work and prove no spawn; cancel running work and prove tree quiescence before a retry becomes possible.
- Exercise owner crash/restart before spawn and while running. Do not replay uncertain effects, grant a new lease silently, or infer quiescence from parent death.
- Keep approval/execution clock tests, including the approximately30-second recipe budget case, in `approval-execution-timeout.test.ts`; navigation independence must not enlarge an explicitly short requested timeout.
- Verify worker wait/terminal handling and direct task bridge behavior in `external-task-tools.test.ts`, including the new approved/queued state.
- Build router and panel, request the touched route on isolated demo data, and inspect actual headless browser navigation plus persisted action receipts. No live provider requests are needed for these regression tests.

## Validation performed

Read-only inspection of the named route, admin bridge, worker action service, process runner and panel request wrapper. No tests were run because this brief requested investigation only and the parent has a frozen-source validation running. No source, application, live configuration or runtime state changed. Only this report was written.
