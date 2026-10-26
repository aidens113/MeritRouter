# S3 explicit global capacity

Worker: storage_split_contract
Date: 2026-10-26
Status: source frozen; supervisor independent review and broad checks pending.
Directory: MAIN D:/SwitchYardRouter only.

## Owned changes

- gateway/capacity.ts: explicit attachCoordination, composite executionGrants holder input,
  split global slot counting/purge/acquisition/claim/wait/release without joining tasks.
- gateway/quarantine.ts: coordination reads minimal endpoint_quarantines; explicit sanitized
  recordEndpointQuarantine publisher. Legacy unbound project diagnostics remain compatible.
- routing/claim-capacity.ts: optional fifth trusted execution grant resolver, additive split
  recordProjectClaim path; legacy call unchanged.
- New storage/project-execution-grants.ts; appended new migration and shared-table role
  classification for project_execution_grants/endpoint_quarantines. Prior migrations unchanged.
- New tests/project-capacity.test.ts and this report. No Gate/service/queue activation.

## Stable host API

ProjectExecutionGrants(db, limits(projectIdentity), now?) requires FULL bound coordination DB.
Trusted limits are maxTasks, maxSupervisors, maxWritersPerRepository, projectMaxTasks nullable.
reserve({grantId UUID, project ProjectStoreIdentity, leases LeaseRef[], role worker|supervisor,
repositoryDigests sha256[], expiresAt}) returns disposition plus grant {ref,input,state}.
ref is {grantId UUID, nonce UUID}. consume(ref) activates once and returns fresh/replayed;
replayed never authorizes a new executor. assertActive(ref) rechecks registered UUID/store/
generation and live trusted limits. revoke/complete are exact nonce terminal transitions.
read returns validated immutable receipt or null. No task specs, paths, prompts or provider
response data enter grant rows. Input runtime/stored rows use zod, immutable fields crosscheck. Writer grants with any
repository digest require exactly one task lease; composite batch requests combine separate
per-task grants, so one grant cannot hide several writers behind one repository hold.

ProviderCapacity.attachCoordination(db, settings, requestHoldMaxMs, grants) explicitly opts in;
legacy attach signature/behavior remains. SlotHolder.executionGrants is readonly ref[]. Every
captured lease must be covered exactly once across active same-project/store/generation grants;
independently claimed tasks combine for batching. Empty/taskless authority cannot bypass this.
recordProjectClaim(holder,platform) atomically checks provider headroom and records exact
idempotent claims; later tryAcquire consumes original claims. Actual S5 local claim commit and
executor start ordering remains the caller's responsibility.

Split requests write nonce, UUID/store/generation, captured lease tags and grant refs. Split
count/purge never joins task rows. Physical request holds do not expire with task/grant age,
parent exit, project retirement or claim revocation. Claims/waits can age out as scheduling
hints; they are not proof of physical completion. Global execution reserved/active grants remain
counted past expiry until explicit revoke/complete; expiry only denies new authority.

Ordinary split release atomically checks global accounting and deletes under one IMMEDIATE
transaction, serialized against global dispatch intent. Sent intent, settled uncertain outcome,
unbounded/quarantined cost and failed timeout/abort/unknown completion retain the slot.
releaseReconciled(handle) can clear an exact nonce including uncertainty only from authoritative
retired-unsent, settled succeeded, or settled failed remote response code rate_limited,
authentication or policy. Neither lease age nor financial settlement alone proves remote work
finished. Unknown provider errors remain held for explicit future reconciliation. This API does
not claim to query providers or infer their remote process completion.

Shared endpoint quarantine contains only request/endpoint IDs, fixed code, digest and time;
private model_requests policy prose stays local. Explicit acknowledgement keeps existing
operator actor/reason semantics and is tied to one exact violation.

## Validation observed

- Final project-capacity: 17/17 passed, including separate connections/two projects final slot,
  composite batching, nonce/run/project retirement, grant replay, reserved/active caps, distinct
  trusted project caps/live decrease and multi-lease supervisor sum, native stored-row tamper, claim consumption and minimal
  shared quarantine. Actual global broker dispatch/settlement backs release completion tests.
