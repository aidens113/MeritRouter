# Request admission protocol

Status: Complete; source/dist frozen for supervisor independent verification. No commits or shared-doc edits.
Baseline: feat/request-admission-protocol at c3110a0, isolated roadmap-process.

Owns admission/{admission,request-ledger,sqlite-request-ledger,request-receipts}.ts; gateway/{gate,direct,capacity}.ts; routing/{router,claim-capacity}.ts; scoring/classifier.ts; runners/{types,batch}.ts; one appended storage/migrations.ts entry; new request-admission-protocol.test.ts; proportional request-ledger/classifier-project-scope/gate-request-ledger/gate-request-capture/team-capacity fixtures; this report. Root owns purge/export/service/docs integration. No commits or user services/providers.

Contracts: RequestReceipts(db,now?).blockers(project) -> {requests,slots}; purgeProject(project) -> {receipts}; synchronous nested immediate hook, refuses pending protocol or strict observed-local-transport holds, retains opaque consumed IDs. Root integration remains required before project config/purge writes.

Strict nonempty Gate participants carry exact detached LeaseRef; taskless [] remains explicit. Captured identity reaches classifier/batch/normal requests and metadata/cache publication guards. Sync Admission owner-only facade remains explicit compatibility, never used by default async Gate authority.

Each selected key/endpoint attempt allocates timestamped random requestId before persistence. Immutable data-only binding/fingerprint and fresh/replayed reservation share accounting transaction. Authoritative dispatch intent is separate from optional observational capture, then final synchronous exact SQLite guard after all awaits. Reserve/intent replay or persistence uncertainty never triggers HTTP/fallback. Settlement loads persisted binding and compares final outcome digest; identical replay is harmless and conflict retains original accounting. Paid unknown-cache-write semantics remain in shared accounting core.

Strict request slots count independently of task liveness, use nonce-fenced release, and retain uncertain holds rather than inferring completion from lease or age. Claims/waits retain captured generation; old acquisition cannot delete newer claim. Capacity denotes observed local transport attempts, never strict remote processing concurrency. Abort/socket closure/client death do not prove nonbilling; unknown holds require explicit operator reconciliation with original nonce/evidence and separate conservative paid accounting. No finite TTL proof or PG/policy/key/session/tool/Git backend claim.

Private protocol bindings bounded to262144 bytes each, max256 participants; reserve IDs have seven-day retry window and100000 opaque-key cap, failing closed at capacity. Expired settled bindings without outstanding slot are pruned in64-row chunks; purge preserves anti-replay keys until expired IDs become invalid. No model bodies or credentials stored in bindings, only normalized-input digest and data-only price/participant metadata. Unresolved bindings/holds remain retained conservatively, so crashes can block capacity/deletion until explicit safe reconciliation.

Final worker validation:137/137 named affected checks passed109.96s; router typecheck/build passed. Supervisor integration/acceptance remains separate; no backend or complete R2 claim.


Development findings: first frozen focused52 checks produced48 pass/4 fail. Capture fixture lacked execution membership (three delayed barriers), fixed with its real task execution. Classifier filtering lost members permitted partial batch on cancellation, fixed to reject the entire selected batch. Next83 checks produced82 pass/1 fail: paid T4 completed no result after10s. Isolated repro persisted; diagnostic executor rejection showed StoredTaskDTOSchema.row.tier rejected legitimate T4 in the accepted lifecycle adapter. Supervisor independently reproduced baseline c311 and owns upstream one-line T4 union fix; explicitly authorized the identical local task-queue.ts line after all runs exited. Temporary paid diagnostic spy/assertion removed; original expectation/timeout unchanged. No broader core/verification edits.

Additional hardening: detach normalized request body at Gate entry before persistence awaits; snapshot direct route; use unique probe holder IDs. Added actual explicit task-ID reuse refusal, actual expired-live-request hold, independent Node/SQLite slot refusal fixture (requires router dist build), and dispatch-intent close-drain/input-mutation regressions. Source frozen before next checks.


Frozen affected85/85 passed86.10s (8 files), including unchanged T4 after authorized lifecycle schema fix. Final source-audit corrections afterward: strict lease_json marker also retains a request hold when nonce is corrupted toNULL (cannot adopt legacy expiry); blocker counts request-kind holds only. Original consumed outcome now records true global paid cost even after task-ID reuse, with exact captured-incarnation predicate on per-task charge updates and no task-outcome mutation. New paid-late-reuse and corrupted-nonce regressions added; next checks pending. No source edits occurred during any validation run.


Supervisor review correction: GC originally shared the admission transaction, so capacity refusal rolled its bounded work back. RequestReceipts.prune now commits bounded expiry cleanup independently BEFORE reserve mutation. Reserve/prune reject an externally nested transaction because a released savepoint cannot establish independent commit; default Gate scheduling already calls outside transactions. Deterministic100128 expired-key saturation test checks64-row progress across two refused reserves, eventual admission and preservation of unresolved binding/tombstone. Root purge hook remains intentionally nestable.

