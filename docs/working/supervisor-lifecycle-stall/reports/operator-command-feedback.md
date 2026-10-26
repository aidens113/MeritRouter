# Operator command decision feedback

Status: Complete (worker claim; root independent review/release remain)
Workspace: D:/SwitchYardRouter-command-feedback
Branch: feat/operator-command-feedback

## Root cause and correction

executeSupervisorCommand's human_only adapter returned only row.output and exit/killed fields. Operator denial reason/actor lived separately on the validated WorkerActionRequest, so denied run_check produced exit null/killed denied and a nearly empty log, losing actual Header/P1 remediation feedback.

Owned source change is harness/worker-actions.ts only. Terminal recorded action decisions are projected into a strict bounded workerActionDecision result (actionId/status/actor/reason and explicit truncation flags). A separately labelled quoted JSON copy is appended to the END of existing formatted stdout, so unchanged run_check stdout-tail projection and stored check log both preserve the metadata. JSON control/line-separator/angle characters are escaped. Per-field escaped-output budgets keep the whole decision envelope below5000characters, including hostile control-character input, preserving exact action identity inside the existing6000character tail.

Metadata is explicitly decision data, not command output or execution authority. Actual exitCode/killed/empty stderr/duration semantics remain unchanged. Null remains null for denied/cancelled/unknown outcomes; no success, stderr, permission, replay, budget or action state is fabricated. Observed successful commands retain actual output/exit and additionally identify approval. The direct supervisor-policy runProcess branch is unchanged. Pre-result source/lease/cancellation failures still throw; root explicitly approved no error-log widening for those paths.

Other owned files: tests/operator-command-feedback.test.ts (new), docs/operations.md (exact contract). No supervisor-tools or observation-priority changes; companion investigation disproved actual truncation and left source untouched.

## Validation observed

- `pnpm install --offline --frozen-lockfile` succeeded219reused/zero downloaded,1m48.1s; pre-dist package bin warnings only; no manifest/lock changes.
- Final `pnpm --filter meritrouter typecheck` passed.
- Final `pnpm --filter meritrouter build` passed.
- Own suite11/11 passed11.68s.
- Final `cd packages/router; pnpm exec vitest run tests/operator-command-feedback.test.ts tests/supervisor-action-clock.test.ts tests/supervisor-human-approval-wait.test.ts tests/active-validation-ownership.test.ts --maxWorkers=1`:4files37/37 passed48.45s (11feedback+3clock+6humanwait+17ownership).
- `git diff --check` passed (CRLF normalization warnings only).

Actual run_check tests approve/deny exact fixture actions and read real stored artifacts. They verify Header/P1 denial visible in BOTH model result/log with exact action/status/operator/null exit; denial never runs the marker command. Repeated exact invocation retains original denial and ignores later approval attempts without a new request or execution. Adversarial long/control-character reason and old captured output cannot crowd metadata out of the model tail; reason truncation is explicit. Empty/null legacy reason, system cancellation, timeout uncertainty and actual successful command are covered. Source changes still refuse approval; original lease loss/cancellation still throw without running the command. Input env secret is absent from feedback.

## Boundaries

No app source, user config, live runtime/store, real providers, approvals, commits or pushes changed. Tests use temporary repositories and explicit fixture operator decisions; fake provider request count remains zero in denial/replay tests. The82a full-suite tree was not edited. Source is FROZEN at final receipt; root owns independent checks, authored integration/publication and live activation. This closes the proven operator-feedback loss, not an unproved observation priority issue.
