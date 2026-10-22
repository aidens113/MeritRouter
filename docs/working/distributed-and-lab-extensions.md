# Distributed workers and Lab extensions
Status: Active
Status detail: Follow-on architecture scoped during roadmap implementation; no R2/L5 completion claim.
Created: 2026-10-22
Last updated: 2026-10-22
Owner: Senior supervisor agent
Scope: Implement the remaining L5 browser/ephemeral/Compose features and R2 distributed persistence after core Labs integration stabilizes.
Paired document: none
Related: [roadmap completion](roadmap-completion.md), [Labs](labs.md), [sessions and teams](agent-sessions-and-teams.md)

## Current State

Task-attempt lifecycle82ef6bd is merged locally after independent14/14 recovery/source tests
(105.32s). Supervisor follow-up adds opt-in validation, authorization recheck under insertion
lock, all-alias source pins, configured default-cwd ordering, configured junction spelling and
independent retained-control responsiveness. New validation6/6, affected contract9/9 and actual
concurrent-control1/1 pass; router typecheck/build pass. Caller/verification/integration and
safe project deletion are still missing: this is a local prerequisite, not complete L5.
Compose validationce4a257 independently passes10/10; runtime remains disabled.

L1-L4 integration is active under roadmap-completion.md. L5 and R2 were explicitly deferred in
their original plans; the current build request keeps them open. This document scopes their
prerequisites rather than treating them as delivered. Initial static-render browser checks
(scripts disabled; not hydrated app acceptance) and the first async Gate accounting boundary
are now merged locally after independent8/8 actual Chrome and17/17 ledger tests. Whole-head
evidence reuse is integrated; full combined acceptance remains pending. Ephemeral-task plan
is [recorded separately](distributed-and-lab-extensions/reports/ephemeral-lab-plan.md).

L1-L4 and the earlier panel fixes are accepted and pushed at77914fc. The next local unit
at6d61b8e has passed recursive typecheck/build, production policy/model/Labs/legacy browser
checks and an outside-checkout install smoke; the complete router suite passed734/734 tests
in83 files (484.47s). Static browser and async Gate accounting prerequisites are accepted.
Task-Lab lifecycle unit1 remains active in its isolated tree. The default async queue-claim
boundary418b106 is merged locally after supervisor review and20/20 independent tests, including
real separate CLI workers (6 unique claims/provider peak1). Full frozen queue acceptance passed
753/753 tests in85 files (542.28s); recursive typecheck and isolated recursive build passed.
Compose design is recorded in its report; a new-file-only validation/read-only CLI prerequisite
is assigned in a third tree. Runtime Compose integration and actual-engine acceptance remain open.
Caller wiring for task-Lab verification follows lifecycle contract freeze; no ephemeral-task,
Compose or PostgreSQL/multi-host completion is claimed.

The current store is the synchronous better-sqlite3 Database type. Raw prepared statements,
transactions and SQLite expressions reach beyond storage into admission, routing, admin,
sessions and Labs. A PostgreSQL connection substituted into openDatabase would not preserve
these contracts. Filesystem session logs, Git brains/workspaces and local provider capacity
also need explicit host ownership; a shared database alone does not supply multi-host safety.
The concrete [storage inventory](roadmap-completion/reports/distributed-storage-inventory.md)
maps81 direct SQLite consumers in24 areas and the required atomic transaction boundaries.

Environment inspection: Docker CLI exists, but the Linux engine pipe is absent; docker info
fails. No psql/postgres executable was discovered. These are unverified acceptance dependencies,
not a reason to stop the independently runnable core work. No service was installed or started.

## L5 implementation sequence

1. Browser checks: extend the validated declared-check union with a browser kind. Human config
   selects service/path, viewport, executable and bounded assertions/screenshots; models select
   only the declared name. Resolve only a currently owned loopback service using the same
   positive listener proof as lab_http. Capture console/page errors, bounded artifacts and
   exact checked repository heads. Browser and child processes close on timeout/cancel/failure.
   Tests use the installed headless browser against an isolated fixture, including foreign-port
   rebound, cross-origin redirect refusal, failed assertion and screenshot artifact retrieval.
