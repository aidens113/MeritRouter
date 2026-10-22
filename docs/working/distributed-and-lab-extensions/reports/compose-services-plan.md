# Compose services implementation plan

Status: Planning complete; no runtime implementation or engine acceptance claimed.
Baseline: 5b4725a5e9bdc21fce48c126d885c6c2ddf1cb39, roadmap-team. This report is the only worker write. No merge/build/test/install/Docker command or service start occurred.

## Decisions

Preserve command services; introduce a strict declared Compose subset. Human configuration selects images, source manifest, environment, mounts and port targets. Models select declared lab/service/check names only. No arbitrary Docker arguments, commands or authored model configuration are accepted.

Persist a unique project and immutable incarnation before engine effects. Labels and names are discovery hints; destructive authority requires a committed request intent, current generation fence, journaled complete immutable engine IDs and fresh inspected configuration proof. Never automate compose down, orphan removal, prune, image removal or name-based deletion. Supervisor agreed this boundary during planning.

Trust the local engine and its administrators. Docker-admin peers can forge metadata or change the daemon; labels do not authenticate ownership. Lost creation responses without committed resource IDs must quarantine resources for explicit human-reviewed exact-ID resolution. This intentionally prefers a visible cleanup obligation over deleting another project's resources. Stronger automatic recovery would require a trusted engine broker/authorization boundary and is a separate unit.

First execution support: local Linux-container engine, fixed trusted endpoint, preloaded digest-approved images, bind-only mounts, no builds or named/anonymous volumes. Docker Desktop host paths and listener mediation require actual Windows acceptance before claiming Windows support. Working document records Docker CLI present but unavailable engine; this worker did not probe/start it.

## Source findings

Read assigned Current State/L5 sequence and labs/recipe.ts, services.ts, process-ownership.ts, ports.ts, store.ts, lab.ts lifecycle/recovery, environment.ts, paths.ts and coordination.ts.

Command services persist starting intent before spawn, then PID/token and readiness/process-tree proof. Adoption verifies OS ownership, manager leases fence active peers, monitor handles restart/backoff. These are process proofs: Docker CLI PID does not prove ownership of daemon workloads. Add a distinct container backend rather than filling process PID/token columns with misleading values.

Port reservations serialize database allocation but briefly release their test socket; actual publish can race. Bind failure must not steal a port. Existing lab start walks dependencies; failed start reverses only successfully started services. Destroy stops services before removing worktrees/data/releasing reservations. Compose must block destructive lab cleanup until its engine resources are absent, or persist cleanup_pending and preserve paths/ports. Recovery must reconcile failed/stopped/uncertain runs too, not only running labs.

Task-Lab lifecycle and queue workers are active elsewhere. Wait for their freeze before changing shared recipe/services/store/lab/migrations. Ephemeral attempt identity belongs in Compose incarnation identity; teardown must retain their existing artifact/branch guarantees.

Browser/lab_http positive ownership checks cannot equate Docker proxy/VM listeners with the CLI process. Introduce ServiceEndpointProof discriminated by process/container backend; container proof includes current engine/run/generation/full container ID and exact inspected loopback mapping. Before/after browser/HTTP proof remains mandatory. No bypass of processOwnership to make containers appear supported.

## Proposed strict authored schema

Legacy `{repo,command,ready?,after?,restart_on_integrate?}` remains valid, normalized to kind command. New service union:

```ts
type CommandService = {
  kind?: 'command'; repo: LabName; command: BoundedCommand;
  ready?: ExistingReady; after?: LabName[]; restart_on_integrate?: boolean;
};
type ComposeService = {
  kind: 'compose'; stack: LabName; service: LabName;
  ready?: ExistingReady; after?: LabName[]; restart_on_integrate?: boolean;
};
type ComposeStack = {
  repo: LabName; file: RelativePath; file_sha256: Sha256;
  images: Record<LabName, DigestPinnedImage>;
  environment?: Record<LabName, Record<EnvName, string>>;
  ports?: Record<LabName, Array<{name: DeclaredPort; target: Port}>>;
  mounts?: Record<LabName, Array<{
    source: {repo: LabName; path: RelativePath} |
            {data: DeclaredData; path: RelativePath};
    target: AbsoluteContainerPath; read_only: boolean;
  }>>;
};
recipe.compose_stacks?: Record<LabName, ComposeStack>;
```

