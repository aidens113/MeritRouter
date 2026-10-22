# Async session authority plan

Status: Complete ? read-only design, pending supervisor review.
Baseline: feat/session-authority-plan at 351d867, 2026-10-22.
Owner: brain_completion.

## Decision

Implement the first integrated slice in **classifier sessions only**, using a validated async journal whose ordered event bodies, session metadata/counters, and operation receipts commit in one SQLite IMMEDIATE transaction. Classifier has real default runtime traffic, strict captured task leases and no tool effects or resumed workspaces. This avoids pretending that changing an index adapter migrates filesystem truth, or silently mixing two writers in agent-loop sessions. Do not enable PostgreSQL, shared filesystem journals or remote artifacts in this slice.

For new protocol sessions SQLite event bodies are authoritative. JSONL may be an optional local export with explicit projection watermark, never an effect prerequisite or second truth. Legacy sessions retain existing fsync-before-index/backfill semantics and are explicitly tagged legacy. Never automatically import a file while an old recorder may be live. Conversion of legacy resume remains a later serial unit with exclusive local ownership proof.

## Evidence inspected

Source inference only; no fault reproduction, tests, builds, services or provider calls in this unit. Read Current State, distributed-storage-inventory, task-lease-fence-plan and accepted request-admission-protocol reports. Earlier lifecycle-plan observations are historical, not assertions that accepted async task lifecycle remains unfixed.

| Boundary | Actual source and implication |
|---|---|
| Create | sessions/store.ts create inserts session then creates recorder/started event; crash can leave indexed session without log. Input validates role/profile but carries task ID, no captured lease/session incarnation/host authority. |
| Append | sessions/recorder.ts append allocates seq locally, validates event, opens/appends/fsyncs JSONL then transactionally writeIndex. Index failure consumes local seq; reattach backfills. Two recorder objects have no writer CAS protecting file writes. |
| Reopen/recovery | store.reopen calls reattach before status CAS, reconstructs whole transcript, creates fresh recorder without invalidating old object. markDeadRunning uses callback/task liveness, not captured immutable session writer identity. run-sessions.ts selects prior sessions by task ID and reopens same ID. |
| Model call | runners/types.ts ask synchronously syncMessages/modelRequest before Gate await, then modelResponse. Accepted Gate enforces strict LeaseRef and durable request reserve/intent/settle; session error must never weaken or retry that protocol. Classifier owns a SessionStore and creates separate sessions per member, logs shared cohort and request/response; finalization preserves RequestPersistenceError. |
| Tools | harness/journal.ts persists toolIntent before run and toolOutcome afterward, but no durable operation identity or independently fenced effect capability. toolOutcome deletes local intent before append; failure leaves local/durable state inconsistent. coding/task-tools.ts serializes requests and drains on close, but its active guard is owner-only activeStatus plus deadline. Outcome-record failure enters catch and tries a second outcome; not safe async settlement semantics. |
| Resume | sessions/resume.ts delegates replay by label and commands by idempotent boolean; edit recovery commits/resets using workspace evidence in harness/resume.ts. These policies are not durable deduplication proof for remote tools. Unanswered model request is dropped in transcript but still charged, not permission to retry the same ambiguous attempt. |
| Reads | SessionStore.events reads/parses full JSONL before slicing (default1000/max10000 events); transcript/planResume read all. admin/session-project-scope.ts separately enforces full-cohort privacy with bounded8MiB/50000events file scan. admin/request-evidence.ts uses own bounded JSONL reader (512KiB/session,4MiB total) and exact response requestId anchoring. New event backend must feed both readers without bypassing those checks. |
| Artifacts | storage/artifacts.ts writes file then metadata, no fsync/atomic publish protocol, no strict row/input zod, and no task incarnation or project identity; get casts stored row. read loads entire Buffer; absolutePath exposed. Metadata failure can orphan bytes. This is current local compatibility, not a proposed remote authority contract. |
| Artifact consumers | Writes: completion/readonly/batch/native/supervisor/coding finish, harness web/check tools, context/upstream, verification followup/review, qualification. Reads: context/sources, harness/tools, acceptance/calibration/audit/review, qualification, CLI/MCP/admin insights. Batch response is taskless with executionId: ownership must bind full immutable participant cohort, never infer from one task. |
| Scope | sessions has stored project_id populated by insertion trigger. admin sessions checks session/project plus complete execution cohort; request evidence preserves payloadScopeExclusive and normalized capture separately. New session creation must explicitly bind immutable project+task incarnation. Current-task joins cannot adopt old sessions/artifacts after explicit task-ID reuse. |
| Delete/close | projects/deletion.ts collects local files, removes session_events/sessions/artifacts for scoped task IDs and retains financial accounting. service.close starts Gate drain, stops scheduler/executor, closes Labs/promotion/Gate then DB; async session/artifact drains must finish before DB close, including classifier activity not owned solely by executor. |

