# Instagram trial: supervisor assessment
Status: Complete
Status detail: Read-only review of all 18 task results, 19 session logs, request outcomes and live panel; fixes proposed, not implemented.
Created: 2026-10-23
Last updated: 2026-10-23
Owner: Senior supervisor agent
Scope: Assess MeritRouter reliability, worker failures, supervision overhead and operational improvements from the downstream Instagram trial.
Paired document: none
Related: [trial and acceptance evidence](instagram-meritrouter-trial.md), [working index](README.md)

## Current State

MeritRouter successfully provided isolated worker execution, concurrent file ownership,
request budgets, free-only routing, provenance and cautious acceptance. It helped produce a
working local social app through repeated worker attempts and substantial external supervision.
It did not demonstrate autonomous delivery of a complete Instagram product. No standalone
MeritRouter supervisor job or Lab was used; the external Codex supervisor planned, dispatched,
integrated, tested and accepted results.

Review covers all 18 tasks, all 19 session logs (2,736 events), all terminal result/verification
records and all 364 physical requests through aggregate metrics and inspection of every
non-success request. It does not claim a fresh semantic audit of every generated source line
or every successful response. Prior independent app acceptance remains recorded in the trial.
Live panel Overview, Activity, Tasks, Requests, Sessions, Jobs, representative task verification
pages and a failed session timeline were opened in installed headless Chrome. A task-list
screenshot was inspected. These were read-only operations; no new model work was dispatched.

Confirmed issues include inconsistent MCP project selection, cancellation/lease-release delay,
incomplete task schemas, repeated basic tool argument friction, unavailable evaluator-change
review, late review budgeting and misleading aggregate completion/attention presentation.
Their causes and acceptance proposals follow. Only the separately authorized four-worker
defaults were implemented in the build trial. This assessment changes documentation only.

## Measured outcome and accounting

| Measure | Observed |
| --- | --- |
| Task window | 2026-10-23 17:18:58 to 17:54:38 America/Los_Angeles; 35m 40.502s from first submission to last task completion |
| Final explicit acceptance | 17:56:26; this excludes later report/cleanup time |
| Tasks | 18: 8 completed, 2 failed, 1 budget exhausted, 7 cancelled |
| Acceptance | 3 met, 4 unmet, 11 not_verified; two completed component tasks are still not_verified |
| Sessions | 19, with 361 model-loop requests and 476 tool intents |
| Physical gate requests | 364: 355 successful responses, 4 failed, 5 uncertain |
| Request purposes | 321 execution, 40 repair, 3 verification; no classification requests |
| Input/output tokens | 6,724,702 input including cached input; 273,563 output |
| Cache | 5,947,904 known cached input; 9 requests with unknown cache usage |
| Paid spend | Panel ledger $0; paid routing disabled; provider-reported dollar cost absent |
| Recorded routing violations | 0; this specific metric measures served-model mismatch, not all security properties |

364 reconciles across task counters, per-task metrics and usage_summary. Session request totals
are a different level: reviewer session shows one request while its gate fallback attempts use
three; session counters must not substitute for physical requests. Another one-request
difference is present on the original backend (46 initial session requests versus 47 execution
requests); this review has not traced that final difference to a particular call path.
Do not describe it as evidence of a quota leak. Provider-attempt exactness is explicitly false.

The original backend's total allowance was 100, allocated 60 execution and 40 repair. It used
47 execution and all 40 repair, then stopped at 87 under its cumulative repair cap. The
remaining 13 belonged to the original execution allocation; they were not available to that
repair run. Thus the earlier trial wording 'exhausted100 requests' was inaccurate: the total
budget was 100, actual physical requests 87. This is a phase-budget explanation, not evidence
that the router charged 13 nonexistent requests. The UI should explain the distinction.

Four failures were plan refusals: pinned minimax-m2.7, then independent reviewer attempts on
minimax-m3.1-flash, minimax-m3 and glm-5.3-flash. Four uncertain calls were aborted by the caller
during cancelled repair tasks; one was a provider HTTP500 on the original backend. None proves
that the application was faulty. Conversely, a successful response only proves a model answered.

No dollar savings or speed advantage over direct Codex can be established: there was no
controlled baseline, external supervisor usage is absent from this ledger, and cached-token
pricing/provider billing is incomplete. Free quota was consumed even though paid spend was zero.

## Every task reviewed

Task IDs link to the authorized local panel; availability depends on that install remaining up.
Request counts are physical gate counts, not estimates from elapsed time.

