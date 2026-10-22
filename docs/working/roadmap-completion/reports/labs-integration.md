# Report: labs-integration

## Outcome

Done within assigned L2/L3 scope; source frozen in feat/roadmap-labs-integration after final focused validation. No commits/push. Supervisor owns integration, CLI/panel/service acceptance and whole-roadmap status.

## What changed and why

- `labs/binding.ts`: persisted root supervisor claim, one live root team, descendant/project/repository inheritance, configuration preview and managed-worktree overlay, explicit base ancestry enforcement. Claims run synchronously inside the service task-submit transaction.
- `labs/control.ts`: validated durable create/start/stop/restart/check/refresh/destroy/after_integrate/promote operation queue, scoped retrieval/wait, atomic expiring execution claims, heartbeat, foreign-owner deferral, creation lease deferral and interrupted completed-create recovery. API clients enqueue/poll; the explicit supervisor processes requests. Waiting never executes requests or starts model workers.
- Windows process ownership follow-up: excludes older processes whose stored parent PID was reused, validates exact creation ticks and command identity, kills individually leaf-first with no taskkill /T, and checks every known target is gone. Durable private process-tree proof sidecars retain the union of known births/commands; missing wrapper plus known live orphan refuses cleanup/restart/destroy and preserves PID/token/worktree/proof, marking the service failed. Proofs contain internal command identity and are never exposed through status/log APIs.
- `labs/http.ts`: declared running HTTP service only, OS ownership nonce plus positive descendant socket ownership on the requested allocated loopback port, fixed origin, strict header allowlist, all redirects refused, bounded timeout/body. Rechecks process identity after response. Windows CIM rows validated with zod. Linux socket inode ownership implemented; unsupported platforms fail closed.
- `labs/coordination.ts`: exact heads, ahead/behind and overlapping changed paths between same-project labs targeting the same source branch.
- Promotion now rechecks configured repository writability at the target mutation boundary, excludes readonly targets from mutations/manual instructions, and refuses any readonly candidate containing lab-only commits; regression verifies committed readonly changes cannot advance target.
- `labs/promotion.ts`: persisted promotion attempts and physical-repository/target leases, refresh into lab, settled descendants, clean owned branch/worktrees, configured checks on captured revisions, target/ref/head rechecks before mutation. Manual policy returns target checkout and exact-SHA merge commands without changing target. Automatic/supervisor policy uses clean target checkout fast-forward or compare-and-swap ref update. Conflicts remain in lab. Multi-repository partial promotion is explicit; no destructive rollback of a target already advanced.
- `labs/public-status.ts` and manager projections: omit recipe/environment/ownership nonce fields; redact known environment values and service tokens from logs/check output. Safe operation metadata, promotion reason/results/manual instructions, current ownership local/other/null. Internal status remains trusted-only.
- `labs/tools.ts`: bound-task-only status/logs/restart/check/http and root-supervisor-only promotion. Scope comes from persisted task context; current root-team claim checked on invocation. Model mutations always queue with actor/cancellation, including after-integration hooks.
- `labs/lab.ts`: integration APIs, live limit reload, creation leases, independent service lease renewal during long queued operations, exact-revision restart/check hook, active root job prevents idle stop. Existing recipes remain snapshots.
- Task/RunContext schemas expose optional lab; supervisor root integrates directly on managed lab branch, delegated specs inherit lab, subjobs retain own branches. Merge hooks request declared restart/on_integrate checks and record results. Final lab-root acceptance uses latest clean exact-head declared lab checks.
- Persistent `projects/<slug>/labs/<name>.md` is the root team's active working document. Authorized narrow brain classifier recognizes only exact lane paths; nested paths retain prior classifications. Regression covers Current State, ledger, channel and denied worker writes.
- Scoped MCP status/logs/control/operation tools and start_job.lab; charters/delegation example explain inheritance, exact checks and promotion policy.
- Appended migration creates teams/operations/target locks and creation leases. Prior migrations unchanged.
- Root-authorized test correction: lab-supervisor.test.ts raw TaskStore spec now supplies context/constraints.

## Integration contract

`LabManager.configuration(project,name):ResolvedConfig` previews repository overlays without claim or persistence. `bindTask(project,taskId,spec,tasks):LabRunContext|null` is synchronous and transaction-safe. `contextForTask(...)` returns `{binding,cfg}`; `assertTaskBases(binding,spec,tasks)` is async and runs before workspace preparation. `LabRunContext` carries manager/project/name/rootJobId/labId.

`requestControl(project,name,input,by?) -> LabOperation`, `operation(project,name,id)`, `waitOperation(project,name,id,{timeoutMs?,signal?})`, `control(project,name,input,by?,options?)`, `processControls()`. Requests support create/check/refresh/destroy/start/stop/restart/promote/after_integrate. Serve owner processes; CLI/API instances do not tick/adopt. `reloadConfig()` updates validated global service limits.

