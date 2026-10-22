# Report: labs-core

## Outcome
Done within the assigned L1 core scope. Source frozen in feat/roadmap-labs. Supervisor owns Switchyard lifecycle/public exports/CLI integration and broader acceptance; no commits or pushes.

## What changed and why

New `src/labs/` area:

- `recipe.ts`: strict zod recipe/global/project limits, named ports/data, configuration-owned setup/services/checks, known repository/placeholders, dependency-cycle rejection, loopback HTTP/declared TCP readiness, template substitution.
- `store.ts`: zod-validated persisted lab, recipe, repository, environment, service and state records; scoped lookups and lifecycle event writes.
- `ports.ts`: database-unique port reservations with actual exclusive loopback-bind checks; occupied OS ports skipped and allocation failures release partial reservations.
- `lab.ts`: exported LabManager; scoped create/start/stop/restart/status/list/logs/check/touch/refresh/destroy/recover/tick/close and task-worktree pruning. Per-lab operation locks reject overlapping mutations. Closing aborts and awaits in-flight setup/check/start work before service teardown.
- `environment.ts`: isolated data/home/cache and recipe environment; inherited environment uses existing minimalEnv whitelist and does not pass inherited provider credentials.
- `services.ts`: independent foreground command wrappers, startup/dependency ordering, HTTP/TCP readiness, owner leases, adoption/restart, bounded exponential crash retries, idle stop, capped log-tail reads and rotation. A wrapper outlives its manager only through explicit close({stopServices:false}) or manager failure.
- `process-ownership.ts`: verifies random wrapper token against actual OS command line before adoption/termination. Windows taskkill /T and POSIX process groups stop verified process trees. Descendant listening sockets must use this lab's allocated ports and loopback addresses; public/undeclared listeners are refused and stopped.
- `paths.ts`: rejects traversal and existing symlink/reparse ancestors before filesystem mutations. A per-lab identity marker must match the stored project/name/id. Worktree source must remain the configured repository of that project.
- `checks.ts`: only declared commands run with the lab environment and bounded timeout; records result and exact revision. Dirty starts are refused; concurrent HEAD or uncommitted changes invalidate the check result.
- `revisions.ts`: current linked-worktree HEAD metadata for status without spawning Git for every UI request.
- `retention.ts`: hourly housekeeping of old terminal task attempts whose entire job ancestry ended; only configured-source, Git-registered, clean owned worktrees under storage/worktrees are removed. Dirty evidence and active ancestry remain.

Schemas/migrations:

- Global `labs`: max_active4, max_services16, port_range5100-5999, idle30min, setup/check300s, readiness30s, max_restarts3, restart_backoff500ms, task-worktree retention7days. All configurable/validated; these are policy defaults, not provider facts.
- Project entries accept `lab` and `labs:{max_active?,promotion:manual|supervisor|auto}`; manual default. Resolution validates recipe repository references at config load.
- Appended labs/lab_ports/lab_services/lab_checks/lab_events/lab_promotions migration. No old migration changed.
- Parent-requested cache-accounting prerequisites: optional nonnegative PaidModelSchema.cache_write_input_usd_per_million (no assumed price) and separate appended nullable INTEGER model_requests.cache_creation_input_tokens migration with nonnegative CHECK. No pricing/admission runtime changed.

Creation retains intended worktree metadata before Git creation for interrupted-create cleanup. Each lab has its own branch, worktree and data; target branches are never written. Refresh merges target into the lab, preserves conflicts for repair and updates the tracked target base. Destroy refuses uncommitted work, removes managed worktrees/data, releases reservations and retains committed branches.

## Public integration contract

`new LabManager({db,storageDir,cfg,project:(slug)=>ProjectContext,monitor?:boolean})`.

