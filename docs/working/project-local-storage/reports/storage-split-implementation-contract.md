# Project store split: executable single-machine contract

Worker: storage_split_contract
Date: 2026-10-26
Status: source-grounded implementation contract; no source or live changes made.
Owned file: this report only.

## Decisions for the next implementation

Use one installation coordination database and one authoritative database per project.
Do not use SQLite ATTACH as a cross-store atomicity mechanism. Keep a legacy shared-store
adapter until every registered legacy project has an explicit, verified migration. A fresh
project may use the new layout before legacy projects move; that is not completion of the
whole storage plan. Do not silently assign empty/missing owners to the primary project in
split mode. Historical empty owners need an explicit migration mapping and digest manifest.

Keep existing table schemas inside each project database initially so the existing TaskStore,
SessionStore, ArtifactStore and ContractStore do not need parallel SQL implementations. The
presence of unused legacy shared-table definitions is harmless; copying shared rows is not.
Initialize only an identity row plus this project's owned closure. Assert role invariants at
open: project tasks belong to its declared project, registration generation matches, and
credential/provider/global-accounting tables contain no rows. Add new migrations by appending
entries to storage/migrations.ts; do not edit applied migrations or hand-copy partial CREATEs.
The role-specific opener controls which services may receive a connection. An empty schema is
not a security boundary by itself; typed services and ownership validation remain mandatory.

Use a persisted random project UUID and store UUID/generation in addition to the existing
public slug. Recreating facebook-mvp after deletion produces a new UUID/generation. Never bind
old request IDs, approvals, workspaces or grants to the new project merely because its slug
matches. Global package/key usage remains spent when the old project is deleted.

Critical global and local receipt connections use synchronous=FULL in split mode. Existing
NORMAL compatibility remains only for the legacy adapter; document effective durability and
fail split-mode opening if the required connection setting cannot be established. This is a
single-host synchronous broker, not a claim of remote transaction or full filesystem
power-loss atomicity. Filesystem migration still needs durable journals and ownership checks.

The reserved qualification runtime gets an installation-owned synthetic project directory
under installation metadata, with the same local-store boundary. User-project audits and
source-bearing reviews remain in the user's project bundle. Shared qualification aggregates
contain only validated endpoint/evaluation metrics. Deliberately approved global brain
promotions remain installation-owned shared knowledge, with separate index ownership; never
copy an entire user brain or its FTS rows to support that exception.

## Facts confirmed in current source

All source paths below are relative to packages/router/src.

- core/service.ts:174-215 constructs one DB for tasks/artifacts/sessions/contracts/admission,
  Labs, vault, providers, web, catalog, Gate and router. projectStores():356 returns the same
  references each time; projectDeps adds only this transitional handle to executor context.
- core/executor.ts constructs TaskRunLeases once from constructor dependencies. Changing a
  per-run stores field alone does not change its lease port, session ending, Gate or router.
- core/scheduler.ts and storage/sqlite-task-queue.ts own one TaskStore/TaskLeases. Claims and
  fairness currently assume all project tasks and global limits share one write transaction.
- Gate constructor attaches the supplied shared health breakers and capacity to its own db.
  Creating per-project Gates with the same ProviderHealth would repeatedly redirect global
  coordination to the last project's database. Gate also directly creates RequestReceipts
  from this.db before transport, bypassing an injected split ledger's dispatch authority.
- Admission builds SqliteRequestAccounting with local task reads and shared package reads on
  the same connection. sqlite-request-ledger.ts reserve/reconcile combine both authorities.
- gateway/capacity.ts counts/prunes provider slots with LEFT JOIN tasks and stored task lease
  predicates. That join cannot survive moving tasks to another file. Missing local task rows
  must not become proof that an uncertain physical request slot can be released.
- model_requests.execution_id references executions; request_charges references both requests
  and tasks; paid_spend references model_requests. Moving project tasks/executions while
  retaining current physical model_requests/paid_spend is not possible by changing paths alone.
- ProjectRegistry.attach runs backfillProjects and records all configured projects. Split
  project open must not call this global backfill against a newly opened project database.
