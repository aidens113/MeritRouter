# Task Lab lifecycle unit1

Status: Frozen for supervisor review: bounded command-only lifecycle unit1 implemented and exercised; caller/verification integration is a later serial unit. Browser task attempts are explicitly rejected pending durable browser recovery.
Baseline: 6d61b8e, isolated feat/roadmap-task-labs worktree. No commits/shared documentation changes.

## Stable integration contract

`LabManager.taskAttempts` exposes `register(input): Promise<TaskAttemptHandle>`, `submit(handle,{commit,tree,patchDigest}): Promise<void>`, `requestCheck(handle,{checks}): TaskLabOperation`, `wait(handle,operationId,{signal?,timeoutMs?}): Promise<TaskLabEvidence>`, `cleanup(handle,reason?): TaskLabOperation`; serve owns `process/recover/prune`. Existing LabManager.processControls/recover/tick/close delegate the lifecycle at safe points. API instances never auto-drain an attempt queue.

See validated DTOs in labs/task-attempt-schema.ts. Register requires taskId, project, leaseOwner, runCount, executionId, sessionId, sourceWorktree, writableAlias, repositories:[{alias,sourcePath,baseCommit,head}]. It validates live persisted task generation, coding/allowedPaths scope, execution membership, running session's exact workspace/base pointer, registered isolated worktree and physical Git common-directory identity. Caller ordering: persist task/session + session WorkspacePointer + execution membership first, finish attributed coding edits, register the source attempt, submit exact clean commit/tree/patch digest, request declared checks, await evidence, then perform verification/integration in the next caller unit. Registration at finishCoding is suitable. Do not pass source paths from model output.

Human project policy is ProjectLabsSchema.ephemeral:{enabled:false,checks:[]}. Names use the existing LabName regex, max10, unique, nonempty if enabled. requestCheck requires its selections be a subset of that human allowlist and exist in the declared recipe; repository recipe references must fit task scope. It accepts command checks only in this unit. WorkerTask constraints and acceptance wiring are deliberately untouched.

TaskLabEvidence has schemaVersion1, attemptId/labId, submittedCommit/tree, patchDigest, recipeDigest, exact all-repository heads, status, cleanup, selected bounded LabCheckResult records and a generic error. No ownership nonce, raw env/command or source path. Existing command/tree verification semantics are not redefined here.

## Implementation notes

- Append-only migration adds validated legacy-compatible labs.kind, immutable task workspace attempts, attempt Lab snapshots, private operations and auxiliary spawn intents.
- Runtime always uses separate Lab worktrees/branches/data/ports from immutable task commits. It neither runs services from nor deletes the worker source or target checkout.
- Services/setup/check commands use a durable nonce-first dormant wrapper; identity/proof is saved before private grant allows execution. Wrapper remains alive after child exit to preserve cleanup ancestry. Spawn-before-PID registration recovery searches exact nonce/marker with runtime-validated OS data, then reuses birth/command-based owned tree termination. No /T or foreign PID kill.
- Persisted task cancel/deadline/lease/run generation is polled during queued execution; old operation ownership cannot grant a new child after losing its operation lease. Safe teardown is independent of the aborted check signal. Ambiguous cleanup retains evidence/reservations and cannot return passed evidence.
- Public retained controls, promotion, team binding and generic retained service adoption refuse task Labs. Recovery stops expired attempt resources before retained service monitoring; stopped retained task Labs do not consume active capacity or keep port reservations.
- Retention removes only validated exact Lab resources after terminal ancestry and inactive merge queue; it keeps branch refs/check metadata and never removes the coding source worktree.

## Validation so far

