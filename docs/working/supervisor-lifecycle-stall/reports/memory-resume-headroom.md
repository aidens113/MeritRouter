# Reclaimable resume headroom for fresh memory

Status: implemented in isolated feature, frozen; final focused checks passed.

## Owned changes

Worktree `D:/SwitchYardRouter-memory-headroom`, branch `feat/memory-resume-headroom`. Only `packages/router/src/context/memory.ts` and new `packages/router/tests/resumed-memory-compaction-projection.test.ts` changed. No application/live/provider/config/brain/store writes or commits by this worker.

The live failure occurred before model routing: memory refresh measured the entire oversized restored transcript, assigned zero memory budget, and only afterwards would runAgentLoop compact old turns. Current decisions were therefore omitted despite reclaimable history.

The selector now calculates desired role/explicit memory allocation and, when ordinary headroom cannot provide it, deep-clones assembled messages and projects the existing bounded compactor against minimum endpoint/task input minus actual tool schemas, offered output, existing margins and desired memory. It then recomputes actual projected headroom and clamps the memory budget. Original restored messages are never compacted/reordered/stubbed by refresh. New memory is appended normally; real runAgentLoop compaction remains the only owner of effect-history removal/guard receipts.

If the immutable head or tool/output requirements leave no real room, memory stays omitted with a generic `context:memory` reason explaining headroom. The early diagnostic reads no source records or private source names. A deliberately tiny explicit cap has its own accurate generic reason.

Memory header/record/final-block estimates now use the same conservative gateway estimateTokens units as routed prompt admission, including dense Unicode. Per-record framing overestimates slightly, so cap selection is conservative. Previous chars/4 accounting could pack materially more memory than the gateway chars/3/dense estimator admits; a guessed ratio would not protect Unicode.

## Regression proof

An isolated temporary before/after probe replaced only the owned token helper with the old chars/4 calculation, ran only the two new immutable-head boundary cases, then restored exact corrected bytes in a finally block. Both old-estimator cases failed the131072 context cap:

- ASCII: actual132749 tokens.
- Dense Unicode: actual136749 tokens.

The ASCII fixture uses3x14000-character decisions. Dense data uses String.fromCodePoint(0x754c), with a presence assertion, avoiding Windows shell encoding loss. The original-estimator JSON receipt is TEMP/meritrouter-memory-headroom-before.json. A prior console-only probe hit a Windows Unicode printing error after its guaranteed restore; it was repeated with JSON output to obtain the exact two expected failures above.

Corrected production source SHA256 at final freeze: `340d413d65f0ea63cffc74b2529e5bacfd041ffc0c1dcb0c0125f913f095a522`.

## Validation

Pinned Vitest3.2.7 from main's existing dependencies is used with explicit isolated workdir and relative feature source imports. The feature has ignored node_modules junctions to existing dependencies; no manifest/lock/dependency changes. An initial npx command before junction setup selected an unrelated cached tool and failed native binding before tests; that startup failure is not a validation receipt.

- Final `pnpm --filter meritrouter typecheck` in isolated feature -> exit0.
- Final `pnpm --filter meritrouter build` in isolated feature -> exit0.
- `git diff --check` -> exit0, CRLF normalization warning only.
- Final frozen five-file command: pinned vitest run `tests/resumed-memory-compaction-projection.test.ts tests/resumed-memory-headroom.test.ts tests/memory-v2.test.ts tests/reviewer-memory.test.ts tests/model-stall-handoff.test.ts --fileParallelism=false` ->48/48 passed across5files in82.94s (75.76s tests). No source/test edits occurred during this final group.

The six new cases cover >140k restored input against131072 fallback, larger sticky endpoint refusal followed by real loop fallback compaction, preservation of current decisions, immutable original history, effect-loss receipt recorded only by the actual loop, impossible huge immutable head with source-free diagnostic, task/tool/output/explicit caps, and ASCII/dense full-role immutable-head boundaries. Existing ACL revocation/expiry, reviewer memory, task-local handoff and unsafe-effect replay refusal cases are included unchanged.

Initial default-cwd edits accidentally landed in main; root caught the isolation mistake before any same-tree validation. Worker relocated only its two owned files with byte verification, restored main memory.ts exactly to current HEAD and removed only its own copied untracked test. All counted final checks run in the assigned feature. No main source changes remain from this worker.

## Limits

The projection cannot make an immutable head or pinned tool schemas fit an undersized endpoint. Such cases correctly omit memory and remain subject to ordinary Gate refusal. This does not expand model windows, change route eligibility, override ACLs, grant spending authority or alter actual loop effect-history rules. Source tests do not prove the resumed live model followed current decisions; root must inspect the actual new manifest and model behavior after controlled integration/deployment.
