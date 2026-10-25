# Retained failed-candidate repair handoff

Status: Complete (read-only diagnosis)
Worker: repair_context_handoff
Date: 2026-10-25

## Finding

Ordinary `delegate` and `plan_work` cannot express failed-candidate reuse. `dispatchBriefs` in `packages/router/src/harness/supervisor-tools.ts` initializes writable repository bases as HEAD_OF_JOB and resolves them to the actual integration-worktree HEAD before submission. Public brief properties have `file_refs` and `brain_grants`, but no artifact references or source-task repair field. Only the private integration-conflict redelegation seam attaches result patch references through `opts.artifactRefs`.

Consequently the observed core-repair-fix task can accurately describe two defects while still receiving the older818e98d base and none of the previous task's patch. Mentioning task/artifact IDs in goal prose does not grant artifact access: `harness/check-evidence.ts scopedArtifact` requires explicit context grant (or an existing universe grant) for another task's artifact, then independently enforces project scope.

The previous task's unmet status cannot safely be bypassed through integration. `integrationGate` refuses unmet results before merge/conflict handling. Nor can `depends_on` provide repair reuse: `storage/tasks.ts resolveDependencyGates` fails dependents of terminal unsatisfied tasks, even when acceptance is not required. Upstream base choice only operates after that dependency gate.

## Safest existing operations

1. For an internal supervisor remaining inside current supported tools: read the real patch artifact, write bounded actual patch/file content as a project Brain note, then give a NEW repair worker an explicit read `brain_grants` entry and instructions to reconstruct that patch before the two corrections. No false acceptance or integration is required. The note is untrusted reference material; all checks must rerun. Merely mentioning the note without a grant is insufficient.
2. External `submit_tasks` accepts WorkerTask context.baseCommits and artifactRefs, so an explicitly scoped standalone repair can pin the immutable candidate and read its artifacts without changing app code. However attaching a new external task to the existing internal parent requires independent submission-authority/budget review: do not infer permission to bypass internal child grant accounting. This worker did not verify those service boundaries, so this is NOT a recommendation to submit an external child immediately.
3. There is no supported mutation that injects new context into an already-running repair task. Preserve its progress; do not raw-edit stored specs or rewrite worktrees.

## Recommended narrow contract

Add explicit validated `repair_from_task` to implementation briefs (not implicit label matching). Resolve through this supervisor's own-task ownership lookup; require same project, same parent, same writable repository, terminal state, immutable retained commit and proven quiescence/no live operations. Failed source remains untrusted and unmet. Do not accept or integrate it.

The safe minimum version attaches original scoped patch/check artifacts and an authoritative source provenance receipt while keeping HEAD_OF_JOB as base. This avoids transplanting ancestor source outside the new allowed_paths. A direct candidate-base option is more efficient, but must prove the entire retained source delta from job HEAD fits both parent and new child scope, preserve all original attribution, and retain all inherited commits in the eventual integration range. Otherwise a repair based on an unintegrated candidate could omit the original changes from its patch/integration range or silently carry out-of-scope changes.

Normal dispatch must still charge the new finite grant through grantBriefs/recordGrant, preserve paid constraints and require new source-bound checks. Lab-scoped work must use its winning attempt authority or refuse initially. Revalidate source/lease immediately before persisting dispatch; record source task/head/tree/artifact provenance for resume. Scope violations and uncertain retention must fail closed with actionable explanation.

## Proposed validation

- Failed terminal sibling with real patch and two test defects -> granted artifacts accessible, baseline/provenance explicit, no acceptance/integration side effect.
- Non-owned sibling/other project/repository, active source, changed source, out-of-scope source delta and unsupported Lab authority -> refusal before child dispatch/grant.
- New repair grants charge parent once and obey paid0; repeat idempotency does not duplicate children or grants.
- Resume preserves immutable provenance and artifact grant, not a mutable HEAD lookup.
- Direct-base variant, if implemented: final integration includes original candidate changes plus repair with original attribution; checks bind exact combined tree.
- Existing ordinary delegation and integration-conflict redelegation remain unchanged.

## Validation and limits

Read-only source inspection using Get-Content/rg. No tests executed because no production/test edits were made. No live state, app files, configuration or shared working documents changed. No commits. Only this report was written. Root must decide implementation ownership after phased_plan_preservation releases supervisor-tools.ts.


## Follow-up: bounded native workspace hydration

The new live evidence (UI40grant/28execution/zero files despite source notes; API rewriting820lines for one import) makes context-only transfer inadequate. Implement native hydration explicitly; do not add larger prompts as the repair mechanism.

### Smallest viable contract and flow

