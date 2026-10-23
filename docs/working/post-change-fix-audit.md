# Post-change fix audit
Status: Superseded
Status detail: Accepted fix plan implemented and validated in correctness-and-panel-flows.md; audit evidence below is historical.
Created: 2026-10-23
Last updated: 2026-10-23
Owner: Senior supervisor agent
Scope: Correctness and release planning for current dev integration and uncommitted live-run fixes.
Paired document: none
Related: [handoff](handoff.md), [roadmap](roadmap-completion.md), [live validation](live-validation.md)

## Current State

Implementation and latest acceptance are owned by
[Correctness and panel flows](correctness-and-panel-flows.md). F1-F6 were executed with the
expanded user security/UX requirements. The original findings and baseline measurements below
are retained as audit evidence, not a description of the current candidate or live deployment.

Audited dev 371875a plus the existing 28 modified tracked files and untracked readonly-checks test.
The dirty changes implement repeat suppression, read-only declared checks, scheduler restart,
artifact line evidence, provider-plan failure classification and serialized delegation arrays.
No product code was changed by this audit. No real providers, live configuration/store, panel
processes or downstream repositories were operated. Temporary fake-tool/test probes were removed.

**Observed validation:** recursive typecheck passes. Focused seven-file Router run: 83 passed,
1 failed, 68.52s. The failing readonly-checks third test reproduces alone. A temporary fake-tool
probe reproduces stale task_result after await_tasks and subsequent false stalled termination.
Native, budget-control, execution, scheduler-async, project disposition and verification-review
focused suites pass. This is not full release acceptance; no fresh build/browser/package run.

**Fix first:** F1 mutable-state repeat handling; F2 read-only check command authority/isolation
and revision binding. Then F3 evidence recovery/preservation, F4 deterministic regression fixture,
F5 cache-metric presentation and F6 frozen-candidate acceptance/document reconciliation.
F1/F2 are release blockers for these new features. Do not restart another clone job as acceptance
until their isolated checks pass. Do not add a job-wide request cap as a substitute for progress logic.

**Separate next work:** supported uncertain-request recovery (durable ownership and conservative
financial holds), canonical session writer/effect authority, Compose lifecycle, native browser
isolation and PostgreSQL/two-host support. These are unfinished work, not all new regressions.

Existing working documents disagree about acceptance/deployment. Live-validation reports a newer
1096-pass/2-skip run and then later changes with full validation pending; the integration worker's
1083-pass/2-fail snapshot is historical, not the latest evidence. Neither accepts the current dirty
candidate, which demonstrably has a failing focused test. Current panel/MCP versions were not
inspected; do not infer live process version from source or old PIDs. HEAD 371875a is an empty
commit despite its clone-workspace title; it added no downstream files.

## Findings and implementation phases

### F1 - P1: repeat policy mistakes mutable state for a stable snapshot

Evidence: harness/loop.ts:278-311 caches all tool results by name/arguments, invalidating only
successful local edit/command calls. supervisor-tools.ts:655 task_result, channel reads, brain
reads/access status and Lab status/logs can change independently. Awaiting completion does not
invalidate them. Supervisor probe: task_result returns running; await_tasks changes state to
completed; identical task_result still returns running; third read produces stalled. One real
read executed. No model/provider involved.

Implement in harness/{loop,tools,supervisor-tools,channel-tools,budget-tools}.ts and labs/tools.ts:
- Define explicit semantics for immutable snapshot reads, live reads, bounded commands and
  externally mutating actions. Fresh-state tools must actually re-read authoritative state.
- Repair check -> Lab restart -> same check/HTTP GET workflows; distinguish GET/HEAD from
  mutating HTTP. Preserve duplicate-side-effect protection and existing run limits.
- Do not cache every error permanently: allow bounded safe transient retries, while keeping
  unknown external effects under reconciliation. repeatBehavior execute currently excludes
  previous failures, so a metadata-only fix is insufficient.
- Add native/supervisor/channel/Lab regressions for changing state, denied-then-approved reads,
  transient failures, repeated side effects, canonical JSON and final-request terminal-only tools.
- Preserve stalled result propagation and bounded no-progress termination. Reset/rebuild state
  appropriately on resume; do not invent successful outcomes for actions that were not executed.

### F2 - P1: read-only check authority and source identity are not enforced

Evidence: runners/readonly.ts:39-55 sets cwd to configured repository root; harness/tools.ts:270
uses shell:true. core/validate.ts:55-60 permits this without writable authority. A check's exact
string is not an OS read-only boundary; supervisors can author child checks. Scope/protected
path verification is not applicable for this mode. This is source-confirmed, not a destructive
probe against real data.

