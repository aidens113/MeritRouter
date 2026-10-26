# S6c pinned private Brain and Web ports

Worker: storage_split_contract
Date: 2026-10-26
Status: source frozen; supervisor independent review/checks pending.
Directory: MAIN D:/SwitchYardRouter only.

## Owned files and boundaries

Web: access.ts, ledger.ts, backend-state.ts, new usage-reservations.ts. Brain: brain.ts and
access.ts, released only after root accepted/committed C3 ee7c5f8. Root additionally approved
promotion.ts's optional publicProjection hook; no common-owner queue/capability/push ordering
was removed. Exact caller bridges: harness/web-tools.ts caller lease; harness/worker.ts live
principal lease/session and terminal ReportContext lease/receipt/reportOnly; runners/supervisor.ts
principal lease/session; core/executor.ts final-report captured lease/finish receipt arguments;
harness/tools.ts brain_decide_request explicit principal argument only. No runtime-services or
service.ts changes. Tests: project-brain-web-isolation.test.ts. This report only, no shared docs.

S5/schema owner serialized the appended web_usage_reservations(globalshared),
web_usage_protocol(localscoped), brain_access_requests.lease_json and
brain_grants.lease_incarnation(nullable legacy) migrations/classification. This worker did not
edit migrations/store-role or import/copy user data. Nullable unique legacy_web_request_id is
reserved for verified quota-history import; existing unknown legacy history is not guessed.

## Web protocol and quota authority

WebAccess.project requires pinned identity, runtime guard, explicit WebUsageReservations and
WebBackendState ports on the same real coordination provider bookkeeping. A bound project DB
cannot construct backend-state or an implicit legacy ledger; bound coordination cannot host
private WebLedger data. Unbound legacy behavior remains supported explicitly.

WebLedger validates original captured lease, task/project/run/incarnation/owner/live deadlines,
local running session, private target and immutable protocol binding. It commits private prepare,
reserves global quota, then commits local bind. Local IMMEDIATE checks authority while the
synchronous global intent commits; local marker commits before a one-use process send proof.
Replay/new adapter/lost local marker acknowledgement grants no send. No global transaction opens
local SQL, awaits a provider or infers task authority by joining global task copies.

Global rows contain minimal attempt/call IDs, installation/project/store UUID/generation, opaque
key/backend IDs, binding digest, phases and fixed-code/numeric outcome only. No query/URL/task/
session/error prose/result body is copied globally. Trusted host WebConfig and backend/key
resolver enforce install daily call and backend day/month attempt caps across projects. Local
budget values cannot widen these caps. Daily DISTINCT call IDs dedup legacy/new history; backend
history is deduped only through exact verified legacy ID mapping. A fallback crossing UTC midnight
must pass the new day's call cap if the call was not already counted that day. All unresolved
admissions stay counted; no expiry refund or automatic intent replay.

Provider failures are separated from accounting failures, so failed persistence cannot trigger
another physical backend send. A live minimal outcome commits globally before local access that
may fail due to a closed project volume. Local private outcome/projection is idempotent; recovery
from a global-only settled receipt writes only numeric/fixed-code accounting and labels missing
private diagnostics honestly. No invented provider response or private error is reconstructed.
Bound shared backend health stores fixed ProviderErrorKind; existing legacy error prose is
sanitized on shared read. Full masked provider diagnostics remain local.

## Brain isolation and explicit shared knowledge

BrainOptions.project and BrainAccess's fourth project options pin actual UUID/store/generation,
configuration project and canonical project/.MeritRouter/brain. Own logical namespace/mounts/
physical canonical own .MeritRouter runtime root are enforced even for a human principal. Existing
foreign/global local index rows require explicit migration rather than being adopted. Index and
FTS remain in the project DB; generated root/own indexes name only that project and use only its
allowed index-generation meta key. Shared global files are not bootstrapped or indexed locally.
Private Brain/BrainAccess construction against bound coordination is refused.

SharedBrainKnowledgePort is an explicit read/list/search and optional publishApprovedLesson
boundary. Returned paths/metadata/content/receipts are validated and must remain global/public.
Search queries are ephemeral inputs that host implementations must not persist. There is NO
coordination Brain exemption or reuse of private brain_files/FTS/access tables. A dedicated
sanitized shared-knowledge backend is a host integration dependency, not an implicit filesystem
or SQL fallback. Missing global ports fail closed rather than writing a local global copy.

