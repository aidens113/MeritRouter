# Supervised delivery v2: specification and execution plan
Status: Active
Status detail: Source implementation and corrective release checks verified; physical interactive/live product acceptance and cold indexing target remain open.
Created: 2026-10-23
Last updated: 2026-10-23
Owner: Senior supervisor agent
Scope: Default final/delegated supervision, quality-first supervisor routing, spec-driven delivery, replacement harness, memory and evidence-based acceptance.
Paired document: none
Related: [trial assessment](instagram-meritrouter-assessment.md), [index](README.md)

## Current State

2026-10-23 corrective task: user explicitly authorized fixing the unusable supervisor default.
The Facebook pilot proved delegated_delivery is configured, but an empty default quality_evidence
blocks every supervisor. Prior external-supervisor direct-worker fallback was rejected and stopped.
Corrective intent: usable best-available supervisor routing by default without invented benchmark
scores; preserve explicit strict evidence policy, paid/access restrictions, and external FINAL ownership.
Workers below own disjoint source files; supervisor owns integration, docs and full validation.
Corrective code is integrated through5e1bfe2: usable default and generated preset, atomic
submission preflight, finite unavailable-model recovery with per-key/model refusal cache,
portable native/MCP batch schemas, concurrent same-turn repository reads and grouped-check
approval barriers. Explicit strict evidence and all paid/access/request limits remain enforced.
Independent review found/fixed the batch offset-schema collision and clarified invocation/file
concurrency. FINAL additionally removed nested dialect tags; actual-MCP/native26/26 rerun passed.
Final integrated83/83 and final schema/MCP26/26 passed; recursive typecheck/build passed.
Initial full snapshot:1360passed/15failed/3skipped across147files plus1VitestRPCtimeout under
parallel load. All15 failed cases passed serialized9-file rerun78passed/1unrelatedskip (R1dist
fixture unavailable in that worktree; it passed initial full run). Assertions/timeouts unchanged.
Fresh real-config MCP stdio preview now has3supervisor candidates/no blocker. Config SHA256
2963B9A8B79CD23DC2425989BAD58A1BC068E6A6E8DA8F755C0145188B9554E7 unchanged; paid disabled.
Five idle stale MCP processes were stopped after confirming all projects had0queued/running
tasks. Final daemon26696 and production panel4477 run rebuilt code. Original chat transport
closed; fresh SDK MCP works. Renewed supervisor jobt_0mvlxbcr2902bde7859a2 is running with
500requests/$0paid; its live tool events prove multiple calls per response and overlapping safe
reads. No clone accepted/manually coded. Source publication receipt is pending; see
[corrective acceptance](supervised-delivery-v2/reports/supervisor-recovery-batching-release.md).

Earlier release baseline: source merged and pushed to dev/main at cc1e0a4; the current
checkout is D:/SwitchYardRouter on dev. Isolated feature/verification worktrees were temporary.
No downstream clone,
real user configuration/Brain, paid routing policy or live panel4477 was changed. No live
provider calls or paid spending occurred. Source publication is complete;
the live installation has not been restarted or migrated.

Implemented: FINAL initiator plus delegated delivery defaults; four-worker defaults;
quality-evidence supervisor selection; conserved600/80/80 request budgets and upward requests;
versioned mandatory specs, exact candidates, independent evaluator review, evidence/readiness
and separate FINAL decisions; defensive batched harness with adjustable30s timeouts,
lossless paging/journals/process cancellation; typed project/global preference memory,
role/headroom injection, ACL/CAS/revocation and install-root reads; indexed/lazy Brain flows,
preferences/history/context receipts and mobile table fix.

Release scope audit found and prompted additional P9 fixes: product attention independent of
legacy task acceptance, compact bounded CLI/MCP project reports, project/job product views,
and explicit guarded repair of completed FINAL-rejected supervisors. Repair opens a new
linked session in retained workspace, preserves consumed budget/history, and requires fresh
candidate evidence plus another FINAL decision. Accepted/nonproduct completed tasks stay closed.

Verification: recursive typecheck and production router/panel builds pass after P9 integration.
Production demo seed passed all expectations.17/17 UI/API scenarios passed; rebuilt mobile
Brain/settings checks and new project/job desktop/mobile status checks passed, zero browser
exceptions. Actual Request repair UI queued a synthetic demo-only rejected task, duplicate,
foreign-project and nonrejected requests returned409. Fixture state restored; this is UI
control proof, not runtime/product proof. Actual fake-provider repair runtime passed in two
project layouts; independent integrated repair/report/resume selection passed31/32 initially,
with only obsolete MCP tool-count failure; corrected inventory rerun2/2 passed.

Final full snapshot d17890a:1,354 passed, two failed, three skipped (143 files,1,359 tests,
827.18s). Both failures were stale HTTP tool counts47 vs48; corrected actual stdio/HTTP,
product and repair rerun passed12/12. Earlier classifier batching fixture now synchronizes
real classification admission, retaining actual queue/Gate/cache and unchanged50ms window;
it passed in the final full run. Final stored repair-row zod validation passed delivery/repair
6/6, then final12/12; recursive typecheck/build also passed. All observed failures are resolved.
This is full-run plus focused corrections, not a fabricated green exit for d17890a. See
[release acceptance](supervised-delivery-v2/reports/release-acceptance.md) for exact evidence.

Remaining limitations: Docker client has no working engine/image, so real container interactive
journeys/isolation and Linux physical containment are unverified. No qualified live-provider
product pilot or request/cost-reduction claim. Quality onboarding requires manual dated
capability evidence; it is fail-closed rather than turnkey frontier discovery. Latest10k-file
benchmark passed1/1: initial indexing4.59s, above2s target; existing-index new-instance p95
264ms and warm catalog/search p95 .392/4.304ms. Warm production navigation p95 was281ms.
No cold10k/50k browser acceptance claim. Automatic worker Task Labs and FINAL waiver UI remain
unsupported; retained Labs/MCP FINAL decisions are the implemented paths. Entire P0–P10 is
not marked complete from offline tests. Preserve these gates when publishing the verified
source unit. Temporary QA servers4480/4481/4482 are stopped; user panel4477 is untouched.

Historical checkpoint notes: [archive](supervised-delivery-v2/archive/2026-10-23-release-checkpoints.md).
## Decision: failed product acceptance, new default ownership

The prior app failed product acceptance. Preserve the recorded test passes as historical facts,
but withdraw the implication that they establish usability. User rejection is not overruled
by compilation, worker claims or a previous supervisor conclusion.

```text
User / initiating client = FINAL supervisor
  -> MeritRouter delivery supervisor: spec, plan, workers, integration, review, TEST, repair
       -> bounded implementation/discovery workers and independent reviewers
       -> bounded sub-supervisors when a domain needs its own delivery loop
  <- exact candidate + evidence + limitations + resource requests
FINAL supervisor independently accepts/rejects; rejection reopens delivery
```

New multi-step builds default to a delivery-supervisor job, not the initiator dispatching every
worker. Direct bounded tasks remain available for small work or explicit user preference.
Retain `client_supervision.dispatch_final_supervisor=false`; flipping it would transfer FINAL
authority into MeritRouter and contradict this request. Add workflow `delegated_delivery` as
new/missing-field default, retaining explicit direct-task selections. External FINAL ownership
is outside internal nesting depth. Four task/four repository writer defaults remain separate
capacity controls, not a requirement to create four supervisors.

The initiator owns product intent, cross-domain decisions, upward resources and final acceptance.
Delegated supervisors remain responsible for their assigned delivery through planning, worker
coordination, integration, independent review and tests. They return checked candidates, not
collections of worker claims. They delegate implementation rather than silently fixing it
themselves. Human-only decisions retain their real authority; an agent CLI cannot label itself
human. Record trusted initiator/delivery/worker identities and lineage on every decision.

## Starting architecture and detailed designs

Source already provides nested supervisors, task graphs, per-file leases, integration queues,
budget holds, Git-backed memory and process cancellation. Reuse these foundations. Missing
defaults and gates require service changes, not just stronger prompts.

- [Harness replacement design](supervised-delivery-v2/reports/harness-redesign.md): exact files, six serial implementation units, compatibility and fault tests.
- [Supervisor routing/budgets](supervised-delivery-v2/reports/supervisor-routing.md): current selection/extension gaps and quality policy.
- [Memory/product acceptance](supervised-delivery-v2/reports/memory-acceptance.md): scoped memory, evidence and real interactive-runtime prerequisites.
- [Brain panel](supervised-delivery-v2/reports/brain-panel.md): initial navigation/search work paths, missing flows and performance gates.

Supervisor independently checked routing/select ordering, supervisor exclusion from budget-tools,
static-only browser schemas and deliberately unavailable hydrated isolation in source. These
are implemented behaviors, not worker predictions. Proposed defaults/benefits below are unverified.

