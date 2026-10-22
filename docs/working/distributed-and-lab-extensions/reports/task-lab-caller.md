# Task Lab caller unit

Status: complete for the bounded caller unit; source frozen. Worker claim pending supervisor verification.

## Scope and behavior

Worktree `roadmap-labs`, branch `feat/task-lab-callers`, baseline `31adb3a`. No commits or pushes. Lifecycle, service, project deletion, admin and shared working documents were not edited.

Coding callers capture the claimed generation/project and preserve submitted immutable pins. After the runner has persisted its attributed commits and session/execution membership, shared coding completion registers that exact attempt, submits commit/tree/patch digest, enqueues the selected human-authorized command checks, ensures an explicit supervisor is available, and waits with cancellation. The runner never drains the control queue. Failure/cancellation queues scoped cleanup; late cancellation is reflected in the outcome.

`result.taskLab` is typed separately from ordinary checks: ordinary revisions remain tree SHAs, Lab checks retain commit SHAs. Compiled contracts persist declared Lab selection and always require `ephemeral_lab_checks`; re-evaluation keeps it required. Missing, failed, forged, stale or unsafe evidence is a deterministic failure, so a passing reviewer cannot waive it. A preexisting contract with a different selection fails closed.

Integration selects the exact accepted result attempt and durable source, independent of the mutable/latest workspace pointer. Source evidence is checked before picking and again before completion, including recovered picks. Opt-in conflicts preserve the checked source and redelegate with `lab_checks`; they never automatically rebase an already checked commit. Ordinary tasks retain their existing merge/rebase behavior.

## Integration contract

`runners/coding/task-lab.ts` exports:

- `TaskLabAuthoritySchema`, `TaskLabAuthority`.
- `taskLabAuthority(labs: LabManager, taskId: string, evidence: unknown): TaskLabAuthority | null`: synchronous read-only authority snapshot; no queue processing or asynchronous wait. Call before acquiring an acceptance writer transaction.
- `taskLabEvidenceProblem(spec: WorkerTask, evidence: unknown, authority: TaskLabAuthority | null): string | null`: pure fail-closed guard; null means the supplied trusted snapshot and evidence agree.
- `runTaskLabChecks(ctx: RunContext, workspace: Workspace, executionId: string, tree: string, digest: string): Promise<TaskLabEvidence>`: internal shared coding completion caller.

Authority validates persisted task/project/generation, selected attempt and request, completed operation/check records, recipe digest and current human policy, every immutable repository pin/head, exact registered worktrees/physical Git common directories/owned branches, source tree and cleanliness, retained stopped Lab, and zero active operations/services/processes/port reservations. It reloads config **by content** with `loadConfig` and a fresh unattached `ProjectRegistry`, so same-mtime revocation is observed. Scoped repository order and writable permission must remain authorized.

Git inspection uses validated managed paths, argv-only `execFileSync`, no shell: 5 seconds per command, 10 seconds aggregate, 256 KiB output per command and 2 MiB aggregate. Errors, bounds or ambiguous identity return null.

`ExecutorDeps` and `RunContext` expose optional `ensureLabsSupervisor?: () => Promise<void>`; root supplies the service startup callback. Context also carries `claimedRunCount`, `taskProject`, and `taskLabs`. Opt-in completion requires these plus a persisted session. Test fixtures use an explicit external queue-drain loop, never runner-driven supervisor work.

Supervisor-authorized expansion: `core/acceptance.ts` narrowly forwards `VerifyOptions.taskLabAuthority` and adds `DecisionDeps.beforeAccept?: (task: StoredTask) => void`. This synchronous hook runs inside `tasks.updateResult`, after terminal/completed checks and only on accept. Root owns the service callback, fresh metadata/policy fence, and all service/public acceptance behavior; the worker did not edit service.ts.

MCP `submit_tasks` describes camel-case `constraints.labChecks` matching WorkerTask. Supervisor delegate/tool JSON describes `lab_checks`, maps it to WorkerTask in dispatch/staffing, and preserves it for conflict redelegation. Runtime task validation remains authoritative.

