# Exact retained patch-reference guard

Status: implemented and frozen; own lifecycle checks passed, root combined validation pending.

## Owned changes and cause

Unit worktree `D:/SwitchYardRouter-repair-quiescent`, shared with the quiescent-operations worker through disjoint file ownership. This worker changed only `packages/router/src/harness/repair-reference.ts` and `packages/router/tests/supervisor-lifecycle.test.ts`. No application/live/provider/config/store changes or commits were made.

The existing guard required repair_from_task when a goal named an exact owned terminal coding task ID. The live planner dropped that task ID after a source refusal and named only its patch artifact ID. A fresh worker then lacked artifact access and attempted recreation. Merely writing an artifact ID in prose must not replace explicit native repair intent or grant access.

## Behavior

For implement briefs, exact a_* tokens (bare or following artifact:) are resolved with the existing ArtifactStore.get metadata accessor. Returned id/task_id/kind are zod-validated, kind must be patch, and returned id must exactly match the referenced token. The owner must already be in the existing owned same-parent/same-project terminal coding source pool. The existing writable-repository and complete changed-path/original-scope compatibility checks then apply.

That source joins the same referenced-source set as an exact task ID. Existing required/mismatch/ambiguous repair_from_task refusals apply before plan/staff/grant/child effects. A matching explicit field still goes through the ordinary native resolver; this guard never hydrates or authorizes source itself.

No artifact bytes are read, no artifact/context grants are added, and no records are mutated. Wrong kinds, screenshots, check logs, missing/shared owners, unknown IDs, foreign/unowned/active sources, malformed metadata, mismatched returned IDs, disjoint scopes and nonmatching token suffixes do not become repair authority. This is exact validated identifier matching, not natural-language inference.

The exact integration receipt/current branch ancestry/HEAD/undo exemption was not changed. A valid current integration can be followed normally; undone or mismatching integration still requires explicit repair source.

## Tests observed

Pinned Vitest3.2.7, explicit assigned workdir:

`node D:/SwitchYardRouter/packages/router/node_modules/vitest/vitest.mjs run tests/supervisor-lifecycle.test.ts`

Result:46/46 passed in69.49s (66.42s tests). Seven new cases cover:

- Actual-shaped API patch a_0mvofjo055767581894fc and UI patch a_0mvof94fpd683b60c48cf with task ID omitted; bare/prefixed references are refused in draft, dispatch and delegate modes.
- Every refusal preserves plan versions, request grants, held requests, child count, model charges and approval count; native resolver and artifact body readers are not called.
- Wrong typed field refuses; matching dispatched label proceeds through the mocked native resolver exactly once and records its repairSource.
- Wrong-kind/foreign/unowned/active/shared/unknown/malformed/disjoint references remain ordinary drafts without repair authority, Git preflight, body reads or hydration.
- Owned patch references preserve the existing current-integrated exemption and lose it after undo.

Existing task-ID ambiguity/path fallback/complete-scope, persisted repair-source pin, integration identity/reset/undo/race and supervisor lifecycle/default behavior tests passed unchanged.

Both source owners declared frozen before combined checks. This worker ran only its own narrow test file and did not start broad typecheck/build while peer edits were in progress. Root owns final combined source review, checks, integration and live validation; this report does not claim the live model repaired the UI or obtained artifact access.
