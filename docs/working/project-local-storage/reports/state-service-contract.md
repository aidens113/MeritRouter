# Project state and shared accounting service contract

Worker: project_storage_discovery
Date: 2026-10-26
Status: design proposal grounded in source inspection; not implemented or tested.
Owned change: this report only. No source, live state, database, tests or commits changed.

## Recommendation

Introduce a project runtime bundle and a shared accounting broker before changing store roots.
Keep project content/state under `<project>/.MeritRouter`; keep installation credentials,
provider coordination and authoritative physical-request accounting in installation storage.
Use durable, idempotent local/global reservations with conservative holds. Do not copy the
entire shared database into every project or pretend independent commits are atomic.

This is an executable staged architecture, not approval to begin every stage concurrently.
Stage 1 is a prerequisite contract extraction preserving the current single-DB behavior.

## Verified current contracts and callers

All paths below are relative to `packages/router/src/`.

| Consumer | Current coupling | Required boundary |
| --- | --- | --- |
| `core/service.ts` constructor | One DB for TaskStore, ArtifactStore, SessionStore, Admission, ContractStore, LabManager, brain access, vault, providers, Gate and router | Shared services plus project runtime registry |
| `core/service.ts:projectDeps` | Returns only project config/brain/access; tasks, sessions and artifacts remain global | Full project store/service bundle |
| `core/executor.ts` / Scheduler construction in service | Single task store and executor dependencies; project callback cannot select full storage | Project-specific executor context; scheduler claims through per-project stores |
| `admission/sqlite-request-ledger.ts:reserve` | `RequestReceipts.reserve` wraps Admission.reserve and paid reservation in one DB transaction | Local budget preparation plus broker reservation protocol |
| `admission/request-receipts.ts:reserve` | Same transaction checks execution membership and stores binding/receipt; payload fingerprint and lease identities are bound | Project-private binding receipt; minimal global accounting digest |
| `SqliteRequestAccounting.reserve` | Validates task generation/deadline, task totals, grants/carves, global allocation, project share and key/global/project spend, then inserts request/charges/spend | Local task/grant authority; shared physical quota/key/spend authority |
| `RequestReceipts.beginDispatch` | One transaction rechecks local task authority and global provider slot nonce before recording dispatch intent | Explicit lock/commit protocol below |
| `RequestReceipts.reconcile` | Outcome digest CAS wraps model request, charge and paid-spend reconciliation | Global authoritative settlement + idempotent local projection |
| `admission/job-pool.ts`, Admission carvedRequests | Local grants join terminal task states and request charges; terminal children return unused budget | All job graph, grants and task-charge projection stay together locally |
| `harness/worker-actions.ts` | Shared DB contains reviewed cwd/source/generation and command results | Project-local approvals; global index contains counts/IDs only if needed |
| `storage/request-captures.ts` | Uses model_requests, request_charges, tasks and projects to derive ownership; stores raw payload in shared DB | Project-private capture store, ownership from trusted bound reservation |
| `admin/insights.ts` | Direct SQL against sy.db plus sy.tasks/sessions/artifacts; mixes global provider and project task views | Project queries receive explicit bundle; global view fans out bounded summaries |
| `operations/backup.ts` | One SQLite/files snapshot and optional key, global daemon/lease checks | Separate project export and installation backup contracts |

`storage/db.ts` explicitly enables WAL. Multi-file ATTACH transactions under this mode must
not be assumed crash-atomic. Existing RequestReceipts refuses reserve inside an external
transaction. A new adapter must preserve that legacy behavior until selected explicitly.

`SqliteRequestAccounting.reserve` and RequestReceipts.reserve already reject requests whose
participants span projects. Earlier discovery identified historical mixed capture handling;
the current admission path does not authorize new mixed-project batches. Preserve that rule.

## Data ownership

