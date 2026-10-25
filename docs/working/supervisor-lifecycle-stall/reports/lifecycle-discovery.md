# Lifecycle discovery report

## Result
Confirmed a framework control gap, not merely slow model output. A v2 supervisor can spend its entire discovery period issuing host checks or inspect tasks without ever publishing a PlanStore graph. No code changed; no live-provider calls or app edits performed.

## Verified causes
- `runners/supervisor.ts:255`: v2 wrapper gates only delegate/plan_work calls whose literal profile is implement or supervise. An inspect task with checks is unrestricted. run_check is unrestricted by lifecycle. Generic harness tools are constructed outside this wrapper, so equivalent run_command/recipe/batch operations require guarding at their command execution boundary too.
- `harness/supervisor-tools.ts:567`: plan_work is the only structured plan writer and couples recording with immediate dispatch. delegate writes task/Brain briefs but no PlanStore graph. A model can delegate forever with an empty framework plan UI.
- `verification/product-delivery.ts:57`: transition validates adjacent stage progression and readiness at handoff, but does not require a PlanStore plan before implement. A stage named plan is not evidence a plan exists.
- `admin/job-plans.ts:210`: UI/API reads PlanStore. Existing node view already supports taskId=null and state=not_dispatched, so persisted draft plans fit existing storage/view contracts without a migration.
- `harness/loop.ts:136,187`: generic stall detector identifies coding ability by presence of write_file. Supervisor also has that tool for coordination documents. Nudge triggers halfway through allowance, misleading a delegate-only supervisor to write implementation itself; at a 500 request budget it arrives far too late.
- `harness/supervisor-tools.ts:638`: await_tasks deliberately wakes for pending worker actions. Thus a needless inspect command returns control but the model can simply repeat discovery/approval handling; that is working wait behavior, not proof the supervisor is delivering.

## Recommended bounded implementation
1. Add optional `dispatch` boolean to plan_work, default true for compatibility. dispatch:false validates/records decomposition only, then returns visible not-dispatched nodes. It must not classify models via staffNodes, submit tasks, reserve child budgets or request host approval. Use declared difficulty or existing tier-weight fallback. Full brief is supplied again when dispatching, because PlanNode intentionally does not persist every WorkerTask option (repositories/max_requests/lab_checks/shared files).
2. For deliveryVersion2, require persisted spec and actual PlanStore graph before implementation dispatch or entering implement. Permit plan_work draft during prepare/plan; permit ordinary discovery reads before the spec. Keep legacy supervisors unchanged. Never count a stage transition alone as planning.
3. Route v2 implementation dispatch through the persisted graph: either require plan_work for new implementation nodes, or require delegate label/brief matches a recorded plan node. Do not silently record plans after tasks already start. Read-only discovery may stay outside plan but is bounded.
4. Reject pre-plan host command execution before creating a worker-action request. Cover direct run_check, generic command/recipe operations and delegated read-only tasks with host checks. Do not bypass human-only policy or auto-approve harmless-looking shell text. Legitimate commands execute after an explicit plan, preserving existing authorization requirements; a real prerequisite blocker can be represented as a plan discovery node.
5. Add supervisor-specific bounded progression to the loop, based on persisted state and total task requests (resume cannot reset allowance). Suggested small stage budget: 4 initial discovery requests then restrict offered/executable tools to set_delivery_spec/status/ask_user/finish_job; next missing obligation is prepare/plan and draft plan. The server should narrow tools and enforce policy at execution, not only inject a nudge. Preserve blocked finish for genuine unavailable information. Waiting on active legitimate workers/approval does not count as free discovery turns. This policy must not manufacture a plan or observed evidence.
6. Replace/suppress generic coding write_file nudge for role supervisor. Coding workers retain existing behavior. Keep finish_job completed gate requiring actual integrated candidate/readiness/handoff; no new fabricated completion path.

## Ownership proposal
- lifecycle worker: runners/supervisor.ts, harness/supervisor-tools.ts, verification/product-delivery.ts, new harness/supervisor-lifecycle.ts if a distinct policy concern is needed, tests/supervisor-lifecycle.test.ts and plan tool regression tests.
- loop worker (serial runner integration or disjoint): harness/loop.ts and its new narrowly typed policy hook, tests/harness-supervisor-progress.test.ts. Supervisor supplies the hook; do not import product-delivery storage into generic loop.
- supervisor: docs/roles.md, docs/operations.md, working docs, integration and full validation. New files belong to owning existing areas, not catch-all helpers.

## Required validation
- Fake-provider actual supervisor run: empty repo, attempted direct host check and inspect-with-check before plan -> no WorkerActionRequests row, no subprocess/task; persisted spec/draft plan visible with zero dispatch; plan then dispatch -> bounded workers actually run.
- Draft plan: no Gate/classification request, task reservation or worker action; get_plan exposes not_dispatched nodes; default plan_work still immediately dispatches legacy callers.
- Invalid graph/brief leaves no partial plan/tasks; duplicate labels, foreign repositories, missing allowed_paths and dependency cycles preserve existing refusal semantics.
- Stubborn model repeated read/check calls reaches bounded progress restriction without 22 calls; resumed task retains discovery count. Tool calls invented despite narrowed defs still rejected.
- Supervisor never receives write implementation nudge; coding workers still do. Genuine blocked finish and waiting worker approval remain valid, no human approval impersonation.
- Existing supervisor/team-graph/product-readiness/repair/runtime tests plus recursive typecheck/build and full router suite as repository rules require. Panel production demo API/page check should confirm existing draft node rendering if behavior changes.

## Limits
Static source inspection only. Proposed thresholds are design recommendations, not measured optimal constants. No promise arbitrary weak models will produce correct plans: enforcement can require progress or explicit blocked state, not generate trustworthy content. Review and testing acceptance still requires actual observed runtime/evaluator evidence; persisted plan nodes alone do not establish it. Guard location for native/task MCP nested command execution needs implementation trace before editing; wrapper-only protection is insufficient.
