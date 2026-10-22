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

L1-L4 integration is active under roadmap-completion.md. L5 and R2 were explicitly deferred in
their original plans; the current build request keeps them open. This document scopes their
prerequisites rather than treating them as delivered. Isolated implementation now covers an
initial static-render browser-check unit (scripts disabled; not hydrated app acceptance) and
the first async Gate request-accounting boundary. Neither is accepted or merged yet.

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

## Work Ledger

### 2026-10-22 - Follow-on prerequisites inspected
- Agent: supervisor
- Changed: recorded L5/R2 implementation boundaries and acceptance sequence so deferred features remain visible.
- Validation: read current Labs/check/store/session design and inspected Docker/PostgreSQL availability; Docker engine unavailable, no PostgreSQL executable found. No feature implementation or provider calls claimed.
- Outcome: Partial
- Follow-up: complete core integration first, then execute these bounded phases with isolated fixtures and explicit backend acceptance.

## Open Questions

- Owner: supervisor. Select concrete PostgreSQL and object-store deployment fixtures during R2 implementation; availability is not yet verified. No user installation or paid infrastructure is assumed.
