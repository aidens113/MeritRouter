# Request operator recovery plan

Status: Complete, report only; supervisor review pending.
Baseline: feat/request-operator-recovery-plan at e14b8f6, 2026-10-22.
Owner: brain_completion.

## Recommendation and achievable guarantee

Provide supported scoped diagnostics first, then a human-only control action that retires **local scheduling capacity** only after the exact original local attempt is independently proved drained or its registered process birth proved gone. The action preserves original dispatch uncertainty and conservative financial accounting. It never certifies provider termination or nonbilling. Existing holds without such proof remain ineligible; human confirmation cannot manufacture missing kernel evidence. No force-release-any-row, TTL reaper, task-death rule, arbitrary SQL or PID-string control is proposed.

This is an explicit required dependency of admission usability. Current blockers instruct operators to reconcile, but no supported recovery list/action/API/UI exists. The first implementation must truthfully expose ineligible historical holds and actionable reason codes rather than pretending it repairs every existing record. Stronger recovery of legacy unknown ownership requires a separately designed installation-exclusive maintenance proof; it is not established by restarting one panel or by stopping one worker.

## Evidence and present boundaries

Read Current State, accepted request-admission-protocol and session-authority-plan reports, admission/request-{receipts,ledger}.ts/sqlite-request-ledger.ts, gateway/{capacity,direct,gate}.ts, paid/spend.ts, projects/deletion.ts and current panel mutation/auth patterns. Source inference only; no tests, builds, services, providers or runtime mutations performed.

- RequestReceipts.reserve atomically commits immutable input/reservation binding and charge. beginDispatch stores exact dispatchId; synchronous pre-client assertDispatch checks receipt and slot nonce. Keys have seven-day retry window; top-level64-row prune precedes reservation so denied admission still makes GC progress. Unknown holds/bindings remain.
- gateway/direct.ts holds one capacity SlotHandle across same-endpoint credential retries. Several request IDs can therefore reference one slot. Recovery cannot bind only the selected visible request; complete slot cohort and dispatch IDs must be inventoried/frozen. A retry delayed inside the original Gate invocation is still an active attempt even when the first row appears settled.
- capacity.ts strict slots count regardless of task lifetime; nonce+lease_json mark strict proof. quarantine sets uncertain=1, normal release deletes only exact nonce uncertain=0. No authoritative installation host/process-birth/transport-lifecycle registration exists in these rows. AIMD generation is provider policy generation, not transport owner generation.
- Gate.inFlight tracks promises in one Gate object and close drains that Gate and ledger. Empty local set is not evidence about another Gate instance, process, host, old binary or abandoned client.
- RequestReceipts.reconcile accepts same settled outcome digest as no-op and rejects a different one. Thus a settled uncertain outcome cannot currently be changed to late success by ordinary reconcile. Unsettled original receipt can still accept truthful late consumed usage. Accepted task-incarnation charge CAS prevents mutation of a new task insertion, but original request metadata and PaidSpend.settle still require exact once correction discipline.
- PaidSpend.settle unconditionally updates actual_usd/cost_basis; the request receipt currently supplies idempotence. Calling it as an operator override would bypass that protection. failed outcome means zero/not_billed; never fabricate failed for uncertain dispatch.
- Taskless Gate participants=[] creates no request_protocol_projects mapping; probes can have strict slots but no model request receipt. Both require install-scoped diagnostics. Malformed/unknown or cross-scope binding is restricted install-level control, never inferred from latest task/alias/label.
- Root deletion calls RequestReceipts.purgeProject before task/capture/charge cleanup. Current purge refuses unsettled receipts or strict holds, then settled private bindings are deleted; accounting rows remain and request_charges are removed/project anonymized. Releasing capacity must not make unresolved financial/private-binding evidence suddenly purgeable.
- Existing panel proxy permits token-less local operation and authenticates cookie when configured. Routes stamp human:panel or human actor server-side, but admin quarantine accepts an actor string. Such a string is attribution, not unforgeable human authority. New recovery control requires an actual trusted control capability and endpoint isolation; do not copy the attribution string as authorization.

## State model: preserve independent facts

Use separate orthogonal state, never overload request_protocol.state/outcome_digest:

| Fact | Proposed values | Meaning |
|---|---|---|
| Local owner proof | active / drained / dead_proved / unavailable | Evidence about the local transport invocation, not remote processing. |
| Scheduling hold | held / retired_by_operator | Explicit control decision after local proof; original slot archive remains. |
| Original request protocol | reserved / dispatch_intent / settled | Existing immutable dispatch and first financial outcome protocol retained. |
| Financial uncertainty | unresolved / exact_original_settled / adjusted_with_evidence | Retain conservative spend until truthful supported accounting evidence. |
| Recovery operation | prepared / applied / refused | Operation receipt, not tool/provider outcome. |

No separate prepared mutation is needed if proof collection is read-only and final application is a single local immediate transaction. If a future drain command aborts/waits on a producer, that is an effect with its own operation protocol and cannot be represented by an in-memory prepared flag.

## Required local owner/attempt prerequisite

Introduce new gateway/attempt-owner.ts and gateway/attempt-registry.ts (strict DTOs, adapter-owned host evidence), integrated at Gate request admission and actual client dispatch. Durable registration binds install identity, immutable host identity, random process instance, PID plus kernel process-birth token, and invocation nonce. Do not accept registration/birth supplied by model input. Windows adapter must compare trusted OS process creation identity with exact PID handle semantics; Linux uses boot identity plus process start identity, robustly parsed and revalidated. Permission denied, PID reuse ambiguity, remote host, malformed evidence, unavailable process APIs or unknown boot means unavailable/refuse. No host modification/daemon is required or authorized by this plan. An explicit host adapter acceptance fixture is prerequisite to enabling dead_proved, not a new fake cross-platform proof.

Register invocation and immutable complete holder identity **before any slot acquisition/HTTP**. Durable attempt state transitions admitted -> dispatching -> draining -> drained; request/dispatch membership is added atomically before each actual transport and never borrowed from a new task incarnation. No new credential/endpoint retry may issue once recovery fence is set. Persist exact local drained proof only after all provider promises/callbacks/ledger operations and holder membership are finished; an AbortSignal or socket close is insufficient. A process birth proven absent implies no further local callbacks from that process, but still says nothing about remote processing/billing.

All modern processes using this install must enforce registry and recovery fences. Legacy/unregistered holders are never upgraded from current task state. Synchronous immediate pre-client guard checks invocation recovery fence as well as request/slot. Process proof read is outside transaction; final CAS verifies unchanged owner/attempt+cohort version, and death proof is scoped to immutable process birth (PID reuse cannot turn absent birth live again). A live registered owner, even stalled, refuses action; stopping/draining it is a separate supported lifecycle action. A closed Gate with still-pending accounting refuses proof of drain.

## Async backend/control DTO contract

New admission/request-recovery.ts owns strict schemas/interface and errors; sqlite-request-recovery.ts owns atomic persistence. Async calls return detached bounded DTOs. No Db, SQL, host paths, secrets, closures or arbitrary effect commands cross the port.

```
list({scope:{kind:'project',project}|{kind:'installation'},cursor?,limit<=100}): Promise<Page>
inspect({scope,holdIdentity}): Promise<RecoverySnapshot>
preview({controlCapability,scope,holdIdentity}): Promise<RecoveryPreview>
retireLocalHold({controlCapability,operationId,scope,holdIdentity,
  expectedSnapshotDigest,confirmationToken,reason,acknowledgeUnknownRemote:true}): Promise<RecoveryResult>
receipt({controlCapability,operationId,digest}): Promise<RecoveryResult|null>
drain(): Promise<void>
```

holdIdentity binds exact slotId, slot nonce, original AIMD generation, platform, holder invocation nonce and owner-registry identity; request set binds every request fingerprint+dispatchId+state version+original task-incarnation/project cohort, not public client-supplied reconstructed rows. Missing nonce/registry or inconsistent complete cohort -> evidence_unavailable. A selected project must own the complete immutable cohort; shared/mixed/unknown entries are installation-only and private projects never appear in project-scoped counts or error strings. Taskless/probe rows use explicit installation scope. KeyRef, payloadDigest, raw LeaseRef owner, paths, labels and request bodies are not normal public outputs.

RecoverySnapshot exposes safe request IDs/provider/endpoint where scope-authorized, age as diagnostic only, protocol status, localProof enum, financial uncertainty, conservative reserved/retained amount, eligibleActions and fixed reasons. Complete private binding digest and raw slot nonce can remain server-side inside an opaque short-lived preview token. Token binds operation target, user/control session, scope, cohort/version digest, expiry and action, with server MAC or stored random nonce; expiry is UI consent freshness, not transport death evidence. Refreshing preview never adopts a changed target silently.

