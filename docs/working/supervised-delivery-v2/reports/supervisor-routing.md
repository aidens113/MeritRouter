# Supervisor routing and ownership: discovery and implementation brief

Status: Complete (planning only)
Owner: supervisor-routing worker
Date: 2026-10-23
Scope: Delegated supervision, model quality, budgets, stage prompts and spec contracts.

## Current State

No source, configuration or runtime state changed; no model/provider calls or tests run.
The proposed default is initiator FINAL supervisor -> MeritRouter delivery supervisor ->
bounded workers, with optional additional bounded supervisors. This is a workflow change,
not a request to move final project authority into MeritRouter.

## Findings verified from source

1. `docs/roles.md`, `src/admin/client-supervision.ts` and
   `src/config/schema.ts` already preserve external final ownership by default:
   `client_supervision.dispatch_final_supervisor=false`; bounded supervisors are permitted.
   Default guidance currently tells the client to delegate practical bounded work but does
   not establish a delivery supervisor as the normal orchestration unit. Do NOT flip the
   existing boolean to true: it permits internal final-project supervision, the opposite of
   the requested default. `supervisionScope: subtask` may own a whole delivery candidate
   while the initiator retains project acceptance; ownership terminology needs clarification.
2. `src/routing/router.ts:168` routes supervisor-mode profiles at T3 and applies configured
   supervisor endpoints/paid policy. `src/routing/select.ts:276` ranks availability, then
   free/paid preference, then web/independence, qualification pass rate and parameter count.
   Thus most_capable does NOT mean strongest demonstrated supervisor. Closed-model unknown
   parameter counts and worker-oriented qualification are unsuitable quality substitutes.
3. `src/config/schema.ts:540` defaults supervisor paid policy to on_free_exhaustion, job
   timeout to 14,400s, implementation to delegate. Team nesting is already supported with
   depth 2, child carve share 0.5 and only four supervisor reserve requests. The supervise
   profile has no request cap by default. This is neither an explicit high-budget contract
   nor assurance sufficient capacity remains for final integration/testing.
4. `src/harness/supervisor-tools.ts` already implements task graphs, per-file leases,
   dependency acceptance, nested supervisor branch carves and integration queues. Reuse
   these mechanisms rather than creating a second orchestrator. A supervisor's job pool
   already holds child allocations and releases unused grants on completion.
5. `src/harness/budget-tools.ts` exposes request_more_budget only when role != supervisor
   and purpose != verification. Therefore a delegated supervisor cannot currently request
   more from its parent through that tool, despite worker extensions being implemented.
   `src/admission/budget-requests.ts:147` already resolves a supervisor parent from parentTaskId;
   extending nested budgets must update both child allocation and ancestor accounting.
6. `src/runners/supervisor.ts` injects the supervisor charter plus static job information.
   Its finish_job accepts free-text verified evidence. At runner completion acceptance may
   become met simply from finish completed plus all collected checks exiting zero; this does
   not establish criterion or usability coverage. The working ledger can say Accepted even
   when acceptance is not_verified. Both need contract-driven gating, not stronger prose alone.
7. `src/core/task.ts` supports stable criterion IDs, optional check mapping, baseCommits and
   request/dollar budgets. `src/mcp/schemas.ts` does not fully advertise these controls.
   Spec revisions, stage receipts and candidate-bound evidence need explicit extensions.
8. `charters/supervisor.md` already requires planning, delegation, review and integration.
   It treats reading a patch OR running checks OR requesting review as minimum verification.
   The delivery default needs ALL applicable evidence gates, especially integrated runtime
   and user-journey evaluation. A prompt alone cannot enforce that requirement.

## Proposed ownership and workflow defaults

Introduce `client_supervision.workflow: delegated_delivery | direct_tasks`, default
delegated_delivery for new configurations and missing workflow fields. Keep the existing
dispatch_final_supervisor=false authority default. Explicit user direct-task requests remain
supported. Existing persisted ownership/security/paid choices are never silently overridden.
The initiator ordinarily submits one bounded delivery job, inspects milestones/exceptions,
decides upward budget requests, and makes the final product decision. It can split independent
delivery domains among supervisors after defining shared contracts, but must avoid delegation
trees merely for their own sake. The external final role does not consume internal nesting depth.

