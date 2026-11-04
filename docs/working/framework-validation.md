# Framework repair and validation
Status: Complete
Status detail: Framework checks pass and coherent runtime commit e235983 is published to dev and main.
Created: 2026-11-03
Last updated: 2026-11-03
Owner: Senior supervisor agent
Scope: Integrate and verify retained framework changes without publishing private application state.
Paired document: none
Related: [operations](../operations.md), [setup](../setup.md), [working document protocol](agent-working-doc-protocol.md)

## Current State

The existing checkout contains a connected set of routing, qualification, admission,
recovery, service-lifecycle, panel and demo changes. Their public interfaces and new
modules must be integrated together. Licensing, package-publication metadata and
development-instruction changes are separate work and are excluded from this unit.

Completed checks include recursive typecheck/build, a full fake demo seed and a production
browser audit with 54 HTTP/navigation checks, 34 screenshots and no browser errors.
All owned demo services stopped. The demo did not demonstrate review-cache reuse:
the two reviews had distinct verification contracts.

A complete baseline router run finished with 3,129 passing, 11 failing and 5 skipped tests
across 266 files. All 1,850 source/test/build file identities remained unchanged during
that run. This was a failed aggregate, not a green result. Its three failing files now
pass together, 38/38, after correcting test environment and fixture lifetime handling.

The resumed investigation also found and corrected immediate key-health cache invalidation
and mismatched path selection between editing and recovery proof. The latter was reproduced
through actual edit journaling and resume, then verified by 109/109 focused tests.
Continuation authority and linked-session initialization fixes pass 250/250 focused tests.
Final recursive typecheck and build also pass on the repaired source. The final complete
regression passed: 265 files passed and one skipped; 3,190 tests passed, five skipped,
zero failed, exit0 in 3,984.81s. All 1,850 source/test/build identities were unchanged.
The lead independently inspected logs, JSON, exit status and the identity comparison.

No live-provider or downstream application acceptance is established by these framework
checks. Private application state and detailed local execution history remain outside
this public validation record. Runtime commit `e235983` was pushed to `dev` and `main`;
both remote branches and the local branches were verified at that commit. Unrelated
licensing, development-instruction and private-history changes remain local and unstaged.

## Changes and invariants

- Retained runtime closure includes ranked supervisor qualification/routing, budget and
  reserve enforcement, scoped lifecycle/Knowledge access, Models query performance,
  continuation and source-recovery controls, request lifecycle views and demo fixtures.
- Vault mutations invalidate both installation and split-host health caches immediately.
  This does not reset provider breakers, request accounting or spending limits.
- Legacy editing and recovery share the exact supported path-alias selection. Unknown
  fields cannot prove authorship of a different file; conflicting aliases are refused.
- Required blocked continuation authority is checked for the current claim before routing.
  Linked-session initialization failures must settle without dispatching a fresh runner,
  while ordinary interrupted-session fallback remains available.
- Native service tests use the same minimal environment as real callers. A direct Windows
  helper launch with an empty environment reproduced a Node cryptographic-startup abort;
  adding only `SystemRoot` made the measured probe start successfully. No generic helper
  environment policy was broadened.
- Panel tests await owned child-process closure before removing fixture directories and
  await a previously unobserved revival promise. The original isolated initial-readiness
  failure's cause remains unproven; that case passes in the corrected focused group.

## Validation environment and sequence

Checks use the existing checkout and isolated temporary fixtures, never user configuration
or data. The validated command runtime is portable Node 22.23.4 with the existing pnpm
installation and a process-local child `PATH`. The installed Node version and machine
settings are unchanged. Earlier recursive builds under installed Node 22.11.0 exited with
a native access violation without compiler diagnostics; the precise cause was not proven.

1. Finish focused continuation regressions, including malformed explicit directives and
   ordinary-resume compatibility controls.
2. Run `pnpm -r typecheck`, then `pnpm -r build`; inspect both router and panel output.
3. Freeze source/tests/build outputs and run the complete router suite with two workers,
   JSON/full-log capture and before/after content identities. Resolve demonstrated failures.
4. Review an explicit runtime file whitelist and generic documentation hunks. Include every
   required new module; exclude private history and unrelated licensing/instruction edits.
5. Commit and publish only the coherent validated framework unit under repository policy.

## Worker Briefs

Completed work was partitioned by owned files; the lead independently read the relevant
source and actual test output. Raw reports and execution artifacts remain local. Worker
roles used GPT-6.1 Sol at medium effort for validation/fixture work and max effort for
the critical provenance and continuation review/fix work.

### Brief: final framework validation
- Role/model/effort: Worker `regression_resume`, `gpt-6.1-sol`, medium.
- Task: After explicit lead release, run serial recursive typecheck/build and final full router regression.
- Owns: Temporary execution scripts/logs/manifests and its existing local report only.
- Must not touch: Source, tests, private application state, Git index/refs, providers or machine settings.
- Definition of done: Exact exits, complete counts/failures/skips, inspected output, stable content identities and owned-process inventory.
- Constraints: Portable verified runtime; no concurrent heavy checks, speculative repairs, weakened assertions or interrupted-green claims.
- Report: Lead records independently checked results in this document; raw evidence remains in OS temporary storage.

