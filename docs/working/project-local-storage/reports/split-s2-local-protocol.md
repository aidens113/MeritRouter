# S2 local request protocol

Worker: storage_split_contract
Date: 2026-10-26
Status: source frozen; focused checks observed; supervisor review required.
Directory: MAIN D:/SwitchYardRouter only.

## Changes and contract

New admission/project-request-ledger.ts implements RequestLedger without activation. New
project-request-store.ts owns strict private persistence; project-request-authority.ts checks
actual local task/execution/lease/grant/config authority; project-request-projection.ts binds
and applies exact original participant accounting; project-request-totals.ts includes unresolved
preparation holds in task/job request, token and paid budgets.

Modified admission.ts, budget-requests.ts and job-pool.ts count preparation holds through their
existing budget interfaces. request-ledger.ts exposes honest local phases and optional synchronous
assertDispatch hook; legacy SqliteRequestLedger is unchanged. A new appended migration adds
project_request_protocol, project_request_holds and project_request_spend, plus physical_requests
unbounded_cost. Applied S1 migration is unchanged. store-role.ts classifies the three local tables.
No Gate, service, runtime path/default or activation edits.

Durable order: local FULL preparation/holds; global synchronous reserve; local binding/charges;
local IMMEDIATE authority -> synchronous global IMMEDIATE intent -> local marker COMMIT;
postcommit authority check -> fresh process proof. assertDispatch consumes that proof exactly
once, checks local/global authority and records transport consumption before returning. A restart,
serialized receipt, replay, failed local commit or lost postcommit acknowledgement grants no proof.
All checkpoints run outside SQL transactions; no SQL transaction awaits or calls a provider.
Global DTOs hash participant/owner labels and exclude private binding/outcome prose/paths.

Settlement saves private normalized evidence, settles globally, then projects locally. Original
incarnation is required for projection, including late outcomes. Stored outcome and global CAS
digests make replay exact. Financial-only recovery uses authoritative global numbers without
inventing provider diagnostics. Native private-outcome persistence failure after live transport
still attempts minimal global financial truth; original holds/local uncertainty remain until
projection recovery. Native local dispatch marker rollback retains global intent with no transport.

## Approved S1 extension

accounting-broker.ts/sqlite-accounting-broker.ts add quarantineUnboundedCost for unpriceable
paid cache writes/provider cost: cost_quarantined+unbounded_cost is durable, first outcome digest
is retained, conflicting claims only raise known exposure, normal zero settlement cannot clear it.
The existing global paid and same-provider/key/endpoint fences apply across reopen. No finite
upper bound is claimed. accounting-usage.ts restricts unexpected-cost supplemental accounting
to free authority, avoiding double counting paid quarantined exposure. A broker regression checks
known minimum exactly once, persisted fence, replay and no free/settled result.

## Validation

- project-accounting-broker + project-store-identity: 45/45 passed (26+19).
- project-accounting-protocol initial final draft + request-ledger: 22/22 passed (15+7).
- project-accounting-protocol final: 18/18 passed, including closed-local live unbounded
  evidence and coordination reopen paid-fence proof. request-admission-protocol 12/12 passed.
  Optional budget-control whole file finished EXIT1 in673.62s:12/17passed,5failed
  (three Repository mutation lease supervisor-completion mismatches, one close hook timeout,
  one missing tool outputs plus EBUSY cleanup); combined41pass/5fail.
- Real separate FULL SQLite files, actual broker, native ABORT triggers; fake model outcomes only.
  Covers all seven commit checkpoints, replay/process proof, cancellation/deadline/incarnation,
  local preparation cap, batch charges, known paid projection, unbounded paid quarantine, private
  outcome write failure and local dispatch marker rollback. No real provider calls or broad checks.
- Fixture deliberately uses native generation-bound task lease rows: existing TaskStore.claim still
  writes shared fairness meta and is an S5 dependency; strict role whitelist was not weakened.

## Supervisor verification

Root independently reviewed local preparation/binding, local-then-global transaction order,
postcommit one-use dispatch authority, private projection and live closed-DB quarantine paths.
Final protocol18 +broker26 +identity19 =63/63 PASS48.13s. Recursive typecheck PASS for router
and panel on this frozen snapshot. Runtime activation and final recursive build/full suite remain
open; optional long budget-control suite has no result claimed yet.

## Review limitations / follow-up

No power-loss/fsync or truly simultaneous multi-process contention claim. All setup is OS-temp.
The S2 adapter is not exported/activated by Gate; later integration must call assertDispatch
immediately before transport and preserve existing capacity ownership/release semantics.
A consumed process proof retains its original validated private context and trusted captured price
basis. Reconcile validates the exact proof/outcome and commits explicit unbounded global quarantine
before touching local SQLite. Closing the project DB during a live response cannot suppress that
paid fence; private projection still fails honestly. Process death cannot reconstruct lost private
outcomes; it retains durable intent and holds without inventing a response. Existing claim fairness and global
capacity factories require subsequent split phases. Supervisor owns broad typecheck/build and
independent inspection; this report is not verification or live validation.