## Identity and executable port contracts

All requests, stored rows and receipts use strict zod; bounded arrays/UTF8 payloads and detached immutable values. IDs and digests are allocated before await and never synthesized by reading latest rows on behalf of a stale caller.

- Task authority is accepted full LeaseRef={taskId,owner,runCount,incarnation,project}; server checks state/cancel/expiry/deadline using its own clock in each mutation transaction.
- SessionIdentity={sessionId,sessionIncarnation:32hex,project,task:{taskId,incarnation},originLease:LeaseRef}. Origin attribution never changes on reopen.
- WriterFence={sessionId,sessionIncarnation,epoch:positiveInt,nonce:32hex,lease:LeaseRef,host:{installationId,hostId,processInstance}}. Host fields are provenance; actual process liveness/remote takeover authority requires independently established evidence. Owner-label difference, path existence, PID alone or heartbeat TTL alone does not prove effects stopped.
- Reopen rotates epoch+nonce atomically and binds new captured LeaseRef of the **same task insertion incarnation**. Original events retain their old writer attribution. Old writer append/close denied, even same owner/run string or session ID reuse. Taskless control sessions require an explicit independently issued host capability, never missing-lease fallback; first slice rejects them.

Proposed SessionJournal async API (new sessions/journal-port.ts; illustrative types need final schemas):

```
create({operationId,sessionId,sessionIncarnation,lease,role,agentLabel,
        profile,tier,parentIdentity?,previousIdentity?,cohort}): Promise<OpenReceipt>
append({operationId,writer,expectedSeq,event:{type,data}}): Promise<AppendReceipt>
close({operationId,writer,expectedSeq,status,reason}): Promise<CloseReceipt>
reopen({operationId,identity,expectedEpoch,lease}): Promise<OpenReceipt> // later unit
read({project,identity,afterSeq,throughSeq?,maxEvents,maxBytes}): Promise<EventPage>
receipt({project,operationId,digest}): Promise<OperationReceipt|null>
blockers(project): {writers:number,uncertainOperations:number} // SQLite local root hook
purgeProject(project): {sessions:number,events:number,receipts:number}
drain(): Promise<void>
```

create commits metadata+started event+receipt together. append assigns server seq via expectedSeq CAS, stores validated body+digest+index+counters+receipt together. expectedSeq conflict is explicit; do not blindly rebase/retry a different event. Same operationId+same digest returns original receipt; changed writer/event/expectedSeq rejects. close terminal status and ended event are one mutation; replay succeeds even after terminal state/lease expiry using original receipt. New mutations require live writer/task authority. Read uses stable throughSeq watermark/cursor bound to project+session incarnation and a byte/event budget; no unbounded whole-log allocation. Empty page cannot signal successful complete transcript when quota was hit.

Durable operation identity/fingerprint must bind method and every immutable field. Retain original receipt on ACK loss, return typed SessionPersistenceError carrying operation ID/session identity/phase; reconcile same operation only. Do not catch as classifier unavailable or ordinary tool error; never model fallback because journal ACK failed. If failure was definitely before model/tool issue, no effect; if Gate or tool already ran, preserve original consumed accounting/effect evidence and stop execution until reconciliation. Gate RequestPersistenceError takes precedence over failed diagnostic journaling.

Async recorder is an ordered facade over the port, not an unawaited queue: syncMessages/modelRequest/modelResponse/modelError/note/end return Promises and callers await before continuing. Serialize per writer; allocate operation IDs before enqueue, advance local transcript/intent/ended state only from validated receipts. No DB callbacks after drain. A poisoned/uncertain writer rejects new effects until exact receipt reconciliation.

## First integrated slice and file ownership

S1 scope: new classifier sessions use async protocol by default. Existing loop/review/native sessions remain explicit legacy local compatibility; no cross-backend writer for the same session. No tool-fencing completion claim.

