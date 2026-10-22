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

Request-only release663626d is now pushed to dev/main after783/783 (88files,943.08s),
recursive typecheck/build and production browser acceptance. Authorized4477 update completed:
accepted663626d rebuilt at root, livePID24040 and populated recorded exchange verified; config unchanged.
Local async task lifecycle19268e7 is merged: supervisor independently50/50 (16.67s), plus
root scoped receipt purge/tombstone + task-Lab deletion10/10 (25.68s). Public lease DTO exports
and authored operations guidance are added; complete combined acceptance/package remains pending.
Compose known-resource proofcff80fa independently80/80 (862ms) and is merged locally.

Accepted and pushed through8d22596: L1-L4, static-render browser checks/all-head evidence reuse,
async Gate accounting and default async queue claims. Last accepted queue suite753/753 in85
files (542.28s), recursive typecheck/build and independent real CLI workers passed. Static
browser checks execute no app JavaScript; this is not hydrated acceptance.

Local integration throughb766516 includes task-attempt lifecycle82ef6bd, root authorization/
all-alias pin/default-cwd/physical identity fixes, nonblocking service monitoring, caller98ab27a
and public human acceptance/write fencing. Supervisor independently verified14 lifecycle tests,
8 caller/verification tests,49 integrated checks and7 project-purge checks; actual dedicated
Labs supervisor service startup passed14.22s and fixture stopped. Router typecheck/build and
panel typecheck pass. Scoped immediate project prune4a239ab independently passed11/11 (65.19s); root confirmed
delete integration9/9 (22.84s) passed actual resource cleanup and dirty refusal. Complete
combined acceptance/package and updated production panel acceptance remain pending. No complete
L5 claim; task browser recovery is absent.

Compose validationce4a257 independently passed10/10; immutable full-ID resource proof181d18e
independently passed51/51 (648ms). Both are local prerequisites; runtime is disabled. Engine
mutation, durable container ownership and real-engine acceptance remain open. Browser hydration design
is [reviewed](distributed-and-lab-extensions/reports/hydrated-browser-plan.md): flags/CDP alone
do not prove before-contact denial of every transport. Pipe/capability H1 independently passed26/26 (1.12s) and is merged locally; no accepted network isolation adapter exists on this Windows host, so hydrated
runtime cannot yet be enabled. No OS services/firewall/Docker activation authorized. Read-only follow-up found a usable Ubuntu
WSL2 host: root unshare --net true succeeded; Linux Node/Chrome fixture tools remain absent.
Native Linux isolation investigation is active without host configuration changes.

Next R2 request-admission-protocol is ready for serial source dispatch after the accepted
local lifecycle merge. It carries strict LeaseRef into Gate/batch/classifier, durable request
reserve/intent/settle receipts and conservative local transport holds. Its worker owns the next
appended migration exclusively; root owns project purge/exports and combined acceptance.
Compose engine-contract work owns only new pure port/schema/builder files, no migration.
PostgreSQL, policy/key/session/tool/Git ports and actual two-host acceptance remain open.

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

### Brief: linux-browser-isolation-plan (seed_repair)
- Tier: isolated roadmap-team report-only design against newly discovered Ubuntu WSL host, not runtime enablement.
- Read Current State, hydrated-browser-plan.md/H1 reports and browser isolation/pipe/process/network/check contracts as needed.
- Own only reports/linux-browser-isolation-plan.md. No existing/shared source/docs/config/migrations/user data changes.
- Root read-only discovery: Ubuntu distro runs Linux6.18.54.1 WSL2 asuid0; unshare --net /bin/true succeeded. /usr/bin/unshare/python3/curl exist. Node/Chrome/LinuxPostgres absent from initial command discovery. Windows Docker CLI is in inherited PATH; do not invoke it. Another registered distro lacks its backing disk; do not repair/reconfigure it.
- Allowed: bounded read-only Ubuntu capability/library/version queries and short-lived isolated namespace probes that exit immediately. No apt installs/downloads, engine/service/firewall activation, host config changes or distro termination.
- Goal: concrete first native Linux deny-all browser network adapter + trusted helper unit, using current H1 nominal lease and CDP pipe, positive kernel namespace/process-birth/descendant proof and owner-death cleanup.
- Account for AF_UNIX/system resolver/portal/DBus and inherited descriptors/env as well as TCP/UDP/DNS/IPv6; a bare netns assertion cannot silently claim all transport isolation if host services can broker traffic.
- Specify privilege/capability drop and proc/mount namespace policy, exact child containment/handshake before navigation, lease assertion and no stale PID adoption. Preserve artifacts/proof on ambiguous cleanup.
- Human trusted executable boundary and browser escape limits explicit; no model URLs/evaluate/scripts/config authority. Static compatibility remains unchanged.
- Plan temporary portable Node/headless Chrome/dependency fixture under owned temp paths without OS service installation; list required primary verified URLs/checksum/version provenance and unresolved dependencies, no downloads now.
- Define actual zero-contact TCP/UDP/DNS/WS/SW/worker/popup/redirect tests with interception intentionally bypassed; owner crash/FD/profile cleanup and unsupported-host refusal.
- Return reviewed source partition and <=40line first implementation brief, actual capability observations, risks and exact environment limitations. No code/build/runtime completion claim or commits.