## Specification-led methodology and stage contract

All roles use the same versioned spec wherever applicable. Small fixes use a compact instance;
larger builds require full observable journeys and design intent. No document ceremony just
to change a constant, and no broad feature claim without a corresponding requirement/test.

### Shared validated artifacts

| Artifact | Required content |
| --- | --- |
| DeliverySpec | ID/version/digest, original user instruction, owner, users/platforms, workflows, data invariants, interface contracts, visual/usability references, failure/loading/empty states, security, exclusions and runnable setup |
| Criterion | Stable ID, priority, observable behavior, required evidence types and applicability; critical criteria cannot be waived by a worker |
| ExecutionPlan | Dependency graph, exact file ownership, input/spec revisions, setup/check recipes, budget/reserves, integration strategy and rollback |
| WorkerBrief | Spec slice/criteria, exact context refs, allowed paths, outputs/check IDs, budget/deadline and return contract |
| EvidenceReceipt | Criterion IDs, observations vs claims, candidate heads/tree, spec/test/recipe/environment/dependency/fixture identities, actor, logs/screenshots/traces and unknowns |
| DeliveryBundle | Candidate/run information, coverage matrix, runtime/visual review, known defects, spend/requests and readiness verdict |

Use Zod for live/stored inputs and portable shared CLI/MCP/panel schemas. Authored project specs
remain in working docs; structured records reference their immutable digests instead of becoming
an unsynchronized second truth. Append migrations when persistence changes. Update runtime brain
protocol and repository protocol together if their format changes.

### Enforced stages and prompts

1. **Discover:** retrieve relevant memory and inspect repository/runtime/capabilities in batches.
   Resolve product ambiguity that affects delivery; state consequential assumptions.
2. **Specify:** write user journeys, functional and visual quality expectations, scope and criterion
   matrix. FINAL supervisor reviews significant scope choices; routine implementation stays delegated.
3. **Prepare:** establish dependencies, stable contracts, isolated data/services and authorized checks.
   Missing setup is a blocker, not an invitation to parallel speculative implementations.
4. **Plan:** persist graph/briefs before dispatch, partition files and reserve integration/review.
   Dependent work uses accepted upstream input where correctness requires it.
5. **Implement:** workers batch observations, make complete surgical edits and run applicable checks.
   No omission placeholders, fake check results or silent weakening of requirements/tests.
6. **Integrate:** inspect patches, serialize merge queue and validate combined candidate. Accepted
   components do not establish a working product. Re-delegate failures with concrete evidence.
7. **Validate:** runtime journeys, negative paths, persistence, test-change review and applicable
   visual/usability review. Defects return to worker repair while delivery supervisor owns outcome.
8. **Handoff:** return `ready_for_final_review`, `blocked` or explicitly partial with missing criteria.
   Initiator independently evaluates the actual candidate; only its decision is FINAL acceptance.

Version common role charter and stage prompt separately; record digests per session. Startup
contains role/lineage, active spec, environment/tools, memory manifest and completion gate.
Review prompts treat worker narratives as claims; validation prompts require actual behavior.
Tools enforce stage authority and readiness; prompts alone cannot establish either.
Plan-only/non-UI work has explicit applicable gates, not fabricated browser requirements.
Spec/candidate changes invalidate affected evidence. Missing/stale/not_implemented/self-claimed
required evidence blocks readiness. `finish_job` cannot accept arbitrary successful commands
as complete criterion coverage or write Accepted into a ledger for unverified delivery.

## Highest-quality eligible supervisors

Supervisor routing becomes a distinct quality-sensitive policy across ALL configured providers.
Eligibility first: authorized credentials/model/key plan, tools/modalities/context, role quality
floor and existing paid/spend/security policy. Rank eligible models by task-specific planning,
architecture, worker supervision, integration, review/testing and product reasoning performance.
Prefer verified frontier GPT/Claude-class offerings when appropriate, alongside other models
meeting the same demonstrated bar. Parameter size and vendor labels are not quality evidence.

Store versioned quality/capability provenance, checked date/expiry and sample confidence. Unknown
closed-model parameter size must not exclude a proven capable model. No permanent hard-coded
model names, prices or provider superiority. Use task fit and current pool; visual tasks need
visual capability or a separate eligible visual reviewer. Expose selection and exclusion reasons.

Proposed floor: `frontier_or_qualified_supervisor`. No eligible route yields a structured
`supervisor_quality_unavailable` blocker. Wait/select another qualified route on temporary
capacity loss; never silently drop below the floor. A degraded per-job exception requires a
recorded FINAL decision. Preflight reviewer eligibility/independence as well as execution.

Quality ordering does not enable paid routing or raise dollar limits. Preserve explicit
free-first/on_free_exhaustion/zero-dollar settings. Where paid selection is already authorized,
quality precedes marginal cost; otherwise expose policy/quality conflict instead of selecting a
weak model or spending without authority. Paid-disabled live configuration remains unchanged.
Qualification probes have their own stated authorized quota/spend; unknown is not a capability.

## Supervisor budgets and upward requests

Proposed configurable starting delivery envelope: **600 aggregate model requests**, including
supervisor/descendants/review/repair, not a target to consume. Protect **80 supervisor turns**
and **80 integrated validation/review/repair requests**; initial worker holds total at most440.
Suggested initial task grants: inspect12, bounded implementation40, review20; adapt to spec.
Commands have separate runtime/check limits. Existing explicit lower ceilings remain constraints;
preflight rejects infeasible reserves or requests resources, never silently overrides them.

Supervisors must gain the actual `request_more_budget` capability (currently excluded). Ask the
immediate parent; root delivery supervisor asks the FINAL initiator. At20% remaining or earlier
if plan exceeds headroom, suggest +200 or justified exact amount with candidate, criterion
progress, failed checks/no-progress counts, remaining plan and marginal request/cost estimate.
Persist requests, wake on decisions and spend no model calls polling. Proposed response window
1hour then resumable waiting/blocked state; chat absence must not lose work.

Atomic grants update child allowance and ancestor holds together, protect parent reserves,
prevent sibling/self approval and release unused holds exactly once. Count each physical request
once through the tree. Counts, dollars, authority and wall-clock extensions are separate decisions.
No-progress causes bounded diagnosis/replan/reassignment, not automatic budget inflation.

## Harness v2: dedicated owner and complete replacement

The harness-redesign worker owns the full design and serial implementation briefs. Replace
the model-facing contracts, tools, batch scheduler, errors/output and operation lifecycle end
to end. Preserve proven Gate/admission, containment, journal/replay, scoped memory and process
termination primitives. Do not replace working safety mechanisms merely to call it a rewrite.

### One typed operation registry

Each operation defines Zod arguments/results, generated schema, role/authority, side effects,
replay rules, timeout and handler. Native/MCP adapters share it. Results contain operation ID,
status/duration, workspace/revision, data, diagnostics, artifact/cursor and next action. Distinguish
failed check, denied permission, pending approval, timeout, cancellation and unknown effects.

| Operation | Model-facing use |
| --- | --- |
| workspace_info | Inject OS, aliases/default repo, writable scope, base/head, recipes, dependencies and limits |
| read_files | Many paths/ranges, independent outcomes, hashes/lines and bounded paged output |
| list_paths / search_text | Root defaults, glob/literal/regex search, pagination and complete artifact |
| apply_edits | Explicit create/replace/delete, expected hashes, grouped preflight, preserved line endings |
| git_status / git_diff | Typed read-only inspection; workers have no commit/push/reset capability |
| run_recipe / run_checks | Declared IDs -> trusted executable/argv/cwd/env and revision-bound evidence |
| batch | Stable item IDs/dependencies, bounded read concurrency and ordered effects |
| operation_status / cancel_operation | Event-driven long-operation progress and confirmed termination |

Normalize harmless root `.`/`./`/empty and Windows separators. Omitted repo resolves only to
sole granted or explicit default alias. Documented field synonyms must be unambiguous; conflicting
fields return corrected examples. Never guess a destructive target, fuzzy-apply a mismatched
edit, fix malformed shell text heuristically or broaden traversal/symlink/hardlink permissions.
Mismatch returns current hash/nearby context and match count, not an opaque retry instruction.
Whole-file replacement requires old hash and explicit intent; suspicious omissions/deletions
trigger diagnostics plus independent semantic checks. Known commands use wrappers, not shell
quoting. Package recipes still execute code and remain subject to real authorization/containment.

### Batch reads/actions, bounded output

One model response can request many relevant files/actions. Initial proposal:64items per batch,
4concurrent independent reads,128KiB inline aggregate/32KiB per item, clamped further to available
model context. Larger logical reads use lossless scoped artifacts/manifests/pages; no silent
omission or unlimited heap/context claim.50small files should fit one batch/round trip when
content fits. A missing item returns its own error without erasing49successful items.