- WebAccess constructs both WebLedger and WebBackendState from one db; WebLedger counts
  installation/backend daily usage from web_requests. Moving that whole object locally would
  multiply shared web quotas. Split sanitized global web usage reservations from local query
  targets/results/errors, rather than merely giving each project its own WebLedger.
- storage/db.ts always opens WAL and migrates; session logs are a separate fsynced filesystem
  authority. SQLite backup must be used for existing WAL databases; raw file copying is unsafe.

These are inspected source facts. The 70-table ownership map and 55 direct-SQL caller list in
ownership-inventory.md remain the explicit export/caller baseline, not a claim that dynamic
SQL or future migrations are automatically covered.

## Stable ports to implement first

ProjectRuntimeRegistry.require(projectUUID, generation) returns a pinned bundle containing
identity/paths, db, tasks, sessions, artifacts, contracts, local admission/ledger, Gate/router,
Brain/access, web ledger, Labs, actions, deliveries and the task lease/queue port. Its shared
references are explicit: catalog, provider client/runtime, vault, provider health/capacity,
broker and installation registration. Reload cannot replace a pinned DB beneath a running
attempt. Removal or migration fences new bundles before it closes old ones.

Add a coordinationDb option to Gate construction while keeping db as projectDb. Breakers,
capacity and sanitized endpoint quarantine use coordinationDb; job pools/captures use
projectDb. Replace the direct new RequestReceipts(db).assertDispatch call with the active
RequestLedger's host-only dispatch validation; the default legacy adapter preserves current
semantics. Do not expose raw database routing or split-mode switches to model tool arguments.

RequestAccountingBroker methods are synchronous SQLite operations with validated DTOs:
reserveGlobal, beginDispatchGlobal, settleGlobal, readReceipt, retireDefinitelyUnsent and
listUnresolved. They may be wrapped in Promise-returning adapters, but dispatch's local->global
critical section must stay synchronous. Global transactions never open/read project stores.

New global physical_requests and broker_paid_spend tables contain accounting-only columns,
opaque project/store/task IDs, task incarnation/run count, payload/binding/outcome digests,
slot nonce, provider/key IDs and numeric status/token/cost totals. No prompts, source paths,
route prose, arbitrary error messages, telemetry headers or citations. New local preparation
rows hold complete request bindings and project charge/spend projections. Keep full private
model_requests diagnostics locally so existing project evidence can still render them.

During legacy coexistence, global package/spend reads combine old legacy rows and new broker
rows with exact request-ID deduplication, preferring the verified broker authority for imported
IDs. Import cannot count historical spend twice or delete paid_spend's FK parent prematurely.
Existing paid key reservations become broker_paid_spend entries before old model_requests
payloads are purged. Per-task paid budget reads use local projections, not a global tasks join.

## Two-store effects and recovery

1. Local IMMEDIATE checks cancellation, deadline, lease incarnation, execution membership,
   parent/child pool and token/paid budgets; insert prepared receipt plus conservative holds.
2. Global IMMEDIATE checks package/project allocation and key/global/project spend; insert
   idempotent physical reservation keyed by request ID, project UUID/generation and digest.
3. Local IMMEDIATE binds the matching receipt and converts the counted hold to charge/spend
   projection exactly once. If authority changed, retire only with definitely-unsent proof.
4. Hold local IMMEDIATE; revalidate local authority; synchronously commit broker dispatch
   intent with exact slot nonce; then commit local dispatch marker. Always local -> global.
   If global intent committed but local commit failed, never call the provider. Retain uncertain
   liability; recovery of that intent does not grant a second transport attempt.
5. Gate calls the provider only with both durable commits and process-owned fresh dispatch
   authority. Replayed receipt means read/reconcile, never provider execution.
6. Global outcome-digest CAS settles physical tokens/cost and paid authority. Full errors stay
   local; global diagnostics are bounded enumerated codes. Conflicting digests fail closed.