Every document service maps exactly once to a declared lab service; no hidden dependencies/replicas/profiles. One stack is reconciled as a group, with per-service readiness and dependency order. Existing command dependencies remain unchanged. Maximum 32 stacks, 100 services/resources per run (also enforce existing max_services), 100 mount/env entries per service, 1MiB manifests, bounded8192-byte paths/64KiB private values. Validate authored data, normalized data, stored rows and CLI responses with zod.

Initial adapter rejects build and uses --no-build/--pull never. Future human-approved build schema should require exact committed context, Dockerfile hash, bounded private args and network:none; reject remote/SSH/additional contexts, entitlements and secret exporters. This is future scope, not an image-only support claim for arbitrary Compose applications.

Secrets initially unsupported unless separately tested human staging inside declared private lab data exists. Future secret mounts must be read-only and private; never arbitrary host secret paths. Image selection/environment stay human config authority. Model-edited repository Compose files cannot change approved digest/mount/port settings. Canonical manifests and inspect Config.Env are private, never public status/artifacts. Redact configured secrets from bounded logs/errors.

## Validation before effects

1. Verify recipe snapshot, owned worktree and exact authored manifest SHA256. Deny traversal/symlink/reparse ancestors and source target checkout/.git/storage/brain/home/socket paths. Atomically snapshot approved bytes under private lab control storage; no later engine command reads model-writable manifest files.
2. Resolve only declared placeholders. Bind sources must already exist within this lab's owned worktrees/data, with realpath/ancestor proof; writable sources are an explicit subset. Restrict read-only binds too. No automatic host-path creation. Recheck before use; host administrator symlink races are outside the trusted-host boundary.
3. Precheck authored document imports: reject include/extends/remote references/env_file before invoking normalization, avoiding unintended host reads. Use fixed argv, minimal env, explicit project name/directory/file and private empty env-file. No inherited COMPOSE_*/DOCKER_HOST/CONTEXT overrides or shell execution.
4. Run bounded `docker compose ... config --format json`; validate canonical resolved model. Do not disable consistency/interpolation/path checks. Compare final sealed generated manifest's canonical digest before provisioning.
5. Strict allowlist supported canonical fields: pinned image; bounded command/entrypoint arrays, user/working_dir/env; approved bind mounts; exact127.0.0.1 allocated TCP publications; generated labels/private bridge network; restart:no; bounded resource limits. Default read-only rootfs, cap_drop ALL and no-new-privileges where the tested engine supports them.
6. Reject privileged/cap_add/devices/gpus, host/service/container network namespaces, host pid/ipc/uts/userns/cgroup, use_api_socket, volumes_from/external_links/hostgateway, external resources, container_name, named/anonymous volumes/tmpfs, profiles/deploy/scale/provider/models, lifecycle hooks, build, unapproved logging/security/driver options, sysctls and unknown fields. Reject image-declared VOLUME via image inspect before create, preventing implicit anonymous mounts. No UDP, wildcard/IPv6/random/range/public ports or publish-all. Inspect must confirm published mappings and mounts after create/start.

Strict validation is adapter policy, not proof a malicious image/kernel/daemon is contained. Private bridge alone does not promise blocked egress. No zero-network or hostile-Docker-admin isolation claim.

## Durable migration and APIs

Append one migration only after active lifecycle/queue migration ordering freezes. Proposed tables (FKs/indexes and zod enums required):

```text
lab_compose_runs:
 id PK, lab_id FK, stack_name, generation, attempt_id?, engine_key,
 project_name UNIQUE, manifest_sha256, private_manifest_path,
 state, desired_state, owner_id?, lease_until, fence, operation_id?, timestamps
 UNIQUE(lab_id,stack_name,generation)
lab_compose_intents:
 id PK, run_id FK, fence, action, state, request_sha256,
 owned_cli_pid?, cli_token_hash?, started_at?, finished_at?,
 error_code?, bounded_private_evidence_path?
lab_compose_resources:
 run_id FK, kind(container|network), engine_id, generation,
 spec_sha256, created_at_engine?, state, verified_at?
 PK(run_id,kind,engine_id), UNIQUE(kind,engine_id)
```