Writes default sequential; dependency references avoid stale reads/racing edits. Parallel checks
require explicitly disjoint resources. No nested unbounded batches. Every child rechecks authority,
counts quotas and has an intent/outcome journal. Preflight all grouped edits; do not pretend
multi-file filesystem effects are atomic. Precisely report/reconcile partial interruption.

### Timeouts, approvals and cancellation

Every operation has model-visible configurable deadline, default30seconds; adjust within trusted
caps (initial ceiling300seconds). Build/install recipes can explicitly declare120–300seconds.
Managed services use readiness deadlines and owned lifetime, never infinite command calls.
Effective deadline is minimum of requested/task/parent. Approval waiting and execution have
separate bounds and event-driven responses, not repeated model polling.

Timeout/cancel must stop real effects: abortable reads, authority recheck before effects and
confirmed process-tree termination, not Promise.race alone. Stop new children/model requests,
acknowledge quiescence, then release ownership. Preserve lease/expiry when stop is uncertain.
Resume replays only proven idempotent/unexecuted work; unknown command effects require reconciliation.
Retain per-response attribution and versioned historical session compatibility.

## Written memory by role and scope

Extend existing Git-backed Markdown brain, ACLs and FTS; no second memory database. Typed records:
user preference, project fact, decision and empirical lesson, each with scope/status, source,
author/role/task/model, timestamps/revision/digest, supersession/revocation and optional expiry.
CAS expected-digest writes prevent concurrent supervisor overwrites. Nested supervisors own
their job sections/assigned records; workers propose changes through own reports.

Project supervisors maintain project knowledge. Explicit user instructions that apply across
projects use a dedicated authorized global-preference path, preserving the original instruction
and bounded scope. Trusted initiator capability or visible proposal/decision is required;
worker text saying 'the user authorized' is not proof. Model-inferred global lessons retain
independent promotion review. Memory never grants execution/spending/publishing permissions.

Automatic startup/resume context proposed caps: supervisor12ktokens, reviewer6k, implementation/
analysis/inspection4k, summary/classifier2k; clamp to endpoint context/task/output headroom.
Caps are ceilings, not padding targets. Retrieve applicable authorized preferences, active spec/
contracts, Current State, relevant project facts/decisions and approved global/failure lessons.
Check grants before ranking/rendering. Manifest records refs/revisions, reason, token estimates,
omissions and read-more handles. Version refreshes/revocation explicitly across resume and cache.
Current user intent and enforced policy outrank stale memory. Retrieved prose is data, not
system authority; conflicting preferences/spec facts are surfaced rather than silently merged.

## Runtime, interactive testing and product quality

Required layers: structural checks; meaningful component/security tests; integrated runtime,
user journeys and persistence; applicable visual/usability review. The delivery supervisor owns
the evidence even when specialists execute tests. Every claimed primary feature must be
reachable and perform its specified action. Green build/tests cannot override a failed journey.
Independent evaluator-change review must actually exist, not return not_implemented.

Current browser checks disable scripts; hydrated isolation is deliberately unavailable. Complete
durable Lab/service ownership and REAL Windows/Linux isolation adapters before automatic hydrated
journeys. Integrate existing unfinished lifecycle roadmap rather than invent an unsafe parallel
path. No fake availability flag or hidden ordinary-host-browser fallback. Unsupported hosts report
missing capability; explicitly authorized FINAL manual testing can provide separately attributed
evidence without pretending an automatic contained backend exists.

Typed journeys exercise desktop/mobile/keyboard, forms, upload, error/loading/empty states,
navigation, refresh/restart, console/network failures as applicable. Restrict actions/navigation
to owned services and isolated fake data/profile/ports; prove owned cleanup/cancel/crash recovery.
Bind evidence to every repo head, spec/test/recipe/dependency/fixture and browser generation.
Screenshots must be inspected against visual requirements by a capable reviewer, not merely saved.
Absent visual capability means missing review. FINAL initiator receives launch/candidate/coverage
and independently samples actual behavior; user rejection reopens repair.

## Brain panel: latency and incomplete workflows

Source audit confirms initial page traverses/reads the full Brain before project filtering,
View/Edit eagerly load history/related blame, search repeats full index traversal and filters
scope AFTER top30 ranking, and unrelated task/session events can repeatedly refresh the page.
These are expensive/correctness-sensitive paths; no measured latency attribution yet. Existing
browse/search/edit/history/blame/access/promotions work must be preserved, not called absent.

Work sequence: (1) stream page shell and lazy-load selected tabs; subscribe only to relevant
memory events; (2) indexed scoped metadata/search pagination with scope BEFORE ranking/limit;
(3) revision-keyed scoped cache/in-flight dedup, bounded rename-safe history/blame and Git deadlines;
(4) complete create/edit/CAS, global preferences/revoke, promotion/access inbox and context preview.
No full-body corpus scan/Git history on initial navigation; no background repair blocking the page.
Preserve mount/rename privacy masking and scope cache keys. Dirty edits survive live refresh.

Fixture matrix:100/1k/10kentries across3projects, foreign search matches,1khistory revisions,
mounted docs/long documents/external edits and active task stream;50kentries stress bounded growth.
Proposed production local targets: warm metadata/short entry p95<500ms, search p95<300ms,
first history page<1s; cold shell streams<500ms and useful bounded document<2s. Record hardware,
>=30warm/5cold samples, p50/p95/max, payload/query/Git counts and click-to-useful-render. These
are proposed budgets, not measured results. Hard gates: zero eager history/blame on View/Edit;
no unrelated document-body reads on unchanged warm browse/search; <=100metadata rows/200KB
initial metadata; no unrelated-task-triggered full refresh; no lost edits/cache scope bleed.

## Implementation phases, owners and dependencies

Each phase gets a bounded spec/brief and unique report; supervisor verifies before acceptance.
Freeze shared types first. Config/task/MCP/runner/public-export/migration files each have one
scheduled owner at a time; workers may parallelize only disjoint files.

| Phase / future owner | Concrete scope | Dependencies / exit gate |
| --- | --- | --- |
| P0 Contract worker + FINAL | verification/product-spec.ts, product-evidence.ts, product-readiness.ts; core/task/config schemas; appended migrations as needed | Freeze versioned stage/spec/operation/memory/budget interfaces; fake unusable products fail readiness |
| P1 Control worker | client-supervision defaults/guidance, core/admin authority, MCP tools/schemas, CLI agent identity | P0; consistent two-project lifecycle and truthful FINAL/delegated/human decisions |
| P2 Routing/budget worker | routing/supervisor-quality.ts plus select/router/staffing; qualification provenance; admission/budget-requests, harness/budget-tools | P0/P1 authority; qualified cross-provider selection and conserved upward grants under races/restart |
| P3 Dedicated harness owner | Six serial units below; no competing loop/tools edits by other workers | P0/recipe authority interface; batch/deadline/containment/replay/cancel tests pass |
| P4 Memory worker | brain/memory-record/preferences/brain/access; context/memory and manifest; role injection adapters | P0/P3 operation contract; scoped CAS, authorized preferences, deterministic capped context/resume |
| P5 Runtime isolation worker | labs/task-attempt*, process-ownership/control-authority/browser-isolation and real platform adapters | P0/P3; actual platform setup/service/termination/crash ownership proof |
| P6 Journey/evidence worker | labs/browser-journey-schema/runtime/evidence plus checks/recipe/promotion; verification checks/contracts/decide | P0/P5; interactive exact-candidate positive/negative controls and visual review |
| P7 Delivery integration owner | runners/supervisor, harness/supervisor-tools/integration-tools; charters/prompts; protocol changes if needed | P1–P4/P6; full spec->workers->integration->TEST->repair trace; finish cannot evade coverage/FINAL decision |
| P8 Brain panel worker | Brain routes/components/API; scoped admin read models through insights/public exports | P4 frozen API; P8 loading-path optimization can start early; complete scoped flows and measured fixture gates |
| P9 Status UI worker | Tasks/detail/Activity/job/operation/budget/evidence views; compact CLI/MCP project reports | P1–P3/P7 read models; rejected/unverified/blocked visible and actionable, no false Nothing needs attention |
| P10 FINAL + independent reviewer | Authored docs/setup/roles/operations, regenerated presets, migration/compatibility and live delivery pilot | All gates below; user/initiator product acceptance, not compilation-only claims |