7. Local receipt application updates original-incarnation task charge/spend projections once.
   Until application completes, conservative holds remain counted. Terminal tasks, returned
   grants, project deletion and payload expiry cannot erase unresolved liability.

Recovery is by same-ID receipt inspection at every durable boundary. Global absence plus
definitely-unsent proof permits retirement; silence, expired leases and missing project volumes
do not. A late outcome never charges a new incarnation or resurrects a deleted project. Do not
refund, clear provider uncertainty or reset totals to make migration/test acceptance pass.

## Claims, concurrency and resource coordination

Use the same local->global ordering for split task claims. While holding local task selection
transaction, obtain a minimal global execution grant for global max tasks/supervisors/writers,
project share and provider claim headroom; then commit local claim with captured generation.
Failure after a global grant is conservative and reconciled by grant ID. It must not start an
executor whose local claim never committed. Same-project batch companions still share their
leader's execution grant and cannot span stores/projects.

Replace capacity's tasks joins with explicit global lease/slot receipts and local task
authority supplied under the project transaction. Global physical request slots remain held
when dispatch completion is uncertain. Claim/wait expiry is not transport-completion evidence.
The shared scheduler performs bounded fair fan-out over registered project queues; unavailable
projects appear unavailable and receive no claims, rather than falling back to installation DB.

Keep file glob leases locally, but retain shared canonical repository/branch coordination for
projects that reference the same physical repository. Shared lock keys use validated physical
owner hashes plus target identity; source/glob/command prose stays local. C3 mutation leases
and merge-branch locking must define one order before adapting these callsites.

## File-partitioned execution briefs

Rows sharing files are serial. C3.0 currently owns selected-commit/git policy files; the rows
below do not require them until filesystem activation. All new tests use isolated temporary
stores and fake providers. Each row writes its own report; supervisor owns shared documents,
integration, independent verification and commits.