Worker A, serial source partition:
- NEW sessions/journal-port.ts (strict DTO/errors), sqlite-journal.ts (atomic body/receipt authority), async-recorder.ts (awaited facade), journal-read.ts (bounded canonical/legacy read routing).
- sessions/store.ts: retain synchronous legacy create/reopen; read protocol metadata/events via bounded SQLite reader, refuse legacy reopen/recorder for protocol sessions. Existing sync transcript convenience must enforce a fixed bound and return explicit unavailable rather than partial success for protocol logs.
- scoring/classifier.ts: await create and each note/message/request/response/error/end using captured leases; final rejection preserves original financial or session persistence error through every finalizer. Revalidate batch all-or-none after each admission await; create a partial cohort must not dispatch.
- core/service.ts minimal construction/drain wiring only after supervisor authorizes this file; tracking wrapper must own classifier journal promises, including independent router.prepare callers.
- admin/session-project-scope.ts and admin/request-evidence.ts replace only low-level raw journal loading with bounded backend-aware reader. Preserve existing full participant checks/redaction/exact request anchors; normalized Gate capture remains separate provenance.
- storage/migrations.ts ONE appended migration **after Compose31 is committed/released and fresh supervisor baseline is named**, never edit31/applied entries. Parent owns exports and project deletion integration.
- NEW tests/session-journal.test.ts, tests/session-classifier-journal.test.ts and fixtures/session-journal-process.mjs. Own report only beyond these files.

Migration design: nullable protocol marker/session incarnation on sessions for legacy distinction; separate writer row with original task incarnation/project/lease and epoch/nonce; canonical session_event_bodies keyed(session identity,seq), operation receipts/tombstones and scoped cohort rows. Keep event body FK/size checks; receipts carry bounded identifiers/digests and independently pruneable terminal payload. Do not silently backfill authority from today's task rows. New protocol writes must avoid old project trigger inference; enforce project/identity explicitly. Append-only SQL ownership remains one worker, migration ordinal assigned only at dispatch.

S1 does not require changing SessionEventSchema or normalized request capture DTO. Protocol envelope stores writer/origin identity outside historical event shape; model_response still carries exact Gate requestId. Never represent synthetic export/reconstructed transcript as normalized provider input.

## Follow-on serial units

S2: migrate run-sessions.ts, core/executor.ts, runners/types.ts, batch.ts, verification/review.ts and all agent loop recorder callers to awaited protocol; include shutdown/watchdog/workspace/session-workspace and service resume paths. Split by file in written briefs, not simultaneous changes to shared runner/types. Freeze S1 before S2. Legacy resume import must verify closed local writer/host, scan full bounded validated log/index, persist immutable import digest and bytes; corrupt/oversized/missing proof means unavailable/operator action, not guessed transcript.

S3: effect journal authority: harness/journal.ts/resume.ts/tools and coding/task-tools.ts implement strict captured-lease guard at actual dispatch, before/after awaits; persisted effectId+digest binds tool name/normalized args/resource generation/session writer. Durable prepared intent != issued proof != successful outcome. Mutating tools must consume a receipt-backed capability from service enforcing actual task/resource authority; prompt, labels and idempotent boolean are not capability. Cross-system calls cannot be made atomic with SQLite: persist issued intent before effect, retain uncertain state on lost response, reconcile independently verified outcome, never automatically repeat commands/Git/brain/delegate on ambiguous journal failure. An intent with no issued marker is safe to abandon only if issuance protocol proves it never escaped. Explicit allowlisted reads may be rerun under new lease with new attribution; replayed output is observation, not fresh authority. Existing Gate request receipts remain sole model financial protocol.

S4: artifact port and runtime caller migration. ArtifactIdentity binds artifactId+incarnation, immutable project set, original task insertion incarnation or execution/cohort proof, host/object namespace, contentHash/bytes/mediaType. write({operationId,lease,ownership,kind,label,bytes-or-uploadHandle}) and commit/read/query/purge DTOs validated; no absolute paths across async API. Object staging to random owned no-follow path, fsync content then atomic owned publish, verified hash/size, metadata+receipt atomic, orphan cleanup queued with exact owned object nonce. Physical file write and DB commit are not crash-atomic; acknowledgement loss queries original receipt, never creates new artifact or removes uncertain bytes. Host-local missing bytes -> unavailable, never resolve another host's absolutePath. Future object backend needs independent bounded streaming/hash/authentication contract. Shared artifacts require complete cohort authorization; taskless compatibility capability explicit. Migrate raw whole-Buffer consumers to bounded streams or deliberate cap/error; never truncate a patch/check log and call it complete evidence.

## Recovery, scope, retention and deletion

