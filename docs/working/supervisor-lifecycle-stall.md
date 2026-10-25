# Supervisor lifecycle stall investigation
Status: Active
Status detail: Lifecycle correction verified; source publication and bounded live reactivation next.
Created: 2026-10-23
Last updated: 2026-10-25
Owner: Senior supervisor agent
Scope: Diagnose and fix pre-plan stalls while preserving human-only command approval.
Paired document: none
Related: [supervised delivery](supervised-delivery-v2.md)

## Current State
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
harness,readonly checks,delivery runtime and rejected repair). No live restart yet.
Need verify persisted plan, dispatch, independent review and product tests; source builds
alone do not demonstrate delivery. Host approval policy must remain intact.

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
## Work Ledger
### 2026-10-23 ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â Live stall reproduced
- Agent: supervisor
- Changed: investigation document only; denied optional node version request through supported API.
- Why: supervisor had no plan and no implementation, waiting on unnecessary host command.
- Validation: CLI job read -> running,16 requests, cancelled env-inspect child; last tool npm run typecheck.
- Outcome: Partial
- Follow-up: trace and repair lifecycle progression rather than approve needless checks.

### 2026-10-25 ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â Resume and implement lifecycle correction
- Agent: supervisor
- Changed: assigned disjoint lifecycle and loop-role workers; no app code edits.
- Why: confirmed PlanStore supports undispatched nodes, but plan_work couples recording and execution.
- Validation: CLI job -> cancelled22requests, both children cancelled; source inspection confirmed current gaps.
- Outcome: Partial
- Follow-up: draft plan support, command/dispatch gates and bounded discovery; independently validate.

### 2026-10-25 — Integrated lifecycle correction verified
- Agent: supervisor
- Changed: worker-owned lifecycle/loop/planning/storage/charter files and proportionate regressions; docs/roles.
- Why: require persisted planning and actual assignment before unrestricted discovery/execution.
- Validation: pnpm -r typecheck and pnpm -r build -> exit0; full vitest ->1392pass/9fail/3skip,525.41s.
- Validation: all8failedfiles serialized ->62/62,299.72s; final7-file delivery/native/harness selection ->49/49,42.59s.
- Outcome: Accepted
- Follow-up: publish verified source, restart bounded free-only pilot and inspect actual plan/dispatch; no clone accepted.
## Open Questions
- Supervisor owns diagnosis and implementation scope after worker report.
