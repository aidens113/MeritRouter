# Phased plan preservation worker report

Status: implementation complete; root verification/publication pending.

Cause: plan_work carried omitted prior nodes only if already dispatched. Staffing a subset therefore silently removed undispatched API/UI/review/testing phases from the latest graph.

Changed only packages/router/src/harness/supervisor-tools.ts and packages/router/tests/supervisor-lifecycle.test.ts (plus this report). Delivery-v2 now retains omitted prior nodes by default. Only submitted fresh briefs enter dispatchBriefs, staffing and grant calculation; retained future nodes remain not_dispatched without requests or holds. Explicit boolean replace_undispatched:true deliberately removes omitted future nodes. Already dispatched definitions/history remain retained. Non-v2 replacement semantics remain unchanged. Runtime boolean is validated for all versions. Tool schema/description explains new behavior; root owns authored docs.

Graph validation remains PlanStore.record on the merged graph, preserving cycle, dependency and <=50-node enforcement. No source migration, paid/config/live/app edits, commits or daemon restart. Existing already-lost phases are not resurrected from arbitrary historical versions; live supervisor must restore desired graph once through normal planning.

Validation: npx vitest run tests/supervisor-lifecycle.test.ts -> final15/15 passed, tests28.144s / total30.98s. First run13/14 passed: new implicit-grant assertion incorrectly assumed default grants were serialized to task spec; corrected test to explicitly grant10 and assert heldRequests exactly10 while omitted future brief requested1000. Final cases cover preserved future graph/dependency and one child/10hold/no requests, explicit replacement preserving dispatched history, merged cycle/missing dependency refusal, invalid flag for v2/legacy, merged51-node refusal preserving prior50-node version, legacy replacement and existing real phased delegate fixtures.

Not verified: recursive typecheck/build, full suite, live new behavior or panel screenshot. Root should perform integrated checks and only then publish/activate. Source/test edits frozen at final passing run.