Dependent opted-in tasks preserve their explicitly submitted base pins while still receiving dependency artifacts/text. A task that needs the newly integrated upstream HEAD must be submitted after integration or redelegated with the current authorized base; injection must not silently replace its snapshot. Ordinary dependent tasks retain existing base selection.

## Exact file inventory

- `packages/router/src/core/task.ts` (result schema only), `core/executor.ts`, and explicitly approved narrow `core/acceptance.ts`.
- `packages/router/src/runners/types.ts`, `runners/coding/finish.ts`, new `runners/coding/task-lab.ts`. Native and external runners both use shared finish; their source files required no edits.
- `packages/router/src/verification/contract.ts`, `checks.ts`, `policy.ts`, `phase.ts`.
- `packages/router/src/harness/integration-tools.ts`, `supervisor-tools.ts`.
- `packages/router/src/workspaces/merge-queue.ts`, `mcp/schemas.ts`.
- New `packages/router/tests/task-lab-caller.test.ts`, `task-lab-verification.test.ts`.
- This report only under docs.

## Validation ledger

- Initial end-to-end run: 3/3 passed in 109.23 seconds (120.82 seconds including collection), before added conflict/upstream/generation and acceptance-transaction regressions. Native coding and external fake-agent paths exercised real isolated command checks/HTTP service; required failure stayed unaccepted despite passing ordinary checks.
- Final source router typecheck: passed.
- Final source router build: passed.
- Final focused run: **58/58 passed across eight files**, 149.69 seconds total (133.72 seconds tests), single Vitest worker. Command: `pnpm --filter switchyard-router exec vitest run tests/task-lab-caller.test.ts tests/task-lab-verification.test.ts tests/coding.test.ts tests/native.test.ts tests/verification.test.ts tests/team-nesting.test.ts tests/team-integration.test.ts tests/mcp.test.ts --maxWorkers=1`.
- New caller cases passed 5/5 in 77.58 seconds: native/external real HTTP command Labs, required-check failure/no acceptance, exact selected source despite a misleading mutable workspace pointer, actual cherry-pick conflict/no source rebase and preserved redelegation checks, claimed-generation race, and dependency artifacts with immutable submitted pins. The exact-source/conflict assertions run inside the native end-to-end case.
- New verification cases passed 3/3: missing mandatory evidence remains failed despite passing review; acceptance fence executes under the result transaction and refusal rolls back; MCP task selection survives description/runtime validation, duplicate names refused.
- Existing verification21, team nesting7, team integration5, native9, external coding6 and MCP2 all passed.
- `git diff --check`: passed. Test fixture cleanup completed; scoped scan found **zero remaining caller fixture directories**. No fixture supervisor remains.

## Limits and follow-on obligations

This unit does not implement hydrated browser task checks, a host/OS sandbox, full R2 generation fencing, Compose runtime, or all planned Lab work. Browser selections remain rejected by the existing command-only lifecycle. Bounded Git and transaction metadata fencing cannot atomically lock out malicious host filesystem/process changes. Root owns the final service snapshot fence and independent human accept/override tests after integration.

Parent identified a separate durable prune/source-retention fence needed for concurrent evidence inspection/cleanup; lifecycle was frozen and is unchanged here. `LabManager.tick` still awaits task checks through `processControls`, delaying retained service monitoring/idle/retention during long checks even though retained commands drain concurrently; record for the next lifecycle unit.

Fixtures use temporary repositories/configs/brains and fake providers only. No paid model calls, Docker, real panel4477 or user resources. Cleanup explicitly stops owned retained attempt processes, closes Switchyard, removes test-only trees, and leaves no fixture supervisor running. Final cleanup outcome is recorded in the validation ledger.

Plan metadata note: `plan_work` dispatches original `freshItems`, so runtime task specs preserve `lab_checks`. Existing PlanNode schema omits a durable Lab-selection field; this unit leaves storage/plans.ts unchanged. A later plan-display requirement can add that metadata without weakening current task enforcement.

Frozen 16-file source/test SHA-256: `996cee6e650c56431c0f5e0b632f63d7806de193e07a719bcfa0444591a17039` (sorted owned package paths; hash each UTF-8 path, NUL, raw file bytes, NUL; excludes this report).
