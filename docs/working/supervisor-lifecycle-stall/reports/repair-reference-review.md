# Independent repair reference guard review

Reviewer: repair_hydration_review
Date: 2026-10-25
Status: Corrected integrated exemption reviewed; 14 independent additional tests passed; clear for integration
Scope: D:/SwitchYardRouter-repair-reference. Reviewer owns this report only.

Read main Current State and written implementation/review briefs, changed supervisor-tools.ts, new repair-reference.ts and lifecycle tests; inspected task scope containment and stored child lookup as needed.

No source blocker found. The guard runs before plan persistence/staffing and before fresh dispatch planning/child/grant effects. Qualifying sources are owned terminal coding children under the exact parent, project and writable repository. A task ID must be a complete token in the goal. Full nonempty validated changedPaths must match the target; absent/malformed/empty path evidence falls back to conservative proof that the original full allowed scope fits the target. It never hydrates or grants access; native resolver remains the authority for actual explicit recovery.

Missing, ambiguous and nonmatching explicit sources produce actionable errors naming repair_from_task. An explicit matching one-of-many reference is accepted. Prior draft source cannot be silently omitted even when goal prose drops the ID. Fresh/disjoint/foreign/unowned references do not create source authority; previously dispatched history skips fresh guards for idempotence. Native hydration is exercised through its normal resolver call in the dispatch regression.

Awaiting final frozen test/typecheck receipt before independent focused lifecycle execution. No source/test/runtime/config/store/provider edits or commits by reviewer.


## Final independent validation

Final source frozen; implementer reports lifecycle25/25, package typecheck and build passing. Independently executed the nine new guard regressions on final frozen source:

`pnpm exec vitest run tests/supervisor-lifecycle.test.ts -t "typed retained source|actual-path compatibility|disjoint contract|complete retained path|ambiguous omission|drafted explicit source|native resolver"`

Observed PASS: 9 passed, 16 skipped, 6.80 seconds. This independently verifies rejection before plan/grant/child effects for draft/dispatch/delegate, actual full-path compatibility and conservative scope fallback, exact token boundaries/disjoint/foreign references, complete multi-path coverage, ambiguity/mismatch versus explicit selection, prior draft omission even after removal of goal ID, resolver invocation and dispatched retry idempotence.

No remaining blocker. Clear for supervisor integration and broader verification. This guard improves structured recovery selection; it does not establish actual app repair completion or runtime delivery. No provider calls, runtime/configuration/store changes, commits or source/test edits by reviewer.

## Reopened boundary: already integrated sources

Supervisor identified a real false positive after initial clearance: all terminal coding children include sources already integrated on the current parent branch. Follow-up polishing the current base while mentioning that task ID is wrongly forced to replay it through repair_from_task, potentially producing empty/conflicting cherry-picks. Previous clearance is withdrawn for this boundary.

Authoritative exclusion should use the latest exact parent/task/repository merge_queue integration receipt, matching current IntegrationRepo branch/worktree, valid recorded after_head, and proof that the actual current branch still contains that head. Acceptance or task completion alone and other-parent/repository/branch receipts are insufficient. Stale/reset branch evidence must not suppress the guard. Ancestry alone also survives supported attribution undo: calibrationUndoHook records outcome_signals kind undone with task_id/job_id, while merge_queue stays integrated. Any relevant later undo must conservatively prevent exemption. Reported both issues to root and implementer; no source edits.


Root approved a bounded correction after stopping the guard feature's prior full validation; main checkout validation remains separate. Implementer proposal uses current repository branch/worktree metadata, exact merge_queue receipt lock key and task kind, bounded safeGit ancestry and conservative undo refusal. Correction to earlier terminology: the actual authoritative undo table is verification_signals (not outcome_signals). Review remains reopened pending frozen implementation and new regression validation.

## Corrected integrated-source exemption review

Reviewed the bounded correction in progress. It checks exact current parent/source/kind/repository/branch/worktree/lock-key integrated receipt; matching source and parent project; current symbolic branch identity; bounded safeGit ancestry against a pinned immutable current head; final head equality and synchronous receipt/source/project/undo rechecks. Ordinary nonreferencing/disjoint drafts incur no Git preflight. Any same-parent or unknown-parent source undo signal conservatively blocks exemption.

Review found a reset-during-final-await proof race in the initial correction (ancestry checked mutable HEAD then only branch identity was rechecked). Implementer pinned the head, checked immutable ancestry and final head equality, adding a reset-during-proof regression. New fixtures perform an actual MergeQueue integration, verify follow-up child base commit and absence of repairSource, and use supported attribution undo rather than acceptance flags as proof. Wrong job/repo/branch/worktree/lock/head/state, reset, undo and undo-during-proof cases refuse exemption. Source review has no remaining blocker; awaiting final frozen regression receipt.


## Final integrated-exemption independent validation

On final frozen corrected source independently ran:

`pnpm exec vitest run tests/supervisor-lifecycle.test.ts -t "current integrated base|does not exempt|Git preflights|acceptance alone"`

Observed PASS: 14 passed, 25 skipped, 30.77 seconds. Verified real integration produces an ordinary follow-up based on the current integrated head with no repairSource; wrong parent/repo/branch/worktree/lock/head/nonterminal receipt state, branch reset, supported attribution undo, undo-during-proof and reset-during-proof retain native-source requirement. Ordinary disjoint drafts issue no Git calls; acceptance alone does not exempt retained source.

No remaining blocker found. Final clearance supersedes the reopened false-positive/race findings. Earlier original nine guard regressions passed independently before this correction; broader final39 run remains supervisor/implementer-owned. No source/test/provider/live-state edits by reviewer.