Implement a service-enforced command-authority contract in core validation and supervisor
brief inheritance, with read-only runner/tool integration. Prefer narrow built-in runtime probes
as the initial bounded feature; generic source checks require enforced containment with immutable
source and isolated scratch, rather than shell filtering or after-the-fact mutation detection.
Reuse an accepted isolation service only if it actually supplies those guarantees; ordinary Git
worktrees alone do not contain host writes. Keep generic checks unavailable when guarantees fail.

Pinned reads use context.baseCommits in context/sources.ts:43-49, but checks execute current
working tree and record no revision. Bind source checks/logs to the same snapshot and verify
identity in verification/checks.ts; distinguish runtime observations from source-revision checks.
Tests: read-only repo/host sentinels unchanged, child cannot widen parent authority, package
script writes contained, commit A fails/B passes while task pins A, restart/source-change
invalidates old evidence. Update roles/operations/charters to match actual check semantics.

### F3 - P2: check evidence is lost on resume and some failure paths

Evidence independently traced: readonly.ts:34-47 reloads checkResults but never registers their
logRefs in its new evidence universe; harness/resume.ts:48-91 has no run_check restoration case.
A completed command in the transcript can become uncitable after interruption. Events are read
only from the most recent 1000 mixed task events. Budget-exhausted/invalid-output result branches
omit checks, though terminal/stalled branches retain them.

After F2 fixes the record shape, implement validated check-event/artifact restoration with exact
line bounds, direct bounded event paging/filtering, authoritative task/session/source scope,
and checks in every outcome's common result fields. Share restoration with native workers where
appropriate. Tests: interrupt after check, submit old artifact#L4 with no rerun; >1000 unrelated
events; corrupt/foreign/missing artifact refusal; passing/failing checks retained after exhaustion
and invalid output. Preserve execution counts and distinguish unavailable evidence from not_run.

### F4 - P2: current regression fixture cannot reach its expected fifth turn

Reproduced: readonly-checks.test.ts:98-134 expects five model requests and repeated_tool_call,
but default inspect profile AND T1 tier caps are four (helpers.ts:59, config/schema.ts:98).
Task budget.maxModelRequests:6 only narrows policy; it cannot widen those caps. A temporary
budget-only increase to12 still failed (effective cap8 after retries); profile-only increase
also failed because the T1 cap remained. This is a fixture defect, not evidence budgets should
be loosened in production. Configure both profile and tier/forced difficulty explicitly for the
five-turn scenario and supply adequate total execution/review allowance. Assert no escalation,
exact physical command count and five-turn behavior. A temporary probe raising both inspect and T1 caps to8 passed this exact test (1 pass,2 filtered skips,3.34s); the original file remains unchanged. Keep separate low-budget/final-tool tests.
This test update follows the final F1 command policy; do not preserve a stale cache expectation
if commands are meant to execute freshly under their own limits.

### F5 - P2: unknown cached tokens are rendered as zero

Evidence: storage/usage.ts:81-86 sets aggregate cachedInputTokens null if any row has unknown
cache usage, while subtracting known cache hits on other rows from uncached input. Panel
components/task-detail.tsx:271 prints cachedInputTokens ?? 0. Thus total1000, known cached200
plus unknown rows can display new800 / total1000 / cached0. This explains a possible mechanism
for the recorded live discrepancy; the exact historical rows were not inspected.

Preserve unknown versus measured zero in DTO/UI/CLI summaries; define partial-known totals and
labels consistently rather than fabricating cache counts or changing billing. Test mixed unknown
and known cached records, batches, failed requests and all-known reconciliation; production-demo
browser acceptance required for presentation changes. Own storage/usage.ts, affected admin DTOs,
panel task usage and CLI formatting plus providers-routing/new named usage tests.

### F6 - release gate and current-state documentation

After F1-F5 freeze a coherent candidate and run:
1. Focused native, budget-control, read-only, policy/evidence, sessions/resume, team/channel,
   Labs, provider disposition, scheduler and usage tests. Inspect actual output.
2. pnpm -r typecheck; pnpm --filter switchyard-router build; full Router vitest run
   --maxWorkers=2 --minWorkers=2 (historical retention test timed out with default concurrency).
   Explain all skips and repeat only new failures/changed code.
3. pnpm -r build. For panel changes seed demo, serve production on spare port, request touched
   pages/APIs and inspect desktop/phone screenshots, then stop owned process.