**Project authoritative:** task specs/results/dependencies/executions/membership; contracts,
verdicts, plans/questions/channels; job grants/carves/budget requests; file/merge leases and
workspace receipts; sessions/events/logs/artifacts; private request bindings/captures; task
charge and spend projections for task budgets; approvals/results; delivery candidates/history;
project brain/access records; Labs, services/checks/test data and project web query/results.
All references include stable project identity and store generation, not just mutable slug.

**Shared authoritative:** credential encryption/master key; provider/key state and rate limits;
provider slots and uncertain transport ownership; model discovery/catalog/qualification
aggregates; physical model request identity/status and package limits; authoritative paid
reservation/settlement and per-project aggregate allocation/spend; installation registration,
daemon ownership and migration coordination. Global request rows contain bounded accounting
fields, opaque project/task IDs, lease generation/digests, token/cost totals and outcome code.
They must not retain prompts, tool output, source snippets, web citation text, private errors,
full request binding JSON, application paths or capture payloads.

Current model_requests columns include error_message, route_note, telemetry_json and citations;
moving only request_captures would leave project content in global storage. Define strict zod
accounting projections and keep full diagnostics locally. Shared endpoint quarantine may retain
an incident code/request ID and digest, not copied model output or arbitrary policy text.

Global installation records may identify a registered project and its root. They are an index,
not authoritative copies of task plans/results or permission to access unregistered folders.

## Proposed service API

`ProjectRuntimeRegistry.require(projectId)` returns immutable generation-bound handles:
`{ identity, paths, db, tasks, sessions, artifacts, contracts, localAdmission, actions,
delivery, brain, labs }`. Reload may update display/config metadata; relocation replaces a
bundle only at a quiescent generation boundary. An open run pins its bundle and cannot silently
switch DB because config changed. One project DB has only that project's rows and a project
identity/layout manifest verified at open. Unknown/unavailable projects fail closed.

Shared `RequestAccountingBroker` exposes validated async-compatible DTO methods:
`reserveGlobal`, `beginDispatchGlobal`, `settleGlobal`, `readReceipt`, `retireUnsent`,
`listUnresolved`. Project RequestLedger composes these with local budget receipts. No callers
receive global DB access to mutate project accounting. Keep existing RequestLedger public
surface for Gate; add internal versioned receipt states rather than falsifying fresh/replayed.
Shared global summaries are not used to authorize local task dispatch.

`reserveGlobal` receives accounting-only values and participant identity/digest, not raw
payloads. The existing payloadDigest can remain; full binding stays local. Global operation
IDs are unique across stores. Every receipt binds project ID, project store generation,
request ID, fingerprint and original task incarnation/run. Reusing any ID with changed values
fails. Tombstones survive payload expiry; requests never become fresh due to deleting a project.

## Reservation, dispatch and settlement protocol

Only one project participates in a physical request. No SQLite transaction contains `await`,
network calls or fsync-heavy external work. Every phase is durable before proceeding.

1. **Local prepare:** local IMMEDIATE validates all task generations, deadlines, execution
   members and budgets. Insert an idempotent `prepared` receipt and task request/token/paid
   holds for every participant; job pool reads include those holds exactly once. Failed
   validation changes nothing. This hold is not a physical model request charge yet.
2. **Global reserve:** broker IMMEDIATE validates package/project allocation, key/spend and
   provider reservation authority; inserts physical request, paid reservation and global receipt
   exactly once. Unknown response is resolved by same-ID read/replay, never a different request.
   A global denial lets local preparation retire with explicit definitely-unsent evidence.
3. **Local bind:** verify the global receipt matches; atomically convert local preparation to
   the ordinary reserved charge projection (or retain one counted hold until conversion).
   Record its global commit receipt. Revalidate live authority; cancellation now may retire
   unsent global reservation but cannot erase historical accounting. Dispatch is forbidden
   unless both sides have matching durable reservations.
