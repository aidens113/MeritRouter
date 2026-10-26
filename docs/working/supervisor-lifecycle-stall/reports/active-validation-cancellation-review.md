# Active validation cancellation review

Read-only investigation completed; no source/runtime/store/provider changes in investigation.

## Observed incident

Parent t_0mvof1bldb6e51dd16e6a, session s_0mvoivuv3b9218b6ca526, completed with supervisor_blocked. Its active api-verify-v5 child t_0mvokhrgw0108cf0efc82 was cancelled. Exact npm install wa_0mvokihn6b5581386cf3b had executionStartedAt1792977783445 and decidedBy operator with delegated Codex reason. Parent seq593 at1792977818998 invoked cancel_tasks; seq594 accepted. Action quiesced1792977820529 with exit null/lease_lost and uncertain status. Child terminal1792977820646. Parent finish_job blocked seq599 was acceptedseq600 at1792977823726; endedseq603. Thus this was active approved execution, not a pending human approval.

Parent await_tasks seq570 reported pending human approval before approval; seq580 after approval reported only child still running. Its observation omitted the now-running action. The final summary reused stale pending wording and listed unexecuted phases as blockers. Those model claims are not authoritative state.

## Enforcement gaps

1. harness/supervisor-tools.ts cancel_tasks only ownTask-scopes IDs then calls svc.cancelTasks unconditionally. No approval/action guard, reason, generation/CAS or anti-abandonment policy.
2. core/service.ts cancelTasks calls TaskStore.requestCancel, then aborts matching execution controllers. This is appropriate explicit external cancellation authority; changing it globally would break legitimate user cancellation.
3. runner finish_job accepts status blocked with free text and checks only current active child states. Its refusal explicitly says await OR cancel them first, encouraging cancellation to clear the guard. Once the child is terminal, blocked is accepted even with stale/inaccurate reasons.
4. await_tasks collects pending actions and terminal operator decisions only. Pending->running removes the action from both visible sets. worker_action_requests likewise lists pending only. No authoritative running-action explanation reaches the model.

## Approved narrow prevention proposal

Add a trusted INTERNAL supervisor cancellation boundary, generation-bound to the caller and target, with one atomic SQLite transaction covering all target preflight plus logical cancellation. Refuse when any active current-generation target/owned descendant has a pending human_only action or an approved running exact action. Use persisted status, original lease owner/runCount/incarnation/project and trusted deciding actor; never free-text reason parsing. Models cannot bypass by claiming approval expired/unneeded. Preflight entire mixed batch before mutating any target; no check-then-await race. The supervisor must wait for approved checks; only external operator cancellation, runtime deadline/cancel/policy enforcement retain override authority.

Keep existing explicit external service/CLI/panel/MCP cancellation unrestricted, as authorized operator behavior; do not block TaskStore.requestCancel globally. Expired/inactive old-generation action rows must not prevent supported cleanup of dead children. Foreign-project/non-owned rows cannot supply cancellation authority. If a separate internal service callback is necessary, add a distinct typed method rather than changing ambiguous global cancel semantics; preserve existing API callers.

Expose pending AND running exact actions in supervisor observations, with authoritative status, command, task, execution-start/elapsed and wait guidance. Running is execution in progress, never pending approval. Put these lines before long historical worker results to survive output caps. Update finish refusal to await active work; cancellation is not a suggested completion shortcut. The existing active-child finish guard then enforces continued work when cancellation is refused.

Further typed blocked-fact validation could prevent arbitrary abandonment of unfinished plan phases, but is broader than this concrete incident. Do not try to prove blockers by parsing summary prose. Missing UI/review/test work alone is remaining work, not an external blocker. No weakening of product evidence acceptance is justified.

## Tests needed

- Real pending human_only exact action -> internal cancellation refuses and no child/action mutation; operator-approved running action -> internal cancellation refuses; finish blocked still refuses while child active.
- Mixed cancellable/protected IDs all-or-nothing; approval-vs-cancel race serialized; exact parent/child lease owner/runCount/incarnation/project gates checked.
- Old generation/quiesced/denied/cancelled/expired action cleanup remains possible; ordinary child cancellation with no protected action remains supported.
- External explicit cancel aborts running command and quiesces; runtime deadline/cancellation/policy fences remain effective.
- Await observations distinguish pending/running/completed and keep active status visible after approval; no repeated model polling needed.
- Scripted supervisor integration: approval transitions running, model attempts cancel+blocked, runtime refuses, action/check completes normally and supervisor continues rather than accepting blocked.

Read-only evidence used direct better-sqlite3 readonly connection and bounded session log reads; no write-capable MeritRouter instantiated. Implementation brief subsequently authorized separately by root.