2. Ephemeral task Labs: introduce a task-owned lab kind with persisted task/attempt binding.
   Its source is the task's owned commit/worktree, not the target checkout. Allocate independent
   ports/data and run configured services/checks before integration; persist exact-head evidence
   into the task result. Teardown runs on success/failure/cancel and recovery, preserves useful
   branch/artifact evidence, and cannot delete another attempt's worktree. Promotion excludes
   ephemeral labs. Verify parallel tasks and an actual killed owner.
3. Compose services: extend the declared service union with a Compose kind, preserving command
   recipes. Use a unique persisted project name and SwitchYard ownership labels. Validate the
   resolved Compose document before up: reject host networking, undeclared/public ports,
   privileged containers and writable host mounts outside owned lab data/worktrees. Validate
   inspect output before stop/down and never tear down an unrelated Compose project. Credentials
   stay outside model-visible status/logs. Fake CLI tests cover validation/failures; actual engine
   acceptance covers two isolated labs, readiness, restart, adoption and complete cleanup.

## R2 implementation sequence

1. Inventory and introduce asynchronous repository interfaces by owned subsystem: task claims,
   admissions/reservations, sessions/events/artifacts, coordination, catalog/config metadata,
   projects/brain and Labs. Preserve the SQLite implementation and tests as the default. Move
   direct SQL behind those interfaces before introducing a second backend; do not emulate
   synchronous PostgreSQL calls by spawning a process per query.
2. Add versioned PostgreSQL migrations and backend selection with validated DSN/SSL references.
   Claims use row locks with SKIP LOCKED, conditional lease generation updates and database time.
   Reservations, task/project/endpoint slots, job grants, integration and promotion locks use
   transactions on the same authoritative backend. Stale workers cannot renew or settle another
   generation. Add independent backend contract tests, including rollback and reconnect.
3. Register worker hosts and their capabilities; persist host/workspace affinity. Coding work,
   configured local providers and Labs stay on their owning host. Queue claims refuse missing
   capabilities rather than resolving another host's absolute path. Shared provider/account caps
   remain global. Do not put SQLite on a network volume.
4. Make session events and artifact metadata durable in the selected backend. Store binary
   artifacts through an authenticated object-store interface with bounded verified hashes;
   filesystem remains the single-host implementation. Brain/Git writes require an owning host
   and backend lease, with immutable commit/artifact references crossing hosts. Provider secrets
   remain host/control-plane credentials, never task payloads or model-visible connection data.
5. Two isolated worker hosts share PostgreSQL and fake provider/object-store endpoints. Verify
   exactly one claim/charge, global provider limits, host affinity, dead-host takeover, reconnect,
   lease fencing, session/artifact retrieval and serialized integration. Kill processes during
   reservation, model response, journal persistence and integration; compare durable evidence.
   A two-process SQLite test is useful E7 evidence, but is not two-host PostgreSQL acceptance.

## Worker Briefs

### Brief: ephemeral-lab-integration-plan
- Repository: root read-only source at77914fc; browser WT stays frozen under supervisor tests. Report only at `docs/working/distributed-and-lab-extensions/reports/ephemeral-lab-plan.md` in root.
- Task: inspect actual task attempt/workspace/finish/verification/integration pipeline and Lab ownership APIs; produce executable L5 ephemeral-task-lab plan with exact interfaces and file partitions. Read Current State/L5 sequence above; browser unit report in its WT for new checks/artifact fields.
- Owns: only own report. No code/shared docs/branches/generated files/commits/services/provider calls/user data. No modifications to the frozen browser tree.
- Required decisions: opt-in declared checks contract and configuration/task validation; exact immutable task-attempt heads/owned source; isolated branch/data/ports; coding output-to-verification hook before integration; cancellation/timeout/kill recovery teardown; retained evidence vs destroy/retention; promotion exclusion and no shared Lab-team claim conflicts.
- Preserve task allowedPaths, provider budgets, attribution, normal jobs and Labs. No arbitrary model commands or new authority from prompt text. Stored task-attempt ownership must fence cleanup and keep another attempt's worktree untouched.
- Output exact new schemas/migration needs, signatures, primary owned files and affected caller tests. Distinguish designs from implementation/verification. Include actual killed-owner fixture acceptance. Do not silently substitute reusing one shared feature Lab for per-attempt isolation.
- Return bounded first implementation brief recommendation; supervisor independently reviews, writes next brief and dispatches after current browser source is accepted/frozen.