### Brief: prepare integration manifest
- Role/model/effort: Worker `panel_lifecycle_diagnosis`, `gpt-6.1-sol`, medium.
- Task: Prepare an exact proposed file whitelist for the already reviewed coherent runtime unit, while final regression runs.
- Owns: Local report `trial-failure-audit/reports/integration-manifest.md` and temporary manifest only.
- Must not touch: Source/tests/build outputs, Git index/refs, shared documents, runtime application or providers.
- Context: Read `trial-failure-audit/reports/resume-retained-integration-review.md` and `integration-evidence-boundary.md`; existing closure review is authoritative scope, not a new broad audit.
- Acceptance: Enumerate exact whole-file paths and separate partial README/index/handoff hunks; list exclusions; verify excluded package/build edits have no runtime dependency effect; identify dangling public links from proposed docs.
- Report: Return exact manifest paths, counts and any concrete closure issue; no staging, commits, tests or build.

## Work Ledger

### 2026-11-03 — Vault health and completed repair coverage
- Agent: Lead; workers `resume_router` and `resume_recovery`.
- Changed: Gateway/service/admin key invalidation and focused key tests; expired FINAL-repair regression and operations documentation.
- Why: Newly added keys remained hidden behind cached health; completed repair needed explicit elapsed-deadline coverage.
- Validation: `pnpm exec vitest run tests/providers-routing.test.ts tests/admin-keys.test.ts --maxWorkers=2` → 28/28 passed, 65.25s.
- Validation: `pnpm exec vitest run tests/rejected-delivery-repair.test.ts tests/task-deadline-continuation.test.ts tests/task-maintenance-continuation.test.ts --maxWorkers=2` → 76/76 passed, 53.07s.
- Outcome: Accepted.
- Follow-up: Final combined source verification.

### 2026-11-03 — Build and demo baseline
- Agent: Lead; validation workers.
- Changed: No machine-wide runtime/dependency settings; isolated portable validation runtime and temporary evidence only.
- Validation: `pnpm -r typecheck` → passed in 16.994s; `pnpm -r build` → router and panel passed in 78.788s under portable Node 22.23.4.
- Validation: `node apps/panel/scripts/seed-demo.mjs` → exit0; temporary expanded production-browser audit → 54 checks/34 screenshots/zero browser errors, owned services stopped.
- Outcome: Accepted for that baseline.
- Follow-up: Repeat recursive checks after subsequent source repairs; no cache-reuse claim.

### 2026-11-03 — Complete baseline and fixture repairs
- Agent: Lead; workers `regression_resume` and `panel_lifecycle_diagnosis`.
- Changed: Three test files' Windows environment and owned-process lifetime handling; no product lifecycle changes for these failures.
- Validation: `pnpm exec vitest run --maxWorkers=2 --reporter=default --reporter=json --outputFile.json=<temporary-result>` → exit1, 3129 passed/11 failed/5 skipped, 3825.81s; all 1850 identities unchanged.
- Validation: `pnpm exec vitest run tests/service-panel-lifecycle.test.ts tests/operations-panel.test.ts tests/project-metadata-lab.test.ts --maxWorkers=2` → 38/38 passed, exit0, 56.34s; no owned Node/helper processes remained.
- Outcome: Partial: focused failures corrected, final full run pending.
- Follow-up: Final aggregate; retain original failed evidence.

### 2026-11-03 — Exact path attribution
- Agent: Lead; worker `provenance_review`.
- Changed: Shared native path selector, recovered-edit proof and tool consumer; 18 real-tool/journal/resume regression cases and operations documentation.
- Validation: `pnpm exec vitest run tests/recovered-edit-provenance.test.ts --maxWorkers=2` → before fix, 27 passed/14 failed in 147.70s, including both wrong-file acceptance reproductions.
- Validation: `pnpm exec vitest run tests/recovered-edit-provenance.test.ts tests/native-edit-projection.test.ts tests/hash-bound-line-edits.test.ts tests/harness-v2.test.ts tests/session-resume.test.ts --maxWorkers=2` → 109/109 passed, exit0, 150.15s; target identities unchanged during checks.
- Outcome: Accepted for focused behavior.
- Follow-up: Recursive checks and final full suite.

### 2026-11-03 - Continuation authority and final recursive checks
- Agent: Lead; workers `budget_boundary_review` and `regression_resume`.
- Changed: Current explicit-resume authority, linked-session initialization settlement and five regression files; operations contract documentation.
- Validation: `pnpm exec vitest run tests/blocked-job-continuation.test.ts tests/task-maintenance-continuation.test.ts tests/task-deadline-continuation.test.ts tests/supervisor-stall-recovery.test.ts tests/supervisor-budget-continuation.test.ts --maxWorkers=2` -> 250/250 passed, exit0, 138.56s; seven target identities unchanged.
- Validation: `pnpm -r typecheck` -> router/panel passed, exit0, 14.06s; `pnpm -r build` -> router/panel passed, exit0, 39.32s. Lead inspected actual logs and execution result.
- Outcome: Focused and recursive checks accepted; final full regression launched with frozen source/tests/build outputs.
- Follow-up: Inspect complete aggregate, identities and process cleanup before integration.

### 2026-11-03 - Complete final regression
- Agent: Lead; worker `regression_resume`.
- Changed: No source/test/build files during validation; integration manifest and generic documentation prepared separately.
- Validation: `pnpm exec vitest run --maxWorkers=2 --reporter=default --reporter=json --outputFile.json=<temporary-result>` -> exit0, 265 files passed/one skipped; 3190 tests passed/five skipped/zero failed, 3984.81s.
- Validation: Compared all 1850 before/after source/test/build identities -> zero differences; manifests byte-identical. Worker reported no retained owned Node/helper processes; lead checked the process inventory too.
- Outcome: Complete aggregate accepted together with recursive and demo/browser checks above.
- Follow-up: Review/stage exact runtime manifest and public documentation sections; publish only this coherent unit.

## Open Questions

- No open framework integration step. Downstream live repair and application acceptance are separate work; this record establishes neither.
