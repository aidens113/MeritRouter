# Supervisor lifecycle stall investigation
Status: Active
Status detail: Clock correction9995b14 published and active; rebriefed dependency worker awaits fresh matching install approval.
Created: 2026-10-23
Last updated: 2026-10-25
Owner: Senior supervisor agent
Scope: Diagnose and fix pre-plan stalls while preserving human-only command approval.
Paired document: none
Related: [supervised delivery](supervised-delivery-v2.md)

## Current State

Latest correction independently verified: recursive typecheck/build passed; full router suite
`pnpm exec vitest run --maxWorkers=4 --reporter=default --reporter=json --outputFile <temp>`
passed152files/1skipped,1428tests/3skipped/0failed in670.58s. New approval-clock file14/14
passed in that full run. JSON success verified; no concurrent build/live provider worker.
Only trusted pending approval pauses active execution clocks. Source capture stays bounded,
expired clocks cannot revive, task deadline/cancel remain independent, and approved execution
is clamped by requested and remaining own/ancestor budgets. Trusted execution-start accounting
covers commands completing between polls; optional row metadata preserves old records and
immutable approval identity, and replay may only narrow its effective cap.
Independent reviewer found no remaining blocker. Exact user-approved old request never ran;
no approval transfers to replacement/changed source. Dependency task failed its task deadline,
so resumed parent must rebrief setup. Publish this coherent source before runtime recovery.

Corrective routing/batching release published to dev/main at 14410bc.
Live job t_0mvlxbcr2902bde7859a2 was cancelled after22 requests without a plan; both discovery children are cancelled.
It blocked on node --version; external FINAL denied the optional request, explicitly
without human approval, because independently measured environment facts were in memory.
Next response attempted npm run typecheck before any app implementation exists.
No app code is authored by external FINAL. Paid remains disabled.
Implemented disjoint worker corrections: persisted draft planning, matched execution briefs,
bounded task-wide discovery until actual dispatch, pre-plan command/Lab/integration gates,
blocked final-check suppression and role-aware loop policy. Independent source review found
and corrected four bypass/regression paths. Recursive typecheck and build observed passing.
Full router suite observed1392passed/9failed/3skipped in150files,525.41s (session5536).
All8failedfiles passed serialized rerun62/62,299.72s. Only obsolete batching-guidance assertion
changed; runtime assertions/timeouts unchanged. Implementer charter now matches grouped checks.
Final integrated selection49/49 passed42.59s after charter update (lifecycle,loop,native,
harness,readonly checks,delivery runtime and rejected repair). Source3b52bf6 published dev/main.
Rebuilt daemon20712/panel4477 started with unchanged configuration SHA256; free-only450request
pilot t_0mvo5uxr4cfd4c54aca73 persisted spec and prepare stage, then failed18requests with
no children/plan: new guard rejected JSON-encoded nodes accepted by existing tool parser.
Worker corrected parser compatibility and added actual encoded-draft/delegate regression.
No blind resume or direct state mutation: failed tasks are not resumable through supported APIs.
Encoded correction eca0b54 published dev/main, independent32/32 and recursive checks passed.
Daemon7560 launched425request/$0paid pilot t_0mvo60um54e25d8d973f6; actual spec, planv1 and
worker scaffold-core t_0mvo62ugd6ff177065997 observed. Job page/plan HTTP200 and running node verified.
Pilot failed28requests after pending human-only typecheck: await_tasks repeatedly advised agent
decide_worker_action, supervisor cancelled worker then repeated cancellation. Action auto-cancelled;
external FINAL denial attempt returned409 (no decision executed). Candidate b07f3ad8716b9d07ad048d2e2628ebd0717b6270
preserved in child worktree, unaccepted; no dependencies installed or app verified.
Capability-aware human approval wait correction implemented: pending human-only requests alone
stay inside await_tasks without model polling; supervisor-capable requests still wake promptly.
Root focused75/76 exposed preexisting Lab script race; synchronized actual child completion
without timeout/assertion weakening. Final3-file humanwait/clock/Lab10/10 passed26.59s;
recursive typecheck/build passed. Human-wait sourced0b6417 published dev/main.
Current390request/$0paid pilot t_0mvo6hmvmd7be5c1e9417 saved spec/plan stage after repeated
hash/goal-echo errors, then requested200extra before dispatch. External FINAL denied request#2;
atomic rejected team proposals held no budgets. Same job/session retained for deployment recovery.
Daemon8792 stopped; canonical spec binding now removes model hashing/goal echo need.
Canonical source63faaa3 published dev/main. Final independent28/28 and recursive checks passed.
Same live job recovered its original session at18used/390cap, advanced to27total requests,
completed/accepted foundation task t_0mvo6qpd0842ae3d2755b at a8b8f911b95acfbee52ff7716caa1fd5a277d1b6,
and created deps task t_0mvo6rej5da69d37ab487 (622f23423645001c90f7b3738e41e4dfeb9cd836).
Daemon13184 stopped for final first-dispatch correction; persisted running rows need normal
lease recovery on restart (owner19572 no longer exists). No install approval pending yet.
Final phased-dispatch guard now allows exact planned first delegate after six-request cap;
independent36/36 and recursive typecheck/build passed. Source d9243b8 published dev/main.
Fresh daemon8988 and production panel4477 run final build. Same job/session recovered: root
session s_0mvo6hmxb98171fac6adf has28model requests and is waiting in await_tasks(timeout120s).
Foundation completed/met; deps running with exact npm install request wa_0mvo71ilk540326de44ab
pending. External FINAL inspected package/config, relayed human approval request, never approved
as operator. Same action/source and root28requests observed across independent reads.
Root integration head f2f2a417df5b43020e67076bcd0eaf9a33f47903; app main remains unaccepted.
Config SHA256 unchanged2963B9A8B79CD23DC2425989BAD58A1BC068E6A6E8DA8F755C0145188B9554E7, paid disabled.
No usable app, installed dependencies, production success, browser acceptance or FINAL approval yet.
Need verify persisted plan, dispatch, independent review and product tests; source builds
alone do not demonstrate delivery. Host approval policy must remain intact.

