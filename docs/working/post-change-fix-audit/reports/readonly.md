# Report: readonly-audit

## Outcome
Done. Read-only source audit found one containment blocker and three correctness gaps in the new declared-check path. No product files changed.

## What changed and why
Only this report was created to supply fix planning evidence.

### P1 — Read-only declared checks execute arbitrary shell in the real repository
- Location: `packages/router/src/runners/readonly.ts:39-55`, `packages/router/src/harness/tools.ts:270`, `packages/router/src/core/validate.ts:55-60`.
- Trigger: an inspect/analyze/review task declares a mutating command, or declares a package script that writes build/cache/source files. The repo may even be configured `writable: false`.
- Reasoning: validation now accepts checks for read_only mode without writable authority; cwd is `checkReader.root`, the configured repository, and runProcess uses shell:true. Exact-match validation restricts the worker to its brief but does not enforce read-only filesystem access. Supervisor models author child checks at `supervisor-tools.ts:314-348`, so the brief itself is not necessarily human command authorization.
- Consequence: a nominally read-only task can modify user source, .git, or arbitrary accessible host paths; it bypasses coding worktree isolation and allowedPaths. scope/protected_paths checks report not_applicable for this mode.
- Fix: establish explicit command authority inherited from the parent/user and a contained execution service for read-only checks. Execute against an isolated snapshot with enforced read-only source mounts (allow explicitly isolated scratch space for caches). Do not attempt shell-string filtering as the containment boundary. If containment is not ready, restrict this feature to narrow built-in runtime probes.
- Tests: configured read-only repo and files outside it cannot be changed; model-authored child checks cannot expand parent command authority; normal toolchains writing caches cannot mutate user data; no provider calls needed.

### P1 — Checks ignore the pinned source revision
- Location: `packages/router/src/runners/readonly.ts:53`; `packages/router/src/context/sources.ts:43-49`; `packages/router/src/verification/checks.ts:90-95`.
- Trigger: task has `context.baseCommits.core = A`, but configured working tree is B or dirty; declared test reads a file whose content differs.
- Reasoning: RepoReader serves pinned commit A, while run_check executes in the current worktree. The new records have no revision or artifact digest, and read-only outcome supplies no revision, so acceptance classifies exit 0 as passed without comparing source identity.
- Consequence: accepted analysis can mix evidence from A with check output from B. Rehydrated check records can also remain valid after working tree changes.
- Fix: pin and execute checks against the same source snapshot used for reads, persist source identity with records, and invalidate records when that identity changes. Clarify semantics for runtime-only probes versus source checks.
- Test: commit A fails a declared check, B passes, task pins A; the check must fail on A and must not accept B's result. Add restart/change-source regression.

### P2 — Resumed workers lose the evidence universe entry for prior check logs
- Location: `packages/router/src/runners/readonly.ts:34-47`, `packages/router/src/harness/resume.ts:48-91`, `packages/router/src/harness/tools.ts:274-276`.
- Trigger: completed run_check output was journaled; process interrupts before submit_result; resumed model cites its existing log artifact.
- Reasoning: runner reloads checkResults from task events but does not register their logRefs in universe. restoreEvidence handles read_file, brain_read, read_artifact and edits, but has no run_check case. A completed call is not necessarily re-executed. submit_result then rejects the artifact as not provided/read, despite it being in the transcript.
- Fix: validate persisted check events/artifacts and re-register original log line counts during rehydration, ideally in shared evidence restoration. Query check events directly rather than only the last 1000 mixed events.
- Tests: restart after completed run_check then submit original artifact#L4 without rerunning it; accepted, one execution only. Repeat after more than 1000 unrelated events and verify counts/results remain consistent.

### P2 — Failure branches discard check records
- Location: `packages/router/src/runners/readonly.ts:118-121,137-139`.
- Trigger: a task runs a declared check, then exhausts its model request budget or fails output validation.
- Reasoning: terminal and stalled branches copy checks:checkResults, but budget_exhausted and invalid_output branches omit it. baseResult therefore defaults to no checks, even though persistent worker_check_run events and artifacts exist.
- Consequence: task results, downstream consumers and review/verification summaries report checks as not_run and omit useful completed diagnostics.
- Fix: include checkResults in common result fields so every outcome preserves real execution evidence.
- Tests: one passing and one failing check followed by budget exhaustion/invalid output must retain exact records/log refs and keep the correct check classification.

### Documentation correction
`docs/roles.md:81-83` says read-only post-submission checks determine pass/fail. The implementation retains the worker's run and does not independently execute post-submission checks for read_only. Update this statement alongside the final intended design.

## Commands run and observed results
- `git diff --` on the seven brief-named source files: inspected uncommitted implementation.
- `Get-Content` and `rg -n` on those sources, declaredCheckTool, source readers, resume restoration, events implementation, supervisor check dispatch and relevant tests: findings above supported by direct control-flow inspection.
- Existing `readonly-checks.test.ts` has command denial, happy-path artifact#L4 acceptance and repeated-call coverage. It lacks the containment, pinned-source, resume and failure-output cases above.
- No tests executed; this brief requested source audit and prohibited broad validation. Initial attempts to read validate.test.ts/worker-output.test.ts found those filenames absent; policy.test.ts contains existing evidence range tests.

## Not verified
No provider requests, broad validation, live data access, destructive command probes or panel operations. Findings are source-confirmed reasoning, not runtime reproductions. Artifact evidence happy path appears integrated with deterministic checks and review package refs; no independent runtime claim is made.

## Open questions or contradictions found
Read-only command authority and isolation are unresolved product semantics. Exact declared strings cannot make shell execution read-only, especially when a supervisor model generates the strings. Resolve that boundary before treating the feature as safe for user repositories.