### Brief: compose-engine-contract (link_completion)
- Tier: fresh isolated roadmap-labs branch from root baseline named at dispatch; bounded C3 prerequisite, runtime unavailable.
- Read Current State, compose-journal-plan.md, C1/C2/partial proof contracts and reports. Typed local Engine API selected for eventual transport; no actual client/runtime in this unit.
- Own only NEW labs/compose-engine-schema.ts + compose-engine.ts (named private builder split allowed), new engine-contract tests and reports/compose-engine-contract.md.
- No existing source/client/recipe/proof/manager/services/config/public export/shared doc changes. NO migration/SQLite journal; admission worker owns next migration.
- Define strict bounded private engine effect/request/response DTOs and injected port for original create receipts, exact-ID inspect/start/stop/remove and same-engine404 observations. Unknown transport outcomes explicit; no implicit retry/discovery adoption.
- Pure builder derives versioned closed request plans from original full sealed approval + trusted accepted profile/current creation identity; no arbitrary caller Engine JSON/URLs/argv or TCP/context fallback.
- Preserve full argv/entrypoint/default-CMD/env/multiline/dollar/bind/publication/hardening semantics and C2 labels/image-config distinction; reject unrepresentable or unsupported input rather than reinterpret.
- Network/container creation uses explicit original intent/nonce/request identity. Network ID must be committed before a container plan references it; plans are not mutation permission or durable receipts.
- No client that actually connects; real transport/journal/host profile/capability remain unavailable. Fake trusted inputs are unit fixtures, never accepted host baseline.
- Private plans may contain env/paths/argv; safe diagnostics/results contain fixed codes/counts only, no body/IDs/raw errors. Bound before hashing/serialization; reject accessors/cycles/deep/oversized inputs.
- Test exact canonical API bodies, committed network requirement, original identity/seal mismatch, image/argv/env fidelity, subset refusal, malformed/bounds/secret sentinels and no arbitrary endpoint/operation.
- Verify uncertain Engine fields from primary official schema, record links. No Docker/API probes, OS/providers/user data or runtime support claim.
- Freeze then focused tests/router typecheck/build, report exact limitations/dependencies. No commits/push; ask before expanding ownership.