Latest user reply: approved npm install in panel. Verification found original action
wa_0mvo71ilk540326de44ab system-cancelled before execution after its300000ms operation
budget expired during human waiting. Replacement wa_0mvo784v0d4ff72c1cfc0 is pending with
changed source after worker edits; no approval may transfer across source identities.
No install success observed. New corrective worker separates active execution clock from
human approval wait, preserving unpaused task deadline, explicit cancellation, execution
kill/quiescence and operator/source authority. Old explicit recipe-expiry fixture changes
to explicit cancellation, preserving no-late-execution assertions. No new approval asked yet.
Source correction now separates active execution/approval clocks, keeps independent task
deadline, fences source-capture cancellation, charges missed fast execution and persists a
trusted narrowing execution cap outside the immutable approval identity. Worker focused14/14
and independent safety review complete; root recursive typecheck/build passed. Full suite
running --maxWorkers=4 (session95225), no concurrent build or live provider worker.
Daemon8988 stopped; stale MCP2960 stopped. Dependency task reached its existing task deadline
and is failed; root job remains recoverable/interrupted with390request cap. On recovery,
supervisor must rebrief dependency setup; old approvals cannot be transferred.
Source9995b14 published dev/main and all controllers refreshed. Fresh daemon1680/panel4477
run rebuilt code. Parent explicitly resumed through supported MCP; expired interrupted deps2
was cancelled (not a valid live human wait) so parent could rebrief against accepted foundation.
Planv5 dispatched deps3 t_0mvo8ijuk232b0562665e with required file scope. FINAL inspected
manifest/config, returned setup/time-budget feedback, and declined obsolete-source requests.
Current npm install action wa_0mvo8npaq640917dd768f has matching source e0db7f678184ca18abe0c3b9bd49ba52991e600ab32e199ba635656655fd79ae,
requested/effective execution cap300000ms. Fresh human panel approval requested after inspection;
not approved/executed by FINAL. Compiler/configuration and usable-app acceptance remain open.

## Worker Briefs
### lifecycle-discovery
- Role: read-only worker; no code edits or commits.
- Read Current State above, runners/supervisor.ts, harness/supervisor-tools.ts,
  harness/delivery-tools.ts; follow directly relevant lifecycle/loop definitions only.