Run states: prepared/provisioning/created/starting/running/stopping/stopped/destroying/destroyed/uncertain/ownership_lost/cleanup_pending. Intent states: prepared/issued/observed/committed/uncertain/failed. Preserve tombstones/evidence. Bind engine_key to configured endpoint plus daemon identity; a changed daemon refuses adoption.

Persist random128-bit run ID, monotonic generation, private256-bit creation nonce before effects. Name `sy-<installShort>-<labHash>-<stack>-g<generation>-<runShort>` lowercase bounded63. Labels include install/run/lab/generation/spec hash and nonce digest, never secrets. Exact IDs plus request proof/config/creation evidence establish journal authority; label match alone never does. Owner lease/fence transfers on adoption, immutable generation does not.

New files: compose-recipe.ts (authored/canonical validation), compose-client.ts (bounded argv/DTO transport), compose-store.ts (journal), compose-ownership.ts (proof/reconcile), compose-services.ts (lifecycle). Existing LabServices dispatches backend after lifecycle freeze; no unrelated extraction. Public status adds safe kind/state/ownership/generation/URLs only. Endpoint-proof contract coordinates with http/browser owner. Existing model controls unchanged. Human Save plus explicit restart handles config drift; do not let up silently recreate unknown generations.

## Lifecycle, recovery and cleanup

Every engine mutation requires committed current-fence intent. Suggested bounds: discovery30s/create-start120s/stop30s, aggregate CLI output2MiB,100resources; heartbeat5s/lease30s. Cancel kills only positively owned CLI wrapper; engine workload survival remains unknown until reconciliation. Stale owners fail CAS settlement; no replacement generation starts while an earlier uncertain request may still mutate its resources.

| Operation | Durable behavior |
| --- | --- |
| Create | Persist generation/manifest/expected names and assert no collision; commit provisioning intent and owned CLI request proof. Use create --no-build --pull never, keeping containers stopped. After observed success, discover full IDs and inspect exact typed objects/config; commit IDs before any workload starts. |
| Start/readiness | Commit start intent, inspect known IDs, start those IDs in dependency order. Confirm running/healthy and declared readiness plus exact endpoint proof. On failure stop proven started IDs in reverse order, retain evidence. |
| Restart | Stop/start proven same IDs. Config/image changes require explicit new generation after prior cleanup; no name-based force-recreate. |
| Adopt | CAS expired manager lease only after old CLI request reconciled. Fresh engine identity/ID/generation/config proof and readiness required; unknown resources or drift refuse adoption. |
| Stop | Commit desired stopped and intent; inspect full IDs, finite `docker container stop --timeout 10 <fullID>`, reinspect exited/missing. Retain data/IDs/ports for restart; foreign proof refuses operation. |
| Destroy | Commit destroying; stop/remove known full container IDs after fresh proof; remove journaled network ID only after its inspected endpoints are empty/owned. No -v/down/prune/images. Confirm absence before releasing ports/deleting lab data/worktrees/manifests; retain branches/artifacts/tombstones. |

Collision with foreign name/project fails before create, never overwrites or cleans foreign objects. Extra same-project-labelled objects are incidents. Lost response/nonzero/partial create may leave containers/networks: read-only enumerate candidate IDs and bounded inspect evidence, mark uncertain/cleanup_pending. If IDs were never durably proved and committed, require explicit human-reviewed exact-ID adoption/cleanup. A recorded successful create with committed IDs can reconcile/adopt automatically. Same name/new ID never inherits ownership; stale-generation resource cannot substitute for current one.

Engine unavailable preserves pending intents/resources/reservations/data, gives actionable status and bounded exponential retries; never reports destroyed/stopped merely because CLI failed. Partial network without committed ID quarantines. Initial volume-free policy means any unexpected volume is quarantine evidence, not permission to delete. Future volumes need their own identity/reuse proof; do not assume names have container-like immutable IDs.

## Implementation partition

C1: independent new validation/client files and fake fixtures only, no runtime registration. Can proceed without engine. C2: one serialized lifecycle worker after task-Lab freeze owns recipe/services/store/lab integration plus appended migration and new journal/ownership/lifecycle files. Supervisor coordinates public status and endpoint-proof/http/browser changes as a subsequent partition. C3: actual disposable-engine acceptance, then supervisor docs/decisions/exports/support claim. Builds, named volumes and remote engines remain separately scoped.

### First bounded implementation brief