### Brief: compose-partial-proof (seed_repair)
- Tier: isolated roadmap-team after frozen C2/journal design; pure bounded prerequisite, no engine/runtime activation.
- Read Current State, own compose-journal-plan.md/C2 report and accepted compose-ownership contracts.
- Own existing compose-ownership.ts/schema.ts (new named partial-proof file allowed), own existing/new proof tests and reports/compose-partial-proof.md only.
- No migrations, source outside proof module, client/recipe/manager/services/config/public exports/shared-doc edits. Other worker owns lifecycle migration.
- Goal: explicit per-resource/known-subset positive proof for partial provisioning/cleanup, preserving original FULL normalized approval hash and creation identity; never fabricate a subset approval.
- Preserve full-generation verifier behavior. New API must clearly distinguish partial identity proof from complete generation/readiness/mutation authority, runtimeEnabled:false.
- Every supplied known resource ID must already have a committed journal creation receipt; missing/uncommitted IDs remain unavailable, never inferred/adopted from labels/name/cidfile/discovery.
- Compare sealed full authority/current generation/engine/nonce/config/image baseline exactly. Only exact service subset authorized by original full spec may be inspected; reject extra IDs, aliases, duplicate/colliding IDs or changed seal.
- Define journal receipt-versus-run completeness semantics explicitly; do not label an issued unknown effect committed merely to satisfy existing schema.
- Known container proof includes owned network/full ID and reciprocal peer checks; foreign endpoints must block destructive network proof. Network-removal proof requires known committed ID plus empty endpoints, not inferred all-container absence.
- Unknown/missing creation receipts still quarantine entire run; proving known resources never clears uncertainty, releases ports/paths or permits replacement generation. Return bounded safe codes/counts only.
- Tests: network-only committed receipt, full approval known container subset, unchanged original seal, missing/unknown IDs, forged labels/replacement network, foreign endpoints, and existing full verifier unchanged.
- Reuse strict C2 subset/bounds/secret exclusion. No guessed real-engine normalization, CLI/API calls/probes or user data.
- Freeze then focused tests/router typecheck/build, own report exact semantics/limits; no commit/push. Ask before expanding ownership.

### Brief: request-admission-protocol (brain_completion)
- Tier: isolated roadmap-process feature branch, ONLY after root merges frozen async-task-lifecycle and names baseline; do not begin source work before dispatch.
- Read Current State, own distributed-admission-plan.md and accepted lifecycle strict LeaseRef/companion contracts.
- Goal: real default SQLite Gate reserve/dispatch-intent/settle uses immutable captured generations and durable idempotent receipts.
- Own admission/{admission,request-ledger,sqlite-request-ledger}.ts, new named request-receipts helper if needed; gateway/{gate,direct,capacity}.ts.
- Own routing/{router,claim-capacity}.ts; scoring/classifier.ts; runners/{types,batch}.ts. Ask before any core/task-store/queue signature change.
- Own one appended migration AFTER lifecycle receipt migration only after root explicitly grants exclusive migration ownership.
- Own new protocol/fence/lifetime tests, proportional named affected fixtures and own report; no other source/shared docs.
- Root owns projects/deletion.ts blockers/purge, service/public exports and authored/shared docs. Send hooks/schema purge contract before implementation.
- Task participants MUST carry strict captured LeaseRef; never synthesize from current row. Preserve all batch/classifier participants and fence stale metadata/cache writes.
- Explicit taskless participants=[] public Gate compatibility remains with existing package/accounting/key protections. Separate free-tier probes retain existing limits/slots/breaker, no task/package-ledger claim. Sync Admission facades stay explicit.
- Stable physical-attempt requestId allocated before await for each key/endpoint; immutable validated digest/binding, atomic reserve+receipt, duplicate replay never sends.
- Authoritative dispatch intent is distinct from observational capture. Fresh intent plus final synchronous exact SQLite guard after all awaits immediately precedes provider invocation; replay/lost ACK never authorize another call.
- Reconcile original persisted binding once, replay same outcome harmlessly, reject conflicts, preserve unknown paid-cost accounting. No fallback/provider retry on persistence uncertainty.
- Preserve actual grants/repair/reviewer/twin allowances and existing budget math; no naive effectiveBudget clamp or remote policy-authority claim.
- Exact-generation claim/wait release; observed local in-flight request holds survive task expiry, no stale task-ID deletion. Ambiguous crash/transport completion is conservative, not proof remote processing/billing stopped.
- Receipts/private project scope/tombstones bounded; project purge must refuse unresolved holds and prevent delayed replay resurrecting purged private records.
- Track/drain every authoritative await and renewal before DB close. No detached retries, global taskless bypass or silent backend enablement.
- Test actual fake-provider service paths, same-owner takeover/ID reuse, delayed/lost ACK/replay, late original billing, capacity expiry, grants, purge privacy and close ordering.
- No PG/provider-policy extraction/services/engine/provider quota/user data. Freeze before typecheck/build/tests; report exact limits/cleanup; no commits.

