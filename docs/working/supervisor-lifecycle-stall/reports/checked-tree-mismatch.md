# Checked worker candidate sealing report

Worker: checked_tree_mismatch
Status: source frozen; focused checks passed; root integration/live verification pending

## Observed cause

Read-only inspection of live deps-setup2 task `t_0mvoaezx59bab910181df` confirmed `git status --short` contained staged `A package-lock.json`. HEAD `8dae73c` tree `17945de6905d` omitted that file. The difference from checked staged tree `37770005900e` was exactly the 1,887-line lockfile. `finishCoding.collect()` stages command-generated files and records `write-tree` as the checked revision, but no editing response follows an install to commit those files. Integration correctly refused HEAD differing from its checked revision.

## Change

- Added `attribution/checked-candidate.ts`: capture-only sealing uses attributed `git commit-tree <capturedTree> -p <expectedHead>` and atomic expected-old `update-ref`. It never restages files, reads a newer index into the immutable commit, resets changes, or rewrites existing history. Validates original HEAD/index, absent unstaged/untracked source, current authority around awaits, and exact tree/index/worktree after publication.
- `runners/coding/finish.ts` seals allowed, staged generated candidate files before final checks and updates the worker session workspace head. Invalid scope, failed/aborted runs are not sealed. Existing final action source/hash checks remain unchanged.
- Added `harness/checked-task-candidate.ts` for retained legacy candidates only: completed/met original child and completed author session, exact workspace/head/base lineage, unanimous successful declared check revision/digest, scoped check artifacts and matching execution IDs, exact immutable final action task/project/lease generation/job/command/source proof, current supervisor authority, staged patch digest, no Lab evidence or unsettled actions. Capped uncertain history fails closed. Original worker/model attribution is derived from trusted task/session metadata.
- Integration calls this legacy seal only for mismatched task HEAD, then recomputes source head and commit list and still enforces the exact checked tree guard. It does not accept or integrate arbitrary current HEAD.
- Internal Git process allowlist adds only `commit-tree`; existing no hooks, executable config, environment redirection, or network policy remains. No model-facing command permission added.

## Files

- packages/router/src/attribution/checked-candidate.ts
- packages/router/src/harness/checked-task-candidate.ts
- packages/router/src/harness/integration-tools.ts
- packages/router/src/runners/coding/finish.ts
- packages/router/src/workspaces/git-process-policy.ts
- packages/router/tests/checked-candidate-seal.test.ts
- packages/router/tests/retained-checked-candidate.test.ts

## Validation observed

- `pnpm exec vitest run tests/checked-candidate-seal.test.ts --maxWorkers=1`: 9/9 passed, 14.41s. Includes real native runner/fake-provider install-like generated lock, immutable-index race and expected-old HEAD CAS race.
- `pnpm exec vitest run tests/retained-checked-candidate.test.ts --maxWorkers=1`: initial 19/19 passed,21.74s; expanded 23/23 passed,43.54s. Positive preserves original checked records and worker/model attribution; negatives cover source/action/task/project/lease mismatch, pending/running/unquiesced actions, missing action, mixed check revision/digest, foreign artifact, changed HEAD/index/worktree/untracked source, scope/protected files, wrong parent, Lab and cancellation.
- `pnpm exec vitest run tests/checked-candidate-seal.test.ts tests/retained-checked-candidate.test.ts tests/native.test.ts tests/supervisor.test.ts tests/git-process-containment.test.ts --maxWorkers=2`: 5 files58/58 passed,62.21s (this run loaded initial19 retained cases).
- `pnpm exec tsc -p tsconfig.json --noEmit`: passed after a test-only partial GateResponse cast correction; passed again after expanded23 cases and generation binding.
- Final conservative >=500 uncertain-history refusal and 24th cap regression added after root started aggregate run. Final `pnpm exec vitest run tests/retained-checked-candidate.test.ts --maxWorkers=1`:24/24 passed,43.33s including cap refusal. Root must preserve that aggregate run boundary honestly.

## Boundaries

No application source or live state edited; no app worktree commits, approvals, configuration changes, daemon changes, or repository commits/pushes by this worker. Live candidate recovery must occur through the internal supervisor integration tool after root release verification. No live integration or product acceptance was performed. Root owns authored shared documentation, final integrated checks/build, publication and live recovery.

## Follow-up: avoid duplicate workspace events

Root aggregate run17067 exposed `session-recording.test.ts` native case expected two workspace events but received three. The sealing path had emitted a new workspace event even when no generated staged files existed and seal returned the original HEAD. Changed only `finish.ts` to record workspace when `sealed !== head`; no test assertions or source-sealing guards weakened. Source frozen after this correction. Aggregate result is historical relative to this final no-op-event fix; root records full boundary. Final `pnpm exec vitest run tests/session-recording.test.ts tests/native.test.ts tests/checked-candidate-seal.test.ts --maxWorkers=2`: 3files30/30 passed in82.36s (session-recording10, native11, newseal9). No remaining worker checks or source edits.