- `create(project,name,{goal?,targetBranches?:Record<alias,branch>}) -> Promise<LabStatus>`
- `start`, `stop`, `restart(project,name,service?)`, `refresh` -> Promise<LabStatus>
- `destroy(project,name) -> Promise<void>`
- `status(project,name) -> LabStatus`; `list(project?) -> LabRecord[]`
- `logs(project,name,service,tail=200) -> string` (max2000 lines, max1MiB read)
- `check(project,name,declaredName) -> Promise<LabCheckResult>`
- `touch(project,name)`; `recover()`; `tick()`; `pruneTaskWorktrees()`
- `close({stopServices?:boolean}={})`; default stops owned services. CLI start must use false when intentionally leaving the lab running. Explicit false releases ownership leases immediately.

LabStatus has `{lab,services,checks,urls,heads}`. `lab.repositories` records alias/source/worktree/branch/target/base. `heads` maps aliases to current SHA or null. Service records use persisted snake_case fields (pid/token/state/restart_count/owner_id/owner_until/etc.). Token fields are ownership nonces; panel/API responses should omit them. LabCheckResult includes id/name/repository/revision/exitCode/stdout/stderr/killed/durationMs/createdAt.

Public scoped errors include not_found, lab_not_configured, lab_limit_reached, lab_conflict, lab_invalid_state, lab_dirty, lab_invalid_input. Root should map invalid input/configuration to400, not_found404, state/dirty/limit/conflict/active-owner failures409. Some process/Git/readiness failures remain Error/GitError with actionable messages and require root route mapping.

## Commands run and observed results

- `pnpm install --frozen-lockfile --offline`: passed in3m19.8s, 219 cached packages, zero downloads. CLI-bin warnings before dist existed.
- `pnpm --filter switchyard-router build` (and package-local `pnpm build`): passed after final source formatting/validation changes.
- `pnpm --filter switchyard-router typecheck`: passed after final source changes.
- `npx vitest run tests/labs.test.ts tests/projects.test.ts --maxWorkers=1`:17/17 passed in34.07s (8 Labs,9 project regressions).
- Final focused rerun after explicit input/ownership-map validation: `npx vitest run tests/labs.test.ts --maxWorkers=1`:8/8 passed in45.91s.
- One earlier first-run test failed because the fixture concatenated a second slash into /crash; corrected URL construction, then lifecycle tests passed. No product failure hidden.
- `git diff --check`: passed; only Windows CRLF normalization warnings.

The real-process tests cover two concurrent labs with different ports/data and setup output, HTTP readiness, recorded revision-bound check, adoption by a separate OS process retaining PID, crash/restart/backoff cap/manual restart, idle stop, process-tree child termination, branch retention, public listener denial, foreign PID refusal, dirty destroy/check refusal, source-target refresh, overlapping start refusal, cancellation on close, and conservative task-worktree retention. Fixture services are terminated and temporary stores/worktrees cleaned by afterEach; process ownership is verified before any kill. No user install or provider requests used.

## Not verified

- Full integrated router suite, recursive panel build, CLI/MCP transport and UI acceptance remain supervisor work. No service.ts/CLI/index/panel edits made.
- Process/listener ownership tests ran on Windows. Linux /proc and POSIX-group code is implemented but not executed here. Other OS listener inspection fails closed rather than assuming safety.
- Large-store retention scanning/service inspection cost and high-volume log performance are not benchmarked.
- Generic configured processes are trusted configuration. Loopback enforcement inspects actual descendants at readiness and monitor ticks; it is not an OS network sandbox preventing every transient bind syscall.
- A stopped/failed lab still counts toward max_active and retains its reserved ports/data until explicit destroy. Dirty destroy refuses rather than silently losing edits.
- Aggregate lab state remains running while its supervisor monitors a crashed/backoff/failed service; consumers must display individual service states for health.

## Open questions or contradictions found

- A different still-active manager cannot steal a service lease to stop/restart it. CLI operations against a running daemon must route through that owner or add desired-state coordination. New owner recovery after close/lease expiration is verified; unsafe active-owner takeover was not implemented.
- L2 lab_http must verify live process/listener ownership, not just allocated port number, because an unrelated process may occupy a stopped lab's port.
- Prevent project deletion/removal while retained labs need their configured source repositories for safe cleanup.
- Preserve the existing separation: L2 teams/tools/brain and L3 promotion policy/queue execution are future integration phases, not implied by the L1 promotion table. No compose/browser checks implemented here.