### Brief: compose-journal-plan (seed_repair)
- Tier: isolated roadmap-team after C2 freeze; read-only design of next durable runtime unit.
- Read Current State, compose-services-plan.md, C1/C2 own reports and relevant Lab operation/store/supervisor contracts; inspect minimal necessary lifecycle code.
- Own only reports/compose-journal-plan.md. No source/tests/migrations/shared documents/engine commands/user data edits.
- Specify the next concrete implementation with durable pre-launch intent, immutable trusted preparation/image/default baseline, complete resource IDs, engine+generation fencing and safe terminal recovery.
- Creation-response loss without committed IDs must quarantine; labels/names cannot grant adoption or destructive permission. Preserve journal/private evidence until exact resources are proved gone.
- Identify actual CLI argv/JSON protocol and containment/lifetime of creation commands; collision/partial-create/error/kill windows must be explicit.
- Fit retained and task Labs, process/port/service ownership and project deletion without cross-project or source-worktree authority expansion; no application container readiness inferred from proof DTO.
- Partition named files and one future appended migration AFTER async task-lifecycle receipt migration (worker currently owns migrations). Propose strict bounded private storage/retention/purge and async port close/drain.
- Provide fake-CLI/SQLite killed-owner/replay tests plus independent actual-engine matrix; no mocks-as-engine claim or Docker activation recommendation implicit in code completion.
- Record unresolved trusted engine baseline acquisition and Desktop normalization dependencies explicitly. No fallback from unsupported inspection to guessed defaults.
- Return concrete <=40line implementation brief plus decisions/risks/compatibility. No commit/push; ask before expanding ownership.

### Brief: distributed-admission-plan (brain_completion)
- Tier: isolated roadmap-process new branch after frozen prune review; bounded read-only design, no implementation.
- Read: Current State, distributed-storage-inventory.md and task-lease-fence-plan.md reports, current Gate/admission/provider capacity implementations and async ledger contracts as needed.
- Own only reports/distributed-admission-plan.md; no source/tests/migrations/shared documents/runtime/user data changes.
- Goal: exact next R2 backend boundary after async task lifecycle, focused on Gate reservation/admission/provider capacity and generation revocation before physical provider dispatch.
- Inventory synchronous SQL crossing this boundary; identify transaction authority, await/replay semantics, immutable captured task incarnation/project, global/task/project/provider budgets and idempotency.
- Distinguish observational capture from authoritative mutations; preserve no duplicate provider calls on lost persistence ACK and purge privacy.
- Specify one bounded first implementation unit, file partition and compatibility facades, public schemas, close/drain semantics and meaningful fake/delayed/SQLite tests.
- Identify what must remain a separate later unit (sessions/tools/Git/shared provider state/PG) instead of claiming a shared SQLite proof establishes multi-host behavior.
- Consult primary official source only if a library/backend fact is uncertain; no actual providers, engines or service installs.
- Report concrete decisions, blockers, risks and <=40line next worker brief; no commit/push. Ask before expanding ownership.

### Brief: compose-resource-proof (seed_repair)
- Tier: isolated roadmap-team new feature branch; bounded C2 prerequisite, no engine/runtime enablement.
- Read: Current State, compose-services-plan.md + compose-validation.md, frozen compose-recipe.ts/client.ts contracts.
- Own only new labs/compose-ownership.ts (split into named new schema file if necessary), new compose-ownership tests and reports/compose-resource-proof.md.
- No existing source/schema/client/recipe/service/Lab/HTTP/browser/panel/config/public exports/migrations/shared-doc edits. R2 worker owns migrations.
- Goal: strict bounded Docker inspect projection and pure positive container/network proof against an immutable journal identity; source for later durable Compose lifecycle integration.
- Require full exact engine resource IDs already committed in journal, same trusted engine identity/endpoint, generation/run/install/spec/nonce metadata and exact expected config. Labels/names alone are never destructive authority.
- Creation response loss/missing journal IDs returns quarantine/unavailable even if labels match. Never adopt or delete discovered resources just by name/label/Compose project.
- Validate actual container image ID against inspected approved image ID (manifest digest and config image ID are distinct); declared command/user/env hash/bind paths/ports/network/resource/security settings must match strict expected subset.
- Refuse extra/anonymous/named mounts, host namespaces/privilege/capabilities, unexpected network attachments/publications and ambiguous identity. Reuse frozen canonical recipe policy, don't silently introduce a broader supported subset.
- Runtime raw JSON validated/bounded; private proof fields never returned in public status/errors. No env values, host paths, credentials or raw inspect errors in safe DTO.
- Primary official Docker inspect/API docs for uncertain fields, record exact URLs/provenance. No actual Docker commands/engine activation/probes/providers/user data.
- Tests: exact full-ID positive, engine/run/nonce/generation mismatch, forged/colliding labels/no committed IDs, changed image/mount/ports/security/network, malformed/oversize input and safe diagnostic sentinel exclusion.
- This is a pure prerequisite, not durable intent storage, CLI mutations, container lifecycle or actual-engine acceptance. Keep runtime disabled. No sandbox/hostile-daemon claim.
- Freeze, router typecheck/build/focused tests, own report exact files/evidence/limits; no commits/push. Ask before expanding source ownership.