### Brief: request-ledger
- Repository: `.claude/worktrees/roadmap-process`, branch `feat/roadmap-request-ledger`, baseline6a77c4a. Source dependencies reconciled by supervisor; isolated from root/panel/browser work.
- Task: implement the report's first integrated async request-accounting slice. Read own distributed-storage-inventory report and Current State above; preserve single atomic SQLite accounting and synchronous compatibility facade.
- Owns: new admission/request-ledger.ts and sqlite-request-ledger.ts; admission/admission.ts; gateway/direct.ts and gate.ts; necessary core/service.ts wiring; new request-ledger and gate-request-ledger tests; own report `distributed-and-lab-extensions/reports/request-ledger.md`.
- Must not touch: Labs, panel, CLI, schemas/config/migrations, package manifests/lock, paid math or public exports/shared docs. Ask if boundaries need expanding. No commits/push, provider calls, installation/services, or user data.
- Contract: validated data-only DTOs (no PaidSpend/Db/functions/secret credentials), awaitable reserve/reconcile used by the actual default routed Gate path, not unused scaffolding. Retain one shared SQLite transaction implementation for sync facade and async adapter; do not duplicate budget/price math.
- Preserve commit-before-provider, await settlement before return/fallback; abort during reserve never dispatches afterward. Settlement failure after possible consumption is persistence uncertainty and must not trigger another endpoint/paid call. Preserve paid/participant atomicity and conservative unknown billing.
- Scope: SQLite remains the only enabled backend; no PG selector/driver or multi-host claim. This is prerequisite one, not R2 completion. Check actual latest accounting changes after merge rather than using older inventory assumptions.
- Acceptance: delayed/rejecting ledger at Gate proves ordering/no-network-before-reserve/no-fallback-before-settlement/cancellation; actual default service task persists unchanged rows; rollback no partial request/participant/paid rows; batch/paid/uncertain/mismatch cases. Run focused existing admission/paid/cache/provider/budget/process checks plus router typecheck/build. Report exact checks/limits and freeze.
- Structure: keep transaction extraction by concern; diagnose >800-line files before any split. Worker only writes owned source and own report; supervisor integrates authored docs/exports and independently verifies.

### Brief: labs-browser
- Repository: `.claude/worktrees/roadmap-labs`, branch `feat/roadmap-labs-browser`, baseline e99da6b; isolated from ongoing core/panel acceptance.
- Task: implement L5 declared browser checks only; ephemeral task labs and Compose remain subsequent units. Read Current State and L5 sequence above, labs recipe/check/http ownership implementation and focused tests.
- Owns: labs recipe/check/browser implementation and necessary labs integration files; new browser-check tests/fixtures; own report `distributed-and-lab-extensions/reports/labs-browser.md`.
- Must not touch: panel, core service/executor, CLI, config/project schemas, migrations, package manifests, public exports or shared working docs. Ask supervisor for necessary cross-boundary changes. No commits/push, real providers or user install.
- Contract: human recipe chooses browser executable/service/path, bounded viewport/time/artifact sizes and assertions; models select declared check name only. Existing command checks remain backwards compatible. Validate inputs and stored evidence with zod.
- Security: positively prove current owned listener before/after; enforce loopback service origin for navigation and subresources, refuse redirects/requests to other origins (including browser network side channels where feasible); no arbitrary evaluate/script action from model. Do not equate URL string validation with browser network containment. Fail closed if browser interception cannot enforce the declared boundary.
- Capture exact checked heads, bounded screenshot artifact references plus console/page errors; redact configured secrets, avoid model-visible host paths/commands. Cleanup owned Chrome/profile/listeners on timeout/cancel/error. Keep raw pixels outside public status/logs.
- Acceptance: actual installed Chrome isolated fixture pass/assertion failure; foreign port rebound, cross-origin redirect/subresource denial; bounded output/screenshots and cancellation cleanup; existing Lab check tests. Record any browser containment limitation candidly and do not silently widen trust.
- Verification: own narrow tests/typecheck in this isolated tree, report exact results, then freeze for supervisor review. Do not run Next build. Worker never edits this brief/current state/ledger.