4. Fresh outside-checkout package installation using temporary config; CLI/MCP and bundled
   panel startup/cleanup. Do not publish npm or change live services as part of offline acceptance.
5. Reconcile handoff/roadmap/distributed/live-validation Current State: source SHA, dirty status,
   last observed deployment, accepted commands and truly unfinished phases. Compact overlong
   documents under the protocol before restructuring them; preserve old evidence in archives.

## Dependencies and later work

Execute F1 and F2 first; both touch harness/tools.ts, so serialize that file. F3 follows the
new F2 evidence contract; F4 follows F1. F5 can be independently briefed by file. Supervisor owns
integration and frozen-tree verification. Do not run broad validation against a moving tree.

Next operational feature: strict uncertain request holds intentionally survive task expiry and
can block capacity/project deletion (gateway/capacity.ts:134,328-337;
admission/request-receipts.ts:102-105). Implement the existing operator-recovery design with
trusted process-birth/invocation/cohort proof and receipt-backed local retirement, preserving
financial uncertainty. Never solve by TTL, database deletion or ordinary release. Acceptance:
kill/ACK-loss/PID reuse/foreign scope/late settlement/replay and accounting invariants.

Session authority remains a design: recorder.ts:237-239,274-289 has per-instance sequencing and
JSONL-before-index persistence. Implement canonical DB events/receipts and generation-bound
writers, awaited runner shutdown, then effect and artifact authority. Concurrency/crash tests
must pass before claiming remote-safe execution.

Compose provides validation/sealed plans, not transport/journal/coordinator. Native hydration
is disabled; prepared Chrome tools do not solve the proc-ro sandbox conflict. PostgreSQL and
real two-host acceptance are absent. Keep these separate feature phases, assign fresh migration
ownership, use fakes before disposable infrastructure, and retain disabled runtime gates until
acceptance. See integration report for precise source anchors and existing design references.

## Worker Briefs

Workers audited source only and owned distinct report files; no shared source edits or commits.
- harness-audit: harness repeat/delegation/budget and runner propagation; required current state,
  harness named files and affected runners; owned reports/harness.md only.
- readonly-audit: runner/core validation/evidence/verification and relevant tests; owned
  reports/readonly.md only.
- integration-audit: recent history, roadmap/distributed Current State and latest relevant source
  and reports; owned reports/integration.md only.
All briefs prohibited product/test/shared-document/Git/live-data mutations and provider calls;
definition of done was source-backed prioritized findings with triggers, fixes and test gates.
Reports: [harness](post-change-fix-audit/reports/harness.md),
[read-only](post-change-fix-audit/reports/readonly.md),
[integration](post-change-fix-audit/reports/integration.md).
Supervisor independently traced the cited primary paths and ran the checks below.

## Work Ledger

### 2026-10-23 - Audit baseline and reviews
- Agent: supervisor with harness_audit, readonly_audit, integration_audit workers
- Changed: this plan, index, handoff pointer and three read-only reports; no product changes.
- Why: user requested review and fix planning after extensive changes.
- Validation: git status/diff/log, source flow and worker report claims independently inspected.
- Outcome: Accepted
- Follow-up: execute F1/F2 before another end-to-end clone acceptance attempt.

### 2026-10-23 - Focused validation and reproductions
- Agent: supervisor
- Changed: temporary test probes removed after inspection; product tree preserved.
- Validation: pnpm -r typecheck -> router/panel Done; npx vitest run tests/native.test.ts tests/budget-control.test.ts tests/readonly-checks.test.ts tests/scheduler-async.test.ts tests/projects-router-fixes.test.ts tests/verification-review.test.ts tests/execution.test.ts --maxWorkers=2 --minWorkers=2 ->83 pass/1 fail,7files,68.52s.
- Validation: isolated readonly-checks third test ->same budget-vs-stalled failure; temporary fake-tool stale-read probe ->1/1 pass reproducing defect. Budget/profile-only fixture probes still failed; raising BOTH inspect and T1 caps to8 passed the isolated five-turn test. Original test unchanged.
- Validation: git diff --check ->pass (line-ending advisory only). No fresh full suite/build/browser/package run.
- Outcome: Partial
- Follow-up: current candidate is not release-accepted; use F6 after fixes.

## Open Questions

No user input needed to start corrective offline work. Generic read-only command containment
must be settled in F2 before enabling that capability; runtime probes are the bounded fallback.
Real-provider acceptance needs its own stated budget; paid routing remains separately authorized.