- Diagnose why an empty repository delivery can issue checks before spec/plan and
  loop on approval, and why framework plan UI is still empty after16 requests.
- Recommend a bounded code-enforced progression policy, preserving read-only discovery,
  legitimate blockers, human-only approvals, existing resume and legacy jobs.
- Identify exact owned files/test candidates for implementation; do not implement yet.
- Write docs/working/supervisor-lifecycle-stall/reports/lifecycle-discovery.md.
- Return findings, inspected paths, proposed validation, unverified risks.

### loop-role-review
- Role: read-only worker; no code edits or commits.
- Read Current State above, harness/loop.ts and runners/supervisor.ts only.
- Check generic write_file stall nudge against delegate-only supervisor role.
- Recommend minimal safe suppression/replacement preserving worker behavior.
- Write only supervisor-lifecycle-stall/reports/loop-role-review.md.
- Return exact findings, proposed validation and unverified risks.
### loop-role-fix
- Role: implementation worker; no commits or shared-document edits.
- Ownership: packages/router/src/harness/loop.ts and new
  packages/router/tests/supervisor-loop-role.test.ts only; unique report loop-role-fix.md.
- Read Current State, loop.ts, supervisor runner call site and existing loop test fixtures as needed.
- Prevent generic write_file/implement-now stall instructions for supervisor loops.
- Supply coordination-specific guidance for supervisors; preserve coding worker behavior.
- Use actual profile/runner role or existing terminal identity, not user prompt text.
- Add focused regression testing the real loop under a small fake request budget.
- Run only focused tests/typecheck if needed; no repo-wide concurrent validation.
- Report exact changes/checks/limits in supervisor-lifecycle-stall/reports/loop-role-fix.md.
### lifecycle-implementation
- Role: implementation worker, no commits/shared-document edits.
- Own runners/supervisor.ts, harness/supervisor-tools.ts, harness/delivery-tools.ts,
  new harness/supervisor-lifecycle.ts if needed, and new tests/supervisor-lifecycle.test.ts.
- Read discovery report; storage/plans.ts and existing relevant test fixtures allowed.
- Add plan_work dispatch:false draft persistence; default true preserves legacy behavior.
- Drafts validate graph and briefs without staffing/model/worker execution; UI already supports them.
- For delivery v2 require persisted plan before implementation dispatch/execution; permit
  read-only discovery, explicit legitimate blockers and blocked finish. Require plan before leaving plan stage.
- Enforce command/pre-plan discovery-child guard at tool boundary, including batch nested operations.
- Add bounded pre-spec/pre-plan discovery mechanism (persist/reconstruct across resume) that
  narrows actions to coordination/blocker handling before unlimited discovery spends the budget.
- Preserve legacy non-v2 jobs, approvals, paid limits, resume idempotency and repairs.
- Do not edit harness/loop.ts (other worker owns); coordinate hook requirements with root.
- Test draft no dispatch, actual plan dispatch, bypasses, resume and legacy compatibility.
- Run focused tests only; report changes/checks/limits in reports/lifecycle-implementation.md.
- Use root checkout dev, disjoint workers; no repo-wide validation while edits in flight.
### lifecycle-safety-review
- Role: read-only worker; no code edits or commits.
- Own only reports/lifecycle-safety-review.md; read Current State and changed lifecycle,
  supervisor-tools, runner, product-delivery and loop source/test diffs.
- Check nested command bypass, resume reset, plan/dispatch mismatch, invalid draft effects,
  legacy compatibility and approval preservation. Flag concrete defects with reproductions.
- Wait for implementation worker completion before final review; report exact checks/limits.
### budget-guidance-assertion
- Role: worker; own tests/budget-control.test.ts one prompt assertion only.
- Full suite finished1392pass/9fail/3skip; line424 expects obsolete pre-batching guidance.
- Update expectation to require run_checks grouping, run_check compatibility and exact two-run cap.
- Preserve every runtime command, output, log, event and run-limit assertion.
- No commits; write report reports/budget-guidance-assertion.md; root runs serialized rerun.
### implementer-batch-charter
- Role: worker; own only packages/router/charters/implementer.md and report of same name.
- Resolve conflicting one-check-at-time advice: prefer grouped independent declared run_checks
  when offered, exact check:N recipes/commands; preserve ordering, serial execution and approvals.