4. **Dispatch linearization:** acquire a bounded project IMMEDIATE transaction, validate
   current local cancellation/deadline/lease generation and receipt. While that local lock is
   held, synchronously invoke one broker IMMEDIATE that validates global reservation/slot
   nonce and commits dispatch intent with a unique dispatch ID. Then mark local dispatch
   metadata and release local transaction. Lock order is ALWAYS project -> global; broker
   transactions never acquire/read project connections. No global->project nested path is
   permitted. This bounded critical section needs contention tests and cannot be implemented
   by async network broker callbacks. It preserves cancellation-vs-dispatch ordering without
   claiming two DB writes commit atomically: if global intent commits but local update fails,
   dispatch is forbidden and recovery treats the intent conservatively as uncertain.
5. **Transport:** provider call requires both commits and fresh dispatch ownership in the same
   process. Replay of dispatch intent never grants a second provider call. A crash after intent
   but before/after HTTP remains uncertain unless actual definitely-unsent evidence exists.
   Cancellation after intent aborts transport when possible and keeps uncertain holds if needed.
6. **Global settle:** immutable outcome digest CAS writes authoritative physical tokens/cost,
   adjusts paid reservation, and emits a minimal settlement receipt atomically. Error strings
   are projected to bounded codes; complete errors remain local. Same digest replay is inert;
   conflicting digest refuses and preserves original accounting.
7. **Local apply:** one transaction validates receipt identity and original task incarnation,
   updates local charge/spend/token projections and marks settled. Acknowledgement is replayable.
   Until local settlement applies, conservative local estimates remain counted. Task terminal
   transitions/grant return cannot discard unresolved request liability. New incarnation must
   never receive a late old charge. Local deletion keeps required receipt/tombstone evidence.

This protocol prefers temporary over-holding to overspending. It does not offer exactly-once
external provider execution. A separate coordinator cannot safely replace step 4 with two
unfenced reads; remote/multi-host brokerage requires a redesigned lease/fencing protocol and
is outside this local SQLite implementation stage.

## Recovery matrix

| Last durable boundary | Recovery |
| --- | --- |
| Local prepared only | Read broker by same ID; retry reserve or retire with proven global absence and no dispatch |
| Global reserved; local bind missing | Reconstruct local projection from matching receipt; never reserve a second request |
| Global dispatch intent; local marker missing | Mark unresolved/uncertain; no provider replay; retain conservative charges/paid liability |
| Provider response; settlement not committed | Retry same outcome digest if available; otherwise uncertain, no new transport |
| Global settled; local apply missing | Replay broker receipt locally; budgets remain conservative until applied |
| Local inaccessible/deleted | Block affected project; shared accounting remains authoritative and conservative |

Do not expire accounting liabilities merely because a wall-clock lease or receipt window passed.
Pruning payloads is distinct from authorizing refunds, clearing uncertain slots or reusing IDs.

## Migration, deletion, backup and restore

Migration journal records old/new layout version, project ID/store generation, source DB schema,
row-count/digest manifests, accounting checkpoint and every path relocation phase. Stop scheduling
and quiesce relevant tasks/commands/Labs; refuse unresolved external effects unless retained
ownership can be represented identically. Snapshot global DB and project files using SQLite
backup facilities. Do not copy a live SQLite file without WAL-aware backup.

Classify each table and column by ownership before copying. Append migrations; never edit
applied migrations. Export project rows through typed schema projections, preserve IDs/timestamps,
charges and source identities; reconcile global totals before/after. Establish project Git
exclusions and markers first, then Git-aware worktree moves with per-step journal/rollback.
Update typed workspace/session/Lab/check references; immutable historical log text stays historical.
Pending path-bound approvals are retired/reissued, not silently rebound.

Commit a global registration switch to new project generation only after both new stores and
files verify. Startup rejects an incomplete migration and enters explicit journal recovery.
Old global project content is not purged until validated checkpoint; retained backup location
and cleanup policy must be explicit because old backups also contain project content. A rollback
after new provider activity must not restore old accounting; prohibit writes until migration
commit, and after resumed activity use forward recovery rather than stale-snapshot rollback.