Operation IDs include issuance window+random entropy; digest binds action/target/snapshot/reason/acknowledgement+trusted actor identity. Final transaction revalidates control authority, proof freshness, current exact slot/cohort/attempt fences, no active owner, unchanged accounting/binding, and expected consent token. Insert durable recovery receipt plus immutable hold-retirement record and local capacity exclusion atomically. Preserve original slot evidence; capacity LIVE_SQL must exclude only exact matching retired identity, never wildcard holder/platform. assertDispatch must deny retired invocation even if old code resumes after an awaited callback. Normal release and late callbacks cannot erase recovery audit or delete a replacement nonce.

Result semantics:
- applied: local hold retired with immutable audit; remoteState remains unknown; financial retention explicitly returned.
- replayed: exact operation/digest returns same original applied/refused receipt despite later state changes.
- already_retired: independent operation sees exact prior retirement, returns original decision reference and no additional mutation; different target/digest conflicts.
- refused fixed codes: active_attempt, proof_unavailable, scope_unavailable, snapshot_changed, accounting_pending, control_unavailable, quota_exhausted, closed.
- PersistenceError on possible commit carries operation ID; query/retry exact receipt, no new override and no provider HTTP.

Retirement leaves request_protocol dispatch_intent/reserved/settled exactly as observed; do not invent terminal failure/success or clear provider/model quarantine. Conservatively retain original paid reservation/uncertain amount, token charges and original policy/pricing attribution. A denied decision may be auditable with bounded fixed reason; never store unbounded raw exception/provider bodies in public audit.

## Truthful late usage and correction protocol

First backend/control unit preserves existing original settlement paths without financial adjustment. A distinct later accounting-observation unit is required for new corrections:

1. Original un-settled protocol + late authentic provider result: ordinary RequestReceipts.reconcile once, using original reservation and original task incarnation; duplicate identical digest no-op, conflicting digest refuses. Local retirement does not reject genuine consumed accounting. Local capacity remains retired; never reopen/reissue HTTP.
2. First settlement already committed but ACK lost: same original outcome digest replays; operator retirement must not write any outcome digest. Exact request paid/token effects occur once through existing receipt.
3. A **settled uncertain** outcome followed by truthful new usage: ordinary reconcile currently rejects this. Add a distinct append-only accounting-observation/correction protocol, not allow arbitrary changed reconcile payload. Evidence comes from the original trusted transport callback or an independently verified provider billing adapter; human typed cost/status is not provider proof. Stable observationId+digest binds original request/fingerprint/dispatch/cohort, baseline outcome digest and normalized accounting-only outcome. Store original uncertain settlement and subsequent observation separately. A CAS chooses the one accepted correction; duplicate observation no-op, contradictory evidence quarantines and preserves conservative charge. Parent service must not let rejected observations trigger HTTP fallback.
4. Compute current financial total from original retained liability plus an exactly-once versioned adjustment (or CAS update plus immutable adjustment audit) in one transaction. PaidSpend.settle direct overwrite is not public recovery API. Repricing uses original immutable paid policy; unknown cache-write/search prices retain conservative liability. A provider-reported cost can be above reservation; record truthful actual without silently capping, preserve budget incident. Token charge correction targets original captured incarnation, not a new task's counters/result. No task outcome/workspace mutation.
5. For dead process whose result was lost, there may be no provider invoice identifier/evidence available. Remain uncertain indefinitely until supported independent evidence or a separately approved financial write-off policy; absence of future callback is not nonbilling proof. This plan does not add arbitrary invoice fetch/provider quota spend.

An implementation may limit first **retire eligibility** to unresolved original receipts and uncertain ACK cases whose late observation protocol it actually supports. It must show precise ineligible reason for settled-uncertain unsupported corrections; no claim complete recovery if that pathway is excluded. First unit makes no financial adjustment: ordinary original late settlement/replay remains as implemented, and settled-uncertain correction stays explicitly unsupported/ineligible until the distinct observation unit is accepted. Unresolved original request/financial blockers remain; local retirement is not reconciliation completion.

## Private purge and retention