Every delivery job records `finalSupervisor` actor/session identity and `deliveryOwnerTaskId`.
Nested jobs inherit final identity and narrower scope, never acquire human authority, and
cannot declare final project acceptance. CLI automation identifies its agent actor rather than
defaulting to human. All control tools carry the same project scope and enforce parent ownership.
This requires persistent, authenticated actor provenance, not a caller-supplied role string.

Spec-led stage machine (persisted, resumable, versioned):

1. Discover constraints/runtime and retrieve relevant project/global memory.
2. Write executable specification: use cases, routes, contracts, data invariants, negative
   paths, visual/usability intent, non-goals and verifiable acceptance IDs. Resolve product
   ambiguities affecting delivery; don't ask for routine technical preferences.
3. Establish runnable baseline, dependencies, approved check recipes and fixture isolation.
4. Record task graph and interface contracts before parallel edits; each node pins spec
   revision, ownership, input revisions, expected evidence and request grant.
5. Implement through workers; inspect patches, run task checks and resolve defects.
6. Integrate into candidate revision; run all applicable build, unit, API, runtime/browser
   and usability journeys. Re-delegate fixes until evidence passes or report concrete blockers.
7. Deliver candidate/evidence bundle and limitations to FINAL supervisor for independent
   sampling and acceptance. A task terminal result is a delivery claim, not final acceptance.

For non-UI tasks record browser gate not_applicable with a reason; for unavailable environments
record blocked/inconclusive rather than passing. Plan-only jobs use plan criteria and never
pretend to satisfy implementation gates. A spec change invalidates affected downstream checks.

## Quality-first supervisor selection contract

Proposed `supervisor.routing.strategy: highest_eligible_quality` and
`supervisor.routing.minimum_quality: frontier_or_qualified_supervisor`. Model identity,
provider identity, quality evidence and authorization are distinct. Do not equate vendor name,
parameter count or an unverified model-description claim with quality.

Eligibility first: authorized provider/model, task modalities and tool support, sufficient
context, current plan availability, paid enablement/policy, known pricing where required,
task/project/global spend limits, capacity and capability evidence. Aggregate the eligible
pool across ALL configured providers, not only free routes or a single provider connector.

Rank eligible models using a versioned quality profile: explicit user priority where present,
task-relevant supervisor evaluation results with trial count/confidence, curated current
frontier provenance, observed integration/review/test reliability, then latency and marginal
cost within the authorized envelope. Prefer frontier GPT/Claude-class models when supported
by current identity/evidence and task fit; names/families do not become permanent hard-coded
facts. Track coding architecture, review, product reasoning and visual reasoning separately.
Store source, checkedAt and expiry for curated evidence. Provider badges are not quality scores.

An absolute requirement to be highest quality conflicts with ordinary free-first paid policy.
Resolve explicitly: quality-first ranks within the already authorized paid policy envelope;
on_free_exhaustion retains its semantics unless the user changes it. New-user onboarding can
offer quality-first paid routing with a stated spend envelope, but this plan does not enable it.
If the eligible envelope contains no approved supervisor quality model, return a structured
supervisor_quality_unavailable blocker and eligible alternatives. Never silently run a weak
supervisor. The FINAL supervisor may approve a recorded per-job degraded-mode override.

Temporary rate limits may wait for a qualified route or select another equal-quality route;
they must not silently fall below the minimum quality floor. Display selected route, evidence,
rejected higher-ranked routes, expected cost and override policy before execution. A price
unknown route is not licensed to spend merely because it is frontier.

## Explicit initial budget proposal (configurable, to calibrate)

Use a substantial FINITE delivery envelope rather than today's implicit unlimited cap:
600 aggregate model requests per delivery job, including supervisor, workers, verification
and bounded repair. This is a safety allocation, not a target to consume or a dollar estimate.
Reserve 80 requests for the delivery supervisor's planning/review/integration turns and 80
for final integrated checks/review/repair; initially allocate at most 440 to worker grants.
Suggested initial worker grants: inspect 12, bounded implement 40, review 20; large work is
split or receives an explicit grant. Existing explicit caps remain authoritative, and preflight
rejects an infeasible reserve instead of silently raising them.

At <=20% remaining aggregate budget, or when remaining work exceeds free allocation, a
delegated supervisor may request +200 requests (or a justified exact amount) from its immediate
supervisor; the root delegated supervisor asks the external FINAL supervisor. Include candidate
head, completed criteria, failed evidence, remaining plan and estimated marginal requests/cost.
Waiting is event-driven and costs no model requests. Default response window 1 hour, persistent
pending state and resumable task; do not lose work when the chat is unavailable. Denial produces
honest partial/blocked delivery. Dollar increases are a separate authority request and never an
implicit effect of a request-count grant. No self-approval or auto-paid escalation.