Last134-case check produced133 pass/1 fail: corrupted nonce was correctly retained by capacity count but holder-wide leave then deleted it. Fixed leave to clean waits/legacy request rows only; strict request rows require their exact nonce release. Also found classifier swallowed RequestPersistenceError into null verdict and could continue to another model call. Pending classifier promises now propagate that exact error; ordinary unavailable/invalid classifications still resolve null. Journal-error recording cannot mask a request persistence error in classifier/ask. Added reserve/settlement ACK-loss classifier regressions. Next frozen checks pending.


## Final verification and handoff

All source/test edits ended before the successful final serial run. No overlapping WT validation or source edits during that run. Final test-inclusive router typecheck passed afterward (7.99s); router build passed before the run on identical final source. No further source/dist changes after final checks. No WT Node validation/fixture processes remain at worker handoff. Test-owned temp environments/processes were cleaned by teardown. No real providers, user4477, user data, engines, services, commits or pushes.

Final command:
`pnpm --filter switchyard-router exec vitest run tests/request-admission-protocol.test.ts tests/request-ledger.test.ts tests/gate-request-ledger.test.ts tests/gate-request-capture.test.ts tests/classifier-project-scope.test.ts tests/team-capacity.test.ts tests/paid.test.ts tests/budget-control.test.ts tests/cache-creation.test.ts tests/caching.test.ts tests/resilience.test.ts tests/providers-limits.test.ts --maxWorkers=1`

| Test file | Passed |
| --- | ---: |
| request-admission-protocol.test.ts | 12 |
| request-ledger.test.ts | 7 |
| classifier-project-scope.test.ts | 11 |
| gate-request-ledger.test.ts | 12 |
| gate-request-capture.test.ts | 17 |
| team-capacity.test.ts | 8 |
| paid.test.ts | 10 |
| budget-control.test.ts | 13 |
| cache-creation.test.ts | 7 |
| caching.test.ts | 16 |
| resilience.test.ts | 11 |
| providers-limits.test.ts | 13 |
| Total (12 files,109.96s) | 137 |

Checks also run: `pnpm --filter switchyard-router typecheck`; `pnpm --filter switchyard-router build`; `git diff --check` (pass, CRLF normalization warnings only). New helper/test/fixture files are included in hashes below. No repository-wide, panel or backend acceptance was run by worker.

Migration: exactly ONE appended entry, MIGRATIONS total30 (new ordinal30 after lifecycle29). Adds request_protocol_keys, request_protocol, request_protocol_projects; provider_slots lease_json/nonce/uncertain; request_charges lease_incarnation/run_count. Does not include root's subsequent recovery-retention943a74a unit; supervisor will merge that after this unit. The only extra source beyond original brief is the authorized upstream-equivalent task-queue.ts row.tier T4 union; root already owns its baseline fix. Paid fixture diagnostics were removed and original assertions/timeout preserved, with no semantic paid.test.ts diff.

Root integration import/API: `RequestReceipts` from `admission/request-receipts.ts`; constructor `(db, now?)`; `blockers(project): {requests:number;slots:number}` before config write/purge; `purgeProject(project): {receipts:number}` in the same root immediate transaction before private task/charge deletion. purgeProject intentionally supports nesting and refuses unresolved holds. New `prune(): {receipts:number;keys:number}` and reserve require TOP-LEVEL transactions so GC commits independently; do not invoke these inside root deletion savepoints. Public exports/authored package API docs remain root-owned. Async Task participants are runtime-strict; legacy sync Admission stays owner-compatible, taskless Gate[] stays explicit and probes stay separate free-tier compatibility without package-ledger/task authority claims.

Remaining fixture recommendations: all production Gate.request sites were inventoried (ask/classifier; batch supplies participants). The touched proportional task fixtures capture real claims, never create a production current-row fallback. Other direct Gate fixtures in cache-creation/caching/resilience were run unchanged and passed; actual native+command/default completion batch paths pass in capture suite, actual killed-worker restart passes resilience. Session mock-Gate fixtures are not evidence of task-authority enforcement. Supervisor full suite may find additional direct library callers relying on the now-invalid owner-only nonempty Gate contract; migrate only their test-created claim identity, never relax the runtime guard. Do not merge retained recovery changes into this frozen tree during worker-independent verification.

Limits: SQLite is still synchronous internally. Existing budget/key/catalog snapshots remain trusted in-process policy; no PG, authoritative remote policy, session/tool/Git fencing or instantaneous cross-process remote revocation claim. Capacity bounds observed local transports, not remote provider processing/billing. Unknown strict holds persist, including damaged proof, and can block new capacity/project deletion. This unit supplies no destructive operator recovery API or TTL-based death proof; any operator reconciliation must preserve exact request/nonce evidence and uncertain paid audit under a separate approved policy. Root must integrate purge hooks; worker helper tests are not proof that unmodified root project deletion calls them.

## Frozen raw worktree SHA-256