| Task | Requests | Recorded outcome and review |
| --- | ---: | --- |
| [initial backend](http://127.0.0.1:4477/p/instagram-clone/tasks/t_0mvlniblw8299fa04f6cd) | 5 | Cancelled for replacement with explicit budgets; session lease_lost, final cancellation on lease expiry. |
| [initial frontend](http://127.0.0.1:4477/p/instagram-clone/tasks/t_0mvlniblw1d012de183e6) | 0 | Cancelled before dispatch; demonstrates initial queue, not worker execution failure. |
| [budgeted backend](http://127.0.0.1:4477/p/instagram-clone/tasks/t_0mvlnilssaf0186e3f733) | 87 | T2 invalid output escalated to T3 repair; budget exhausted, failed checks, generated tsbuildinfo scope violation; unmet. |
| [budgeted frontend](http://127.0.0.1:4477/p/instagram-clone/tasks/t_0mvlnilss5b01f5650d07) | 7 | Submitted layout only and unknown criteria; supervisor rejected; completed is not accepted. |
| [pinned replacement frontend](http://127.0.0.1:4477/p/instagram-clone/tasks/t_0mvlnoy8f48c075104735) | 1 | Model outside free plan, HTTP402; correctly no paid fallback. |
| [split shell](http://127.0.0.1:4477/p/instagram-clone/tasks/t_0mvlnptqxaa149cc06c8b) | 12 | Produced files but failed criterion; completed/unmet. |
| [split social](http://127.0.0.1:4477/p/instagram-clone/tasks/t_0mvlnptqx0425ebaa79eb) | 9 | Produced baseline code, incomplete integrations; completed/not_verified. |
| [split overlays](http://127.0.0.1:4477/p/instagram-clone/tasks/t_0mvlnptqx5ecbd1137ba5) | 7 | Produced baseline code, incorrect response wrappers; completed/not_verified. |
| [shell repair](http://127.0.0.1:4477/p/instagram-clone/tasks/t_0mvlnzzlvc54f14b351bf) | 27 | Useful changes, then shell/check approval waits; cancelled, candidate reviewed for integration. |
| [social repair](http://127.0.0.1:4477/p/instagram-clone/tasks/t_0mvlnzzlv23a7b7f4acb4) | 18 | No edits; read/discovery and requested git host action; cancelled and reassigned. |
| [overlay repair](http://127.0.0.1:4477/p/instagram-clone/tasks/t_0mvlnzzlv294231c8288a) | 26 | Useful changes, then host-action waits; cancelled, candidate reviewed for integration. |
| [backend repair](http://127.0.0.1:4477/p/instagram-clone/tasks/t_0mvlnzzlv66b577655868) | 20 | No edits; discovery and incompatible shell request; cancelled and reassigned. |
| [native social repair](http://127.0.0.1:4477/p/instagram-clone/tasks/t_0mvlo4o0n0001cdc4db7c) | 42 | Useful repairs retained in candidate; repeated identical failed replace stopped task; failed/not_verified. |
| [native backend repair](http://127.0.0.1:4477/p/instagram-clone/tasks/t_0mvlo4o0n41b0bab262dc) | 46 | 43 execution plus 3 refused review requests; external checks support acceptance; review remains pending. |
| [test runtime repair](http://127.0.0.1:4477/p/instagram-clone/tasks/t_0mvloe9k75031086ce9fd) | 7 | npm test approval wait; candidate passed9tests but introduced7type errors and removed projection coverage; cancelled. |
| [test type correction](http://127.0.0.1:4477/p/instagram-clone/tasks/t_0mvloh79214d57e1894c9) | 14 | Fixed types/restored coverage; review skipped_budget; independently checked and accepted. |
| [first mobile menu](http://127.0.0.1:4477/p/instagram-clone/tasks/t_0mvlok7mu053412b85bf1) | 11 | Replaced page with omission placeholders, deleting valid code; rejected, never integrated. |
| [surgical mobile menu](http://127.0.0.1:4477/p/instagram-clone/tasks/t_0mvlolmm02386d961e641) | 25 | Additive repair retained existing code; independently typechecked/built/browser checked and accepted. |

The three accepted tasks are not the entire provenance of the final app: baseline and salvaged
worker commits were integrated with subsequent corrections. An acceptance-rate statistic of
3/18 would mix superseded setup tasks, deliberate cancellations, salvageable attempts and actual
failures. Eight completed tasks would equally overstate delivered outcomes.

## What MeritRouter successfully did

1. **Isolation and provenance.** Tasks used separate worktrees and explicit base commits;
   dirty-source warnings made excluded uncommitted supervisor work visible. Edit commits,
   session logs, patch artifacts, criterion evidence and decision history supported review
   and recovery of useful partial work. Original manual application repairs were excluded
   from the accepted branch.
2. **Scheduling.** Four independent repair tasks ran concurrently after the authorized 4/4
   config change. Overlapping test-file ownership still serialized correctly. Initial queue
   friction came from the old single-writer configuration; task capacity and writer capacity
   are separate limits. Hot reload worked. A regression directly tested four disjoint writers
   and a waiting fifth rather than merely checking config values.
3. **Limits and containment.** Paid routing stayed disabled, task budgets held, an undeclared
   npm install check was refused, a jest.config.js edit was refused, and generated
   tsconfig.tsbuildinfo outside the scope was detected. The repeated-call guard stopped a
   failing replacement loop. Detection at final scope verification is different from preventing
   a declared command from creating a generated file; do not overstate the containment proof.
4. **Failure preservation.** Plan refusals, aborted requests, failed checks, scope failures,
   invalid outputs and cancellation remained inspectable. T2 backend failure escalated to T3
   without erasing its previous session or exceeding the phase budget.
5. **Acceptance restraint.** Missing criteria and unavailable review did not automatically
   become accepted app work. Three results were explicitly accepted through a correctly
   project-scoped supervisor MCP client, citing independent evidence. Review status remained
   pending/skipped instead of rewriting history to claim a model review happened.
6. **Usable local outcome.** Worker code ultimately passed build/typecheck,10unit tests,
   21API contract checks and34security/concurrency/upload probes, plus desktop/mobile browser
   flows and persistence after restart. These checks were performed by the external supervisor,
   not all automatically by the router. The separate framework suite passed1207tests; those
   are not1207tests of the clone.

The app is a local demo with accounts, feed, upload, follows, likes/comments/saves, profiles,
search/explore, notifications and DMs. Stories/reels are seeded viewing/photo slideshows.
Production hosting, Instagram integration, real video processing, moderation, recovery email
and Instagram-scale infrastructure were not delivered.

## Confirmed framework defects and operational gaps

### A. Inconsistent project selection across MCP lifecycle tools — high priority

Submission/status accept project; cancellation/resumption/acceptance/rejection bind the server's
default project. A client submitted Instagram work but could not cancel it because the default
was my-project. Collection/wait use unscoped service lookups and returned Instagram results
through that same default connection. Source: `packages/router/src/mcp/tools.ts` registrations
for submit_tasks, get_task_status, cancel_tasks, resume_task, accept_result, reject_result,
collect_results and await_results.

Workaround required CLI --project and a fresh project-scoped MCP client. This is a proven
inconsistent API, not a proven authorization breach; intended cross-project read authority
needs separate definition. Fix acceptance: one client can complete the entire lifecycle in an
explicitly selected project; wrong-project reads/writes behave consistently and cannot affect
another project's task. Include session resume and budget/question/brain controls in the audit.

### B. Cancellation delays ownership release — high priority

For test runtime repair, cancel requested00:46:04.960Z, action wait ended8ms later, task terminal
at00:47:03.689Z on lease expiry:58.729seconds. Replacement waited58.136seconds on its file lease.
The earlier backend replacement also recorded62.104seconds file-lease waiting. Only the test
case has a precisely correlated cancel-to-terminal measurement in this assessment. Root cause
is not established. Do not release leases while a writer can still mutate the checkout.

Fix acceptance: cooperative cancellation stops request/tool execution, acknowledges quiescence,
then promptly releases ownership; crashed/unresponsive workers retain safe expiry fallback.
Test cancellation during approval wait, in-flight request and edit separately. Return progress
and the exact lease holder/expiry while cancellation is pending.

### C. Worker tool ergonomics repeatedly consume requests — high priority

Across476tool intents,60outcomes were unsuccessful.21were list_files dir '.' rejected as
reserved filesystem syntax;21were missing/incorrect repository alias on read/search. Other
failures included missing path/pattern, undeclared/unavailable checks and exact-text mismatch.
These are recorded failed outcomes, not all infrastructure errors or all avoidable waste.
The repository tools alone used77listings,149reads and39searches; many were necessary, but
repeated argument errors are a measurable problem. Four repair tasks used91requests, with
the social/backend pair using38requests and making no edits.

Source: `packages/router/src/harness/tools.ts` repoTools describes alias/path separately but
does not teach a root-dir example; list_files passes '.' into the rejecting reader. Provide
canonical examples, explicit empty-root semantics, safe normalization of the root-only '.'
case while retaining traversal protections, and structured errors with a corrected call.
Do not silently broaden aliases or accept traversal. Inject Windows, repository root/base,
available tools, dependency readiness and check permissions into the runtime context. Return
native git/worktree status rather than prompting models to request a shell just to learn HEAD.

The surgical mobile task still spent all25requests despite a very small repair, including
discovery and brain calls; successful output alone does not establish efficient operation.
Track progress and repeated discovery, and permit bounded rebrief/reassignment when no edits
or useful evidence accumulate. Do not remove context exploration indiscriminately.

### D. Check authorization is safe but difficult to operate — high priority

Workers requested Linux cd /app, /tmp and bash command syntax on a Windows host, then waited
on actions that the external supervisor could not approve through its available MCP surface.
Six request_supervisor_action,11await and14status intents appeared in the logs. A declared
npm test also blocked under the human-only policy. Native-only rebriefs let work continue;
the external supervisor ran validation separately.

The human-only policy worked as configured. Its friction is not grounds to let an agent
impersonate a person. Offer preflight capability/policy output, a first-class pending-action
list with exact command/worktree/revision/required authority, and project-declared bounded
setup/check recipes authorized through the existing policy. Workers should know before
dispatch when a required check cannot run. Human approval must remain human where configured.

### E. Verification planning and implementation gaps — high priority

evaluator_change_review is required on changed tests but returns not_implemented. A test-only
T2 task started standard with20execution/0review, then was raised to deep after editing tests;
review wanted12 and had zero allocated/unallocated allowance. It was correctly left for
supervision, not independently reviewed. Six unused total requests do not satisfy12 anyway.
The review policy can anticipate a brief that explicitly requires test edits.

The T3 backend did reserve12review requests, but all three reviewer candidates were outside
the key's free plan. Thus no independent review happened despite successful execution.
Preflight review qualification/plan eligibility and show whether any eligible reviewer exists;
learn plan refusals with appropriate expiry rather than treating catalog presence as eligibility.
Do not silently weaken independent-review/model qualification requirements or enable paid routing.
Implement evaluator-change review, reserve its budget before dispatch, and expose phase balances
and exhausted phase clearly. Preserve distinct supervisor override and automatic review records.

### F. Completion/attention presentation can mislead — high priority

The Tasks table displays green Completed for the rejected destructive mobile rewrite, with no
acceptance column. Its detail says Criteria unmet and Verification passed simultaneously,
because structural/scope checks passed while criterion evidence was unverified. This is not
false automatic acceptance, but the headline is easy to misread.

Activity said Nothing needs your attention while two completed component results remained
not_verified. `packages/router/src/admin/projects.ts:projectAttention` only counts completed
needs_supervisor results. Add acceptance filters/columns and an unresolved-result inbox with
explicit disposition for superseded/salvaged results. Keep raw execution, automated verification
and supervisor acceptance separately visible. Distinguish process heartbeats ('3 workers active')
from tasks actually executing; the reviewed project had no running tasks.

### G. Task schema and result retrieval require source knowledge — medium priority

TaskArgumentSchema in `packages/router/src/mcp/schemas.ts` omits typed budget and context.baseCommits,
although the loose object can carry them and runtime validation supports them. I initially
misplaced max_requests under constraints and was correctly rejected. Operationally important
fields should be discoverable without reading the implementation.

Expose the complete portable schema and a validate/preview operation showing resolved scope,
effective budget by phase, lease conflicts, route eligibility, verification level and check
permissions before spend. Provide a compact project report with changed files/base/head,
failed commands, unresolved criteria, pending actions and recommended next control operation.
Make full traces pageable by event type/tool/error, with a downloadable sanitized run bundle.

### H. Integration/environment work remains external — medium priority

Isolation worked, but workers lacked installed dependencies and independently produced wrong
named/default imports, API wrapper assumptions and missing UI composition. I installed
dependencies, provided an ignored junction for testing, reviewed and integrated candidate
commits and ran final tests/browser flows. No automated combined candidate acceptance was
demonstrated. Labs existed but were not exercised; this is not proof Labs cannot help.

Supply a reusable project recipe for dependency setup, stable contracts, build/test/server and
browser checks. Use declared authority and isolated test data. Stage bootstrap/contracts first,
then disjoint workers, then an exact-revision integration candidate with combined checks and
bounded worker repair. Do not treat individual worktree completion as project completion.

## Worker quality failures versus router responsibility

Workers submitted only a layout; produced incomplete export/API/UI contracts; omitted message
composition/follow behavior; implemented insufficient origin, mutation, input and upload
handling; introduced CommonJS top-level-await failures; replaced test types with any and
removed a projection assertion; and rewrote a page using literal 'rest unchanged' placeholders.
Those are model/code failures. The router's responsibility is detecting, containing, explaining
and efficiently recovering from them, not guaranteeing that a model never emits a bad patch.

The repeated replacement failed due to exact text/indentation mismatch; the tool already
normalizes CRLF. This trial does not establish a CRLF defect. The repeat guard protected the
run, but a better mismatch diagnostic and bounded recovery could save manual salvage.
Beam produced useful repairs; gpt-oss also fixed the test types successfully. Different task
scopes, prompts and budgets prevent a controlled conclusion that one model is generally better.
Record performance by task/check outcome, including retries and supervisor repair cost.

## Supervisor mistakes and experimental limits

- I directly repaired application files before the user corrected the role. That violated the
  experiment. Original uncommitted repairs were preserved separately and excluded from the
  accepted worker-only checkout; they must never count as router implementation success.
- I promised parallelism before checking the single-writer cap, started with overly broad
  briefs, failed to bootstrap dependencies/check permissions before dispatch, initially put
  budget in the wrong field, and pinned an unavailable model. These increased friction.
- I used the CLI for some decisions while working around project scoping. It recorded
  cli:mrjoh as human even though I issued the command. That is misleading actor provenance;
  the later three accepted results correctly identify mcp:codex-supervisor. A configured
  human-only policy must not be satisfied by an AI using a human-labelled CLI path. This
  review establishes misleading attribution, not that strict human acceptance was bypassed.
- I made browser-selector mistakes during QA; corrected selectors and API evidence established
  actual persistence. Those mistakes are not application or router defects.
- This was one Windows/free-tier trial with an external supervisor, no root job or Lab,
  no controlled cost comparison, and extensive manual integration/validation. It does not
  evaluate every model/provider, multi-host execution, crash recovery, production safety,
  automatic whole-project completion or full Instagram parity.

## Recommended implementation sequence and acceptance

1. **Make control consistent.** Typed task schema, project argument across the lifecycle,
   preflight preview and honest supervisor actor identity through every control surface.
   Validate two-project submit/status/collect/cancel/resume/accept/reject end to end.
2. **Remove measured stalls.** Safe cancellation acknowledgement/lease release; root-path
   tool ergonomics; explicit Windows/worktree/capability context; pending-action visibility.
   Reproduce the exact approval-wait cancellation and '.'/alias failures in isolated tests.
3. **Make verification runnable.** Evaluator-change review, predictive reserves and reviewer
   plan/qualification preflight. Verify no eligible reviewer leaves a clear blocker without
   consuming an otherwise pointless coding run or weakening paid/authority restrictions.
4. **Make status actionable.** Acceptance column/inbox, phase-budget explanation, actor and
   accepted-by-supervisor versus reviewed-by-model display, compact project report/export.
   Browser-check accepted/rejected/not_verified/needs_supervisor examples and current Activity.
5. **Repeat the experiment with controlled integration.** Isolated dependencies/data, declared
   checks, one stable contract, disjoint workers and combined candidate acceptance. Compare
   task success, useful-diff yield, no-progress calls, approval waits, cancellation latency,
   physical requests, cache coverage and external supervisor intervention against this baseline.

These are proposed units with acceptance requirements, not authorized or completed code fixes.

## Work Ledger

### 2026-10-23 — Full run and live panel assessment
- Agent: supervisor
- Changed: this assessment, trial corrections/reference and working index.
- Why: User requested a full candid report and explicitly authorized panel operation.
- Validation: usage_summary/get_task_status/collect_results/list_sessions and18get_job_metrics reads reconciled364requests; parsed19session logs/2736events/476tool intents; Chrome read-only routes returned200; task-list screenshot inspected; app checkout status clean at e28cd8f.
- Outcome: Accepted
- Follow-up: Proposed framework fixes require a subsequent implementation scope; no model calls/app edits in this review.

## Open Questions

- Supervisor: trace the remaining one-request session-versus-gate difference on the original
  backend, and the exact delayed cancellation acknowledgement path before assigning a cause.
- Product owner: choose which proposed framework units to implement; this report is not a fix.
- Product owner: define explicit cross-project MCP authority and AI-versus-human CLI identity
  semantics without weakening containment or existing strict acceptance rules.