### Brief: task-lab-lifecycle
- Repository: `.claude/worktrees/roadmap-labs`, branch `feat/roadmap-task-labs`, baseline6d61b8e. Isolated from combined root/panel acceptance.
- Task: implement unit1 of own ephemeral-lab-plan report: durable task-attempt identity, isolated exact-head Lab lifecycle/queued checks/teardown/retention, and auxiliary process ownership recovery. Caller/verification wiring is a subsequent serial unit; do not claim ephemeral task integration complete now.
- Required reads: Current State and own report's schemas/APIs/teardown/file partitions/acceptance. Existing static browser and awaited accounting are merged; preserve their contracts.
- Owns: new named labs/task-attempt*.ts modules; labs/store.ts, lab.ts, control.ts, services.ts, promotion.ts, binding.ts, retention.ts, recipe.ts; browser-process/check and command setup/check registration hooks; append storage/migrations.ts only; new task-attempt tests/fixtures and own report `distributed-and-lab-extensions/reports/task-lab-lifecycle.md`.
- Must not touch: core service/executor/task, workspaces/task store, runners/coding/verification/harness, admission/gateway, panel/admin/CLI/public exports/config schema/project schema/shared docs or packages. Send stable handle/queue/evidence API early; root owns integration boundaries and preserves new ephemeral config through recipe UI later.
- Enforce persisted attempt UUID+task project/lease/run_count identity, not latest task workspace pointer. Verify immutable attributed commit/tree/all-repo heads and physical Git/worktree ownership before creating separate services; never run from/delete the worker source or target checkout.
- Retained-vs-task kind must be validated/migrated with legacy compatibility. Public retained-Lab mutation/promotion/team binding must refuse task Labs at actual boundaries. Stopped safely retained task evidence releases active capacity/ports; cleanup_blocked retains ownership/reservations and refuses success/prune.
- Auxiliary setup/check/browser children require durable spawn intent+nonce and dormant-until-registration launch; recover spawn-before-PID persistence without broad PID kills. Validate birth/command/marker, retain ambiguity, and terminate known owned children before root removal. Do not claim killed-owner cleanup from finally blocks.
- Execute lifecycle through current Labs serve owner with task-aware cancellation/deadline/generation polling; no model worker auto-start. Public model control bodies cannot forge internal attempt operations. Browser pixels/artifact hashes remain private/bounded and retained after normal teardown.
- Acceptance: two real isolated attempt services/checks/data/ports, exact-head and cross-project/foreign-source refusals, normal failure/cancel/timeout, actual killed owner at declared barriers (including auxiliary and spawn-registration window), repeat recovery and foreign listener survival, capacity/retention/promotion exclusions. Fake providers/temp installs only, no user data/4477. Existing lifecycle/browser regression proportional; typecheck/build then freeze.
- Structure: attempt concern goes in named modules, diagnose lab.ts growth and do not dump all logic there. No commits/push/shared-doc edits. Report limitations; command-only checkpoint may reject browser attempts until durable recovery is actually verified, never silently accept without evidence.