- Repository: fresh isolated WT from then-current accepted lifecycle baseline.
- Task: strict authored/canonical Compose validation and bounded injected config CLI adapter, producing validated generation plan only.
- Own: new labs/compose-recipe.ts, compose-client.ts; tests/labs-compose-validation.test.ts, tests/fixtures/compose/**; own report.
- Must not touch existing recipe/services/lab/store/migrations/config/panel/exports/manifests/shared docs. No real engine/install/provider calls/commits/push.
- Inputs: human stack declaration, owned Lab paths/repositories/data/ports, private minimal environment, injected executable. All DTOs zod validated.
- Effects: private temp manifest files and fake subprocess only. Fixed config argv, bounded output/time/cancel. No mutating Docker verb reachable.
- Tests: safe normalized fixture accepts; unsafe fields/imports/foreign or symlink paths/public ports/image VOLUME/oversized and malformed output refuse before mutation. Fake capability mismatch; Windows argv/path cases; cancellation cleanup and deterministic digest. Legacy command files unchanged.
- Acceptance: focused tests, router typecheck/build, source review confirms no mutation path. Report engine limitations and C2 journal contract; no runtime Compose completion claim.

## Acceptance needed later

Fake CLI: fault before/after each intent/effect/ID commit; reopen DB; assert no mutation before intent/no start before IDs; stale owner cannot settle/remove replacement; label forgery/spec mismatch/collision/daemon switch refuse; lost response quarantines; unavailable engine retains ports/data; partial resources cleanup_pending; single owner under two managers; malformed/oversized inspect cannot broaden cleanup. Sentinel IDs must never appear in stop/rm argv.

Actual fixture prerequisite is currently unmet: isolated working Linux engine, supported Compose capabilities, preloaded digest-pinned images without VOLUME, mountable private test paths/port range. Record engine/Compose/OS versions and daemon ID. Two isolated Labs using same stack must have distinct container/network IDs, ports/data and readiness. Exercise restart/adoption, killed manager before/after ID commit (quarantine versus verified recovery), container crash/backoff, engine disconnect and killed cleanup. Foreign renamed/replaced sentinel survives. Destroy removes all proven fixture resources and releases only corresponding reservations. Ambiguous unjournaled resources require explicit reviewed exact-ID fixture cleanup; never widen deletion to make tests pass.

## Official facts verified and docs/decisions recommendations

Verified2026-10-22 by primary Docker documentation browsing only; no installed output/engine behavior executed. Recommend supervisor records:

- Config merges/interpolates/normalizes and supports JSON; validate rendered model and controlled interpolation environment. [config](https://docs.docker.com/reference/cli/docker/compose/config/)
- Explicit project/file/project-directory flags control identity/path discovery; do not inherit ambient Compose settings. [Compose CLI](https://docs.docker.com/reference/cli/docker/compose/)
- Create provisions separately from start, allowing durable IDs before workload execution. [create](https://docs.docker.com/reference/cli/docker/compose/create/)
- Up can recreate changed containers/start dependencies; detached services outlive CLI, wait considers running/healthy. [up](https://docs.docker.com/reference/cli/docker/compose/up/)
- Down removes project resources with special volume/external behavior; this design deliberately uses exact-ID cleanup instead. [down](https://docs.docker.com/reference/cli/docker/compose/down/)
- Inspect defaults to JSON array and supports typed name/ID lookup. [inspect](https://docs.docker.com/reference/cli/docker/inspect/)
- Current ps JSON docs specify JSON Lines; --all includes stopped objects. Do not assume one array/running-only enumeration. [ps](https://docs.docker.com/reference/cli/docker/compose/ps/)
- Compose exposes privileged/mount/network/hook/security features; the restricted subset here is SwitchYard policy. [services](https://docs.docker.com/reference/compose-file/services/)
- Daemon access is privileged and host binds expose host filesystem; trusted-engine boundary must be explicit. [security](https://docs.docker.com/engine/security/)
- Stop supports finite grace; force-rm kills a container. Use only proven full IDs with bounded shutdown. [stop](https://docs.docker.com/reference/cli/docker/container/stop/), [rm](https://docs.docker.com/reference/cli/docker/container/rm/)

Supervisor approval of proposed visible limitations is needed before execution dispatch, not a request to start/install an engine now. Planning is complete; engine support and actual cleanup acceptance remain unverified.