Local scheduling retirement is not project purge permission. Root blockers add unresolved accounting observations/liabilities, held/draining producers and retained original dispatch proof even when local capacity no longer counts. Do not simply reuse state!='settled' for financial blockers: settled uncertain is financially unresolved. Root performs fresh blocker checks BEFORE config mutation and scoped private purge inside the same immediate DB transaction.

While late accounting can arrive, retain minimal immutable request reservation/cohort/pricing/charge-incarnation and operation evidence required for correct settlement. These fields can themselves contain private project/task/key binding; mark them restricted retained accounting evidence, do not call them purged/anonymized. No raw messages/tool schemas/credentials are required; normalized capture payload may follow existing private retention policy only if independent accounting binding remains. Current purge removes charges and private protocol binding, so deletion must refuse until this retention path is implemented and accepted. First unit deliberately refuses deletion on any unresolved recovery liability; no detached anonymous late-settlement guesswork.

After genuinely resolved original accounting and absent local producer, explicit scoped purge removes private recovery/observation bodies and cohort rows, preserves opaque consumed-ID/digest tombstones and already-retained financial rows. Taskless/unknown-scope evidence remains installation restricted. No cross-project join through latest rows; immutable old project set governs authorization and purge. Project reincarnation with same slug must not inherit retained evidence; future registry should bind project insertion identity, or conservative deletion/recreation refusal must remain until that identity exists.

Bounded quotas: propose100000 recovery/observation keys,100entries/page,256KiB immutable cohort binding,2000UTF8 bytes reason,64row GC batches. Refuse unknown oversized/malformed evidence, do not evict it. Terminal payload retention window and antireplay issuance window must be explicit matching accepted seven-day request scheme; active/unresolved recovery liability never expires because of TTL. Run GC top-level independently before potentially refused admission; reject unsupported nesting, or document safe separate root cleanup. Operator list includes quota reason and unresolved counts without private leaks.

Shutdown refuses new control actions, drains tracked preview/proof/application/observation operations before DB closes, preserves uncertain receipts on timeout, never background retries provider calls. Restart resumes exact operation receipt lookup; no automatic retirement. Process registry rows/boot observations survive until all referenced requests and unknown remote liabilities resolve.

## Human authority and UI follow-on

The service issues an unforgeable local control capability only to an authenticated trusted operator entry point. It is never in RunContext, harness/model tools, general MCP tools or job gateway; actor:'human' supplied as JSON is rejected. CLI local human command and panel server may obtain it through explicit trusted construction after authorization. Library embedders are trusted code, but the capability must not accidentally be serialized into a worker tool. Token-less panel deployment requires verified loopback-only control and same-origin/CSRF protection or action unavailable until authenticated; existing routes alone do not prove safe high-impact mutation.

Separate UI follow-on: project recovery diagnostics and install-only unknown entries, request detail link to original safe accounting, local-proof state, conservative retained financial amount and plain explanation that provider may still process/bill. Active/unproven attempts show disabled action with fixed actionable reason; no force option. Preview requires fresh snapshot, deliberate reason and typed target confirmation; checkbox explicitly acknowledges local scheduling risk and retained billing. Server issues actor/capability and revalidates; browser never asserts proof. A successful page says 'Local capacity hold retired; provider completion and billing remain uncertain' unless independent billing evidence actually resolved it. Request pending/reload keeps original operationId; stale preview409 prompts refresh, never auto-confirms new target. No private raw request/credential/host/path dumps. Retained liability blocks deletion with accurate text and recovery navigation.

## File partitions and dependencies

A0 diagnostics can be separately accepted before mutation: new admission/request-recovery.ts DTO/read port + sqlite-request-recovery.ts read implementation, new admin/request-recovery.ts projections; tests/request-recovery-diagnostics.test.ts; root exports only. No migration required for read-only existing rows. Mark all old process proof unavailable and all actions disabled.

A1 prerequisite+backend control (one serial worker owns shared gateway/admission files): new gateway/{attempt-owner,attempt-registry}.ts, new admission/{request-recovery,sqlite-request-recovery}.ts or extend A0 named files; gateway/{gate,direct,capacity}.ts; admission/{request-receipts,sqlite-request-ledger}.ts; minimal core/service.ts tracked drain under root authorization; next migration appended only AFTER Compose31 release/named baseline. New tests/request-recovery.test.ts, request-recovery-owner.test.ts, fixtures/request-recovery-process.mjs; own report. Root owns projects/deletion.ts/admin/projects.ts hooks and exports/authored docs after API freeze. No concurrent migration/source overlap with session journal work.

