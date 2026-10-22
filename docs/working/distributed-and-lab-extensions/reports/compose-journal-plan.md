# Compose journal and runtime integration plan

Status: Ready for architecture review; report only. No engine/runtime completion claim.

## Recommendation and transport decision

Implement durable journal/preparation/coordinator contracts behind an injected engine port first; keep runtime registration unavailable. Integrate retained/task Labs serially after the task-lifecycle migration/source freeze. Actual engine enablement requires a separately accepted host/profile and disposable-engine validation.

Creation must return immutable IDs directly from the original effect. Compose progress followed by name/label/ps discovery is not a creation receipt. Two alternatives need supervisor selection:

| Alternative | Concrete contract | Limits |
| --- | --- | --- |
| Fixed Docker CLI | Fixed executable, shell:false, explicit --host local endpoint. Network argv: network create --driver bridge --scope local followed only by generated labels and unique name. Container argv: container create --pull never --name generatedName --cidfile privateExactFile --read-only --cap-drop ALL --security-opt no-new-privileges:true --restart no --ipc private --cgroupns private --runtime runc --network committedFullNetworkID; generated env-file/binds/loopback publications/user/workdir/entrypoint, approved digest image and argv only. Parse exactly one full-ID stdout receipt separately from stderr. | Optional cidfile corroborates container receipt; it is not a database commit. CLI entrypoint, mount CSV/path characters and env-file cannot be assumed to represent every C1 array/multiline value exactly. Require a documented narrower subset or use API. Separate CLI identity probes cannot pin a single engine connection across replacement. |
| Typed local Engine API, recommended | Closed versioned POST /networks/create JSON returns201 Id/Warning; POST /containers/create?name=encodedGeneratedName returns201 Id/Warnings. Generate hardening, labels, array argv/env, binds/publications and full network ID from the sealed approval, never arbitrary caller JSON. | New bounded Unix-socket channel/identity adapter and real acceptance required. Windows named-pipe/Desktop support remains unverified. No TCP/proxy/registry/pull/build/update/exec/prune endpoints or fallback. |

Use Linux Unix socket as the first proposed host. Node HTTP socketPath is separate from TCP host/port. Verify daemon identity through GET /info on the same checked live connection used for the serialized effect, with no transparent reconnect/retry. A new connection requires identity revalidation before another effect. Separate pre/post probes cannot prevent accidentally mutating a replacement daemon; document that limitation if selecting CLI. Trusted daemon/administrators remain outside the protection boundary.

CLI execution must use the existing positive token/process-birth wrapper pattern, minimal private HOME/DOCKER_CONFIG and explicit endpoint; strip ambient DOCKER/COMPOSE/context/registry settings. No shell or model arguments. Reject NUL/unrepresentable input before intent rather than rewriting accepted semantics. No name-based deletion, down/orphans, automatic image pulls or OS installation. Network full-ID stdout and every selected CLI encoding still require supported-version actual acceptance.

