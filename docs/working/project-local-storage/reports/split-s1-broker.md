# S1 global accounting broker

Worker: storage_split_contract
Date: 2026-10-26
Status: source frozen; final focused checks observed, supervisor integration/review pending.
Directory: MAIN D:/SwitchYardRouter only.

## Owned changes

- New admission/accounting-broker.ts, sqlite-accounting-broker.ts, accounting-usage.ts.
- paid/spend.ts accounting projections and host-only connection identity check.
- One new appended storage/migrations.ts entry; prior applied entries unchanged.
- storage/store-role.ts shared-table classification for the two new tables.
- tests/project-accounting-broker.test.ts.
- tests/paid.test.ts ONLY its existing uncertain-paid-failure case, after explicit supervisor
  ownership extension for a reproduced bootstrap-precondition failure.
- This report. No Gate, other admission, service, index exports or live configuration edits.

## Stable API / effects

RequestAccountingBroker exposes synchronous reserveGlobal, beginDispatchGlobal, settleGlobal,
readReceipt, retireDefinitelyUnsent and listUnresolved. SqliteRequestAccountingBroker requires
a FULL bound coordination DB, a PaidSpend on that exact connection, trusted validated config,
and a host endpoint/key/price resolver. No request/model DTO can supply an enabled flag,
price, budget, scope list, callback or override. Unknown/disabled endpoint/key, wrong registered
project UUID/store UUID/generation and missing key-quota/slot authority refuse before admission.

Minimal strict request DTOs contain request/installation/project/store IDs, generation, opaque
payload/binding digests, endpoint/key/reservation/slot identities, token totals, numeric bound
dispatchNotAfter and hashed participant task/owner identity plus incarnation/run count. No raw
participant labels/paths, complete request bindings, model messages/tool results, route prose,
provider errors, headers or citations are copied into the new global accounting JSON.

dispatchNotAfter must come from S2's actual local deadline/lease authority, not model text. It
is fingerprint-bound and checked inside the acquired global transaction immediately before
dispatch intent, so time expiring during SQLite lock wait cannot be ignored. S1 does not
validate local cancellation/execution membership; S2 must hold the local IMMEDIATE transaction
and require both durable markers before invoking transport. Fresh global intent alone is not
a model-call capability; replay never grants another call.

Reservation writes physical request plus paid authority atomically. Same-ID/same-fingerprint
is read-only replay; changed owner/content conflicts. IDs already represented by legacy
request/tombstone authority refuse. Provider quota reservation IDs and physical slot nonce
ownership cannot be reused by another broker request; legacy request_protocol binding also
prevents reusing its providerReservationId.

Provider quota scopes come from the host resolver and must have actual recent coordinated
provider_usage rows with sufficient token reservation. Paid worst case is computed from
trusted prices/search bounds, rounded conservatively upward; missing native-search pricing
refuses. Package/project shares, global/project paid windows, key cap and prepaid balance are
read inside the same transaction. Key/config and slot authority are rechecked at fresh intent.
No source price/provider facts are hard-coded; test endpoint metadata is deliberately fake.

The new migration creates physical_requests and broker_paid_spend without task/execution FKs.
The schema now has 75 logical tables, with the new two classified shared-only in S0. It also
adds nullable project_uuid/store_uuid/store_generation fields to provider_slots. Legacy slot
writers remain unchanged/null; the new broker REQUIRES exact UUID/generation stamps, nonce,
platform, held kind and matching captured lease participants. S3 must implement new-mode slot
acquisition before activation; a legacy slug-only slot is deliberately insufficient.

Settlement binds original request/fingerprint and exact outcome plus canonical accounting
digest. Identical replay is inert; conflicting replay preserves original accounting. Known
cost settles once, and uncertainty/unknown costs keep liability. A known partial claim above
the initial reservation raises separate conservative liability rather than disappearing.
Late original settlement after project retirement is permitted; a fresh same-slug UUID cannot
inherit original requests or dispatch authority. Reserved definitely-unsent retirement can
release paid exposure but keeps historical request admission counted; intent cannot retire.

Mutations reject an outer transaction on the global connection, avoiding false durability
from nested savepoints. Broker transactions never open/read a project database, await network
work or call a provider. Read-only receipt inspection remains available for retired owners.

## Unexpected cost from a free authority

Positive actual cost for an authority reserved as free is not silently ignored or retroactively
authorized. The broker commits minimal unexpected liability, exact first original outcome
digest, canonical first accounting digest and conflict flag, retaining dispatch_intent. Only
after COMMIT does it throw GlobalAccountingCostQuarantine carrying the validated minimal receipt.
Throwing inside the transaction would erase evidence and is intentionally avoided.