- Preserve run_check individual/legacy fallback and no shell, exact results, fix failures, final checks.
- No tests/commits or other edits; root runs focused native/check tests afterwards.
### encoded-plan-compatibility
- Role: worker; own src/harness/supervisor-lifecycle.ts and tests/supervisor-lifecycle.test.ts only.
- Live pilot t_0mvo5uxr4cfd4c54aca73 failed18requests after specification persisted.
- New guard z.array rejects JSON-encoded nodes/tasks before existing parseObjectArray accepts them.
- Preserve existing encoded-array compatibility with safe JSON parsing and zod validation;
  malformed strings remain refused, all stage/plan/command guards unchanged.
- Regression: encoded draft nodes and encoded planned delegate tasks; actual tool flow,
  invalid strings and check-bearing encoded tasks still guarded before effects.
- No commits, app edits, broad tests; focused test allowed. Report encoded-plan-compatibility.md.
### human-approval-wait
- Role: worker; own harness/supervisor-tools.ts, harness/worker-action-tools.ts and
  new tests/supervisor-human-approval-wait.test.ts; report same slug. No app edits/commits.
- Approved fixture ownership: supervisor-action-clock.test.ts explicitly supervisor-capable;
  labs-scripted.test.ts await actual child completion before fixed scripted integration,
  preserving every timeout and product/integration assertion. Root75/76 exposed existing race.
- Live pilot t_0mvo60um54e25d8d973f6 failed28requests after real scaffold worker committed;
  await_tasks returned repeatedly on human-only action but advised decide_worker_action.
  Supervisor cancelled child and repeated cancellation, causing stop; action auto-cancelled.
- Fix await_tasks capability-aware: human-only pending action alone must wait without
  spending model requests until actual operator decision/worker result/cancel/deadline;
  supervisor-authorized pending actions must still wake promptly for supervisor handling.
- Re-read trusted policy (no stale authority) and label human-only pending outcomes clearly;
  preserve explicit timeout, budget/acceptance wakeups, lease/cancellation and operator-only approvals.
- Correct action tool guidance/list metadata to distinguish human-only vs supervisor-capable.
- Test real wait zero extra requests/no child cancellation, actual operator deny/approve wake,
  supervisor-capable wake, explicit timeout/current policy change; fakes/temp configs only.
- Do not auto-approve, fabricate operator decisions or broadly forbid legitimate cancellations.
- Scope source stable before root validation; no broad concurrent tests.
### authoritative-spec-binding
- Role: worker; own harness/delivery-tools.ts and new tests/delivery-spec-binding.test.ts.
- Live v4 repeatedly failed spec.source.digest and exact originalInstruction copying before
  eventually succeeding. Do not require the model to hash or re-echo the authoritative goal.
- Make those two fields optional in set_delivery_spec input only; when omitted derive
  originalInstruction from ctx.spec.goal and source {ref:task:<id>:goal,digest:sha256(goal)}.
- Persist full strict DeliverySpecSchema; explicit altered originalInstruction still rejected;
  supplied source retains existing validation. Do not weaken store/evidence/CAS checks.
- Advertised JSON schema/descriptions must clearly explain canonical binding; omitted fields
  work in actual tool/runtime tests. Existing explicit specs, CAS revisions and guards preserved.
- No app edits/commits; focused tests allowed. Report authoritative-spec-binding.md.
- Sources stable before root checks; no broad concurrent validation.
### phased-first-dispatch
- Role: worker; own harness/supervisor-lifecycle.ts and tests/supervisor-lifecycle.test.ts.
- Root review: coordination allowlist omits delegate. After six requests, draft exists but
  no child yet; planned first delegate is blocked until a child already exists (deadlock).
- Permit delegate only when actual PlanStore graph + execution-eligible delivery stage exist;
  retain narrow policy until real dispatch and all exact planned-brief checks.