### Brief: task-queue-port
- Repository: `.claude/worktrees/roadmap-process`, branch `feat/roadmap-queue-port`, baseline6d61b8e; isolated from supervisor acceptance and task-Lab lifecycle worker.
- Task: implement the next exercised async SQLite queue boundary: default Scheduler must await data-only queue claims/companion claims, preserving existing atomic claim policy and sync TaskStore compatibility. This prerequisite is not distributed/PG completion.
- Required reads: Current State of this document; own distributed-storage-inventory report's queue contracts; storage/tasks.ts, fair-claim.ts, file-leases.ts, core/scheduler.ts and actual constructor/caller tests as needed.
- Owns: new storage/task-queue.ts and sqlite-task-queue.ts; storage/tasks.ts if shared core extraction necessary; core/scheduler.ts and minimal core/service.ts wiring; new task-queue/scheduler async tests; own report distributed-and-lab-extensions/reports/task-queue-port.md.
- Must not touch: migrations (owned by Lab worker), Labs/workspaces/runners/executor/admission/gateway/config/project schemas, panel/CLI/index, manifests/lock, shared docs. Ask before expanding scope; no commits/push, installations, live provider calls, user data or services.
- Contract: validated DTO requests/results, no Db/JS callbacks or predicates crossing the port. SQLite adapter privately owns actual policy dependencies (project/provider limits, redundancy/batch compatibility); use current effective config and single shared TaskStore transaction logic. Do not move authoritative limits to caller snapshots or duplicate admission math.
- Claim compatibility: retain fairness, job/project/provider/global/writer/file caps, deadlines, profile modes, prompt batching and redundancy isolation. A companion cannot escape the existing same-project batch/cap rules.
- Await safety: serialize tick operations; track pending claim/companion promises; stop waits for pending queue operations, dispatches zero new executors after shutdown, and releases or safely interrupts exactly its newly acquired leases. Fail closed on queue errors; no unhandled timer rejection or premature DB close. Avoid executing a stale lease after delayed await; recheck persisted validity immediately before dispatch.
- Keep synchronous recovery/renew/finish compatibility for this bounded unit; explicitly list unmigrated operations. Do not introduce PG selection, host registration or claim generation semantics without a reviewed next contract.
- First send supervisor concrete DTO signatures and shutdown/companion strategy after inspection, then implement within scope. If no data-only policy-safe adapter is possible within these files, report exact blocker instead of shipping callback-bearing scaffolding.
- Definition of done: actual default service Scheduler uses port; delayed/rejected claim and companion fixtures prove serialization, shutdown drain/no post-stop dispatch, errors fail closed, no lost owned lease; existing fairness/batching/provider/writer/process tests pass. Run router build/typecheck and focused tests, record exact results, freeze for independent supervisor review.
- Report to: docs/working/distributed-and-lab-extensions/reports/task-queue-port.md; distinguish implemented SQLite async prerequisite from remaining R2 work.

