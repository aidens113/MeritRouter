# Explicit retained repair references

Status: Complete; frozen for independent review/integration
Worker: repair_context_handoff
Branch/worktree: feat/repair-reference-guard / D:/SwitchYardRouter-repair-reference
Base: fccd6ed

## Changed

New focused harness/repair-reference.ts validates fresh implementation briefs. If goal text contains an exact owned same-parent/project terminal coding task ID and its retained paths fit the target writable repository/scope, require explicit matching repair_from_task before draft publication, staffing, budgets or child submission. An omitted ambiguous choice lists compatible IDs; explicit one-of-many selection is allowed. A mismatching explicit source refuses. Labels and words such as native never infer a source.

Compatibility uses validated nonempty result.changedPaths, with EVERY actual retained path matched against target allowed_paths. Without actual paths, use existing narrowedScope(target,originalScope) conservative containment proof. No Git, model request or access grant occurs during this check. Disjoint contract references, fresh implementations, unknown/unowned/foreign-project IDs and ID-prefix/suffix lookalikes do not acquire source authority or trigger this narrow guard.

supervisor-tools.ts calls guard before plan_work validation/staffing/publication and before delegate's exact-plan/grant path. Already-dispatched labels are excluded so idempotent retries and historical graph nodes remain unchanged. A same-label undispatched draft with existing repairFromTask also refuses an omitted field even when new goal removes the old ID: keep the explicit field or choose a fresh label. Explicit changed fields still pass normal goal-reference matching and native resolver; no inferred or automatic source authority.

Native source resolver, workspace hydration, evidence/effect guards, paid budgets and configuration are unchanged. Goal references only cause actionable refusal; resolveRepairSource remains responsible for actual ownership/provenance/quiescence/scope authority.

Files:
- packages/router/src/harness/repair-reference.ts (new)
- packages/router/src/harness/supervisor-tools.ts
- packages/router/tests/supervisor-lifecycle.test.ts

## Exact observed validation

- pnpm install --offline --frozen-lockfile -> exit0;219cached packages,0downloads; pre-dist panel executable-bin warnings only.
- pnpm --filter meritrouter typecheck -> final exit0.
- pnpm --filter meritrouter build -> final exit0.
- pnpm exec vitest run tests/supervisor-lifecycle.test.ts -> final25/25PASS,1file,37.44s (34.19s tests), no edits during finalrun.
- git diff --check -> exit0; line-ending advisory warnings only.

Nine added regression cases cover draft/dispatch/delegate omission with unchanged plan versions, child count, held grants and model-request totals; actual and original-scope fallback compatibility; exact token boundary; disjoint/foreign/unowned/fresh refs; full multipath fit rather than single overlapping file; ambiguous omissions and explicit choice; planned binding omission despite erased goal reference; explicit dispatch invoking normal resolver and preserving source context; already-dispatched retry does not invoke resolver twice. Existing16lifecycle tests also pass.

The explicit-dispatch test mocks only resolver output to demonstrate normal resolver still owns authority; actual native hydration was independently verified by prior23hydration tests and was NOT rerun/modified here. This report does not claim new live-provider or app validation.

Initial run23/24: delegate test encountered outer missing-plan policy before reaching guard; fixture now publishes unrelated cheap draft to exercise the new delegate check. Typecheck caught direct picomatch Matcher passed to Array.every, whose index parameter could change return mode; corrected explicit path=>matcher(path), then added a multipath regression and reran finaltypecheck/build/25tests above. Earlier24/24 did not count as final-source acceptance.

## Limits / handoff

This is a narrow refusal guard, not natural-language intent classification. It deliberately ignores label-only references, unknown IDs, incompatible scopes and active tasks. It does not retrofit already-dispatched pseudo-repair tasks; root must deliberately dispatch a corrected fresh typed repair. An explicit source still can fail the normal strict hydration resolver. Historical partial plans are not globally revalidated.

No runtime/provider/config changes, app edits or live state mutations. No commits. Implementation is isolated and frozen; main checkout only this owned report was written. Root owns independent review, authored docs, merged/global checks and activation.


## Corrective follow-up: already-integrated references

Root identified a workflow false positive: an ordinary follow-up mentioning a source already accepted/integrated into the current job branch should use that current base, not replay old commits. After root stopped the frozen guard-tree full suite and verified no process remained, this owned correction was authorized.

Guard now takes current integration repository branch/worktree identities and performs a bounded asynchronous exemption proof ONLY for a compatible exact owned source reference. Require an exact merge_queue integrated task receipt with same parent/source/repository/branch/worktree/project-qualified lock key and valid after_head. Completion or acceptance alone is insufficient. Missing/malformed/wrong-identity/queued/picked receipts retain explicit repair requirement.

Internal safeGit confirms current symbolic branch, captures currentHEAD, proves receipt afterHead is ancestor of that immutable snapshot, then rechecks symbolic branch and finalHEAD equality. Final synchronous reread checks exact receipt head and current task parent/project/repository/terminal ownership. verification_signals undone evidence for this source/current parent (or unknown nulljob) blocks exemption before AND after awaited proof, so supported attribution undo and undo arriving during proof cannot bypass guard. Branch reset during proof similarly fails finalHEAD equality.

Ordinary fresh/disjoint drafts execute zero Git calls (tested). Git timeout10seconds/64KiB metadata limit applies per bounded proof call; no Git-heavy hydration or model requests occur. No acceptance, scope or artifact authority is created by exemption; new ordinary child inherits the proven current integration base and no repairSource.

Tests use actual isolated Worktrees/attributed commits/MergeQueue integration, ordinary follow-up delegate, and real revertCommits with calibrationUndoHook. Cases: integrated positive; wrongjob/repository/branch/worktree/projectlock/malformedhead/pickedreceipt/resetbranch/undone source negatives; acceptancealone; ordinarynoGit; undo during ancestry and branch reset during ancestry.

Observed so far: first integrated11selectedPASS21.16s; intermediate38/38PASS58.67s before final pinned-head race fix. Final production typecheck/build exit0; final14selectedPASS27.00s. Final39lifecycle group running; do not treat prior25/25 or38/38 as final corrected-source acceptance. Source frozen for reviewer/root final proof.


### Final integrated-source correction receipt

- Final source frozen; pnpm --filter meritrouter typecheck -> exit0; pnpm --filter meritrouter build -> exit0.
- pnpm exec vitest run tests/supervisor-lifecycle.test.ts -> **39/39PASS**,1file,68.05s,65.28s tests, finalrun17:51:59local; no edits during finalrun.
- Final selected integration/refusal/noGit/race subset14/14PASS27.00s preceded fullrun. Previous25/25 and intermediate38/38 remain historical.
- Proof pins currentHEAD for ancestry and compares finalHEAD after awaited checks; final synchronous receipt/ownership/undo reread prevents branchreset or undo arriving during proof from creating exemption.
- Git preflight is limited to exact matched referenced compatible sources with scoped integrated receipt; ordinary drafts remain zeroGit. This changes workflow refusal only and grants no authority.
- Implementer did not edit docs/roles.md; root-authored documentation is also modified in this isolated tree and was preserved. Worker-owned source/test footprint remains the same three files. No commits or live state/app changes.
