# Report: team-correctness

## Outcome
Done: E1 failures reproduced before fixes; scoped delegation, retained batch outcomes and external context pass affected tests and router typecheck. Supervisor integration/recursive acceptance remain separate.

## What changed and why
- Work isolated in `feat/roadmap-team` worktree. Supervisor additionally authorized `core/executor.ts` and `runners/supervisor.ts`; no other worker owns those files.
- New `harness/task-scope.ts` recovers ancestor restrictions, including pre-fix persisted sub-jobs, validates requested scopes, and proves conservative narrowing. `supervisor-tools.ts` preserves/inherits sub-job scope, refuses wider descendants in delegate/plan_work, restricts repository aliases to the parent, and records actual scope in briefs. `runners/supervisor.ts` enforces scope in edit tools and checks committed, dirty and untracked paths before reporting. Violations produce scopeViolation evidence refused by integration even with accept:true.
- `runners/batch.ts` carries validated completions through later errors, with unfinished IDs including later chunks. `core/executor.ts` gives pending members the original failure/cancellation disposition, then sends completions through normal verification, persistence and session termination. Later request attempts attach only to participating members, preserving first-completed attribution and charging.
- `runners/coding/index.ts` includes explicit inline/file/artifact sources alongside upstream results in TASK.md. Writable file slices come from the actual isolated base; read-only repository sources are supplied despite those repositories being unavailable inside the external workspace. Loading precedes gateway startup so context errors cannot leak the gateway.
- New `tests/roadmap-team.test.ts` covers persisted ancestor recovery, conservative glob narrowing, actual nested delegation/direct-edit enforcement, command-escape integration refusal, completed sibling/session/usage/routing preservation, and a real external fixture process reading all explicit context kinds. Temporary fixtures only; no user state or real providers.

## Commands run and observed results
- `pnpm install --frozen-lockfile --offline` passed in 3m29s; prebuild CLI bin links warned because dist does not exist yet.
- Baseline `pnpm exec vitest run tests/roadmap-team.test.ts --maxWorkers=1`: four failures reproduced (lost sub-job allowedPaths, missing completed sibling after later failure/cancellation, missing inline context in external TASK.md).
- First fixed run: 4/4 passed (10.98s); `pnpm --filter switchyard-router typecheck` passed.
- Affected six-file run: 45/46 passed (53.58s), all existing execution/team/supervisor/coding tests passed; newly extended command-escape test used a shell-syntax command prohibited by the command tool. Replaced probe with an allowed configured fixture script. Probe also motivated checking dirty/untracked supervisor worktree paths, not only committed HEAD changes.
- Final `pnpm exec vitest run tests/roadmap-team.test.ts tests/execution.test.ts tests/team-nesting.test.ts tests/team-graph.test.ts tests/supervisor.test.ts tests/coding.test.ts --maxWorkers=2`: 47/47 passed, six files, 66.18s.
- Final `pnpm --filter switchyard-router typecheck`: passed. No commits/push; edits frozen for supervisor review.

## Not verified
- No recursive build, full repository suite, panel or live-provider acceptance run by this worker.
- Hard process death between an accepted batch response and executor persistence still relies on existing re-run recovery. This retains completions across ordinary thrown errors/cancellations, not a new incremental crash-persistence protocol.
- Supervisor commands remain trusted configured commands in isolated worktrees. Shell scope violations are detected in resulting evidence and blocked from integration, rather than operating-system sandboxing.

## Open questions or contradictions found
- Arbitrary glob subset equivalence is unsafe to infer. Proven narrowing supports literal files, identical patterns and literal directory/** parents; unprovable subsets must be narrowed explicitly rather than silently broadened.
- Supervisor should update authored roles/operations docs for inherited sub-job scope and external TASK context when integrating; shared docs were explicitly outside worker ownership.
