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