| Unit | Exclusive files | Deliverable / exit |
| --- | --- | --- |
| S0 identity/schema | append storage/migrations.ts; new projects/store-identity.ts, storage/store-role.ts; tests/project-store-identity.test.ts | UUID/generation/role manifests, registration and migration journal tables; strict open identity; no relocation or default activation. Serialize later migration append owners. |
| S1 global broker | new admission/accounting-broker.ts, admission/sqlite-accounting-broker.ts; paid/spend.ts; tests/project-accounting-broker.test.ts | Minimal accounting DTO/schema, global reservation/dispatch/settlement/tombstones, legacy/new exact-ID deduplicated spend reads. Requires S0 schema. No Gate switch. |
| S2 local protocol | admission/admission.ts, sqlite-request-ledger.ts, request-receipts.ts, request-ledger.ts, job-pool.ts, budget-requests.ts; new admission/project-request-ledger.ts; tests/project-accounting-protocol.test.ts | Durable preparation/holds, two-store dispatch and local settlement. Legacy adapter preserved; no async-in-transaction callback. S1 frozen; coordinate paid-spend interface before edits. |
| S3 global capacity | gateway/capacity.ts, gateway/quarantine.ts, routing/claim-capacity.ts, new storage/project-execution-grants.ts; tests/project-capacity.test.ts | No task joins in global slot ownership, explicit global grants, conservative unresolved holds. No local task copies in global DB. Depends S1/S2 DTOs. |
| S4a Gate/router split | gateway/gate.ts, gateway/direct.ts, routing/router.ts, scoring/classifier.ts; tests/project-gate-isolation.test.ts | Separate coordination/project DBs; injectable ledger dispatch authority; local captures/classifications; no health re-attachment to project DB. Fake two-project end-to-end request slice passes before next unit. |
| S4b private runtime | projects/runtime-store.ts; new projects/runtime-registry.ts; core/service.ts, core/executor.ts; sessions/run-sessions.ts; tests/project-runtime-registry.test.ts | Actual bundle construction/close/generation pinning and explicit project services including lease/session end paths. Keep public installation DB semantic explicit; no per-project getter pretending raw global SQL is scoped. |
| S5 queue | core/scheduler.ts, storage/sqlite-task-queue.ts, storage/sqlite-task-leases.ts, storage/fair-claim.ts, core/task-run-leases.ts; tests/project-queue-isolation.test.ts | Fair fan-out queues, global execution grant + local claim protocol, safe multi-store recovery/cancel. S4 stable; no global->local nested transactions. |
| S6a project tools | harness/supervisor-tools.ts, harness/budget-tools.ts, harness/worker-actions.ts, core/supervisor-authority.ts; tests/project-tool-store-isolation.test.ts | All graph/approval/grant/command authority uses pinned local bundle; no root DB escape. |
| S6b private evidence | storage/request-captures.ts, storage/artifacts.ts, storage/usage.ts, sessions/store.ts, sessions/recorder.ts; tests/project-evidence-isolation.test.ts | Project-only ownership without global task joins, local captures/log/artifact roots and exact receipt checks. Keep current pointer/file containment semantics. |
| S6c brain/web | brain/brain.ts, brain/access.ts, web/access.ts, web/ledger.ts, web/backend-state.ts, new web/usage-reservations.ts; tests/project-brain-web-isolation.test.ts | Local brain/access/index and query/results/errors; global backend/usage only sanitized coordination and quota authority. Serial with C3.6 Brain mutation changes; schema append owned serially with S0/S1. |
| S6d Labs/delivery | labs/lab.ts, labs/task-attempt-source.ts, labs/task-attempt-prune.ts, runners/coding/task-lab.ts, verification/phase.ts, verification/audit.ts, verification/product-delivery.ts; tests/project-lab-delivery-isolation.test.ts | Project DB/paths through Labs and checked delivery graph; globally coordinated ports/process authority separated from private recipe/source/evidence. Subdivide by exact files before parallel dispatch. |
| S7 reads | all admin/*.ts in ownership-inventory Appendix B, admin/insights.ts; tests/project-admin-store-isolation.test.ts | Project-local queries, bounded global summaries with unavailable states; no direct root-DB joins for project evidence. Partition files into individual briefs; keep public insights/index exports. |
| S8 entrypoints/internal | cli.ts, mcp/tools.ts, mcp/schemas.ts, mcp/client-supervision.ts, qualification/runner.ts, qualification/comparison.ts, qualification/registry.ts, projects/registry.ts, projects/backfill.ts; tests/project-entrypoint-isolation.test.ts | Explicit owner at ingress; synthetic qualification store and sanitized global aggregates; legacy backfill cannot run against split stores. Serial with S4 service API integration. |
| S9 filesystem activation | workspaces/worktree.ts, workspaces/merge-queue.ts, workspaces/repository-prepare.ts, projects/repository-setup.ts, runners/coding/finish.ts, labs/lab.ts; tests/project-runtime-activation.test.ts | New projects default compact v2 beneath own .MeritRouter for jobs/attempts/version/integration/agent homes/Labs/artifacts/sessions/brain. Use one persisted manifest for creation, authorization, recovery and deletion. Depends accepted C3 wrappers/fences; serial with S6d Lab and C3 workspace owners. |
| S10 migration | new projects/store-migration.ts, projects/store-export.ts, projects/store-path-references.ts; operations/backup.ts, projects/deletion.ts, admin/projects.ts; tests/project-store-migration.test.ts | Dry-run manifest, WAL-aware backup, export closure, Git-aware moves, typed operational reference updates, registration switch, purge, restart recovery and safe rollback. Serial with C3 deletion and S7 admin/projects owner. |
| S11 panel/docs | supervisor integration and panel paths/migration/unavailable-state UI; docs/setup.md, operations.md, roles.md, decisions.md | Actual demo desktop/mobile/route/screenshots plus full checks and live new-project acceptance. No user credentials or downstream source in repository. |

ProviderSlotAdmission's actual owner is routing/claim-capacity.ts; TaskRunLeases is
core/task-run-leases.ts; agentHome is exported from runners/coding/finish.ts. Existing ownership
inventory is the exhaustive literal-SQL baseline for S6/S7, not permission for topic-only
overlapping briefs. Supervisor should dispatch S0 first; S1 and independent schema review can
follow. S2 is one transaction owner, not multiple simultaneous authors.

## Migration and rollback sequence

Resolve a registered project root and immutable UUID first. Quiesce scheduler claims, active
provider dispatches, reviewed commands, Lab operations and C3 publication receipts. Refuse an
ambiguous/unresolved external effect; do not infer quiescence from terminal task status alone.
Snapshot the legacy WAL database with SQLite backup plus owned files. Keep migration backups
project-local once safely copied/verified; global installation backup containing old private
data is retained only as an explicitly disclosed transitional artifact, not hidden completion.

Create ignored metadata/identity and new local DB, export the table closure in FK order and
preserve all IDs, times, incarnation/generation, charges and immutable source/evidence identity.
Split mixed tables using named typed projections. FTS is rebuilt from local roots. Global
accounting import uses original IDs and deduplicated totals, never fabricated zero usage.
Move stopped worktrees using Git-aware operations and journal each actual before/after common
Gitdir/head/path. Across volumes, use a staged verified destination plus worktree repair where
supported; refuse unverified EXDEV fallback. Do not use recursive shell moves on unchecked paths.

Rewrite only typed operational path fields, not arbitrary historical JSONL/model prose. Retire
and reissue approvals whose exact cwd/source binding changes; never mutate their original
authority. Verify foreign keys plus logical references, counts/digests, file content and Git
attribution, accounting equality and known-root absence before switching global registration.

Commit one registration generation switch only after destination is complete and validated.
Startup detects an incomplete migration and opens read-only recovery instead of dispatching.
Before any new dispatch, rollback may restore the old registration and journaled paths after
identity verification; global historical accounting is never rewound. After resumed activity,
only forward recovery is allowed. Purge old project content after the accepted checkpoint,
including private model diagnostics/FTS/meta/classification/web data, captures, sessions,
artifacts, workspaces and obsolete backups. Deletion after migration revokes generation first
and preserves global accounting/tombstones and uncertain physical holds.

## Required proof before claiming completion

- Failure injection after each of the seven protocol commits; same-ID same-binding replay and
  different-binding/outcome rejection; no second provider call after any uncertain intent.
- Two independent project DBs contend on final global quota, key headroom and execution/provider
  slots; at most one wins. Parent/child holds cannot oversubscribe or lose unresolved liability.
- Cancellation, deadline, slot loss and lease reincarnation race dispatch under local->global
  ordering; no opposite lock order or network await in a transaction. Missing volume blocks only
  that project without freeing uncertain liabilities or reading another store.
- Late settlement after task reincarnation/deletion/slug recreation never mutates fresh owners.
  Restore/import preserves request IDs and consults broker authority before budgets reopen.
- SQL/schema caller audit has no unexplained project/global join left; canary prompts, commands,
  source paths, web text and provider-echoed errors appear only in the intended project storage.
  Shared credential ciphertext/key material never appears in any project export.
- Fresh project, retries, resumes, Labs, deletion and backups create zero user-project-owned
  files beneath installation storage. Readable compact v2 paths survive Windows process launch.
- Migration interrupted at each filesystem/DB/registration step either rolls back before new
  dispatch or enters explicit forward recovery; no orphan worktree, mismatched pointer or false
  refund. Exact source/Git attribution and original global usage survive.
- Required recursive checks/full tests, touched-panel demo browser validation and actual fresh
  Facebook project delivery under the stated real-provider budget are supervisor observations.

## What this worker verified

Read the current storage checkpoint, state-service-contract and ownership-inventory reports,
then direct store construction and projectDeps in core/service.ts, runtime-store.ts, executor,
scheduler/queue, SQLite request accounting/DTOs/receipts, Gate/capacity, registry, runtime paths,
database opener and relevant migration FK definitions. Ran source searches only. No test,
SQLite open, migration, provider, Docker, live project operation, build or new checkout ran.
No existing source/test/shared document changed. No commits or pushes. No new user decision is
needed for these implementation choices; supervisor must verify the proposed ports and assign
the file-resolved briefs before implementation.