BrainAccess principals bind exact persisted task profile/role, original lease and actual task/
parent/repository/report context in a private WeakMap; mutation/forgery/reused generation refuses.
A different harness phase role requires an explicit literaltrue host authorization plus captured
running local session with matching task/role. That phase binding expires when the session ends;
there is no blanket reviewer/classifier allowlist. Production host wiring must bind actual phase
proof before activation, not silently disable intentional verification/classification phases.
Stored task/spec/access/grant/receipt rows and public port outputs use Zod. Tier-based approval
uses persisted task tier, not caller-selected tier. Access requests persist the original lease;
grants are stamped with original incarnation and cannot transfer to a recreated task. Legacy NULL
rows require explicit migration; split mode never guesses their owner.

Split approval policy is read freshly from trusted config; the bundle's initial Brain overlay
cannot retain revoked auto-approval or global approval flags. Root activation must also drain/
recreate relevant service graphs on config changes; immutable per-project path/identity snapshots
must never become generic live policy authority. Legacy fixture live-object semantics remain.

Terminal report authority is deliberately separate: exact original durable finish receipt is
looked up locally and checked for applied finish, original lease(owner included), current stored
incarnation/run/state. Cleared current lease owner is not compared to the old owner. The resulting
principal can access ONLY its actual report path and cannot request/grant/approve/search broadly.
Missing/stale proof makes best-effort worker reporting return null, without minting new authority.

## Sanitized publication and uncertainty

The optional trusted GlobalPromotions.publicProjection leaves complete project/source/supervisor/
review/approval provenance in the local promotion record. Global markdown contains only public
lesson content, kind and opaque publication_digest. Raw promotion ID, project, source paths,
actor labels and approval notes are not sent to the shared publication port. CAS ownership uses
the opaque digest in split mode; legacy frontmatter/behavior is unchanged.

publishApprovedLesson receives exact sanitized content/digest and expected prior digest. Its
host must provide durable idempotent CAS. Lost shared acknowledgement leaves local approved
promotion unresolved; settle retries the same opaque publication and does not create a second
lesson. Review/approval evidence remains local. Existing Brain mutation queues, common-owner
capabilities, selected Git paths and push-after-release ordering are preserved.

## Observed validation

- Existing web.test.ts33/33 passed52.04s with fake APIs/page transports/agent clients.
- Existing brain.test.ts10/10 passed270.50s, including native Git initialization, reports,
  access, FTS, mounts, external edits and common initialization serialization. This was before
  final split-only policy/row hardening; no legacy bypass/timeout/skip was added.
- Combined new Brain/Web16/16 passed19.20s after input/public-receipt/persisted-tier hardening;
  supervisor independently observed16/16 passing19.18s before final mount requirement correction. Covers two actual private Brain/index/FTS roots,
  local grants/stale principals, actual terminal receipt after owner cleared, exact phase role/
  session, fresh approval revocation, real local promotion review/human approval and one shared
  publication after lost acknowledgement, plus two-project Web quota/diagnostics, midnight,
  native SQL marker abort, closed local DB and global-only outcome projection.
- All native work is in normal OS-temp canonical project roots; fake shared knowledge storage
  and fake HTTP/provider responses only. Global private task/session/Brain/access tables are
  asserted empty. No provider quota/money, new checkout or source .MeritRouter was used.

## Host wiring / remaining phases

The staged runtime must supply per-project Brain/BrainAccess/Web objects and explicit shared
knowledge publication/quota/backend-state ports. Harness-role authorization must carry the exact
captured session/phase proof. Dedicated sanitized shared document authority, config graph reload,
admin/CLI/MCP routing, migration/default activation and fresh Facebook live validation remain
supervisor integration work. These are explicit port dependencies; no unsafe global private-data
fallback or silent fresh store is implemented here. Root owns broad tests/build/source review,
acceptance, commits and all live operations.

## Final requirement correction: runtime mounts

Split Brain mounts must remain physically beneath the canonical owning project's .MeritRouter
root. Assigned source repositories or other project directories are not runtime destinations,
even for a non-committing mount. An ordinary configured source docs mount is rejected in the
constructor before Brain root/docs writes. Existing unbound legacy mounts remain unchanged.
This is an explicit migration incompatibility: host migration must inspect/approve relocation
or remove old external mounts; this phase never silently moves or adopts them. RepoReader
remains the explicit source-reading boundary. Final17/17 check passed31.98s; source frozen for supervisor acceptance.
