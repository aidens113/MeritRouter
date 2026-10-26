# Dependent review source
Status: Corrected source frozen; final focused checks passed; independent review pending

## Confirmed defect and scope
Queued job-owned readonly review tasks retained their dispatch-time source pin after coding dependencies integrated. A coding task depending on that readonly review also retained the stale pin: the existing direct-coding selector has no coding workspace to select from for the bridge. The new real-Git UI -> features -> review -> runtime fixture fails against original HEAD upstream.ts at review base equality (received initial 228a6ee, expected integrated 8818ff1). Corrected source was restored byte-for-byte after the regression probe.

## Implementation
Owned source: isolated D:/SwitchYardRouter-dependent-source, context/upstream.ts only. Existing direct coding algorithm is unchanged. Job-owned dependent reads select permitted aliases at first dependency readiness, checking source parent/project, terminal ownership, common Git repository and immutable commits. Integrated subjects require an owned merge_queue receipt, expected project/repository/job lock, branch identity, receipt ancestry and no undo signal. Single unintegrated owned terminal heads remain reviewable without fabricating acceptance. Conflicting subjects refuse.

Readonly bridges inherit the exact frozen reviewed subject through new backward-compatible upstream_snapshot rule. Upstream event lookup filters event type before limiting, validates bounded stored input and owned artifact metadata, and refuses invalid existing receipts rather than retargeting. Source validation occurs before artifact publication. Resume does not recalculate. No-dependency pins and parentless readonly declared/canonical behavior remain unchanged. No access, acceptance, scheduler, provider, application or runtime state changes.

Root approved one existing team-graph fixture correction: reader parent job plus new expected source pin/comment; direct coding assertions remain unchanged. Authored roles documentation explains job-owned readiness selection and parentless compatibility.

## Validation
- Offline frozen-lockfile dependencies installed in isolated tree; pinned Vitest 3.2.7.
- First corrected new suite: 12/12 pass, including canonical .git-only source, real Git integration and inherited reviewed commit across 550 later logs and parent movement.
- Original source regression probe: one selected chain test fails at stale review pin (12 skipped); corrected bytes restored in finally.
- Initial TypeScript noEmit passed before final parentless compatibility addition.
- Final frozen focused group: dependent-review-source14 + team-graph12 = 26/26 PASS (47.74s).
- Existing delegated-context-snapshot14/14 PASS (27.23s), preserving dispatch-time source and ACL/symlink/project/dirty guards.
- pnpm -r build PASS (router + production panel).
- pnpm -r typecheck PASS after building router exports. Initial recursive typecheck before build failed on missing meritrouter dist declarations with cascading panel errors; the normal own-tree build resolved them without source changes.
- Source frozen, independent review notified. Full router suite and live queued task verification remain supervisor responsibilities.

No commits, application edits, provider calls, runtime/config writes or live task changes performed. Root must independently review/integrate and validate actual queued task behavior before deployment claims.


## Independent review finding
Reviewer repair_hydration_review identified a concrete final-authority fence gap: integrated source ownership and undo are checked before awaited Git calls, but HEAD equality alone does not detect an undo-only signal or source/receipt ownership mutation during ancestry proof. Source remains frozen pending root authorization; do not integrate this version despite its passing preexisting fixtures. Proposed correction is one final synchronous exact receipt, source/dependent/parent scope and undo recheck after all awaited alias proof, plus injected proof-race negatives. No acceptance policy or direct-coding behavior change is proposed.


## Authorized final-fence correction
Root authorized the bounded correction after all validation readers exited. The selector now collects synchronous validators for exact dependent/parent/source project, scope, terminal ownership and original source spec; exact integrated receipt identity/state plus undo; workspace identity; and readonly frozen-subject identity. These run only after all alias Git awaits, inside the same IMMEDIATE SQLite transaction that re-reads any concurrently published receipt and writes the new artifact/event. Existing first pin wins. There are no awaits between final authority checks and publication, closing the cross-process check/write window. Direct coding selection still follows its existing algorithm.

Expanded new fixture suite22/22 passed (35.12s): six during-merge-base mutations (undo-only, source project, source parent, dependent project, parent alias scope, receipt state), late second-alias undo invalidating earlier proof, and concurrent first-pin preservation. All refusal cases leave no target artifact or upstream event. Temporarily omitting final validators reproduces undo-only acceptance: selected regression fails because the promise resolves instead of rejecting; corrected source restored byte-for-byte. Final 3-file group48 cases now running on frozen corrected bytes. Earlier type/build receipts predate this correction and will be rerun.


## Final corrected-source receipt
- Three-file pinned Vitest3.2.7 group: 48/48 PASS (96.96s), comprising dependent-review-source22, team-graph12 and delegated-context-snapshot14.
- Recursive typecheck PASS on corrected source.
- Final corrected-source pnpm -r build PASS, router and production panel. All own checks finished; no processes left running from this brief.
- Independent reviewer notified final source is frozen and all own test readers exited. No further source edits planned. The earlier blocker/authorization notes above are historical; authorized transaction correction supersedes them, subject to independent review.