- Combined project-capacity12 + project-accounting-protocol18 + broker26: 56/56 passed before
  the final three explicit uncertain/unbounded/failed-timeout refusal tests were added.
- S3 capacity10 + identity19: 29/29 passed before final live-limit/refusal additions.
- Final capacity15 + selected legacy team-capacity4: 19 passed, 4 selection skips.
- Full legacy team-capacity earlier: 6/8 passed; two scheduler/harness cases failed: holds tasks
  beyond provider slots body completed then afterEach close hook10s timeout; supervisor workers
  fill slots case60s timeout plus EBUSY cleanup. AIMD, crossprocess slot and Gate limiter cases
  passed. These failures are reported, not hidden or attributed definitively to an unrelated cause.
- Optional budget-control session25232 finished EXIT1 in673.62s:12/17 passed,5 failed;
  combined request-admission12 +then-S217 yielded41pass/5fail. Three supervisor completion
  assertions got internal_error Repository mutation lease; expiration case afterEach10s timeout;
  limits-per-task missing tool outputs plus EBUSY tempDB cleanup. No25232 process remains.
- Real separate OS-temp FULL SQLite connections, fake outcomes only. No providers, broad build,
  new checkout or repository metadata directories. Independent connection tests are serialized,
  not a claim of simultaneous OS-process contention or crash/power-loss durability testing.

## Integration dependencies

S5 must derive real grant participant identity and canonical repository writer digests under local
claim authority, choose trusted configuration limits, consume global authority then commit local
claim before executor start, and reconcile unused/terminal grants. S4/S8 must provide grant refs
for taskful requests and explicit synthetic-store authority for taskless internal probes. Grant
expiry is immutable in this prerequisite; heartbeat/renewal policy requires later integration
rather than silently refreshing authority here. No runtime activation is implemented by S3.
Supervisor owns review, global tests/typecheck/build, commits and shared document updates.

Supervisor independently reviewed grant identity, task/supervisor/writer caps and minimal
shared role storage. Root observed final17/17 capacity PASS and separate final3/3 Gate
slice PASS with real project ledgers and fake transport. That slice proves two private
stores share physical quota while private captures/classification stay local. Final recursive
checks await frozen integration; this is not a live-provider or scheduler activation claim.

## S3 renewal follow-on (after committed121be75)

Source freeze candidate. New appended migration adds authority_expires_at (backfilled from
original expiry) and renewal_sequence; original binding JSON/expires_at/nonce remain immutable.
ExecutionGrant now exposes authorityExpiresAt and renewalSequence. Fourth optional constructor
argument is trusted synchronous ExecutionGrantRenewalAuthority(grant,proof)=>number|null.
renew(ref,{project,leases,expectedSequence,expiresAt}) validates exact original project/store/
generation/owner/incarnation/run, active/reserved state, current registration and sequence CAS.
Resolver must inspect actual local lease/deadline/cancel authority while caller owns local
IMMEDIATE; it returns verified maximum expiration, not a model/request-supplied limit. Async
resolvers and extra proof fields fail. A same-sequence+same-expiry acknowledgement replay is
inert; changed sequence/binding/deadline refuses. Expired grant can renew only under that live
local proof, not wallclock alone. No expiry refunds, nonce rotation or new executor authority.
assertActive/consume and split claim/wait live comparison use current authority expiration.
The only extra granted capacity.ts edit is expires_at -> authority_expires_at live comparison.
Lost local commit after global renewal retains conservative global hold; local task update
rolls back, and consume replay never creates a fresh executor. Focused real local/global SQLite
regressions cover this rollback, stale nonce/generation/owner/incarnation/sequence/cancel/retired
project, bounded deadline, immutable binding, expired-live renewal, reopen and invalid async input.
Final project-capacity28/28 passed17.98s (original17 plus11 renewal). No activation.