Read-only CLI observations use fixed argv docker --host endpoint inspect --type container fullID... and inspect --type network fullNetworkID (image inspection similarly uses --type image approvedDigest). Validate bounded JSON arrays, never formatted human text or shortened IDs. A network name query is permitted only for collision refusal, not adoption. The selected CLI version's source prints the network creation response ID directly; actual fixture acceptance must still verify the installed version's behavior. [Official Docker CLI network-create source](https://raw.githubusercontent.com/docker/cli/v28.5.1/cli/command/network/create.go).

## Current source constraints

LabsStore persists command PID/token rows, not daemon resources. LabControl.process's120s outer lease/operation result is not per-engine-effect fencing or an idempotency receipt. LabServices wrapper ownership cannot become container ownership: workloads outlive the Docker CLI.

LabManager.startLab walks dependencies and reverses started services on failure. stopLab marks stopped after command shutdown; destroyLab then removes roots/worktrees/releases ports. Insert a Compose cleanup barrier before those transitions. Recovery must inspect all non-destroyed runs, including stopped/failed/quarantined/partially provisioning states, not only running Labs. Only the explicit Labs supervisor drains operations; panel/MCP remain declared-operation clients.

TaskLabRunner.stop currently stops auxiliary processes, checks/releases ports and retains attempt evidence. Compose must finish before release/prune; preserve immutable attempt incarnation, pinned all-alias source heads, task-owned paths and no-promotion/public-control rules. Do not start from the target checkout. Until the task backend is integrated, explicitly refuse Compose task recipes rather than falling through the command runner.

Project deletion currently blocks live Labs/pending cleanup before purging ownership rows. Add blockers for every Compose resource, live/uncertain request and generation before deleting rows or files. No cascading FK may discard unresolved evidence. Container absence does not grant source-worktree deletion authority; existing scoped Git/path checks remain separate.

## Trusted preparation and durable storage

Before effects, seal normalized C1 authority/canonical source bytes/hash, all-alias heads, approved manifest references, independently inspected image config IDs/defaults and a trusted engine-default profile. Reuse C2's normalized approval hash exactly. C1's current safe plan does not retain these private facts. Docker info does not expose every required masked-path/security/default value: obtain an independently accepted version/platform profile or refuse. Never construct defaults from the candidate being verified, guess omitted fields, or loosen C2 to make a host pass. Desktop path translation and inactive network shapes remain explicit dependencies.

Use random run ID, monotonic stack generation, install/project/lab identity and optional task-attempt incarnation. Preserve original creation intent/request/nonce labels across later operations; current owner fence is mutable journal authority, not a relabelled engine resource. Fresh filesystem ancestor/realpath checks still occur at use; C2 lexical comparisons are insufficient.

Append ONE migration only after the async task-lifecycle receipt migration is committed and its index reserved by root:

- lab_compose_runs: run PK, project/lab/stack/kind/attempt incarnation, generation, fixed engine identity/endpoint/profile digest, sealed approval digest/private reference, creation identity, desired/state, owner/lease/fence, timestamps. Unique lab/stack/generation; one unresolved generation per stack.
- lab_compose_operations: operation PK, run/fence/action/resource slot, immutable request digest, prepared/issued/receipt_committed/reconciled/uncertain/failed state, private receipt digest/reference, safe error code/times. Conflicting ID reuse rejects.
- lab_compose_resources: run/kind/service slot, complete engine ID, creating operation, approval/generation, latest observation and absence proof. Unique engine/kind/fullID prevents cross-run attribution; retain cleanup tombstones.

Awaited ComposeJournalPort methods prepareRun/claim/renew/beginEffect/markIssued/commitCreateReceipt/observe/finish/quarantine/close have a SQLite implementation. Each receipt/CAS checks captured identity/fence/project/attempt/digest in one immediate transaction. Never hold a transaction over engine I/O. Lost DB ACK re-reads the operation receipt, not the engine creation call.

A delayed old-owner response after fence loss cannot mutate current run authority. Preserve bounded private incident evidence, refuse stale settlement and keep the issued effect quarantined if no valid receipt was committed. Do not turn late stdout into a fresh effect or silently relax the current-fence check to avoid cleanup obligations.

Prefer storing the bounded private approval in SQLite to avoid file/DB split-brain. CLI env/cid/raw files require exclusive checked private paths, bounded writes/fsync/atomic rename and a journal reference. Orphan staging is removable only if no issued effect can reference it. An uncommitted cidfile is private incident evidence, never automatic adoption authority.

## Effect state machine and recovery windows

| Window | Required behavior |
| --- | --- |
| Before launch/write | Commit preparation and current generation, then per-resource prepared/issued intent before child go-handshake or API bytes. Collisions refuse; names never overwrite/adopt. |
| Successful create response | Validate original bounded full-ID receipt and atomically commit ID+receipt before dependent effects or any start. Containers use the committed network ID. |
| Provably never issued | After positive old-owner cleanup, CAS new fence and resume prepared operation. Ambiguous IPC/launch/write is issued, not never-issued. |
| Issued with no committed ID | Quarantine; no automatic retry/adoption/replacement generation. Read-only discovery is incident evidence only. Preserve paths/data/ports/private proof. |
| Committed ID, ACK lost | Replay operation ID/digest and inspect exact recorded IDs. No duplicate creation. |
| Start | Require complete committed generation, fresh proof/current fence, exact-ID start in dependency order, durable per-start intent/receipt and separate application readiness. |
| Stop/remove | Fresh exact-ID ownership/config proof, bounded stop, reinspection, removal and same-engine404 absence proof. Transport failure/engine change never means absent. |
| Network deletion | Exact committed ID, fresh network proof and empty endpoints. Foreign/ambiguous endpoint blocks; no forced disconnect/down/prune. |
| Terminal | Only after all effects reconcile and no live client can act: release reservations, allow existing checked Lab/path cleanup, compact/purge private payload. |

Killing a verified CLI client or aborting an API socket does not undo daemon effects. Preserve issued uncertainty. Known-ID start/stop/remove ACK loss can reconcile desired state; create ACK loss without committed IDs cannot. A fresh generation cannot race an unresolved prior request.

CLI wrapper ownership must be durable before release: token/birth/process-tree proof, separate bounded output streams, tracked timeout/cancel and awaited exact-tree shutdown. API has no client PID authority; track connection/request identity and close its sockets/agent. Both implementations finish with a persisted receipt or uncertainty before close/drain reports completion. Failed persistence or cleanup is visible, never best-effort success.

## Proof and readiness prerequisites

C2 verifies an entire committed generation. It cannot bootstrap uncommitted candidates or prove a known network/first container when a later creation response is lost. Do not fabricate a subset approval/hash or insert discovered IDs. A separately reviewed per-resource/known-subset API must retain the original full approval/creation identity for partial cleanup; network-only proof requires empty endpoints. Until then partial generations quarantine without automatic cleanup.

Actual created/exited Docker output may have empty NetworkID/endpoint/publication fields unlike fixtures. Accept exact inactive normalization only after real host tests; never blanket-accept unknown IDs. Typed create bodies should name the committed network ID, not rely on project-name discovery.

C2's safe verified/count DTO is neither readiness nor mutation permission. Container HTTP/browser checks need their own backend endpoint proof carrying engine/run/generation/full container ID and exact loopback publication, refreshed before/after contact. Docker VM/proxy listeners cannot pass by pretending the Docker CLI owns them. Keep that adapter unavailable until independently tested.

## Bounds, retention and close/drain

Reuse1MiB approval,2MiB container/1MiB network observations and100 resource bounds. Proposed implementation policy: one unresolved generation/stack,1024 effects/run, last4 raw observation sets up to12MiB,64KiB diagnostic ring and16MiB auxiliary-file cap/run. Refuse overflow visibly; never discard unresolved proof. Count stopped/failed uncertain runs toward admission. Proposed terminal-run list cap128/install.

Active/restartable and uncertain generations keep private proof; uncertain ownership has no automatic TTL. After exact absence, proposed24h forensic grace for secret-bearing payload, then a bounded minimal digest/state tombstone for7d. Explicit confirmed project deletion can purge immediately only after the cleanup barrier. Retired/unknown run IDs cannot be recreated by old operation replay. These are proposed policy values for review, not current defaults. Backups/exports must explicitly handle private credentials/environment. Public rows/status/events use fixed codes/counts only.

close stops claims, aborts owned controllers, drains queue/renewals/process/socket work, commits receipts or uncertainty, and closes engine/journal ports last. Final persistence gets a short grace independent of the cancelled effect signal. No callback can still write after DB close. Project purge must coordinate with this drain and checked recoverable file removal; retain unresolved rows rather than anonymizing resource authority.

## Integration partitions and acceptance

C3 first dispatch: new journal schema/SQLite/engine-port/request-builder/coordinator and fake tests, one migration after the lifecycle worker releases ordering, no runtime registration. C2 partial-proof changes are separate serial work. Tests may inject a trusted fixture profile but no default available runtime capability follows.

C4 retained integration: one serial owner for recipe backend union, LabsStore/services/manager/control/status. Preserve command behavior. Root owns public/live/UI/CLI/MCP contract review; no raw private proof leaves the facade. C5 task-attempt runner/prune/project deletion integration follows lifecycle freeze, plus separately briefed container HTTP/browser endpoint files. C6 disposable-engine/full suite/build/package/docs acceptance before any activation/support claim.

Fake engine/CLI+SQLite tests must cover effect-before-intent refusal; stale fence/reused ID conflict; exact original receipts; owner killed before go/after issue/after response/before commit/after committed ACK loss; partial network/container creation; labels/name collisions; daemon changes/transient404; no start before IDs; client cancellation uncertainty; delayed renew/close/persistence errors; task incarnation reuse; no port/path release while blocked; bounds/retention/purge and legacy commands. Use actual separate fake child processes for killed-owner windows, not merely mock call order.

Actual acceptance requires explicitly authorized disposable Linux engine, preloaded digest images, recorded daemon/API/Compose/OS/profile versions and owned fixture paths/ports. Verify original full-ID receipts and argv/env/entrypoint/path encodings; real created/running/stopped proof; two retained/task Labs; killed clients/owners at every durability boundary; engine restart; foreign ID/name/port sentinels; partial cleanup/quarantine; exact absence and complete owned teardown. Windows/Desktop normalization remains unsupported until its own evidence. Fakes do not count as engine acceptance; no activation is implied by implementation completion.

## Ready-to-dispatch implementation brief (30 lines)

1. Tier: fresh isolated feature WT after lifecycle migration/source freeze.
2. Root selects typed local API versus restricted CLI and baseline provenance first.
3. Read this plan, C1/C2 contracts and reports; implement journal prerequisite only.
4. Own new labs/compose-journal-schema.ts, compose-journal.ts, sqlite-compose-journal.ts.
5. Own new labs/compose-engine.ts typed port/builder and selected compose-engine-client.ts.
6. Own new labs/compose-run.ts tracked coordinator; frozen C1 client unchanged.
7. Own one appended migration after root reserves the committed lifecycle migration index.
8. Own named journal/transport/coordinator tests and fake engine/CLI/kill fixtures.
9. Own reports/compose-journal.md; no existing Lab/schema/config/export/shared-doc edits.
10. Seal normalized image/config/independent engine-default facts before effects.
11. Runtime capability unavailable without an accepted host/profile, never self-attested.
12. Capture project/lab/task incarnation, generation, owner fence and original identity.
13. Require checked fixed local endpoint/engine; no TCP/ambient context/retry fallback.
14. Validate and bound every stored/request/response/private DTO with zod.
15. Commit prepared/issued intent before go or bytes; no transaction spans I/O.
16. Commit original response full-ID receipt before dependent effect or start.
17. Missing ID after possible effect quarantines; labels/names/cidfiles cannot adopt.
18. Replay operation ID+digest from DB; conflicting reuse rejects.
19. Preserve resources/proof/ports on uncertainty; no replacement generation.
20. Do not fabricate subset approval to call full C2; partial proof stays unavailable.
21. Exact-ID actions remain typed planned effects; no real engine activation.
22. Drain request/process/renewal/receipt work before journal close.
23. Bound data/receipts; reject overflow without deleting unresolved proof.
24. Public results fixed codes/counts only; no env/paths/IDs/argv/raw errors.
25. Test durable ordering, stale fencing, receipt replay and killed fake owner windows.
26. Test partial creation, daemon switch, forged labels and persistence/close failure.
27. No C2/lifecycle/endpoint changes, engine/probes/providers/OS/user data operations.
28. Report partial-proof/inactive-shape/baseline dependencies; no runtime completion claim.
29. Freeze; focused tests and router typecheck/build; root independently reviews.
30. No commits/push; C4–C6 remain separate implementation/acceptance phases.

## Primary facts, reads and cleanup

Container create documents stopped creation, stdout ID and optional cidfile. Network create warns naming conflict detection is not guaranteed. Compose create does not document a transactional per-resource receipt; ps JSON is JSON Lines and orphans default true. [Container create](https://docs.docker.com/reference/cli/docker/container/create/), [network create](https://docs.docker.com/reference/cli/docker/network/create/), [Compose create](https://docs.docker.com/reference/cli/docker/compose/create/), [Compose ps](https://docs.docker.com/reference/cli/docker/compose/ps/).

Official Engine schema defines201 ID response objects for network/container create; it supplies no DB-coupled idempotency transaction. [Pinned official Engine schema](https://raw.githubusercontent.com/moby/moby/v28.5.1/api/swagger.yaml). Node documents Unix socketPath separately from TCP options; Windows named-pipe behavior was not verified. [Node HTTP](https://nodejs.org/api/http.html).

Read Current State/brief, prior Compose plan/C1/C2 reports/contracts, LabsStore/control/services and bounded manager/task-attempt stop/recover/prune/project-deletion/supervisor/port code. Consulted primary documentation for current receipt/transport semantics. No Docker/engine/CLI command, test/build/service/probe/migration was run. No OS resources require cleanup. Only this report changed. Transport/profile/partial-proof/source partition remain supervisor review decisions.