Project deletion first revokes dispatch by project generation and quiesces effects; keep global
request/spend tombstones, purge project payloads and files through exact ownership manifests.
Global uncertainty is not cleared by deletion. No name-pattern-only recursive deletion.

Project backup includes local DB, brain, sessions/artifacts, owned manifest and accounting receipt
checkpoint; excludes installation keys. Restore preserves immutable request IDs, never replays
provider intents, and consults global receipts before opening budgets. Same-install restore must
not rewind global spend. Cross-install import cannot assume original quota/key ownership or
silently resume unresolved requests; import read-only history until explicit reconciliation.

## Staged file briefs and acceptance gates

1. **Service seam, no relocation:** new `projects/runtime-store.ts` / `projects/runtime-registry.ts`
   interfaces and same-DB implementation; update `core/service.ts`, `core/executor.ts`, scheduler
   wiring, ProjectDeps and public exports. Existing behavior remains unchanged. Supervisor owns
   shared-file integration. Prove identical task/approval/delivery behavior before next stage.
2. **Accounting protocol:** `admission/request-ledger.ts`, `sqlite-request-ledger.ts`,
   `request-receipts.ts`, `admission.ts`, `job-pool.ts`, `paid/spend.ts`, new broker/local receipt
   implementation, appended storage migrations. Gate/direct adapter changes only where DTO
   routing requires it. One owner for this overlapping transaction unit; independent review.
3. **Project private services:** storage tasks/session/artifact/contract stores; brain/access;
   harness worker actions; verification/delivery and Labs service dependencies. Require explicit
   project handles; private captures consume validated reservation ownership without global joins.
   Keep stage 2 files frozen while these callers adapt. Audit web request/query content as well.
4. **Read interfaces:** admin insights/jobs/sessions/artifacts/actions/delivery/Labs receive
   explicit project bundles; CLI/MCP and global dashboards route by registered identity.
   Global summaries fan out with bounds and unavailable-project status, never hide failures.
5. **Filesystem/wiring:** apply runtime-path contract to workspaces/integration/agent-home/Labs/
   brain/session/artifact paths; creation, authorization, pruning and deletion use same manifests.
   This shares harness/actions with stage 3 and must be serial or briefed to the same owner.
6. **Migration and operations:** new journaled migration service, operations backup/restore,
   setup/registration and config changes. Inventory paths and schema before execution. Panel
   location/migration presentation and authored docs follow stable API; demo browser validation.

Acceptance tests: inject failure after EVERY protocol commit and before provider call; two
concurrent projects against final global quota/key headroom; same-project parent/child hold races;
same-ID/different-binding and settlement conflicts; cancellation/deadline/slot loss at dispatch;
deadlock/lock timeout (project->global only); late settlement after task reincarnation/deletion;
restore/migration crash and rollback; private capture isolation and no sensitive global columns;
missing project volume; every global SQL task join removed or explicitly classified; no project
owned file writes beneath installation root. Keep batching within one project. Run relevant
focused integration tests then required recursive typecheck/full router tests/build and demo UI.

## Unresolved blockers and limits

- Need a complete table/column ownership manifest and direct SQL caller inventory before DB split.
  This report inspected entrypoints and transaction implementations, not every caller.
- Qualification/auditor tasks currently share real task stores. Decide installation-owned internal
  project placement and sanitized global qualification aggregates without embedding application
  material in installation state. Same applies global brain promotion content deliberately shared.
- Decide supported durable guarantees for `storage.durability=normal`: current WAL NORMAL can
  lose recent commits on power loss. Cross-store accounting protocol likely requires FULL for
  critical receipts on both stores, or explicit refusal of stronger crash-safety claims.
- Cross-filesystem worktree movement, remote coordinator transport and malicious concurrent
  filesystem replacement need dedicated containment/recovery design; not solved by this report.
- No tests executed and no runtime behavior verified. Evidence consists of the named source
  reads/searches; no claim that the proposed split or migration already exists.