Recovery chooses exact old writer identity and compares persisted task insertion/generation; kill actual fixture process after commit-before-ACK and after intent-before-response. A new valid task lease can take over session writer; old transport/tool uncertainty remains separate unresolved evidence, never erased by writer recovery or finite TTL. Historical read permission is project authorization plus immutable complete cohort, not live task authority. Where old evidence cannot establish cohort, retain current unavailable behavior; no project identity inferred from alias/label/parent pointers.

Private JSON bodies/transcripts/tool arguments/output/artifact bytes can contain secrets and source. Mask read projections using existing request-evidence rules, maintain access scope at service boundary, avoid raw errors in public receipt DTOs. Fixed internal bounds proposed for review:256KiB/event,1000events/1MiB per page,32MiB/50000events per active session,100000 operation keys global,64-row independently committed GC chunks; refuse before dispatch at quota, do not drop active/uncertain evidence. Large model reply requires pre-reserved journal capacity or explicit bounded external blob protocol; no silent truncation of tool argument/effect proof. Bounds are proposed product decisions, not existing guarantees.

Receipt antireplay issuance window/tombstones follow accepted task/request patterns. Terminal payload may expire on configured retention only when no referenced uncertainty remains; opaque keys outlive replay window. Cleanup must commit independently before admission that can refuse, and explicitly reject unsupported nested transactions rather than rolling all GC back with capacity denial. Quota pressure must never evict unknown holds, active writer evidence or financial accounting.

Root integrates blockers BEFORE config deletion; after asynchronous drains revalidates in same immediate deletion critical section. Scoped purge removes private protocol events/receipts/object references by immutable ownership, refuses active/uncertain effects, preserves opaque replay keys and financial rows. File/object deletion uses exact owned nonce/hash namespace, no foreign paths; crash after row purge needs durable owned deletion outbox, not metadata-free guesswork. Read scopes cannot broaden because one cohort member/project was removed. S1 migration hook must report bounded counts, not payloads. Session closed alone is not proof remote model/tools stopped.

Shutdown stops new journal admissions, aborts effect producers, drains scheduler/executor/classifier/tool bridges, allows existing append/close reconciliation during final persistence grace, drains journal/artifact writes, then closes DB. Do not close journal admission before producers can append required final outcome. Timeout means unresolved durable intent/operator reconciliation, not successful close or released remote capacity. No background fsync/SQL/export after DB close.

## Required fault acceptance

1. Real default classifier async path commits ordered events, exact request linkage and unchanged accounting; same-project batch retained, cross-project denied before body publication.
2. Create/append/close commit then throw ACK loss: same operation replays once, no duplicate counters/event/model call; mismatched digest rejected. Rollback-before-commit means no effect.
3. Two writers race expectedSeq; old session writer after reopen cannot append/close even reused owner/taskID. Delete/reinsert task/session identity does not adopt old references.
4. Delayed append spans lease expiry/cancel/deadline/takeover without AbortSignal: zero subsequent HTTP/tools. Financial uncertainty survives failed model-error/end recorder paths.
5. Actual killed subprocess committed event before ACK: restart reconciles original receipt; kill during unknown model/tool effect does not authorize reissue. Live owner cannot be displaced based on a different owner string.
6. Canonical row corruption/gap/oversized body/page/exhausted quota fails closed with bounded memory; repeated saturated refusals still advance independent GC, including nested txn refusal tests.
7. Backend-aware historical scope rejects mixed/deleted/private cohort or stale task incarnation; preserve normalized capture vs historical journal provenance and secret masking. JSONL export missing/stale cannot hide canonical events or broaden scope.
8. close with delayed commit/settle/classifier finalization drains before DBclose; new create rejected, already tracked completion awaited; no post-close callback.
9. Artifact staged write/metadata ACK loss/hash mismatch/foreign symlink/dead host and purge races preserve original bytes/uncertain proof; streamed reads cap bytes and report incomplete explicitly.

## Ready-to-dispatch first brief (24 lines)