Harness owner serial units: H1 operation-contract/registry/dispatch; H2 repository-operations/
output-pages and repo-reader normalization; H3 edit-operations/containment transfer; H4 recipe-
operations/lifecycle and process/worker-action adapters; H5 journal/resume/repeat/loop/events;
H6 native/task-tools/legacy facade and role adapters. Exact files/tests in harness report.
P4 runner injection follows P3 runner adaptation; P7 follows both. P8/P9 shared navigation gets
one integration owner. Parallelize routing, independent harness/memory internals and Brain
read-path work after interfaces freeze; serialize actual shared-file edits.

## Validation, rollout and rollback

- Contract/offline: two-project lifecycle; shared tool/schema parity; quality floor/paid-policy
  fixtures; supervisor upward budget races, restart and no double-counting; spec-change invalidation.
- Harness:50-file read in one batch,49successes plus one missing; paged lossless oversized
  output; harmless formatting fixtures succeed, ambiguous/unsafe requests stay denied. Crash
  at each child effect; cancelled approval/in-flight process stops with no delayed writes.
- Memory/panel: global authorized preference reaches a second project; model inference cannot
  self-promote; CAS/revocation/grants/resume manifests;10k/50kfixture performance and full scoped
  create/search/edit/history/preference/access/promotion/context-preview browser journeys.
- Product negative controls: green-build static page with inert buttons, broken hydration,
  omission rewrite, missing assets, hidden mobile controls or data loss FAILS readiness.
  Changed test cannot validate itself; wrong head/fixture/recipe invalidates evidence.
- Real platforms: Windows/Linux process and interactive containment acceptance separately;
  mocks do not certify a runtime capability. Unsupported stays explicitly blocked.
- Repository: pnpm -r typecheck; build router before full router Vitest; pnpm -r build.
  Panel changes additionally seed demo, launch production spare-port, request touched pages/
  APIs, inspect Chrome screenshots and stop owned services. Never use real user datasets.
- Controlled live pilot: new isolated downstream project, frozen product/visual spec and actual
  user journeys; qualified delivery supervisor owns implementation through tests/repair; FINAL
  independently evaluates candidate. State600starting requests and exact dollar policy before
  dispatch. Paid remains disabled absent separate authority; extensions are explicit.

Measure requests by purpose, tool errors/no-progress turns, batching, approval/lease waits,
tokens/cache, time, defects/repair cycles and FINAL interventions. Offline normalization fixtures
require zero avoidable safe-format failures. Paired same-model/spec/environment pilots target
>=50%fewer avoidable recovery turns without quality regression; total cost/request reduction is
measured, not promised. Do not improve counts by omitting tests or treating available600 as a goal.

Version v1/v2 tool surfaces; pin existing sessions to original contracts. Roll out offline fixtures
-> opt-in isolated pilot -> new-job default. Preserve explicit paid/security/authority settings
and historical evidence. Keep legacy log readers/temporary new-job rollback; rollback cannot
weaken containment or rewrite outcomes. Regenerate presets with their script. Update roles,
operations/setup, README/client guidance and brain protocol with substantial changes.

## Risks and implementation decisions

No strong authorized model means blocker, not weak fallback or unauthorized spend. Large
batches/budgets need hard output/resource limits and progress telemetry. Memory needs provenance,
CAS/revocation and clear authority. Harness rewrite needs replay/containment compatibility.
Interactive runtime requires genuine unfinished infrastructure, not just new prompts. Brain
latency needs measured baseline plus architectural no-work tests, not only loading skeletons.
Usability needs observable spec, inspected visual evidence and FINAL/user judgment; passing
checks never settles a disputed product-quality assessment.

## Worker Briefs

### Brief: batch-safety-review
- Repository: D:/SwitchYardRouter/.claude/worktrees/harness-batch-usage (read-only implementation review)
- Task: Independently review pending batching changes for regressions in journaling/replay/cancellation, authority and mutation barriers, model-facing schema accuracy, SDK compatibility and grouped-check approvals. Report concrete blocking findings with lines and reproduction, not speculative redesign.
- Required reads: diff of harness/loop.ts, operation-contract/dispatch/registry.ts, edit/repository/recipe-operations.ts, runners/coding/task-tools.ts and native.ts; narrowly named tests as needed.
- Owns (may edit): own report only at main docs/working/supervised-delivery-v2/reports/batch-safety-review.md.
- Must not touch: source, shared working docs, live data/config; no commits or broad test runs.
- Definition of done: explicit reviewed risks and findings; distinguish validated source observations from unrun tests.
- Report to: docs/working/supervised-delivery-v2/reports/batch-safety-review.md.

### Brief: supervisor-routing-default
- Repository: D:/SwitchYardRouter
- Task: Fix empty-evidence deadlock with explicit best_available default; retain frontier_or_qualified_supervisor as opt-in strict policy. Quality evidence ranks proven candidates first; unverified candidates clearly identified, never assigned invented quality scores. Apply normal supervisor size floors to unverified candidates; evidence-qualified candidates can retain unknown-size support. Preserve paid, tools, modality, endpoint exclusions and dispatch-time strict expiry checks.
- Required reads: Current State above; src routing/supervisor-quality.ts, routing/select.ts, gateway/gate.ts and tests/supervisor-quality.test.ts under packages/router.
- Owns (may edit): packages/router/src/routing/supervisor-quality.ts, packages/router/src/routing/select.ts, packages/router/src/gateway/gate.ts, packages/router/tests/supervisor-quality.test.ts
- Must not touch: any other source, live config/data, clone repositories, shared working docs.
- Definition of done: regression tests prove fresh empty-evidence config routes strongest eligible supervisor, explicit strict still blocks, paid remains disabled, real Gate dispatch matches policy. Run focused tests; no commits.
- Report to: docs/working/supervised-delivery-v2/reports/supervisor-routing-default.md

### Brief: supervisor-startup-preflight
- Repository: D:/SwitchYardRouter
- Task: Investigate and fix supervisor startup preflight/error classification so no-route start_job returns typed actionable errors before persisting a doomed job. Cover direct supervise submission too if existing submission architecture allows a scoped fix. Do not alter qualification policy; coordinate router-default worker API if needed.
- Required reads: Current State above; packages/router/src/core/service.ts startJob/submitTasks, supervisor runner routing and submission tests.
- Owns (may edit): packages/router/src/core/service.ts and ONE new packages/router/tests/supervisor-startup.test.ts, plus own report.
- Must not touch: routing files, gateway, other tests, live config/data, clone repositories, shared docs.
- Definition of done: offline temp-config tests verify typed error/no doomed task and successful usable-default submission. No live provider calls, commits or pushes.
- Report to: docs/working/supervised-delivery-v2/reports/supervisor-startup-preflight.md

### Brief: model-unavailable-recovery
- Repository: D:/SwitchYardRouter/.claude/worktrees/model-unavailable-recovery (isolated branch feat/model-unavailable-recovery)
- Task: User observed whole tasks fail on unavailable/not-in-plan models. Trace Gate candidate fallback cap and terminal task errors. Fix account/endpoint unavailable refusals so remaining eligible endpoints are tried without spending paid authority or retrying rejected routes forever. Preserve finite transport retries, attempt accounting, cancellation and budget limits; exhausted pool errors remain actionable.
- Required reads: This brief, packages/router/src/gateway/gate.ts and provider error classification, affected tests; no broad background.
- Owns (may edit): gateway fallback and provider error handling plus narrowly affected/new tests in your worktree, own report.
- Must not touch: main checkout, supervisor-quality policy/select.ts, harness batching, live config/data; no commits/pushes.
- Definition of done: regressions3+unavailable then healthy succeed, full exhaustion bounded, paid0 cannot escalate; focused tests pass. Report API/compatibility details for supervisor integration with pending main Gate changes.
- Report to: docs/working/supervised-delivery-v2/reports/model-unavailable-recovery.md in your worktree.

### Brief: harness-batch-usage
- Repository: D:/SwitchYardRouter/.claude/worktrees/harness-batch-usage (isolated branch feat/harness-batch-usage)
- Task: User observed serial worker reads/commands despite batch tools. Inspect actual advertised tool schemas, batched execution limits and injected guidance. Reproduce malformed apply_edits missing action and repeated serial calls. Fix concrete schema/injection/execution causes and automatic coalescing where justified. Do not claim models always batch just from prompt text. Keep dependent/mutating/approval commands sequential; independent reads can parallelize, commands only when proven safe.
- Required reads: This brief; packages/router/src/harness/tools.ts and harness v2 tools/executor; relevant tests. Inspect local session s_0mvlw7qu62723759e2107.jsonl only if needed (private evidence, never commit transcript).
- Owns (may edit): harness batch/schema/guidance implementation and affected/new harness tests, own report. Keep original files where concerns belong.
- Must not touch: main checkout, gateway/routing/core/service.ts, provider handling, live config/data; no commits/pushes.
- Definition of done: schema advertises usable typed batch/edit items; test actual multiple reads/check scheduling behavior and failure independence; focused tests pass; describe remaining model-choice limitations honestly.
- Report to: docs/working/supervised-delivery-v2/reports/harness-batch-usage.md in your worktree.