A1b distinct financial observation unit: new admission/request-accounting-observations.ts plus sqlite-request-ledger.ts and paid/spend.ts, exactly-once adjustment tests/report; supervisor serial ownership and optional next migration required. No dependency on UI exposing arbitrary financial mutation. Original outcome_digest stays immutable.

A2 control surface authority: new dedicated admin/operator-control.ts and request-recovery projection wrappers plus panel auth/origin integration, named CLI surface if approved. Do not add public model-callable MCP mutation. Root briefs auth files and exact capability constructor separately because session plan cannot infer security from current human attribution strings.

A3 UI: apps/panel/app/p/[slug]/requests/recovery/page.tsx, install settings recovery page, dedicated API GET/preview/retire routes and component; request detail/navigation touched only named files, optional diagnostics live signature admin/live.ts owned separately after contract stable. Build+demo+production screenshots/client interactions; no real4477/config changes without explicit session authorization.

## Required fault and adversarial checks

- Real blocked fake HTTP is active: every operator confirmation still refuses, no competing local call under ceiling. Client abort/socket close is not death proof.
- Actual killed subprocess with accepted kernel birth registration: exact old birth absence permits preview/control; reused PID, foreign host, denied process inspection, malformed registration, legacy slot -> refuse.
- Two Gate instances/processes and several key attempts share exact slot; complete membership version race invalidates preview; no early capacity retirement or new key retry.
- Commit then ACK loss for retirement and accounting observation: same IDs replay once, altered reason/target/digest conflict, no duplicate model or paid adjustment. Crash before commit leaves original hold.
- Truthful original late success after retirement: exact original request bill once, no new task incarnation mutation; already-settled uncertain correction uses separate auditable CAS, contradictory usage remains quarantined.
- Worst-case unknown cache writes/search cost preserved; no implicit zero/refund, no capped actual when provider reports more; legitimate retained budget remains consumed.
- Unknown/mixed/taskless/probe scopes restricted; private project list/counters/errors cannot reveal foreign identities. New task ID/project slug cannot adopt old binding.
- Deletion before/after retirement or delayed usage refuses unresolved liability before config mutation; resolved purge retains opaque replay keys/accounting and removes only allowed private payload.
- New nonce same slotID/holder cannot be retired by old preview; concurrent normal release/settlement yields explicit no-op/conflict, never deletes replacement.
- Quota-saturated repeated refusals advance bounded independent GC; active unknowns never evicted, nested tx misuse refused.
- close during proof/transaction/late accounting drains before DBclose; restart lists unresolved exact evidence, never auto-retire based on time.
- UI unauthenticated/CSRF/model-supplied human/capability replay rejected; active/missingproof confirmation stays disabled; client lost response reloads original operation.

## First backend/control brief (24 lines)

- Unit request-recovery-control; supervisor-named baseline AFTER Compose31 migration release.
- Read this report/Current State and accepted request protocol; no real providers/host changes.
- Own new gateway/attempt-owner.ts, attempt-registry.ts.
- Own new admission/request-recovery.ts, sqlite-request-recovery.ts; no financial adjustment helper.
- Own gateway/gate.ts,direct.ts,capacity.ts; admission/request-receipts.ts,sqlite-request-ledger.ts.
- paid/spend.ts offlimits; minimal service drain only if root releases it.
- Own one NEXT appended migration assigned by supervisor; never edit31/applied migrations.
- Own new recovery/owner tests+actual-kill fixture and own report; no UI/shared docs/commits.
- Root owns exports/project blockers/private purge integration after frozen API.
- Register exact installation/host/process birth and invocation BEFORE capacity/HTTP.
- Strict no-caller-supplied proof adapter; unavailable/remote/legacy/ambiguous owner refuses action.
- Live invocation always refuses; actual drained/dead birth proof never proves remote stopped.
- Retire complete exact slot nonce/generation/cohort with expected snapshot and trusted human capability.
- Durable operationId/digest replay; no arbitrary force release, TTL/task/PID-label inference.
- Keep original dispatch/settlement evidence and conservative billing; no synthetic failed outcome.
- Preserve ordinary original late settlement/replay; settled-uncertain financial corrections are a separate later unit.
- Never reuse current task/project identity or retry HTTP from persistence/recovery failure.
- Keep retained private accounting binding and unresolved-liability purge blocker.
- Fixed safe bounded list/preview/result DTOs; unknown scopes install-only; no raw credentials/body.
- Independently committed bounded GC; active uncertain proof non-evictable; drain before close.
- Test blocked HTTP refusal, real killed owner, birth ambiguity, ACK loss, late usage, ID reuse, purge, quota and close.
- Freeze, run named tests/router typecheck/build; root independently verifies.
- No remote backend, physical remote concurrency or nonbilling completion claim.