- Unit: classifier-session-journal; feature WT from supervisor-named accepted baseline after Compose31 release.
- Read this report and Current State; do not enable any remote backend.
- Own new sessions/{journal-port,sqlite-journal,async-recorder,journal-read}.ts.
- Own sessions/store.ts bounded backend read routing/legacy separation only.
- Own scoring/classifier.ts awaited protocol default path only.
- Own admin/{session-project-scope,request-evidence}.ts low-level reader integration only.
- Own minimal core/service.ts construction/drain only when explicitly released.
- Own next appended storage/migrations.ts entry after supervisor assigns ordinal; never edit31.
- Own new tests/session-journal.test.ts, session-classifier-journal.test.ts, fixtures/session-journal-process.mjs and own report.
- Root owns public exports/project purge integration/shared docs.
- Strict captured LeaseRef plus immutable session incarnation and rotating writer fence; no current-row synthesis.
- Store canonical event body/index/counters/receipt atomically; JSONL is optional local projection.
- Stable operation IDs/digests bind exact call; replay validates original receipt; mismatches refuse.
- Preserve full cohort privacy, exact Gate request linkage, capture/journal provenance and financial errors.
- Async classifier awaits recording before HTTP; journal uncertainty rejects, never classifier-null fallback.
- Bound byte/event reads and admission; independent GC progresses under refusal; uncertain evidence never evicted.
- Keep legacy recorder/create/reopen explicitly local; reject legacy writes to protocol sessions.
- Track/drain classifier journaling through service close; no SQL after close.
- Tests: ACK-loss replay, competing writer CAS, stale lease/ID reuse, cross-project scope, kill/restart, quotaGC, close drain.
- Run named tests then router typecheck/build serially on frozen source; root independently accepts.
- No providers/user data/OS changes, commits, shared edits or PG completion claim.

## Limits

This report defines a next unit, not a completed session/artifact/tool authority migration. No implementation or validation run occurred. Existing paid.test.ts dirty file preserved untouched. Migration31 remains Compose-owned. External provider processing/billing uncertainty cannot be resolved from local socket/process death.

## Separate required dependency: admission uncertainty operator recovery

Accepted strict request holds deliberately persist after uncertain settlement or client crash. There is currently no supported human operator list/reconcile API or UI; diagnostic project/capacity blocker text recommending reconciliation does not supply that capability. This is a separate required product unit, not session-journal cleanup and not completed by S1. Present provider-slot records do not contain authoritative host/process-birth evidence. TTL, task death, PID strings, owner-label changes, aborted sockets and journal/session close cannot justify automatic release or prove remote provider completion/nonbilling.

Proposed separate bounded unit, after supervisor approves policy: admission/request-recovery.ts strict DTO/service plus admin/request-recovery.ts safe scoped projections; root later owns exports/CLI/MCP/panel integration in serial briefs. Human-authenticated operator capabilities must come from the existing trusted service/control boundary, not a caller-supplied boolean/agent role. Scope listing by immutable request protocol project/cohort binding; expose fixed status/reason/count fields, original request/dispatch identity and reserved/known-spend attribution without credentials or model body. Malformed/unscopable holds are install-level restricted recovery, never assigned to a project by latest task lookup.

A list operation returns bounded cursor pages of uncertain request/holder identities and exact nonce/binding digest where private control access permits, plus why they block. A reconcile command supplies a fresh operationId, selected immutable request+original slot identity, expected binding/state version, bounded reason and explicit human decision. Persist an idempotent immutable recovery receipt and state transition in one immediate transaction. Reject stale/cohort-mismatched/changed decisions; ACK loss replays the same decision, not a second release. Uncertain evidence and original dispatch/billing attribution survive every decision.

Required policy decision before implementation: distinguish (a) independently verified provider billing/result reconciliation from (b) operator accepting local scheduling risk and explicitly retiring a local hold. The latter permits new local attempts only as an acknowledged control decision; it is **never proof the original provider stopped**. Preserve conservative unknown/worst-case charge or the original paid reservation and quarantine until separate financial reconciliation resolves it. Do not turn a scheduling override into zero spend, ordinary definitely-unsent failure or erased intent. A mere historical ended task/session cannot authorize either action. Public UI must explain this uncertainty and show the unresolved financial status separately from local hold status.

Recovery receipt/tombstone retention and scoped purge must preserve original evidence, prevent resurrection/replay, and keep financial records. Root must integrate new blocker states before project configuration deletion; human local-capacity override alone must not automatically allow private evidence purge. Future authenticated provider evidence adapters may support stronger reconciliation, but no current row or finite TTL supplies that proof. No new auto-reaper is recommended.

Required acceptance: real killed client with retained strict hold is visible through supported operator listing; unauthorized/foreign-project/stale-identity decisions refused; duplicate/conflicting/commit-then-ACK-loss decisions idempotent/fail closed; local risk override preserves worst-case financial reservation and immutable original intent; concurrent late provider settlement binds original request and never mutates another task insertion; ambiguous historical holder lacking authoritative host birth is retained until explicit authorized decision. Test UI/control policy separately from provider completion claims. This unit requires its own serial migration ownership review only if existing receipt schema cannot preserve recovery audit; Compose31 remains exclusive meanwhile.