- Before plan, post-cap discovery delegation must stay blocked. Unplanned/mismatched nodes refused.
- Add real fake-provider regression >=six requests then two-node draft -> delegate first only,
  actual child completion, second node remains visible not_dispatched. No need launch wholegraph.
- No app edits/commits; focused tests/typecheck allowed, report phased-first-dispatch.md.
### approval-execution-timeout
- Role: worker; own harness/operation-lifecycle.ts, recipe-operations.ts, worker-actions.ts,
  operation-dispatch.ts if necessary, and new tests/approval-execution-timeout.test.ts.
- Read Current State and those files only, plus existing relevant harness/approval tests.
- User approved npm install in panel, but old action wa_0mvo71ilk540326de44ab was already
  system-cancelled after300s: Owning operation cancelled before execution. Replacement
  wa_0mvo784v0d4ff72c1cfc0 pending with changed source after worker continued editing.
- Trace and fix execution timeout incorrectly consuming human approval wait; preserve
  separate bounded task deadline, lease/source identity, explicit cancellation and command kill/quiescence.
- Do not execute pending actions, carry approval across changed sources, extend paid/budget
  authority, disable timeouts, or interpret user chat as an operator decision.
- Additional root review: charge active execution missed between pending/running/completed
  polls so quick commands cannot escape enclosing group/batch execution budgets. Use trusted
  persisted execution-start timing or equally precise server-owned accounting, not model data.
- Regression actual operation waits beyond execution timeout with pending action stable,
  then approved execution still times out/kills at requested limit; deny/cancel/task deadline work.
- Approved fixture update: external-task-tools.test.ts expired-approval case now uses explicit
  task/client cancellation while preserving all no-late-execution assertions; execution timeout
  becomes active-work time, approval wait remains bounded by a separate task deadline.
- Use fakes/temp directories; root owns final validation/deployment/docs. No app edits/commits.
- Report approval-execution-timeout.md; announce source stability before root checks.

### approval-clock-safety
- Role: read-only reviewer; own only reports/approval-clock-safety.md, no commits.
- Read Current State and changed operation-lifecycle.ts/worker-actions.ts/recipe-operations.ts
  plus new approval-execution-timeout.test.ts and changed external-task-tools test.
- Review pending-action authority, nested clock pause/resume, unpaused task deadline,
  explicit cancellation, cleanup/quiescence and execution timeout after approval.
- Coordinate with implementation worker; do not run broad tests during edits.
- Flag concrete bypasses/races and distinguish inspected source from observed test results.

## Work Ledger
### 2026-10-23 - Live stall reproduced
- Agent: supervisor
- Changed: investigation document only; denied optional node version request through supported API.
- Why: supervisor had no plan and no implementation, waiting on unnecessary host command.
- Validation: CLI job read -> running,16 requests, cancelled env-inspect child; last tool npm run typecheck.
- Outcome: Partial
- Follow-up: trace and repair lifecycle progression rather than approve needless checks.

### 2026-10-25 - Resume and implement lifecycle correction
- Agent: supervisor
- Changed: assigned disjoint lifecycle and loop-role workers; no app code edits.
- Why: confirmed PlanStore supports undispatched nodes, but plan_work couples recording and execution.
- Validation: CLI job -> cancelled22requests, both children cancelled; source inspection confirmed current gaps.
- Outcome: Partial
- Follow-up: draft plan support, command/dispatch gates and bounded discovery; independently validate.