### Brief: compose-services-plan
- Repository: `.claude/worktrees/roadmap-team`, accepted source baseline5b4725a contains browser checks; read-only source investigation. Isolated from active lifecycle/queue work.
- Task: produce executable L5 Compose-services design and bounded implementation brief for later integration. Current work is planning only; do not install/start Docker, containers or services.
- Required reads: Current State/L5 sequence here, labs/recipe.ts, services.ts, process.ts, ports.ts, store.ts, lifecycle ownership/recovery files as needed. Source is frozen in your tree; don't merge/rebuild.
- Owns: only own report docs/working/distributed-and-lab-extensions/reports/compose-services-plan.md. No shared docs/source/tests/config/package edits; no commits/push or user data/provider calls.
- Must define: command-vs-compose recipe union/backward compatibility; unique persisted project/generation labels; resolved-config validation before effects; allowed lab worktree/data mounts only; no host network/privileged/public ports/foreign writable mounts; image/build/secret/environment authority stays human-declared and private.
- Trace durable create/start/readiness/restart/adopt/stop/destroy and hard-kill recovery. Persist command intent before engine calls; verify current inspect ownership before stop/down. Explicitly handle foreign project/name collision, lost engine response, partial container/network/volume creation, stale incarnation, unavailable engine and bounded cleanup.
- No broad compose command passthrough or model-authored Docker config. Separate actual host-engine security properties from assumptions; never treat labels alone as authority if forged or stale. Identify immutable engine/container ID+generation proof.
- Output exact proposed schemas/migration/API changes, file partitions after task-Lab lifecycle freezes, fake-CLI acceptance and actual two-isolated-Lab engine acceptance. Note currently unavailable engine is unverified acceptance dependency, not proof of support.
- Definition of done: report actionable enough to implement without rediscovery, concrete bounded first brief, no runtime changes or engine starts. Include commands/reads observed, missing dependencies and user-facing limitations.