## UI follow-on brief (13 lines)

- Baseline only after backend/control API independently accepted; read final contract/report.
- Own dedicated project/install recovery pages, component and exact API routes named by root.
- Own auth/origin files only by explicit supervisor partition; admin/export hooks root integrates.
- Diagnostics fixed bounded safe fields; unknown/taskless entries install-only.
- Trusted server operator capability never from body/role text; no model MCP mutation.
- Reject unauthenticated/CSRF/cross-project/stale previews before mutation.
- Active/unproven controls disabled with actionable reason; no force bypass.
- Preview+typed target+reason+explicit unknown billing acknowledgement; revalidate on submit.
- Persist operationId through retry/lost response, never confirm a changed snapshot automatically.
- Distinguish local capacity retirement from remote completion and retained financial liability.
- Preserve request capture/private scope; show exact deletion blockers.
- Build router/panel/demo production, actual client action/error screenshots; stop temporary server.
- No real4477/user config/providers/commits/shared edits; report bounded validation honestly.

No source/schema/migration/UI changes, validation commands or provider calls made. Inherited paid.test.ts remains untouched. This design does not claim current legacy holds are safely releasable, or any remote provider stop/billing proof.


## Portable local proof refinement (supervisor review boundary)

For the current Windows host use bounded hidden PowerShell/CIM queries with `$ErrorActionPreference='Stop'`, exact numeric PID filters and strict parsed UTC `CreationDate.ToUniversalTime().Ticks` strings. Registration reads the current process creation ticks from OS, persists exact birth+random process instance, and rechecks the same identity before it may dispatch. Recovery positively distinguishes successful empty exact query (original PID absent) from query failure/access denied/malformed data (unavailable); a different creation tick proves original birth absent, never ownership of the new process. A unique local installation identity/host enrollment bound to protected install state is prerequisite to calling this same-host evidence; a caller host label is not enrollment. Without accepted local host binding, refuse proof after restart. Pinning an actual process handle with creation time would be stronger if an existing accepted native API is available; do not invent such a dependency or claim CIM is a pinned handle.

Reuse reviewed observation **patterns** in labs/process-ownership.ts WindowsProcessSnapshotSchema/CreatedTicks and its exact-birth re-query, not its Lab token/command matching as authority for generic Gate requests. In particular its general processAlive wrapper treats all process.kill errors as false; this must NOT be reused as death proof. EPERM/access failure means unavailable, never absent. No changing unrelated Labs implementation is part of this unit.

Linux follows reviewed labs/browser-linux-helper.py birth()/boot_id() and pin_pid() patterns: bounded /proc PID stat parsing after final comm delimiter, exact field22 startTicks plus kernel boot_id, trusted local host enrollment, and pidfd pin where supported. For recovery same boot plus successful exact absence/different birth can prove original local process gone; proc mount visibility/permissions/parse ambiguity refuse. Kernel boot identity change proves the old local process cannot survive only when same-host enrollment and trusted boot observation are independently established. Never approximate boot time from Date.now/process.uptime or use hostname equality. Other platforms and remote owners are unavailable until dedicated adapters are accepted. Test both positive live proof and actual killed-child absence on Windows; Linux acceptance may be conditional on its real host fixture, never inferred from Windows tests.

The retire operation must perform **zero financial mutation**: no PaidSpend.settle, no request outcome_digest/status rewrite, no synthetic succeeded/failed/uncertain receipt and no charge refund. Original late callback accounting remains governed by existing exact original receipt; current unsupported settled-uncertain revisions return explicit conflict with evidence retained. Separate future accounting observation protocol above is prerequisite for financial correction, not a hidden part of hold retirement. Project unresolved-request/financial-retention blockers remain truthful after local hold retirement. Diagnostics can be supported immediately; modern registry-controlled retirement becomes eligible only when actual local proof adapters and fence integration pass acceptance.