### Brief: async-task-lifecycle (link_completion)
- Tier: isolated roadmap-labs new feature branch from root integratedb766516 or newer; caller source already frozen/independently accepted.
- Read: Current State and reports/task-lease-fence-plan.md, especially first implementation contract and exact serial partition.
- Own: new storage/task-leases.ts + sqlite-task-leases.ts; storage/tasks.ts; task-queue.ts/sqlite-task-queue.ts only necessary identity plumbing.
- Own: core/executor.ts, new core/task-run-leases.ts coordinator, watchdog.ts, scheduler.ts; runners/types.ts; minimal service.ts lifecycle wiring/drain/async variants only. Preserve root acceptance guard/startup callbacks.
- Own ONE append migration for durable operation receipts after current request_captures migration; no other worker owns migrations now.
- Own new task-leases/executor-task-leases tests + fixture; existing scheduler/queue tests only for meaningful contract drift; report reports/async-task-lifecycle.md.
- Implement default awaited SQLite renew/finish/interrupt/defer/recover/cancel port with strict data DTOs and explicit applied/replayed/stale/expired receipts, not merely unused exported adapters.
- Capture immutable identity once from claimed receipt before await; same-owner older generation cannot renew/settle/defer/interrupt current run. Audit task-ID deletion/reuse before final identity design; send finding early if run_count resets can collide.
- Mutation + idempotent operation receipt commit in one immediate transaction. Reuse operation ID/digest to reconcile lost acknowledgements; conflicting reuse rejected. No new provider retry on persistence error.
- Renew serializes per lease and never resurrects expiry; task TTL from adapter config/server time. Stop/flush drains pending renew/recovery/settlement before DB/resources close.
- Only applied/replayed own finish triggers report/settled hooks once. Stale receipts cannot write brain reports or abort a newer local controller. Recovery selects/CASes exact expired generations; preserve startup/tick distinctions.
- Human/logical task cancellation remains scoped control; supervisor actor lease + ancestry checked. Async cancellation receipt carries observed generation; don't abort task-ID-only newer controller after await.
- Keep existing public synchronous SQLite TaskStore/service APIs for CLI/MCP/panel compatibility; add awaited variants and default worker usage without changing their sync return types.
- No Gate/admission/provider-capacity/session/tool/Git backend migration in this unit; preserve capture/accounting and selected task-Lab evidence. Explicitly no end-to-end R2/PG/two-host claim.
- Project deletion must purge private operation receipts safely; expose required integration contract to root instead of editing projects/deletion.ts. Bound receipt payload/retention behavior; no silent unbounded retry loops.
- Test real adapters and delayed fake ports: same-owner takeover, expiry, lost commit receipt/replay/conflict, cancel-vs-resume, renewal serialization, startup/tick, all finish dispositions, batch members, close ordering and no stale reports.
- Temp/fake providers only; no user4477, live keys/paid, service installs or PG enablement. Freeze before typecheck/build/focused tests, report exact checks/limits/cleanup; no commits/shared docs.