Package typecheck/build passed after formatting the new source/tests. Initial full lifecycle run passed 5/5 (44.12s). Actual killed-serve-owner cases passed 2/2 (19.57s), against built modules, at spawn-before-PID persistence and while the granted auxiliary command was running. Recovery twice stopped owned resources, freed ports, preserved unrelated foreign HTTP listener, source worktree and retained evidence. Expanded lifecycle10 + existing Labs18 + Labs-service2 passed 30/30 in 145.10s. Following lease-expiry and exact-prune hardening, the affected expiry/prune/actual-kill/foreign-ownership cases passed 5/5 in 58.75s. Final source/dist typecheck and build passed. Final lifecycle12 + Labs-service2 passed 14/14 in 121.17s, followed sequentially by real Chrome static-render and cross-origin refusal regressions 2/2 in 37.57s (6 unrelated browser cases deliberately filtered). git diff --check passed. All worker-started fixture owners/managers/processes were stopped; no live providers, user config/brain/repositories, user panel or installed packages were used. No full repository suite or Next build run by this worker; supervisor owns independent acceptance.

## Scope limits

No task executor/coding caller/verification/integration hook, core schema, panel/API, CLI or provider work in this unit. Ephemeral task Labs are not end-to-end integrated until the later caller unit passes. Browser selections fail closed, not silently skipped. OS process ownership is not arbitrary command/network sandboxing; operator recipe commands remain trusted. Single-host SQLite lifecycle only.

## Findings and explicit recovery limits

The first actual kill fixture exposed a Windows discovery validation defect: CIM includes ProcessId0, so a positive-only global snapshot parser refused recovery before finding the nonce-owned process. The snapshot now allows nonnegative OS rows while actual owned PIDs remain positive. The affected fixture was recovered through its persisted nonce/OS proof before its temp directory was removed. The initial fixture also needed a referenced timer to remain alive at an intentionally unresolved barrier; that harness error was fixed before the successful actual-kill run.

Owner-kill verification covers the serve process, including the pre-registration window, while its independently owned wrappers survive. Those wrappers remain alive after foreground command exit so ownership ancestry can be recovered. Arbitrary daemonization/reparenting, a malicious executable/OS, and every process/ownership race are not OS containment guarantees. Current actual OS acceptance is Windows; other platform paths are not newly claimed verified here. Browser launch/profile/CDP recovery is deliberately excluded and browser check requests are refused.

The caller unit must persist the winning attempt identity in its result and integrate that attempt's commit/worktree, not the latest workspaces row. Required Lab evidence must gate acceptance even if a reviewer/human accepts other evidence. Command-only lifecycle does not complete the L5 task integration or its browser follow-on.

## Owned inventory

New labs/task-attempt.ts, task-attempt-schema.ts, task-attempt-source.ts, task-attempt-store.ts, task-attempt-runner.ts and task-attempt-processes.ts. Owned integrations in labs/lab.ts, store.ts, control.ts, services.ts, promotion.ts, binding.ts, checks.ts, retention.ts, recipe.ts; one appended storage/migrations.ts entry. New tests/labs-task-attempt.test.ts and tests/fixtures/task-lab-owner.mjs. This report only; shared brief edits were already supervisor-authored and remain untouched.

## Required review hardening

Operation heartbeat cannot renew an expired lease, even without takeover. Completion/failure settlement requires matching owner, running state and still-live lease. Lost settlement quarantines provisional evidence and requests stop; recovery atomically acquires a new cleanup lease and invalidates a provisional pass from an expired check owner. Retained phase does not hide unsettled expired operations. Deterministic no-takeover regression expires the operation at the registered-before-grant barrier, allows a heartbeat tick, and proves lease remains0 and no success is settled before fresh recovery.

Every Lab repository path/source/base/branch is checked against its exact attempt/root, not merely managed-directory containment. Process ids have fixed tap_ syntax and directories must belong to that Lab/attempt process record. Prune additionally proves physical Git identity/registration; malformed cross-attempt pointers retain both trees. Source rename/deletion scope checks use --no-renames so the removed path also requires authorization. Runtime checks revalidate the complete immutable repository set and still-owned service listeners before/after check execution. Console/check text removes configured secrets and known host paths; only bounded result text is returned.