Git may normalize CRLF on commit; these hashes identify the verified WT bytes.
- `packages/router/src/admission/admission.ts`: `5cc82ed3d81e2904770d4346b2da65e8b29276ec16a889db74c61e3a8e99a50e`
- `packages/router/src/admission/request-ledger.ts`: `8d70855e85904e9a58903ef07d1c99be4b52a994b12d26453eac6a435760f155`
- `packages/router/src/admission/request-receipts.ts`: `107b4ee7d91dfe4d2054c57cb255cfdb40e6b27bc382394685f0a145f908fb4f`
- `packages/router/src/admission/sqlite-request-ledger.ts`: `530bd960fcea71a7cc6da229ab0dd75844772888207bc512e3797195eb25131e`
- `packages/router/src/gateway/capacity.ts`: `e16a94fdc7bd0f381c22cc5ac625aad1651c5609cccfaaf060c9ed2802f89099`
- `packages/router/src/gateway/direct.ts`: `ac4aca3bdc0b25f133928f452d350ed89de6e2392bb27b1bc15bfb601882f36d`
- `packages/router/src/gateway/gate.ts`: `38d36c9b0fb2797d92395e6af2764477aa0ffa7a41305af3cdda4fdd63dc1713`
- `packages/router/src/routing/claim-capacity.ts`: `b2c9063474031d469176ed001222580f7b27bebbf2ffe00f30aacd2eb36d161f`
- `packages/router/src/routing/router.ts`: `bbf59b474b99a400c4b3865ae558e0c7bfe05cc13e4d249d420ec58a825383b5`
- `packages/router/src/runners/batch.ts`: `f7f7550d51606c09abcb2b76439a036e8dde260822271a80805e277fe0b5b7c2`
- `packages/router/src/runners/types.ts`: `5b7656468e6b32125972e3f0b8bef702789dc9e269545fc35ba70242f4d87e15`
- `packages/router/src/scoring/classifier.ts`: `a8b7070932053c5c1576f8bd631cc6d8421234d316ac6dd13bd198afb03d3dcc`
- `packages/router/src/storage/migrations.ts`: `5beaee00f33711daec63a5f73967123f771ce58171deeb1626332cc5f32f80ca`
- `packages/router/src/storage/task-queue.ts`: `cbc66e60c561fa4b03f334f5b4b55791789a850d5ed627ac49950176724e474e`
- `packages/router/tests/classifier-project-scope.test.ts`: `73ca92787a94cfe2d51e9fffdee833f310c28378981c1d36da4d60594e18b142`
- `packages/router/tests/fixtures/request-capacity-process.mjs`: `15bd28db7535cd02d3214b540fcc725d3b2fdceb5fd9337953a68a3f492403bf`
- `packages/router/tests/gate-request-capture.test.ts`: `a23405a7a6b9bd5d0ffd673cb9bfa1da45e34babb68a0efd7699749c64a105c6`
- `packages/router/tests/gate-request-ledger.test.ts`: `05b1b19388fb0e1e39232a532a31d1413fdb51815ca9b8f68b65111dfeea1e0a`
- `packages/router/tests/request-admission-protocol.test.ts`: `9012adc926366295615533757f2e93e27c0d8706b3e4d084bfc7685512890953`
- `packages/router/tests/request-ledger.test.ts`: `24927278cf2ba34759348e067fc38e88fa715a7f0d4d794ef279b2f72fc59f00`
- `packages/router/tests/team-capacity.test.ts`: `6a7c5c28903c19828519abdcb87bb099e0f12d30b76050169cde3ff63ea108dc`

### Final review correction: classifier finalization (2026-10-22)

Supervisor independent 38/38 checks passed before this correction. Review identified that a captured RequestPersistenceError could still be masked by an exception during the final batch publication loop. Wrapped the entire finalization loop so the original persistence error takes precedence over session finalization, authority/cache checks, or publication failures, and reject all pending callers through the existing flush boundary. Successful classification behavior remains unchanged.

Added four regression cases: reserve versus settlement ACK loss, each combined with an endSession wrapper exception or SessionRecorder.end exception. Each asserts exact original Gate error identity, expected zero/one HTTP transport, and no classification cache publication. Router.prepare has no classifier catch: its awaited classify rejection propagates directly, so no router change was necessary.

Source refrozen before these serial checks; all processes exited:
- `pnpm --filter switchyard-router exec vitest run tests/classifier-project-scope.test.ts tests/request-admission-protocol.test.ts tests/gate-request-ledger.test.ts --maxWorkers=1`: 39/39 passed, three files, 14.19s (classifier now 15 cases).
- `pnpm --filter switchyard-router typecheck`: passed, 9.98s.
- `pnpm --filter switchyard-router build`: passed, 6.60s.

Prior 137/137 result applies to the pre-correction frozen source; this focused run verifies the amendment. No broader suite repeated. Migration and public hooks unchanged. Updated hashes supersede these two paths in the earlier inventory:
- `D:\SwitchYardRouter\.claude\worktrees\roadmap-process\packages\router\src\scoring\classifier.ts` SHA256 `FE7EFD6132B019290D592DF2AC788D2D1B498E2318C244AA717423632666B5F0`
- `D:\SwitchYardRouter\.claude\worktrees\roadmap-process\packages\router\tests\classifier-project-scope.test.ts` SHA256 `861AC65A232206559E6356FC8AC65B4C111BC998C4F460A2B16E47141530C0DB`