### Brief: browser-pipe-prerequisite (seed_repair)
- Tier: isolated roadmap-team feature branch; H0 approved for typed/bounded H1 prerequisite only, not hydrated enablement or OS installation.
- Read: Current State and own hydrated-browser-plan.md; existing browser-protocol.ts as compatibility reference.
- Own new labs/browser-pipe.ts and browser-isolation.ts plus new named unit tests; own report reports/browser-pipe-prerequisite.md.
- No existing browser schema/process/network/check/runtime/source changes, public exports, config/migrations, shared docs, tools or user data.
- Implement bounded NUL-framed CDP byte-stream transport compatible with later pipe adoption: split/coalesced UTF-8 frames, strict validated envelopes, per-frame12MiB/aggregate32MiB, capped pending/event counts and abort/close/drain.
- Framework-only command API, no model evaluate/URL/script input. Reject malformed/oversized/unfinished frames; no unbounded concatenation or dangling pending calls/listeners.
- Define minimal trusted isolation adapter/capability contracts with strict public unavailable status. Windows is unsupported until a real accepted adapter; no flags/JSON boolean as proof of OS containment.
- Pipe transport must not own/kill arbitrary processes or reinterpret network listeners as pipe proof. Fake streams prove framing only; do not claim actual Chrome/OS isolation from unit tests.
- Preserve existing static runtime entirely. H2/schema/broker integration and H3 durable recovery remain separate, disabled until actual isolation backend accepted.
- Tests cover boundaries/UTF-8, late/unknown replies, invalid frame/envelope, event flood, pending cap, abort/EOF, resource cleanup and unavailable capability path.
- No Chrome/probes/service installation needed in this bounded unit. Freeze, router typecheck/build/focused tests and report; no commits/push or source beyond brief.

### Brief: hydrated-browser-design (seed_repair)
- Tier: report-only in roadmap-team while root independently validates frozen session source; no source/build changes.
- Read: Current State; labs/browser-{schema,check,network,protocol,process,artifacts}.ts and browser tests; other source only as needed for this bounded report.
- Goal: concrete next implementation brief for declared hydrated JS browser checks, preserving existing static default and truthful evidence.
- Own only docs/working/distributed-and-lab-extensions/reports/hydrated-browser-plan.md. No shared docs, code, tests, config, services or user data edits.
- Establish current request broker/target isolation/process cleanup contracts and exact insertion points; identify declared schema/evidence additions and data compatibility.
- Human selects mode/check/assertions/limits; models only select names. No model evaluate/script/URL or unbounded navigation API.
- Investigate before-contact network enforcement for fetch/XHR/images/forms/redirects/popups/iframes/workers/serviceworkers/WebSocket/WebTransport/WebRTC/DNS/prefetch, including non-HTTP bypasses.
- Use primary official Chromium/CDP/spec docs for uncertain facts/flags; record verified URLs and limits. Do not claim interception covers transports it cannot mediate.
- Small read-only/local loopback probes allowed if essential, no external network targets or OS/firewall/Docker/service installation. Close all owned probe resources.
- Recommend safe implementable first hydrated subset with bounded DOM wait/assertions, console/page error collection, exact heads/screenshots and ownership rechecks.
- If hard containment needs unavailable OS/engine capabilities, state that clearly and separate trusted-human executable/host boundary from model input controls; no silent weakening or false sandbox claim.
- Detail file partition, failure/cancel/crash recovery, tests using actual JS-rendered isolated fixture and foreign transport sentinels, expected acceptance evidence and limits.
- Report ready-to-execute phases, not implementation or completion claim. No commits/push; final return exact reads/probes/cleanup/open decisions.

### Brief: task-lab-project-prune (next available worker; not dispatched yet)
- Tier: isolated feature tree based on root74f818b or newer, never mutate active validation tree.
- Read: Current State, lifecycle report, task-attempt.ts/runner.ts and scoped prune invariants.
- Goal: explicit confirmed project deletion can prune its stopped terminal task Labs immediately, without waiting retention or permitting public mutation/promotion of task Labs.
- Own: labs/task-attempt.ts and task-attempt-runner.ts; new named scoped prune helper if needed; new task-prune tests/fixture only.
- Root owns admin/projects.ts and projects/deletion.ts integration, service, captures, public exports and shared docs. No migrations (capture worker owns), no caller/helper edits.
- Expose `pruneProject(project:string):Promise<{removed:string[];blocked:number}>` (final signature coordinate first). Strict scope from authoritative project/task/attempt rows, never global prune with a future timestamp.
- Only retained/stopped, complete cleanup, terminal task+ancestry, no queued integration or pending/live operation/process/port/service ownership. Keep source coding worktrees/branches and other projects.
- Acquire a durable exclusive cleanup operation generation under immediate before awaits; reuse existing cleanup operation kind if possible, no new migration. Renew only unexpired owned lease.
- Before each destructive action verify live cleanup generation + exact Lab/attempt/root/registered Git common-dir/branch identity. Fail closed on foreign PID/path/dirty tree/lease loss, retain proof/reservations.
- Process lifetime cleanup is owned by dedicated Labs supervisor or explicitly safe terminal operation, never API task-check execution. No concurrent prune/tick race or untracked background delete.
- On crash partially removed resources must remain recoverable; recovery must not invent success, remove foreign resources or delete task rows before proof. No generic labels/path prefixes as sole ownership proof.
- Test immediate scoped prune at normal7day retention, another project's live resources survive, dirty/foreign proof refusal, same-attempt concurrent operation refusal, lease loss and retry/recovery.
- Actual temp Git/worktrees/fake processes only. No user data4477/Docker/providers. Freeze, router typecheck/build + focused tests and report; no commits/shared-doc edits.
- Report: docs/working/distributed-and-lab-extensions/reports/task-lab-project-prune.md. Public task Lab start/promote/check remain refused.

