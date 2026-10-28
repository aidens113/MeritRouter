# Gate 2 integration acceptance
Status: Active
Status detail: Supervisor independently testing the retained integration fix before a new Facebook pilot.
Created: 2026-10-28
Last updated: 2026-10-28
Owner: Senior supervisor agent
Scope: Verify service-enforced integration and retry the Facebook MVP through MeritRouter without authoring application source.
Paired document: none
Related: [production readiness](production-readiness.md)

## Current State

User requested repeated end-to-end Facebook MVP builds through supported controls, with no application code authored by the supervising agent. Retained integration changes were preserved and reviewed. Worker repaired failure/timeout dependency release and finish/redelegation race. Root independently observed recursive typecheck/build PASS, job-auto-integration 8/8 PASS (55.62 s), dependent-review-source 22/22 PASS, team-nesting 7/7 PASS and supervisor-lifecycle 46/46 PASS. Full-suite results and serial reruns are recorded below; no wholly-green aggregate claim.

Full suite finished 2413 passed / 7 failed / 5 skipped in1947.87s; all five failing files subsequently passed serially, 36/36 in263.52s, with unchanged assertions/deadlines. Root launched fresh pilot `t_0mvsovety5bfa4069dc69` through CLI and observed running; worker PID8420 (foreground exec73526). Pilot pool:400 new requests, free only, prior usage retained. Panel4477 runs rebuilt source; overview/list/old-job HTTP200. Configuration SHA256 remains 9BBEC711E4B3501ECE3206776A57CFB582B3CAD5F61E7500847D74C5C64F4BA6; canonical project HEAD a63e3be664d0b7fa94d7480723f119271e272284 at launch. No D:/MeritRouter/.MeritRouter directory. Final acceptance remains open: exact integrated source, seed/test/build, browser journeys, persistence and canonical delivery; compilation alone is insufficient.

Acceptance checklist: clean install; seed five users; wrong-password refusal; signup/login/logout/session isolation; text posts/newest-first feed; like/unlike and comments; own bio editing/other-user restrictions; people search and friend request send/accept/decline; notifications/unread count; desktop/mobile screenshots and overflow; restart preserves data; exact tested revision and reproducible README startup. Tests execute against an OS-temp copy with its own SQLite data, not the user's project data. Routine live pilot operation is authorized by this prompt; destructive/fault tests remain isolated.

## Worker Briefs

### Brief: integration-review
- Repository: D:/MeritRouter, existing checkout only.
- Task: Read-only review of the retained service-enforced integration fix for pilot safety.
- Required reads: this Current State; git diff for src/harness/delivery-tools.ts, integration-tools.ts, supervisor-tools.ts, src/runners/supervisor.ts, src/storage/tasks.ts; src/storage/integration-obligations.ts; tests/job-auto-integration.test.ts.
- Owns (may edit): docs/working/gate2-auto-integration/reports/integration-review.md only.
- Must not touch: source, tests, configuration, runtime state, application projects, commits or providers. Do not run tests while supervisor validation runs.
- Definition of done: report concrete blockers in acceptance/integration ordering, dependent source selection, failure handling and finish gating, with file references; distinguish unverified claims.
- Report to: docs/working/gate2-auto-integration/reports/integration-review.md.

### Brief: integration-failure-repair
- Repository: D:/MeritRouter, existing checkout; preserve retained edits.
- Task: Reproduce and repair the two blockers in reports/integration-review.md; framework only.
- Required reads: Current State, review report, integration-review named files; relevant merge-queue/context source only as needed.
- Owns (may edit): packages/router/src/storage/integration-obligations.ts, packages/router/src/storage/tasks.ts, packages/router/src/runners/supervisor.ts, packages/router/src/harness/integration-tools.ts, packages/router/tests/job-auto-integration.test.ts, docs/operations.md; report below. Context/upstream.ts and tests/dependent-review-source.test.ts are permitted only if essential to a minimal source-binding repair.
- Must not touch: application projects, config/runtime, other files, shared docs, commits/pushes/providers. No alternate checkouts.
- Definition of done: failing regression first for integration failure/timeout and conflict-created child at finish; enforce accepted upstream integration before dependent release; keep redelegated obligation until replacement is integrated or original explicitly rejected; recompute active children after drain. Preserve recovery, strict acceptance and existing successful integration. Run focused tests serially after supervisor typecheck completes (ask supervisor for clear if needed).
- Report to: docs/working/gate2-auto-integration/reports/integration-failure-repair.md with exact commands/results and limits.

## Work Ledger

### 2026-10-28 — Resume pilot acceptance
- Agent: supervisor
- Changed: created this record and read-only review brief.
- Why: latest handoff records failed pilot and unfinished integration fix.
- Validation: initial process inventory found no live panel/worker; focused test run started, outcome pending.
- Outcome: Partial
- Follow-up: observe tests and review before activating retained build.

### 2026-10-28 — Failure-path regressions reproduced
- Agent: supervisor; worker integration_review
- Changed: assigned framework-only repair after independent static review.
- Why: timeouts/failures released dependencies; finish could miss conflict-created child.
- Validation: supervisor observed initial `pnpm exec vitest run tests/job-auto-integration.test.ts --maxWorkers=1` -> 3 passed, 46.26 s; `pnpm -r typecheck` -> router and panel Done. Worker reports new regressions red (6 failed/2 passed); supervisor independent rerun pending.
- Outcome: Partial
- Follow-up: verify repaired failure paths. Additional root source review found replacement receipt alone cannot retarget original dependency's context; original dependent must stay blocked unless explicitly rebound through supported re-delegation or a validated source-binding change.

### 2026-10-28 — Integrated build and full-suite observation
- Agent: supervisor
- Changed: independently reviewed repaired source, built router/panel and started authorized panel4477.
- Why: validate retained integration change before spending a fresh pilot budget.
- Validation: `pnpm -r typecheck` PASS; `pnpm -r build` PASS; `pnpm exec vitest run --maxWorkers=4 --reporter=default --reporter=json --outputFile=<OS temp>/meritrouter-gate2-full-tests.json` -> 2413 passed / 7 failed / 5 skipped, 219 passed files / 5 failed / 1 skipped, 1947.87s. New job-auto-integration 8/8, team-nesting 7/7, dependent-review-source 22/22 PASS. Failed files: admin-promotions, task-lab-caller, verification-calibration, resilience, roadmap-team. Serial rerun of all five started, pending.
- Outcome: Partial
- Follow-up: observe serial reruns; preserve full-run failure evidence. Config hash unchanged; overview/list/old-job HTTP200; no new model job yet.

## Open Questions

- None requiring user input before isolated validation.