- Add `repair_from_task` (owned source task ID/label) to supervisor implementation briefs. Resolve through ownTask; forbid read-only/sub-supervisor profiles initially. Draft validation checks shape without mutating workspaces or reserving a source. The authoritative dispatch resolves an immutable source receipt.
- Persist a strict zod-validated internal task context repair descriptor: sourceTaskId/project/repo, source integration base, source candidate head/tree, ordered commit IDs, source patch digest, and current job base. Do not let model-supplied SHA/path data bypass source resolution. Same parent/project/repo; terminal source with retained submitted commit; no active worker actions, unfinished operations, merge activity or Lab uncertainty. Refuse initial Lab-bound sources rather than invent compatible attempt proof.
- Source commits must form a bounded ordinary linear chain from the recorded source workspace base to the immutable head (e.g. maximum100commits and explicit byte/path bounds). Refuse merge commits or missing objects. Require every touched path across EVERY inherited commit (not only net diff) within both parent and new repair scope; handle rename old/new paths, symlinks, submodules and protected paths conservatively. Validate source recorded attribution/trailers, not model claims.
- NEW workspace starts at captured CURRENT job HEAD with `workspace.base_sha` equal to that job commit. Invoke internal `git()` to cherry-pick the explicit validated commit list, in order, `-x --allow-empty`, with trusted committer identity and original authors/messages/trailers preserved. This preserves newly integrated disjoint API work while inheriting UI candidate changes. Never directly check out the older candidate when current job base differs.
- Scope-check every source commit before mutation and final hydrated delta afterwards; inherited evaluator/test changes remain protected changes requiring review, never exempted. No acceptance decision or integration event is written for source. All original failed checks remain historical and all repair checks rerun.
- Before each effect and after each awaited command, call assertRunAuthority; use ctx.signal plus bounded timeout with internal git wrapper. Verify source receipt unchanged/quiescent at dispatch and before hydration; immutable commit objects, never late `HEAD`, drive replay.
- On conflict/abort/timeout: stop before first model request; abort cherry-pick in the NEW owned worktree only if current authority permits cleanup. Mark hydration failed with typed cause and preserve evidence. Do not auto-reset shared/source/job worktrees, fabricate success, or retry indefinitely. An abandoned partial workspace must never enter ordinary resumeWorkspace.
- Persist typed hydration started/completed/failed receipt and task-local output artifact with old->new commit mapping. Completion records integration base, hydrated head/tree and source receipt digest. Resume requires matching completed receipt and matching retained workspace; incomplete receipt refuses or restarts in a NEW workspace from recorded job base, never double-picks commits. Capture session workspace HEAD after hydration (native.ts currently assumes fresh head==base).

### Existing primitives and actual file ownership

1. `core/task.ts`: strict internal repair-context schema.
2. `harness/supervisor-tools.ts`: explicit brief field + authoritative owned-source resolution into dispatch context; preserve grantBriefs/recordGrant, paid policy and exact plan matching.
3. NEW `workspaces/repair-hydration.ts`: bounded provenance/scope resolution and safe replay/receipt logic. This concern belongs in workspaces, not generic helpers or the already large supervisor file.
4. `runners/coding/finish.ts`: call hydration in prepareWorkspace before worktree_ready; keep base unchanged. Existing Worktrees.prepare already separates baseCommit/startCommit for quality retries, but startCommit alone does not merge newer job work.
5. `runners/coding/native.ts`: session pointer records actual hydrated head; check/provide hydration provenance. Resume verifies completion receipt before using prepared workspace.
6. New focused `tests/repair-hydration.test.ts`, plus supervisor lifecycle and coding integration tests. Authored roles/operations docs owned by root. No storage migration required if descriptor is in validated spec context and receipts are task events; event parsing must be strict.

Reusable primitives: workspaces/git.ts invokes execFile without shell, bounded output, AbortSignal and timeout; git-process-policy.ts disables hooks, signatures, executable config, credential/network helpers and cwd redirection. merge-queue.ts already preserves provenance with ordered `cherry-pick -x --allow-empty`. Worktrees.collect diffs against ws.baseSha and integrationTargets enumerates that base..HEAD, so leaving base at current job HEAD ensures ALL hydrated changes remain integrable. Attribution must be verified end-to-end, including empty/redundant source commits and final worker commit.

### Minimum meaningful test matrix

- Source UI candidate + disjoint newer current API integration: hydrated worker sees both, base remains current jobHEAD; repair one import; final patch AND integrate_task include original UI + correction, preserve API and original author/model/task trailers.
- Source includes changed tests and a transient out-of-scope edit later reverted: refusal before mutation; net diff alone cannot bypass scope. Rename/symlink/submodule/merge commit/oversized range fail closed.
- Wrong parent/project/repo, active source action, changed source receipt, unavailable object, Lab-bound source, expired lease/cancel before and during replay: no usable worker/model start and no source/job mutation.
- Conflict is typed, candidate/source immutable, partial workspace cannot resume as ready. Successful resume picks nothing twice and preserves receipt/base/head.
- New finite repair grant charged once, paid0 unchanged; failed source remains unmet with its original spent requests. Actual source-bound checks rerun, protected tests still need review.

### Mediated worker command alternative

A worker may request a specifically authorized declared command through normal command/check mediation; source/cwd/lease binding and operator approval still apply. However generic commandTool/runProcess executes a shell command and does NOT route arbitrary `git cherry-pick` through internal git-process-policy.ts. Plain cherry-pick may honor repository hooks or merge drivers, so it is not equivalent containment. A temporary exact reviewed workaround would require a clean isolated target, explicit immutable ordered commits, scope/linear-history review, full Git executable-config/hook protection, original attribution and fresh full checks. Adding such a command as a declared check also risks post-submission repetition; this is an operation, not a check. Do not widen global allowlists or execute blind range strings. This worker executed no workaround.

Follow-up validation: read-only source inspection only. No code/live changes or tests executed. Only this report changed.