### Brief: task-lab-caller (link_completion)
- Tier: isolated feature worktree roadmap-labs; start from root feat/roadmap-task-integration checkpoint011b318 or newer.
- Read: Current State, own lifecycle report, task-attempt-schema.ts; inspect owned caller files as needed.
- Goal: wire opt-in constraints.labChecks through actual coding execution, mandatory verification and exact winning-attempt integration.
- Own: core/task.ts result schema only; core/executor.ts; runners/types.ts; runners/coding/{finish,native,index}.ts and new named task-lab caller module.
- Own: verification/{contract,checks,policy,phase}.ts; harness/{integration-tools,supervisor-tools}.ts; workspaces/merge-queue.ts; mcp/schemas.ts; proportional new caller/verification tests.
- Ask before other source files. Do not edit service.ts, task validation, projects, admin, config, migrations, gateway, lifecycle files, index or shared docs.
- Existing lifecycle API is frozen, root owns service/project deletion/public exports and final acceptTask enforcement; send exact helper contract early.
- Capture immutable runCount from executor's claimed row in RunContext before await; opt-in prepareWorkspace must use it, never re-read current generation.
- Register persisted session/execution/workspace attempt after attributed commit, submit exact commit/tree/digest; run only human-selected named checks.
- Ensure dedicated Labs supervisor is started before waiting; do not drain process queue from API/runner. Preserve cancellation cleanup.
- Store typed taskLab evidence separately from ordinary tree-SHA check evidence; required ephemeral_lab_checks gate cannot be waived by reviewer/human.
- Verify fresh authoritative attempt, recipe, all heads and stopped resources before pass. Root adds service acceptance guard against your pure validation helper.
- Integration uses exact accepted winning attempt, not latest workspace. Opt-in conflict rebase must refuse/redelegate with labChecks preserved unless fresh checks run.
- RepoReader already respects pinned read-only baseCommits; avoid new read-only clone worktrees. Browser checks remain refused.
- Ordinary coding without labChecks remains compatible. Do not claim browser/whole L5 or full R2 generation fencing.
- Test real fake-provider native/external coding path, failed checks/no integration, forgery/stale/wrong winner, conflict path and no-opt-in regression.
- Use temporary configs/brains/repos only; no paid providers, real4477, user data or Docker. Freeze source before checks.
- Run router typecheck/build and focused tests; supervisor independently verifies/full-suite integrates. No commits/pushes.
- Report: docs/working/distributed-and-lab-extensions/reports/task-lab-caller.md; include exact files/tests, limitations, resources cleanup.

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

### 2026-10-22 - Task runtime monitoring responsiveness
- Agent: supervisor.
- Changed: task operations use one tracked nonblocking drain from the Lab monitor tick; retained controls and service monitoring continue independently. Close awaits the drain and aborts owned active work.
- Validation: actual fixture runtime test passes1/1 (16.11s), tick returned under2s while declared slow check remained active; failed check later cleaned resources completely. Existing actual retained-control responsiveness test passed separately. Complete combined suite still pending caller integration.
- Outcome: Partial; local lifecycle fix only. Project purge now refuses unresolved cleanup/process/operation evidence and deletes completed dependent rows in FK order; six project deletion tests passed8.72s.

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