### Brief: compose-validation
- Repository: `.claude/worktrees/roadmap-team`, branch `feat/roadmap-compose-validation`, baseline9682e92; independent new files only while task-Lab lifecycle owns existing Labs/migrations.
- Task: implement C1 strict authored/canonical Compose validation and a bounded injected read-only config/image-inspect CLI adapter. Produce a validated generation plan, not runtime Compose dispatch/support.
- Required reads: Current State here and own compose-services-plan report; use verified official references for external CLI semantics.
- Owns: new labs/compose-recipe.ts and compose-client.ts (additional specifically named compose validation files only if size needs it); tests/labs-compose-validation.test.ts and fixtures/compose/**; own report distributed-and-lab-extensions/reports/compose-validation.md.
- Must not touch: existing recipe/services/lab/store/process/http/browser/migrations/config/core/panel/public exports/manifests/lock/shared docs. No commits/push, real engine/containers/install/providers/user data. Do not merge active lifecycle changes.
- Human authority: approved digest-pinned preloaded images, explicit private env and owned bind sources/ports. No model-authored authority. Initial scope rejects builds, secrets, named/anonymous volumes, remote engines and unknown features; inspect image VOLUME before accepting a plan.
- Boundaries: zod every input/resolved config/stored-plan/CLI response; validate imports before normalization, fixed argv/minimal env/controlled interpolation/private snapshotted manifest, realpath+ancestor ownership proof. No shell or mutating Docker verb reachable. No public/wildcard ports, privileged/host namespaces or foreign mounts. Browser endpoint ownership is unresolved C2 dependency, not assumed.
- CLI adapter: only config JSON and typed image inspection, injectable fake executable; bounded bytes/time/cancel, private scratch cleanup and sanitized errors. Engine identity/capability can be a validated prerequisite DTO if exact remote semantics cannot be proven here. No raw canonical config/environment in public output.
- Acceptance: safe fixture normalized deterministically; imports/unsafe fields/foreign or symlink paths/public ports/image VOLUME/malformed or oversized output/capability mismatch refuse; cancellation and Windows argv/path cases. Assert no mutating verb ever executes. Existing command recipes unchanged.
- Record exact tests/typecheck/build, limitations and next durable journal integration contract; freeze for supervisor independent verification. Do not claim C1 completes Compose/L5 or actual engine acceptance.
- Report to: docs/working/distributed-and-lab-extensions/reports/compose-validation.md.

### Brief: task-lease-fence-plan
- Repository: frozen `.claude/worktrees/roadmap-process`, source418b106; report-only investigation while task-Lab and Compose implementations run separately.
- Task: design executable next R2 unit for async renew/finish/recovery/cancel and immutable task-attempt generation propagation. Inspect actual callers and propose a bounded serial file partition; do not change source.
- Required reads: Current State here, own distributed storage inventory/task-queue report; storage/tasks.ts, core/executor.ts/scheduler.ts, runners/types.ts, Gate/admission participants and actual generation/lease callers as needed.
- Owns: only docs/working/distributed-and-lab-extensions/reports/task-lease-fence-plan.md. No shared docs/source/tests/commits/build/services/provider/user data changes.
- Determine exact current stale-owner failure windows with source references; distinguish source inference from reproduced failures. A stale attempt must never renew/finish/change another run when owner string is reused; cancellation/recovery must retain intended terminal/interrupted semantics.
- Proposed LeaseRef must carry captured immutable taskId/owner/runCount (or justified durable generation), not read current run from DB on behalf of old context. Trace initial run, repair/twin, resume, classifier, batch, provider slots, reservation/settlement, session journal and integration.
- Define validated async DTOs and atomic authoritative policy/CAS checks preserving SQLite compatibility/fairness/caps and server-time expiry semantics. No callbacks or SQL handles crossing port, no PG-by-process wrapper, no enabled second backend while sync dependencies remain.
- Resolve async executor heartbeat/error/shutdown lifetimes, claim-to-context capture, stale provider receipt reconciliation versus new-generation task mutation, and exact idempotency behavior. Paid uncertainty must not cause duplicate spend or release a newer reservation.
- Output concrete API changes, exact owned files/tests, integration order with pending task-Lab caller changes, bounded first implementation brief and acceptance fixtures. No scope expansion into session/object/host backends; list dependencies clearly.
- Definition of done: actionable report with focused actual-code evidence, safe ordering and failure tests; no feature/fencing/PG completion claim. State any unresolved architecture choice that needs supervisor decision.

## Work Ledger

### 2026-10-22 — Async queue accepted
- Agent: supervisor.
- Changed: accepted418b106 plus public validated DTO exports at6754a11. Default Scheduler uses awaited claim/companion port; no PostgreSQL claim.
- Validation: independent20 focused tests including actual separate CLI workers; full753/753 in85files (542.28s), recursive typecheck and isolated recursive build. No source edits during checks; only later docs/export publication differs from tested queue tree. Existing paid/verification/browser/process regressions pass.
- Outcome: Accepted coherent queue prerequisite. Renew/finish/recovery/session/Git APIs remain synchronous; next task-Lab/Compose/request-page work is separate and not included in this unit.

### 2026-10-22 — Queue prerequisite and authorized user operations
- Agent: supervisor.
- Changed: integrated async default scheduler claim/companion boundary418b106 after source review; public data contracts exported. Next generation-fence report assigned separately. Compose plan reviewed; bounded validation prerequisite assigned, runtime integration remains open.
- Validation: independent20/20 queue/scheduler/actual separate CLI worker checks (7.15s), recursive typecheck pass. Full85-file router acceptance running in frozen queue tree; no claims from pending results. Lifecycle worker's actual kill tests are worker claims pending independent supervisor review.
- User operations: explicit approval granted panel rebuild/restart; accepted9682e92 built and served4477, config unchanged, actual model/settings/Verification browser checks passed. User then requested clone deletion: project resources removed via supported API without problems, server stopped, remaining repository moved to Recycle Bin after automatic permanent-delete rejection. No new clone build yet.
- Outcome: Partial. Continue task-Lab lifecycle hardening/integration, Compose validation and remaining R2 contracts; no complete roadmap claim.

### 2026-10-22 - Follow-on prerequisites inspected
- Agent: supervisor
- Changed: recorded L5/R2 implementation boundaries and acceptance sequence so deferred features remain visible.
- Validation: read current Labs/check/store/session design and inspected Docker/PostgreSQL availability; Docker engine unavailable, no PostgreSQL executable found. No feature implementation or provider calls claimed.
- Outcome: Partial
- Follow-up: complete core integration first, then execute these bounded phases with isolated fixtures and explicit backend acceptance.

## Open Questions

- Owner: supervisor. Select concrete PostgreSQL and object-store deployment fixtures during R2 implementation; availability is not yet verified. No user installation or paid infrastructure is assumed.