Compose service recipes are not supported by this command-only lifecycle snapshot. A future service-union integration must explicitly refuse or implement attempt-owned Compose resources; it must not bypass the auxiliary ownership/cleanup contract.

## Frozen source manifest

SHA-256 of the following sorted path+content-hash manifest: `69ca4d9d42f011bcdcd4bbf488460294f590ee507cee93b3ea580cc9a5e4094d`. Baseline6d61b8e; generated dist is from the observed passed package build, not committed.

```text
packages/router/src/labs/binding.ts 82e0d952d9176e615f76a0e14d9014f1b655bb9690a8f4da224d097fc8e7be38
packages/router/src/labs/checks.ts 0073968455257fcddc1b95fe52dc40f3b2cbd732cb1d67369f98c26aabe7b14b
packages/router/src/labs/control.ts f70a41b6fe2508754bb286298bceaf645c35a85274cc4c860816e9075285acfa
packages/router/src/labs/lab.ts 9310ac07ba7e2ba324efbb59bf5ff92d1f78e5c5a75b54bfdb3e96c9ccca1a4f
packages/router/src/labs/promotion.ts db77c8b954427272c9937951a7b888e056e62d10ff83632541c4257c25e5a01c
packages/router/src/labs/recipe.ts a73f480c6d19966af77c1907d85f6f8a2a0f4eaade49f7eeac1a5af9afacc973
packages/router/src/labs/retention.ts 4c774397b8dc5c81bbbfba31c8dfdfe88e0cca04eabb10da6dab8641a3e69c9e
packages/router/src/labs/services.ts 8ceaed7d4ac1281b8d572564072748b471bf6920a4a2065bb0c01766bbebda06
packages/router/src/labs/store.ts 91b18ae1f42a0465279125cb67bee02548839fb3e7a895481344385f0617d55b
packages/router/src/labs/task-attempt-processes.ts da62162651a389b29b6bdab57c0b7083bd7ea3eca62fd2bd0b491f3a2e2a2529
packages/router/src/labs/task-attempt-runner.ts 5df8f8a855b27d486de2ff1222ee681d0d6ccb6f661077ab7b4ef0985966a524
packages/router/src/labs/task-attempt-schema.ts 4c444b32b9e8bcf2d95ae1722d0b01c19611c708b9efacc07464629febe23800
packages/router/src/labs/task-attempt-source.ts 0262fc4cadb200bb2df5a5b892ce3a70c89e40608343c4671e4c3871647a6009
packages/router/src/labs/task-attempt-store.ts 795e2e962295c69745cf1580dadc267d12426f415b19a248b1426894b85b7dc7
packages/router/src/labs/task-attempt.ts f77738a5698a7d5181fdb6742ca600274acba24e1c1ff21e37aec388f34ff6de
packages/router/src/storage/migrations.ts 461aea84fefb3aed9fa79b02817b53029077db4cec35c1a116637a064f1f8bbe
packages/router/tests/fixtures/task-lab-owner.mjs 20eeae2ac0b9ea8a8fc24e7fe19bac4ab529b0ec3f9cfded70a89c2a363caf9c
packages/router/tests/labs-task-attempt.test.ts 1c2b7806f75b9344fa1950c8bbc2242692045662d23630cf6b1b740af7505eb9
```

## Integration follow-up notes

Configured repository symlink/junction aliases are not acceptance-covered: registration canonicalizes configured source paths while existing LabManager.require compares configured path spelling. This can fail closed; supervisor will review consistent spelling while preserving canonical common-directory and registered-worktree proofs. Do not interpret this checkpoint as symlink alias support.

LabManager.processControls currently awaits the task-attempt batch before the retained control batch. Caller/serve integration should consider draining independent queues concurrently to avoid long task checks delaying unrelated retained-Lab control responsiveness; ownership and resource-cap transactions must stay intact. No task caller exposes this checkpoint to real jobs yet.