Nested grants require an atomic transaction: enforce ancestor headroom, increase ancestor
hold and child cap together, preserve parent reserves and immutable decision history. Prevent
double counting descendant physical requests; release unused holds exactly once on terminal
completion. If parent lacks headroom, relay upward without approving locally. A high budget
does not excuse repeated no-progress calls: bounded retries trigger diagnosis/replan/route
review instead of automatic budget inflation.

## Implementation partitions and exact extension points

Execute these units serially where ownership overlaps; harness redesign owner coordinates
changes to harness files rather than competing concurrent edits.

| Unit | Source ownership | Tests / authored docs |
| --- | --- | --- |
| Ownership/default client contract | config/schema.ts, config/client-supervision.ts, admin/client-supervision.ts, core/supervisor-authority.ts, mcp/tools.ts, mcp/schemas.ts, examples/CLAUDE.delegation.md | client-supervision.test.ts; docs/roles.md and setup.md |
| Supervisor quality policy | routing/router.ts, routing/select.ts, routing/staffing.ts, models/catalog.ts; new routing/supervisor-quality.ts | providers-routing.test.ts; qualification.test.ts; new supervisor-quality.test.ts; docs/operations.md |
| Supervisor eval provenance | qualification/runner.ts, qualification/stats.ts, qualification/comparison.ts and isolated eval fixtures | qualification.test.ts; provenance/expiry/ranking fixtures |
| Budget hierarchy/extensions | admission/budget-requests.ts, harness/budget-tools.ts, harness/supervisor-tools.ts, core/task.ts, appended storage migration as needed | budget-control.test.ts, team-nesting.test.ts, process-acceptance-budget.test.ts |
| Stage/spec enforcement and prompts | runners/supervisor.ts, core/task.ts, charters/supervisor.md, worker.md and role charters, roles/index.ts; new operations/delivery-contract.ts | supervisor.test.ts, team-graph.test.ts, team-integration.test.ts; docs/roles.md |

Storage schemas/migration names must follow final shared design rather than separate workers
each inventing incompatible task metadata. Public exports, admin read models, CLI, panel and
MCP must share these contracts; assign their downstream adaptations after schemas stabilize.
Keep supervisor runner growth under review; stage machine belongs to operations, model quality
to routing, budget accounting to admission, evidence decisions to verification.

## Required meaningful acceptance tests

- Default MCP instructions request delivery supervision while final ownership stays external;
  explicit direct mode works; no setting grants deployment, spend or human actor identity.
- A single candidate may cover whole product scope but cannot emit final acceptance itself.
- Across mixed providers, qualified frontier route outranks large weak route under an
  authorized policy; unknown parameter size does not exclude proven closed frontier model.
- Disabled paid, zero dollars, missing credentials, unknown price, missing capabilities and
  explicit on_free_exhaustion semantics remain enforced despite quality preferences.
- No eligible quality route yields structured blocker; degradation requires an explicit
  recorded FINAL-supervisor decision; reviewer and execution availability checked preflight.
- Supervisor can request extension; wrong project, sibling/self and unauthorized actor cannot
  approve; two concurrent approvals cannot overdraw ancestor reserve; restart preserves request.
- Worker hold, child carve and physical requests conserve aggregate envelope without double
  counting; cancellation/restart/completion return unused budget once.
- Completed finish with no runtime evidence, stale revision evidence, unresolved criterion,
  failing browser journey or changed evaluator cannot be accepted as delivered.
- An approved spec change invalidates dependent evidence and propagates revision to new briefs;
  user final rejection reopens delivery and is never overwritten by worker success counts.
- Fake model fixture demonstrates complete stages and repair; later isolated live evaluation
  uses predetermined request/dollar envelope and human usability assessment, not compilation
  alone. No paid live tests authorized by this report.

## Return contract

Changed: this report only. Verified: source inspection supporting findings above. Not verified:
proposed defaults' quality/cost performance, provider frontier rankings, migrations, race tests
or real-product usability. Remaining: supervisor integrates this design with harness and memory/
acceptance reports, fixes shared contract naming, and sequences implementation briefs. No
commits, source changes, configuration changes or live executions were performed.