### Brief: release-scope-audit
- Repository: D:/SwitchYardRouter-delivery-v2 at61d572c; read-only implementation review.
- Task: Check planned P0–P10 against implemented source/reports; identify material unimplemented requirements, separately from unavailable external acceptance.
- Required reads: Current State, phase/validation tables in this document; implementation reports and only relevant named source needed to substantiate findings.
- Owns (may edit): docs/working/supervised-delivery-v2/reports/release-scope-audit.md only.
- Must not touch: source/tests/shared docs, verification worktrees, runtime data, commits/pushes; do not run tests/builds while release suite runs.
- Definition of done: Concise evidence-based gap list with source paths and user impact. Distinguish implemented/tested, implemented/unverified, and absent. Prioritize actual delivery usability and P9 status/report controls. Do not assume report claims prove runtime behavior. No broad background reads.
- Report to: docs/working/supervised-delivery-v2/reports/release-scope-audit.md.

### Brief: delivery-attention-report
- Repository: D:/SwitchYardRouter-delivery-v2; full suite continues in frozen separate checkout.
- Task: Close confirmed P9 product-attention false-negative and provide compact scoped project delivery status through CLI/MCP.
- Required reads: Current State; admin/projects.ts, admin/deliveries.ts, relevant index.ts exports, cli.ts status, mcp tool registration and single-task delivery_status, product readiness API.
- Owns (may edit): packages/router/src/admin/projects.ts, admin/deliveries.ts, index.ts, cli.ts, mcp.ts and mcp delivery tool registration module as needed; uniquely named tests/delivery-attention-report.test.ts; own report. Coordinate if another module needed.
- Must not touch: panel files, other source/tests, shared docs, runtime config/data, commits/pushes. No broad builds or full tests; root owns integration builds.
- Definition of done: Product delivery unready/rejected/stale/pending FINAL is visible in projectAttention even if legacy criteria met. Compact bounded project-scoped report exposes current readiness/stage/FINAL historical vs effective acceptance and actionable reasons, never cross-project bodies. CLI/MCP consistent strict input validation; preserve existing status contract. Focused tests prove synthetic legacy-met plus rejected/unready is attention, accepted-current clears it, stale historical acceptance is not effective, project isolation and pagination/bounds. Report actual checks and gaps.
- Report to: docs/working/supervised-delivery-v2/reports/delivery-attention-report.md.

### Brief: delivery-status-panel
- Repository: D:/SwitchYardRouter-delivery-v2; disjoint panel-only implementation.
- Task: Make product readiness and FINAL rejection visible on job detail and project overview, with useful next-action guidance.
- Required reads: Current State; own release-scope-audit report; panel task-detail product card, project overview, job detail, task links; existing deliveryView read model.
- Owns (may edit): apps/panel/app/p/[slug]/page.tsx, apps/panel/app/p/[slug]/jobs/[id]/page.tsx, new components/product-delivery-status.tsx, app/api/tasks/resume/route.ts after repair worker confirms service contract; own report. Ask root before any other file.
- Must not touch: router source/tests, other panel files, shared docs, runtime config/data, commits/pushes. No builds while root integrates; no real-provider calls.
- Definition of done: Job page displays root delivery readiness/stage/recorded FINAL decision, invalid historical acceptance, blockers and link to task review. Project overview links bounded product issues if practical using stable insights.projectDeliveryReport API being added by brain worker; coordinate API. Clearly label stored evidence (not fresh Git inspection), instructions inspect delivery_status, independently observe and decide; rejected tasks link existing resume route/UI where safe. Preserve project scope. No panel mutation endpoint that bypasses candidate-refresh/CAS or human authority. Report verified vs unverified; root does production demo/screenshots.
- Report to: docs/working/supervised-delivery-v2/reports/delivery-status-panel.md.

### Brief: rejected-delivery-repair
- Repository: D:/SwitchYardRouter-delivery-v2; bounded control-plane fix, no full-suite/build runs.
- Task: Investigate and close completed-product rejection dead end: documented resume_task only permits interrupted tasks today.
- Required reads: Current State; core/service.ts resumeTask/resumeSession; storage/tasks.ts resume; supervisor runner/session resume, product-delivery finalDecision/stage, native supervisor guidance.
- Owns (may edit): packages/router/src/core/service.ts, storage/tasks.ts, verification/product-delivery.ts, runners/supervisor.ts, uniquely named tests/rejected-delivery-repair.test.ts; own report. Ask before other source files.
- Must not touch: CLI/MCP files (other worker owns), panel files, other tests, shared docs, commits/pushes, runtime data. No production authority weakening.
- Definition of done: Existing resumeTask can explicitly reopen a completed supervisor ONLY when current persisted product FINAL decision rejects it; preserve budgets/lineage/audit and no double integration. Keep completed accepted/nonproduct tasks nonresumable. Reopened supervisor receives rejection and existing spec/candidate/criteria, must validate fresh candidate and return to FINAL separately. Determine correct safe session/workspace continuation; no blanket completed-task resume. Test actual fake-provider supervisor delivery rejection->resume->repair/validation or bounded equivalent proves real runtime, plus isolation/duplicate refusal/budget invariants. Report constraints immediately if safe implementation needs more files.
- Report to: docs/working/supervised-delivery-v2/reports/rejected-delivery-repair.md.

### Brief: classifier-batch-regression
- Repository: D:/SwitchYardRouter-delivery-v2; source frozen except this bounded diagnosis.
- Task: Diagnose full61d572c scoring.test classifier batching failure (2calls expected1); narrow scope, preserve request accounting/cache/security.
- Required reads: Current State; tests/scoring.test.ts, tests/helpers.ts default50ms, scoring/classifier.ts queue; executor scoring preparation only if needed.
- Owns (may edit): packages/router/tests/scoring.test.ts; packages/router/src/scoring/classifier.ts ONLY if genuine classifier queue bug proven; own report.
- Must not touch: other files, shared docs/runtime data, commits/pushes, broad builds/full suite. Coordinate source change before editing.
- Definition of done: Explain why two submitted tasks missed50ms window under loaded realGit tests. Prefer deterministic boundary test of actual batching/cache rather than enlarge time arbitrarily. Keep end-to-end actual shared request and cache reuse assertions. No production waiting/performance change without demonstrated bug. Run selected test file and report exact results.
- Report to: docs/working/supervised-delivery-v2/reports/classifier-batch-regression.md.



### Implementation brief: evaluator-review (P6 verification)
- Repository: D:/SwitchYardRouter-delivery-v2, feat/supervised-delivery-v2
- Task: Implement required evaluator_change_review through actual independent review/evidence and predictive reserve, replacing not_implemented with truthful outcomes.
- Required reads: Current State/acceptance spec; verification/checks, review, phase, decide, contract, policy; core/acceptance and relevant review tests.
- Owns: verification/checks.ts, review.ts, phase.ts, decide.ts, contract.ts, policy.ts; core/acceptance.ts if necessary; uniquely named evaluator-review tests and own report.
- Must not touch: product-spec/evidence/readiness/delivery/candidate modules, config/schema, harness/native/runner, other workers' files; no commits/live calls.
- Definition of done: actual independent reviewer examines changed tests/fixtures versus original behavior and implementation; exact revision/provenance, failed/weakened tests block; no eligible reviewer honestly pending, never deterministic fakepass. Declared test edits anticipate review before spend; meaningful adversarial cases.
- Report: docs/working/supervised-delivery-v2/reports/evaluator-review-implementation.md