ReadReceipt exposes costQuarantined, unexpectedLiabilityUsd, quarantineOutcomeDigest and the
conservative liability. PaidSpend includes that exposure in windows/summary, and globalDenial
fences all further paid routing until explicit reconciliation. The broker additionally fences
the affected endpoint/provider/key even if it remains labelled free. No zero/not-billed retry
can clear the incident; positive conflicting claims only increase maximum exposure and mark
conflict while preserving the first digest. No automatic clear, refund, provider-side action
or retroactive paid grant exists. S2 must validate actual provider/outcome provenance before
calling this host-only settlement port; these are not model assertions.

## Legacy coexistence and ownership

Paid/package reads include legacy-only history plus broker history, counting exact request IDs
once. Paid overlap uses the more conservative exposure until old projections are purged;
key/provider/endpoint mismatch refuses instead of silently choosing another paid identity.
Missing/inconsistent broker paid authority refuses instead of being treated as free.

Legacy rows without an immutable project UUID are NOT guessed onto a registration by slug.
They conservatively count toward limited project-share/paid headroom until verified request-ID
import maps them. This may over-hold during coexistence, which is preferable to an accounting
reset after slug reuse. The legacy public per-slug summary remains an aggregate view; new
split-project authorization uses immutable projectAccountingSpendSince. Existing task spend
joins remain legacy-only and must not be used as the new local projection implementation.

## Observed checks and development failures

- Initial broker/S0 run: 29 PASS / 6 FAIL of35. All six were fixtures passing full receipt DTOs
  to deliberately strict reference-only inputs. Fixtures now construct exact references;
  production DTO authority was not broadened. Corrected broker16/16 PASS12.90s.
- Expanded compatibility run: 56 PASS / 1 FAIL of57 in117.79s. Broker18, S019 and defaults7
  passed; paid.test12/13 passed. The sole existing uncertain-paid test also failed unchanged
  alone: its 2s task never reached a model request while cold Brain initialization ran.
- A temporary owned diagnostic reproduction showed calls0, running task, model_requests[],
  paid_spend[] and week0 at its 5s await timeout. The temporary diagnostic was removed.
- After supervisor approved only that fixture extension, pre-initializing the fake Brain
  BEFORE task submission measured bootstrap6317.28ms, actual task188.37ms, paidCalls1 and
  request statusuncertain/cost_basisuncertain. Existing 2s task/5s await and spend>0 assertion
  remain; actual paid call and persisted uncertainty assertions were added. No product deadline
  change, higher waits, fake reservation or skipped charge. Measured probe passed1/12 selection
  skips; timing logs were removed from final test source.
- Deadline/search, incomplete-paid authority, commit-abort and unexpected-cost invariants
  received additional cases during review. Intermediate 45/45 and49/49 runs are superseded
  by final source below; no final full-suite-green claim is made.
- Final `pnpm exec vitest run tests/project-accounting-broker.test.ts tests/project-store-identity.test.ts tests/paid-defaults.test.ts --maxWorkers=1`
  -> exit0, 51/51 PASS in19.58s: broker25, S019, defaults7. Broker tests10.745s.
- Final source `pnpm exec vitest run tests/paid.test.ts --maxWorkers=1 -t "an uncertain paid failure keeps the worst case charged"`
  -> exit0, 1 PASS / 12 selection skips,14.02s. Owned `git diff --check` exit0.
- Covers independent project stores and separate coordination connections at final global
  quota, trusted paid caps/balance, durable connection reopen/replay, stale owner/nonce/key
  reservations, exact conflicts, retired/recreated UUIDs, private DTO refusal, legacy exact-ID
  coexistence and conservative unknown owner handling. Native SQLite trigger faults prove
  reserve/paid atomic rollback and settlement rollback preserving original held exposure.
- No broad typecheck/build/full suite by this worker; supervisor owns them after source freeze.

## Remaining activation work / limits

S1 is not a physically activated split, S2 local hold/projection protocol, S3 queue/capacity
port, fresh registry, migration, restore, deletion or reconciliation implementation. No existing
Gate/service uses the new broker. Actual multi-process simultaneous contention, process kill,
power-loss and provider execution were not tested: the contention test uses independent SQLite
connections with serialized calls, and the crash boundary test reopens a connection. These are
not exactly-once external transport or general power-loss guarantees.

No live store/config/brain/project/provider/Docker operation, real key/payment/API call, new
checkout, source-repository metadata directory, shared-document edit, commit or push occurred.
All SQLite/model/key data in tests are disposable fakes; fixtures close owned DBs and remove
their OS-temp roots. Production source, tests and this report are frozen for supervisor review.