`publicStatus`, `publicOperation`, `publicOperations` are safe UI/CLI projections. `http`, `logs`, `coordination`, `afterIntegration`, `promote`, `redact` expose scoped behavior. Harness export `labHarnessTools()` is added by root to native/external assemblies; supervisor assembly is included here.

## Commands run and observed results

- Frozen offline install previously completed for L1; no dependency changes/downloads in this phase.
- Router build/typecheck passed after initial APIs. Latest package `pnpm exec tsc --noEmit --pretty false` passed after root service wiring and authorized fixture correction.
- Initial 11-case labs run: 10 passed; root-team fixture lacked a supervisor profile, corrected and retested successfully.
- Five-case integration run: four passed; conflicting-labs fixture had no labs policy object, corrected.
- Subsequent 13-case labs run passed all; root labs-service atomic binding test passed. Scripted test initially exposed fixture missing source file then missing independent worker check; fixed both without weakening acceptance.
- Scripted job then passed branch/worker/source/restart/check assertions and exposed actual brain lane classification defect; authorized fix and brain tests added. Final validation:
- Consolidated `pnpm exec vitest run tests/labs.test.ts tests/labs-scripted.test.ts tests/labs-service.test.ts tests/brain.test.ts --maxWorkers=1`:27/27 passed in75.23s after Windows creation-time/individual-kill correction.
- Root review requested explicit missing-wrapper/live-orphan evidence retention; added durable proof, final target check, safe failure projection, and regression. Subsequent focused labs/scripted/service run:17/17 passed68.38s before final orphan union/refusal coverage; one19-case run passed71.30s. A separate19-case run exposed a legitimate exiting-wrapper CIM row losing command identity during cleanup. The stop path now skips all unverifiable targets and only succeeds once every known birth is observed gone, with a bounded quiescence wait; surviving/changed same-birth targets preserve evidence and fail closed.
- Final `pnpm exec vitest run tests/labs.test.ts tests/labs-scripted.test.ts tests/labs-service.test.ts --maxWorkers=1`:20/20 passed in71.68s, including exact scripted integration, orphan preservation and read-only target refusal. Final formatting-only pass followed by package typecheck passed. No further source edits/tests running at freeze.
- A prior consolidated run caught the PID-reuse false listener association at4477. Corrected the actual process-tree logic; the user's existing panel is off limits and no broad PID-tree kill remains. A subsequent run caught redaction of generated LAB_NAME; redaction now covers configured recipe environment values while preserving generated public identity.
- Final package `pnpm exec tsc --noEmit --pretty false`: passed after process proof and public output changes.
- `git diff --check`: passed (only CRLF normalization warnings).

## Not verified and limits

No live providers or paid requests. No panel/CLI lifecycle acceptance owned here; root verifies those. Windows exercised with real fixture processes. Linux/macOS behavior not live-tested: Linux has /proc ownership/socket implementation, unsupported listener platforms fail closed. Manual commands are instructions tied to exact checked SHA; an external human merge occurs outside service enforcement. Multi-repository promotions can report partial if a later target fails after an earlier fast-forward; no history rewrite attempted.

OS process/socket inspection and external Git state are observations, not atomic OS sandbox transactions. Foreground service recipes are required; an unobserved daemonized child created between snapshots cannot be guaranteed contained. Known live or ambiguous orphans block cleanup and retain evidence for manual investigation; the service does not kill a process solely because a stale parent PID points to its ID.

Fixture cleanup closes owned service managers before SQLite/temp cleanup; process ownership checked before termination. Tests used temporary configuration, state and repositories. Commands did not explicitly target the existing user panel; supervisor separately owns panel health verification.


## Exact changed-file inventory at freeze

New source: labs/binding.ts, control.ts, coordination.ts, http.ts, promotion.ts, public-status.ts, tools.ts.

Modified source: labs/lab.ts, process-ownership.ts, services.ts, checks.ts, ports.ts, revisions.ts, store.ts; core/task.ts; runners/types.ts and supervisor.ts; harness/supervisor-tools.ts and integration-tools.ts; mcp/tools.ts; storage/migrations.ts; authorized narrow brain/brain.ts classifier.

Tests: labs.test.ts, new labs-scripted.test.ts, authorized brain.test.ts lane regression, root-authorized lab-supervisor.test.ts fixture correction. Root-owned labs-service.test.ts was run but not edited.

Authored guidance: charters/supervisor.md, worker.md, implementer.md; examples/CLAUDE.delegation.md. This report only under shared working-doc tree; no shared plan/handoff edits.

No commits or pushes. Supervisor must independently inspect and verify before accepting the phase. Root's later native/external/read-only tool and worker-lane context injection are separate integration work, not claimed verified by this snapshot.