### 2026-10-25 - Integrated lifecycle correction verified
- Agent: supervisor
- Changed: worker-owned lifecycle/loop/planning/storage/charter files and proportionate regressions; docs/roles.
- Why: require persisted planning and actual assignment before unrestricted discovery/execution.
- Validation: pnpm -r typecheck and pnpm -r build -> exit0; full vitest ->1392pass/9fail/3skip,525.41s.
- Validation: all8failedfiles serialized ->62/62,299.72s; final7-file delivery/native/harness selection ->49/49,42.59s.
- Outcome: Accepted
- Follow-up: publish verified source, restart bounded free-only pilot and inspect actual plan/dispatch; no clone accepted.
### 2026-10-25 - Live encoded-plan regression corrected
- Agent: supervisor
- Changed: worker-owned lifecycle guard and regression; preserved encoded-array compatibility.
- Why: pilot t_0mvo5uxr4cfd4c54aca73 persisted spec/prepare but failed18requests before any plan/task.
- Validation: independently observed final4-file lifecycle/loop/team run32/32,32.16s; recursive typecheck/build exit0.
- Outcome: Accepted
- Follow-up: publish correction; start replacement with425requests/$0paid, retaining failed task history and consumed quota.
### 2026-10-25 - Human-only action wait correction verified
- Agent: supervisor
- Changed: worker-owned await/action guidance and authority metadata; default human-only wait tests; Lab fixture synchronization.
- Why: live supervisor treated an impossible agent approval as repeated work and cancelled a real candidate.
- Validation: recursive typecheck/build exit0; focused75pass/1preexistingLab race in107.33s; final synchronized Lab/humanwait/clock10/10 in26.59s.
- Outcome: Accepted
- Follow-up: publish correction and390request/$0paid live replacement; preserve actual approval authority and all candidate history.
### 2026-10-25 - Runtime-owned specification binding verified
- Agent: supervisor
- Changed: worker-owned delivery tool input and new binding regressions; docs/roles.
- Why: live390request pilot repeatedly failed exact goal/hash transcription; service already owns authoritative goal.
- Validation: initial safeExtend typing failed TS2322; corrected input shape plus strict bound-spec parse. Final recursive typecheck/build exit0; independent6-file28/28 in32.28s.
- Outcome: Accepted
- Follow-up: publish and recover same live job without budget reset; request#2 denied200extra, cap390 unchanged. No app candidate accepted.
### 2026-10-25 - Phased first dispatch and working-document encoding corrected
- Agent: supervisor
- Changed: worker-owned lifecycle allowlist and real phased-dispatch regression; repaired UTF-8 working-document headings and role navigation.
- Why: after discovery cap a valid draft still could not delegate its first phase; repeated ANSI/UTF-8 rewrites had bloated ledger headings.
- Validation: independent5-file36/36 in31.44s; recursive typecheck/build exit0. Working document restored from1.1MB to17KB preserving ledger content.
- Outcome: Accepted
- Follow-up: publish and recover same390request live job; no application code authored by external FINAL.

### 2026-10-25 - Final release activated and real approval wait observed
- Agent: supervisor
- Changed: published source d9243b8; refreshed daemon8988/panel4477; scoped project oversight memory.
- Why: preserve same job/session/budget across deployments and verify real planning/assignment/approval behavior.
- Validation: live job/plan HTTP200; foundation task completed/met; deps exact npm install request pending. Root28model requests unchanged across reads while await_tasks waits for operator.
- Outcome: Partial
- Follow-up: operator must approve wa_0mvo71ilk540326de44ab in panel; then inspect install result, later implementation/review/product evidence. No app code by external FINAL.

### 2026-10-25 - Separate approval wait from bounded execution
- Agent: supervisor
- Changed: worker-owned operation clocks, recipe guidance, exact-action cancellation/caps and14regressions; docs/operations and roles.
- Why: user approved in panel after the300s operation timer had cancelled the request during human wait; replacement had changed source.
- Validation: root recursive typecheck/build exit0; full153-file run1428pass/3skip/0fail in670.58s with4workers. JSON success and newclock14/14 verified.
- Outcome: Accepted
- Follow-up: publish, reload all runtime controllers/panel, recover same390request supervisor, rebrief failed dependency phase and inspect fresh approval request. No app edits/approval impersonation.

### 2026-10-25 - Clock release activated and current install request reviewed
- Agent: supervisor
- Changed: source9995b14 published; refreshed controllers/panel; scoped recovery memory and same parent resume.
- Why: old user-reported approval was already expired, and old dependency attempts could not resume after their task deadlines.
- Validation: planv5/deps3 running; current request source matches independently computed worktree identity; requested/effective cap300000ms. Full suite1428pass/3skip/0fail remains source acceptance.
- Outcome: Partial
- Follow-up: human approve wa_0mvo8npaq640917dd768f; inspect actual install/check results and continue MVP workers. No app edits or approval impersonation by FINAL.

## Open Questions
- Supervisor owns diagnosis and implementation scope after worker report.
