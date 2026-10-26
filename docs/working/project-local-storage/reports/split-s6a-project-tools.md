# S6a pinned project tools and run services

Worker: storage_split_contract
Date: 2026-10-26
Status: source frozen; supervisor review/broad checks pending.
Supervisor acceptance: independently reviewed scoped factory, cancellation transaction and
Executor fallback; project-tool12 +runtime-registry19 PASS31/31,17.09s on2026-10-26.
Registry assertPinned now permits terminal reconciliation while closing without admitting work.
Full repository checks remain pending until active queue/Labs edits freeze.
Directory: MAIN D:/SwitchYardRouter only.

## Owned changes

- New core/project-services.ts: createProjectRunServices(runtime,actorLease,policies) returns
  actual SupervisorServices operating on one pinned local bundle. No installation service
  callback delegation or first-project getter. Branded binding is held in a private WeakMap.
- core/supervisor-authority.ts: projectToolIdentity pins a project-role DB identity per connection,
  rejects bound coordination DBs for private tools, checks actual role/content/project and exact
  live supervisor task/config authority. Explicit unbound legacy stores remain supported.
- harness/supervisor-tools.ts: split tool state must use one local db/tasks/admission graph and
  branded exact actor-lease service binding. Every invocation rechecks authority. Post-await
  brief grant/carve writes recheck inside local IMMEDIATE. Provider usage lines use explicit
  sanitized capacity.usage over current route platforms, not SQL against a pretend local copy.
- harness/budget-tools.ts: split worker requests use exact local captured authority; supervisor
  decisions require actual owning job/current supervisor and local child ownership. Decision
  authorization/read/grant write run under one local transaction. No schema changes.
- harness/worker-actions.ts: existing C3 request/decision/command guards remain; added pinned
  store/project/context checks before source capture, approval reads/writes and polling. No C3
  command backend, approval codec, process execution semantics or S5 files were changed.
- Approved bounded bridge: core/executor.ts optional servicesForLease selects captured per-actor
  callbacks. Split supervisors without this factory fail closed; legacy static services remain
  explicit. Lease-bound factory cancellation is preserved, not replaced by legacy async facade.
  projects/runtime-services.ts private callback type accepts that optional factory.
- tests/project-tool-store-isolation.test.ts and this report. No service.ts/default activation,
  migrations, new checkout, shared documentation or provider calls.

## Service boundary

Factory requires a real ProjectRuntimeBundle, exact captured supervisor lease and explicit
policy callbacks: knownEndpoint, beforeSubmit, bindSubmitted, beforeAccept and changed. Task
validation uses real local config/artifacts; beforeSubmit/bindSubmitted/beforeAccept must return
undefined synchronously under the local transaction. Those required hooks preserve actual Lab,
workspace/check and supervisor-policy gates; there is no permissive production default.

submitTasks fixes parent to captured actor, rejects model project selection/foreign parent,
validates dependency ownership (or same submission batch), existing-ID graph ownership and
current delegating session. Local task insertion, policy recheck, Lab binding and delegation
session event commit atomically. Captured authority is rechecked after async source validation.
get/await/cancel/accept/reject stay in the actor's local descendant graph. Observed target task
incarnations cannot be replaced by reusing an ID. Await polling rechecks actual actor/generation;
private approvals/results never resolve through the installation task store.

Acceptance uses recordAcceptanceDecision with mandatory actual local metadata fence and replaces
caller attribution with captured supervisor task identity; forged human attribution refuses.
Graph callbacks do not confer operator authority or bypass existing acceptance requirements.

## Cancellation and S5 integration

Scoped cancellation is synchronous TaskStore.requestCancel under local IMMEDIATE. It repeats
pending human-only/operator-approved running action protection for direct service callers as
well as tool callers. Protected tasks block the whole cancellation without partial writes.
No asynchronous logical cancellation escapes the protection transaction.

Abort/changed publication runs in a post-stack microtask and rechecks actual persisted state,
cancel intent and exact incarnation/run/owner. Rolled-back cancellation emits no abort or change.
S5 owner confirmed boundPorts.changed(ids) is the host hook: it schedules durable global grant
reconciliation after the local commit and rechecks persisted exact claim evidence. Started
cancel_requested tasks retain their global grant until durable terminal evidence. Normal S5
reconcile/tick remains the recovery path; notification is not evidence of completion or a refund.
No S5 TaskLeases implementation was edited by this worker.

## Validation observed

- New split tools initial6 +legacy supervisor-budget11 +outside-operation10:27/27 passed.
- Expanded split suite9/9 passed: two actual local bundles with duplicate task IDs, real
  supervisor delegation and local task grants, local budget decisions, captured acceptance
  attribution/fence, actual worker action filing/operator denial, foreign context/parent/session/
  dependency/run rejection, coordination rejection, protected actions and cancellation rollback.
- Final split9+budget11 after transaction rechecks:20/20 passed10.69s. Added binding/stale
  identity regressions: final split11/11 and outside-operation10/10 passed. No broad checks claimed.
- Optional approval-execution-timeout:11/14 passed;3 failed (38.02s combined run): two pending
  approval stability cases got uncertain/null instead of completed/exit0, approved-timeout kill
  case fixture condition5s timeout, plus cleanup unhandled cancellation_requested at repository
  command authority check. These observed C3 command timing/backend failures were reported;
  no backend edits, skips or timeout increases were made.
- All tests use real OS-temp FULL SQLite files and read-only temporary Git source identities.
  Worker action fixture files/denies a supported operation; no outside command/provider executes.
  Private global tasks/deps/requests/grants/approval/session table counts are asserted zero.
- Legacy outside-operation10 tests confirm human-only, supplied-response labelling and forged
  supervisor-role refusal behavior remains intact. Existing long budget-control/harness failures
  were reported in prior phases and were not suppressed or retimed here.

## Remaining integration

Host runtime privateServices must wire servicesForLease to this factory using the pinned bundle
and actual local Lab/acceptance hooks, plus policies.changed=boundPorts.changed from S5. Root
S6b owns private evidence/Brain wiring. This phase supplies the scoped callback/tool boundary;
it does not activate root service operations, migration, scheduler fan-out or live testing.
Supervisor owns independent review, recursive typecheck/build and commits.

## Review correction: split worker static fallback

Executor's optional non-supervisor split static service case is now sanitized through actual
local getTask only. Reads require the captured worker's live exact lease and a target in its
local self/ancestor/dependency policy; target incarnation is pinned once observed. Supplied
installation/static callbacks are never invoked. Submit/await/cancel/accept/reject explicitly
refuse this worker compatibility facade. Unbound legacy service behavior remains unchanged;
split supervisors still require their separately branded captured supervisor factory.

Exact regression constructs a real split Executor with six root callback spies, obtains its
actual worker RunContext, checks local self/parent reads, rejects unrelated task and every graph
operation, and asserts all six root spies remain zero. Final project-tool suite12/12 passed
12.51s. Source frozen for supervisor independent review/typecheck. Three optional approval-timeout
failures plus first assertion details and cleanup rejection were sent directly to c3_message.