### Implementation brief: interactive-runtime (P5/P6)
- Repository: D:/SwitchYardRouter-delivery-v2, feat/supervised-delivery-v2
- Task: Implement durable isolated interactive journey capability and typed evidence on real supported platform backends, reusing existing Lab/control primitives; no fake available flag or ordinary host-browser fallback.
- Required reads: Current State/runtime spec; memory-acceptance report; labs/browser-isolation, browser-check/schema, process-ownership, checks, recipe, task-attempt and existing lifecycle roadmap/tests.
- Owns: labs/** except unrelated user changes; uniquely named browser-journey/isolation tests; own report. Coordinate any workspaces/git/process seam already supplied by harness.
- Must not touch: config/schema, core/task, delivery/readiness modules, exports, UI or other workers' files without negotiated seam. No live providers or user data; no commits.
- Definition of done: real capability establishment, owned process/network/fs scope, JS-enabled typed journeys, revision-bound evidence, cancellation/crash cleanup and negative controls. Explicitly report platform prerequisites absent on this host and implement/test all useful work without pretending unsupported capability is ready.
- Report: docs/working/supervised-delivery-v2/reports/interactive-runtime-implementation.md

### Implementation brief: memory-v2 (P4)
- Repository: D:/SwitchYardRouter-delivery-v2, feat/supervised-delivery-v2
- Task: Implement role-budgeted automatic memory context and typed authorized scoped memory/preferences service, using existing Brain storage/ACL/CAS.
- Required reads: Current State/memory spec; memory-acceptance report; brain/access/promotion; context assembly in worker/read-only/native/supervisor.
- Owns: new brain/memory-record.ts, preferences.ts; new context/memory.ts, memory-manifest.ts; brain/access.ts only if needed; harness/worker.ts; runners/readonly.ts; uniquely named memory-v2 tests and own report.
- Must not touch: brain/brain.ts or catalog (Brain worker); config/schema, native/supervisor runners, harness loop/tools/dispatch (send injection seam), migrations/exports/MCP (FINAL owns); no commits/live calls.
- Definition of done: real automatic context in allowed runners, grants checked before render, role caps/revision manifest, CAS and revocation, distinct authorized global preferences vs inferred lessons. No raw model 'user said' authority bypass; provide explicit service capability seam for FINAL/MCP UI adapters.
- Report: docs/working/supervised-delivery-v2/reports/memory-v2-implementation.md

### Implementation brief: supervisor-quality-budget (P2)
- Repository: D:/SwitchYardRouter-delivery-v2, feat/supervised-delivery-v2
- Task: Implement real supervisor quality policy and upward request grants; integrate existing router/admission paths, preserving explicit paid settings.
- Required reads: Current State/quality/budgets; supervisor-routing report; routing/router/select/staffing; model catalog/qualification; admission budget store and harness budget tools.
- Owns: routing/**, models/catalog.ts, qualification/** as needed; admission/budget-requests.ts; harness/budget-tools.ts; tests/supervisor-quality.test.ts, supervisor-budget-extension.test.ts; own report.
- Must not touch: config/schema.ts (send needed typed config seam to FINAL), core/task, supervisor runner/tools, harness loop/tools, public exports/panel, other workers' files; no commits/live calls.
- Definition of done: high-quality-floor route selection across authorized providers with evidence/expiry and no weak silent fallback; supervisors can request more from parent/FINAL; conserved nested grants and paid limits, race/restart tests. No disconnected policy helper.
- Report: docs/working/supervised-delivery-v2/reports/supervisor-quality-budget-implementation.md

### Implementation brief: delivery-contracts (P0)
- Repository: D:/SwitchYardRouter-delivery-v2, feat/supervised-delivery-v2
- Task: Implement versioned Zod product spec/evidence/readiness contracts and meaningful negative tests; freeze public API before consumers.
- Required reads: Current State/stages above; core/task.ts; verification/contract.ts, checks.ts, decide.ts; supervisor runner finish flow.
- Owns: new verification/product-spec.ts, product-evidence.ts, product-readiness.ts; tests/product-readiness.test.ts; own reports/delivery-contracts-implementation.md.
- Must not touch: existing shared schemas/runners/config/exports, other workers' files; no commits/live calls.
- Definition of done: valid typed spec/receipts, digest/version and exact-candidate checks, missing/claimed/stale/failed evidence blocks readiness, final decision separate; consumers get exported file API. No unattached pretend runtime implementation.
- Report: docs/working/supervised-delivery-v2/reports/delivery-contracts-implementation.md

### Implementation brief: harness-v2 (P3)
- Repository: D:/SwitchYardRouter-delivery-v2, feat/supervised-delivery-v2
- Task: Own COMPLETE harness replacement implementation through H1–H6, starting contract/batch/read/edit/recipes then native-loop integration. Persist milestones and coordinate shared file ownership.
- Required reads: Current State/harness spec; reports/harness-redesign.md; named existing harness/coding/session modules and focused tests.
- Owns: harness/** except supervisor-tools.ts/integration-tools.ts/budget-tools.ts; context/repo-reader.ts; runners/coding/**; sessions/events.ts; uniquely named harness-v2* tests; own report.
- Must not touch: config/schema, core/task, index exports, memory modules, panel, supervisor runner, shared doc, other tests without coordination; no commits/live calls.
- Definition of done: runtime-integrated defensive typed batching,50file mixed-outcome reads, adjustable deadlines, safe wrappers/edits, journal/recovery/containment preserved, default native v2 with compatibility. Do not stop at disconnected schemas.
- Report: docs/working/supervised-delivery-v2/reports/harness-v2-implementation.md

### Implementation brief: brain-performance (P8 early)
- Repository: D:/SwitchYardRouter-delivery-v2, feat/supervised-delivery-v2
- Task: Implement Brain navigation/search performance and correctness work plus scoped paging/lazy provenance; measure isolated fixture and finish usable browse/edit flows.
- Required reads: Current State/Brain spec; reports/brain-panel.md; Brain page/admin/index/read paths and tests.
- Owns: apps/panel/app/p/[slug]/brain/**, app/api/brain/**, components/client/brain*.tsx, new app/all/brain/** standalone global view; admin/brain*.ts; brain/brain.ts; new brain/catalog.ts if needed; tests/brain-performance.test.ts; own report.
- Must not touch: brain/access/preferences/injection, config/migrations/exports, shared docs or other worker files; request public export seam from supervisor. No commits/live data/provider calls.
- Definition of done: no eager history/blame/full-body scans on View, scope-before-limit search, bounded paged tree/search, stale-safe caching; production-demo/manual validation needs listed precisely. Keep privacy/history behavior.
- Follow-up acceptance: exact-HEAD history cursor, bounded blame deadline, standalone global memory flow and injected-context provenance preview; rerun selected privacy/core/performance tests after P4 ACL integration.
- Report: docs/working/supervised-delivery-v2/reports/brain-performance-implementation.md

### Brief: brain-panel
- Repository: D:/SwitchYardRouter
- Task: Investigate user-reported slow/incomplete Brain page and propose exact performance/completeness work; no implementation.
- Required reads: this Current State; apps/panel/components/brain*, app/p/[slug]/brain/**, app/brain/**, relevant admin/brain data access and brain storage/retrieval.
- Owns (may edit): docs/working/supervised-delivery-v2/reports/brain-panel.md
- Must not touch: source, shared docs, user brain/config/runtime data.
- Definition of done: source-grounded loading bottleneck hypotheses vs measured facts, missing UI capabilities, scoped/lazy/paginated design, test and performance budgets; use demo/temporary data only for probes.
- Report to: docs/working/supervised-delivery-v2/reports/brain-panel.md

### Brief: harness-redesign
- Repository: D:/SwitchYardRouter
- Task: Own the complete replacement harness design and executable implementation brief; no source edits in this planning phase.
- Required reads: this Current State; packages/router/src/harness/**, src/runners/coding/**, src/sessions/events.ts; relevant existing harness tests only.
- Owns (may edit): docs/working/supervised-delivery-v2/reports/harness-redesign.md
- Must not touch: source, shared docs, config, runtime data or downstream app.
- Definition of done: map existing behavior; defensive typed wrappers, batching, bounded large reads, cancellation/timeouts, edits/checks and migration; exact file ownership and meaningful tests. Distinguish implemented vs proposed.
- Report to: docs/working/supervised-delivery-v2/reports/harness-redesign.md

### Brief: supervisor-routing
- Repository: D:/SwitchYardRouter
- Task: Audit delegated supervision, routing, budgets and stage prompts; propose concrete quality-first changes, no source edits.
- Required reads: this Current State; docs/roles.md; src/runners/supervisor*, src/routing/**, src/qualification/**, relevant config/task/MCP files and charters.
- Owns (may edit): docs/working/supervised-delivery-v2/reports/supervisor-routing.md
- Must not touch: source, shared docs, config or runtime data.
- Definition of done: exact extension points, initiator/final vs delegated ownership, highest eligible quality across providers, budget hierarchy and testable spec stages; preserve paid authorization.
- Report to: docs/working/supervised-delivery-v2/reports/supervisor-routing.md

### Brief: memory-acceptance
- Repository: D:/SwitchYardRouter
- Task: Audit memory/context, checks/Labs and acceptance; design scoped writable memory and product acceptance, no source edits.
- Required reads: this Current State; src/brain/**, src/context/**, src/verification/**, relevant Labs/roles docs and tests.
- Owns (may edit): docs/working/supervised-delivery-v2/reports/memory-acceptance.md
- Must not touch: source, shared docs, config or runtime data.
- Definition of done: role-budgeted injected memory, authorized project/global edits, versioning/provenance, integrated runtime/browser acceptance; exact file map, dependencies and tests.
- Report to: docs/working/supervised-delivery-v2/reports/memory-acceptance.md

## Work Ledger

### 2026-10-23 — Accept integrated recovery/batching corrections and activate supervisor
- Agent: supervisor; workers routing_default/startup_preflight; independent batch_safety_review
- Changed: finite model refusal recovery/cache, native/MCP portable batch tools, safe read coalescing, grouped-check approval barrier and final nested-schema correction.
- Why: user observed premature model failures and serial/malformed tool use after a blocked supervisor default.
- Validation: final integrated83/83; final schema/MCP26/26; recursive typecheck/build pass. Initial full1360/15/3 plusRPCerror; all15 failed cases pass serialized78/1skip rerun without relaxed assertions. Fresh real-config MCP3candidates/no blocker; live renewed supervisor calls overlap repository reads.
- Outcome: Accepted
- Follow-up: source publication; oversee renewed Facebook delivery separately, preserve FINAL product acceptance and human-only command policy.

### 2026-10-23 — Repair unusable supervisor bootstrap
- Agent: supervisor; workers routing_default and startup_preflight
- Changed: supervisor default routing/Gate, atomic submission preflight, example/preset generation and authored setup/roles/README guidance.
- Why: default empty evidence excluded every supervisor; shipped claude-code preset additionally persisted strict policy.
- Validation: recursive typecheck/build passed before final amendments; final focused supervisor/startup/presets29/29 pass. Full snapshot1360pass/15fail/3skip and1RPCerror; reruns pending.
- Outcome: Partial
- Follow-up: integrate unavailable-model and batching fixes; final rebuild/typecheck and reproduce full-run failures without concurrent build load.

### 2026-10-23 — Initial implementation and contract checks
- Agent: supervisor
- Changed: bounded worker implementation briefs and feature worktree; product/control integration and migration.
- Why: User authorized executing the full corrective plan.
- Validation: offline dependency install219packages; independently ran `pnpm exec vitest run tests/product-delivery.test.ts tests/product-readiness.test.ts tests/mcp-lifecycle-v2.test.ts --maxWorkers=1 --minWorkers=1` ->30passed. Worker narrow suites remain subject to integration review.
- Outcome: Partial
- Follow-up: Complete P4/P8/harness recovery, implement runtime/journey prerequisites, then stable-tree full typecheck/build/tests and demo-browser acceptance.

### 2026-10-23 — Planning scope and worker briefs
- Agent: supervisor
- Changed: this working document and three bounded research/design briefs.
- Why: User requests a complete corrective plan and a worker-owned harness replacement.
- Validation: prior assessment/current repository guidance inspected; no implementation checks run.
- Outcome: Partial
- Follow-up: Review worker conclusions against source and assemble sequenced specifications/acceptance gates.

### 2026-10-23 — Corrective plan and Brain panel scope complete
- Agent: supervisor
- Changed: full P0–P10 specification, four worker design reports, working index/handoff and prior-assessment clarification.
- Why: User requests strong delegated supervisors, spec methodology, complete defensive/batched harness, written memory and responsive complete Brain UI.
- Validation: inspected source for routing order, supervisor budget exclusion, static/hydrated browser capability and Brain eager loading; report links/phase coverage and documentation whitespace checked. No implementation tests or live-provider calls run.
- Outcome: Accepted
- Follow-up: Execute contract-first implementation sequence; numerical defaults/performance targets remain proposed until tested.

### 2026-10-23 — Verified source release and publication
- Agent: Senior supervisor; bounded workers brain-performance, harness-v2 and release-scope-audit.
- Changed: integrated P0–P9 source, corrective product attention/reports and guarded rejected-delivery repair; authored current docs/presets and preserved implementation history.
- Validation: full d17890a 1354pass/2obsolete HTTP inventory failures/3skips; corrected actual stdio/HTTP/product/repair12/12; final dev-integration product/report7/7; final row validation delivery/repair6/6; recursive typecheck/build passed. Production17/17 and rebuilt mobile/settings/P9 UI/API controls passed; benchmark1/1. Exact boundaries and remaining limits in release-acceptance report.
- Outcome: Accepted for coherent framework source release, merged/pushed dev and main at cc1e0a4. Entire delivery/live-platform plan remains Active.
- Follow-up: actual Docker/Linux isolation and qualified live-provider product pilot, manual quality onboarding improvements, cold initial-index target. No live installation restart/migration, paid calls or downstream clone edits.

### 2026-10-23 — Production acceptance and memory/fixture closure
- Agent: supervisor; workers Brain QA, delivery contracts, harness.
- Changed: actual-tool/output headroom on resume and trusted install preference binding; original security/integration fixture assumptions replaced with actual startup/terminal boundaries; classifier omission receipt and explicit noninteractive CLI authority assertions; unknown criterion inputs rejected without poisoning evidence; mobile Markdown table readable minimum width and settings copy aligned with actual defaults.
- Validation: root independently observed 22/22 memory/global-root/headroom/product tests, 10/10 CLI/product tests and classifier recording case. Workers report team/supervisor/containment24/24 and source typecheck. Production demo seed passed all expectations. Panel17/17 functional scenarios passed, zero JS exceptions; warm30-navigation p50/p95 188/281ms. Root inspected mobile/global/product distinction screenshots and found genuine mobile index row-height defect despite passing overflow assertion; source fix needs rebuilt visual verification. Initial10k-file indexing remains above2s target (~5.68s loaded host); no false cold-browser performance claim.
- Outcome: Partial.
- Follow-up: checkpoint frozen source, final exact-revision suite/build and rebuilt mobile/settings acceptance; preserve Docker/real-provider acceptance blockers.

### Brief: merge-resume-regression
- Repository: Feature D:/SwitchYardRouter-delivery-v2; reproduce on own stable temporary test fixtures.
- Task: Diagnose repeatable release full-suite team-nesting crash-resume fixture failing to reach the merge fault (simulatedCrashCount 0, expected 1).
- Required reads: Current State; tests/team-nesting.test.ts final crash-resume case and scripted worker; relevant integration/worktree/verification paths based on actual event evidence.
- Owns (may edit): packages/router/tests/team-nesting.test.ts, src/workspaces/merge-queue.ts if demonstrated cause, own unique report; request root for any other source ownership.
- Must not touch: current worker-owned memory/context/executor/harness tools/runners; release snapshot; shared docs; config/data/commits/pushes.
- Definition of done: Reproduce narrow test, inspect actual task state/result/events/tool errors before cleanup; identify cause rather than increasing polling blindly. Fix legitimate bug or obsolete fixture assumption preserving exact two-commit/crash/recovery guarantee; run focused regression. Report source owner if cause is outside scope.
- Report to: docs/working/supervised-delivery-v2/reports/merge-resume-regression.md
- Extension: also owns packages/router/tests/supervisor.test.ts first legacy standalone fixture, which reports supervisor_completed/unmet after the same scripted await_tasks -> immediate integrate sequence. Inspect actual errors and preserve its integration/check/attribution guarantees. No runtime source weakening.
- Extension: also owns packages/router/tests/worker-containment.test.ts running-action cancellation fixture. Release run got cancelled instead of uncertain after a fixed300ms cancellation; inspect actual pre-spawn vs running distinction. Ensure the command has really started with a marker before revoking authority, preserve uncertain status for a genuinely started effect, and prove no delayed sentinel write. Do not relax the security assertion or production containment.
- Extension: also owns packages/router/tests/external-task-tools.test.ts running approved recipe timeout fixture (same cancelled-before-spawn vs uncertain assumption under a1s total deadline). Prove actual process start before timeout, use sufficient fixture deadline and later forbidden-write timer, retain strict uncertain/quiescence/no-write assertions. This tests the running case; adjacent expired-approval case continues testing no-spawn cancellation. No production changes.

### Brief: resumed-memory-headroom
- Repository: D:/SwitchYardRouter-delivery-v2 (not the running release snapshot).
- Task: Close actual-tool context headroom omission on resumed native/read-only/supervisor sessions.
- Required reads: Current State; context/memory.ts and refreshMemoryMessages call sites in runners/{readonly,supervisor,coding/native}.ts.
- Owns (may edit): those four files only, uniquely named tests/resumed-memory-headroom.test.ts and own report.
- Must not touch: release snapshot, other source/tests/shared docs, commits/pushes. Root will not edit these owned files meanwhile.
- Definition of done: Pass actual offered tool schemas and output margin into refreshed memory context budgeting; keep existing role caps, ACL/revocation and pinned session tool behavior. Avoid double output reservation. Add a meaningful large-tool/small-context regression ensuring fresh memory doesn't exceed available input and revocation still removes old text. Run focused memory/resume checks and router typecheck; report precise outcomes.
- Report to: docs/working/supervised-delivery-v2/reports/resumed-memory-headroom.md

### Brief extension: install-wide preferences across separate project Brains
- Repository: D:/SwitchYardRouter-delivery-v2; serial continuation by resumed-memory-headroom worker.
- Task: Fix confirmed global preference injection gap when a project has a distinct Brain root.
- Required reads: Current State; core/executor.ts dependency/context construction, runners/types.ts, harness/tools.ts Brain read tools, context/memory.ts, project Brain context setup.
- Owns (may edit): prior four files plus packages/router/src/core/executor.ts, packages/router/src/runners/types.ts, packages/router/src/harness/tools.ts; uniquely named tests/global-preferences-roots.test.ts; own report.
- Must not touch: shared docs, release snapshot, unrelated source/tests, commits/pushes.
- Definition of done: Wire trusted install Brain capability into actual execution contexts without model-supplied roots. Canonical typed global/preferences resolve/read from install Brain with current role ACL, while project memory stays in its own root and existing ordinary project/global document/promotion semantics remain intact. Explicit brain_read/list/search prefix global/preferences must support injected read-more refs. Test actual routed project with distinct root receives/revokes install preference, never foreign private project data, and can read the cited record. Keep role/token bounds and no raw preference writes. Verify defaults/shared-root behavior with focused tests/typecheck.
- Report to: docs/working/supervised-delivery-v2/reports/resumed-memory-headroom.md (combined report with a distinct-root section).

### Brief: production-delivery-panel-acceptance
- Repository: Verification only D:/SwitchYardRouter-delivery-v2-release at 9c80b12; report in feature worktree.
- Task: Exercise latest production Brain/global memory/settings/task acceptance UI and affected API routes against isolated demo only.
- Required reads: Current State; relevant owned P8 docs/report and panel components/routes/settings definitions.
- Owns (may edit): verification snapshot apps/panel/.demo test data, unique temporary QA scripts/screenshots outside source; feature docs/working/supervised-delivery-v2/reports/production-delivery-panel-acceptance.md only.
- Must not touch: source/tests, shared docs, live config/Brain/provider services, port4477, commits/pushes. Never change files while full-suite source validation runs.
- Definition of done: Wait for root production build confirmation, seed demo and inspect failures without weakening expectations, start production panel spare4480, exercise project Brain navigation/search/catalog/pages/document create/edit/CAS conflict/history/blame/related; project/global typed memory create/update/revoke including bad scope/CSRF/CAS; saved context receipt preview, settings workflow/budget/Add-supervise defaults; tasks acceptance/product distinction. Capture/inspect Chrome screenshots and browser errors/timings. No provider calls. Preserve fixtures, stop every owned temporary server/browser at end; report exact coverage/failures/limits promptly.
- Report to: docs/working/supervised-delivery-v2/reports/production-delivery-panel-acceptance.md

### 2026-10-23 — Independent acceptance review and concrete boundary fixes
- Agent: supervisor; read-only reviewer harness-v2.
- Changed: FINAL expected spec/candidate digests with conflict rejection; dirty integration sources refused; handoff/completed/terminal-descendant acceptance gate; original goal/mandatory criteria and no self-waivers; before/after final-check source binding with invalidation; scope/patch capture after final commands; effective accepted flag distinct from historical decision; portable MCP schema descriptions with strict runtime digest validation.
- Validation: actual default lifecycle plus source-changing final command, stale FINAL observation/decision, dirty source, mandatory criterion/waiver/history and roadmap team tests passed 10/10. Existing verification-resume plus product/budget rerun passed 17/17; root router build passed after latest source. Full initial snapshot finished with 14 known failures (see Current State), not release acceptance. Latest MCP schema/stdio rerun passed 2/2; capacity eventual-state rerun in progress.
- Outcome: Partial.
- Follow-up: stable checkpoint, complete release suite/build, latest production panel/API/screenshots; actual isolated interactive runtime remains blocked by missing engine/image.

### Brief: delivery-acceptance-integration-review
- Repository: D:/SwitchYardRouter-delivery-v2 (review checkpoint 7152295 plus later fixes)
- Task: Read-only adversarial integration review of root-owned specification/candidate/evidence/stage/FINAL controls; identify actual bypasses or unusable runtime paths.
- Required reads: Current State; verification/product-{delivery,candidate,runtime,readiness}.ts; harness/delivery-tools.ts; runners/supervisor.ts finish/stage guards; MCP delivery controls and existing new tests.
- Owns (may edit): docs/working/supervised-delivery-v2/reports/delivery-acceptance-integration-review.md only.
- Must not touch: source/tests/shared docs, validation snapshot, configs, commits/pushes.
- Definition of done: Trace default full lifecycle plus repair/rejection, dirty/revision races, model self-authored receipts/waivers, stale Lab evidence, independent acceptance and runtime/persistence mapping. Report concrete severity/file/line/repro and tested vs inferred. Do not spend provider quota or require unavailable Docker. Return findings promptly for root fixes; no speculative broad refactor.
- Report to: docs/working/supervised-delivery-v2/reports/delivery-acceptance-integration-review.md

### 2026-10-23 — Second implementation checkpoint and regression integration
- Agent: supervisor; workers harness-v2, delivery-contracts, brain-performance.
- Changed: real evaluator review and immutable snapshots; genuine Docker journey adapter with current runtime binding; memory/cache/native tool gaps; global Brain preferences and historical context receipts; defaults/presets/charters/docs; durable delivery history, original-goal/criterion protections and CLI actor authority.
- Validation: independently observed router typecheck and recursive typecheck passes; focused repair/budget/team/CLI 44/44; product/MCP lifecycle 5/5; protected evaluator rename 1/1; default delivery pipeline 1/1. Initial checkpoint panel build and production Brain/tasks/knowledge HTTP200 screenshots inspected with zero browser errors. Workers report P8 30/30, evaluator 35/35 plus reviewer/cache/native-memory 14/14, runtime 47/47 plus real static Chrome smoke; these reports are not release-wide acceptance. Initial snapshot full suite still running, exposing regressions now fixed or under focused confirmation. Initial old-snapshot demo seed failed three nested-team assertions after prompt-ordering regression; rerun required on new snapshot.
- Outcome: Partial.
- Follow-up: checkpoint stable source, run complete build/full suite and latest production panel/API/browser acceptance; preserve genuine Docker prerequisite blocker and missing real-provider pilot.

### Brief: client-supervision-regressions
- Repository: D:/SwitchYardRouter-delivery-v2
- Task: Diagnose full-suite client-supervision regressions and fix actual narrow-policy write behavior, preserving unrelated YAML and new default FINAL/delegated guidance.
- Required reads: Current State above; src/admin/client-supervision.ts, src/mcp/client-supervision.ts, tests/client-supervision.test.ts (under packages/router).
- Owns (may edit): packages/router/src/admin/client-supervision.ts, packages/router/src/mcp/client-supervision.ts, packages/router/tests/client-supervision.test.ts; own report.
- Must not touch: other files, shared documents, source tools.ts, runtime config, commits/pushes.
- Definition of done: Reproduce reported failures: default narrow-write preservation and stdio/http initialization assertion for original final-responsibility wording. Fix product behavior if broken; update obsolete assertions only when intentional new behavior, never weaken authority checks. Run selected tests against built current router if subprocess dist needed, coordinate root before build.
- Report to: docs/working/supervised-delivery-v2/reports/client-supervision-regressions.md

### Brief: delivery-v2-authored-docs
- Repository: D:/SwitchYardRouter-delivery-v2
- Task: Update current authored user docs for implemented delivery v2 defaults and controls.
- Required reads: Current State above; docs/roles.md, docs/setup.md, docs/operations.md; relevant config/schema.ts and implementation reports only to verify documented APIs.
- Owns (may edit): docs/roles.md, docs/setup.md, docs/operations.md, packages/router/examples/CLAUDE.delegation.md; own report.
- Must not touch: source, tests, generated presets, shared working docs, README/handoff; never commit/push.
- Definition of done: Explain FINAL plus delegated supervisors, spec/evidence gates, explicit quality evidence setup (no vendor-name inference), 600/80/80 budgets/extensions, defensive batched tools/timeouts, typed memory and Brain controls, CLI explicit --human; distinguish real Docker capability unavailable from tested contracts. Remove contradictory old defaults in owned docs. Verify every stated contract against actual source, link references, report gaps. No promises of usable apps from builds alone.
- Report to: docs/working/supervised-delivery-v2/reports/delivery-v2-authored-docs.md

## Open Questions

No design decision blocks the verified source release. FINAL owns the remaining physical
Docker/Linux acceptance and qualified live-provider pilot; these need an available engine/image,
current quality evidence and an explicit pilot spending policy. Cold initial-index optimization
and controlled large-corpus browser measurements remain open. Unknown model capabilities never
become guaranteed facts or permission to spend.
