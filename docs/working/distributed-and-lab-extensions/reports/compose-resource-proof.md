# Compose immutable resource proof prerequisite

Status: FROZEN for supervisor review. Pure prerequisite implemented;51/51 focused tests, router typecheck and router build passed. No engine, lifecycle or actual Docker acceptance claim.

## Files and contract

Only new `labs/compose-ownership.ts`, named `labs/compose-ownership-schema.ts`, `tests/compose-ownership.test.ts` and this report. No existing source/schema/client/recipe/services/Labs/HTTP/browser/panel/config/export/migration/shared-document changes. No commits/push. Prior untracked logs preserved.

`verifyComposeResourceProof(input)` returns a strict safe DTO: verified/quarantine, fixed diagnostic code, bounded container count, runtimeEnabled:false. It returns no raw inspect JSON, resource IDs, labels, engine identity/endpoint, nonce/request/intent, environment, host paths, argv, image defaults or caught exception text. It performs no I/O, engine command, filesystem access, ID discovery, storage mutation, service start or resource deletion.

Private input consists of (a) trusted immutable resource journal plus current identity/fence and observed trusted local engine capability, (b) a sealed normalized approval snapshot using frozen ComposeAuthoritySchema/ComposeCanonicalSchema plus approved image inspections and engine-default baseline, and (c) bounded container/network inspect JSON strings. The future trusted caller must compute `specSha256 = composeCanonicalHash(ComposeResourceApprovalSchema.parse(snapshot))` over the normalized private snapshot, and commit that identity and complete engine IDs before this proof can verify. Hashing a different unnormalized object is not an equivalent seal.

Journal/current fields compare install, lab, run, generation, fence, spec hash, nonce hash, original creation request hash and intent ID; engine identity and fixed local endpoint/capabilities must match exactly. Containers require full64-character lowercase IDs keyed by the exact approved service set and one committed full network ID. Issued/lost-response/missing IDs quarantine before candidate adoption; matching names/labels cannot bootstrap authority. Duplicate IDs, replacement resources and forged ownership labels fail. Every resource also checks reserved io.switchyard install/lab/run/generation/spec/nonce/request/intent/resource labels and Compose project/service/network metadata, as corroborating hints only.

The function compares snapshots; it cannot attest where a caller obtained JSON or whether a database commit/fence is real/current. It is internal trusted-caller input, not a model/public proof API. A matching safe DTO is not an executable mutation permit or transaction receipt. Later lifecycle code must independently hold current journal authority, recheck fence/engine/resource state immediately before each exact-ID operation and reconcile uncertainty. No protection against a malicious Docker administrator/daemon is claimed.

## Strict configuration proof

Reuse frozen canonical/authority schemas and exact image/env/bind/port service authority comparisons. Pure lexical managed-root checks preserve scope; this unit does not redo C1's actual filesystem ancestor/realpath/symlink proof. A trusted C1 validation and fresh path revalidation at later use remain mandatory; no filesystem ownership claim follows from strings alone.

The actual container Image field must equal the separately inspected approved image config ID, whose RepoDigests includes the approved manifest reference. It never compares container Image to the manifest digest itself. Effective entrypoint/CMD derives from approved image defaults plus canonical overrides, including Compose's non-null entrypoint suppressing image default CMD; actual Config plus Path/Args must agree. User, working directory, stop signal, merged environment map and duplicate env names are checked. Environment comparisons use canonical hashes internally and no private values appear publicly. Image VOLUME and implicit healthcheck are refused in this initial proof subset.

Both HostConfig.Mounts and actual Mounts must equal the exact bind-only approved targets/source/read-only map; extra/named/anonymous/tmpfs mounts or changed propagation/options refuse. HostConfig.Binds/VolumesFrom are empty. Socket/.git/.switchyard/whole-worktree/control-root mounts are refused. Configured and observed publications must be exact allocated127.0.0.1 TCP mappings. Publish-all/public/extra ports refuse; unbound exposed ports must remain unbound.

Security projection is closed: read-only rootfs, cap_drop ALL, no cap additions, exact no-new-privileges, restart:no, no auto removal, no host PID/IPC/UTS/user/cgroup namespaces, no devices/additional groups/sysctls/storage/DNS/host links, no undeclared CPU/memory/IO limits and no unknown HostConfig fields. Engine-generated defaults such as logging/shm/masked/readonly paths/AppArmor, swappiness and unlimited PID representation are supplied as a trusted, sealed baseline and matched exactly. They are not guessed from documentation, derived from the observed candidate, or exposed as additional human recipe knobs. The initial baseline permits only private IPC/cgroup namespace and runc; broader engine profiles need separate review.

The exact journaled private bridge/default network must match name, driver, local scope, flags/options and required labels. Containers have exactly one matching NetworkID; active endpoint IDs/names cross-check network Containers, with no foreign endpoints. Created/exited identity can verify only with the exact NetworkID, no active endpoint/peer and no live publication; this is not readiness. Empty/unknown NetworkID remains unavailable. This private bridge is not zero-egress isolation.

## Bounds and compatibility

Input shape is checked before zod/hashing:5MiB aggregate private string/key bytes,100,000 nodes, depth32,10,000 keys/object, no cycles/accessors/non-plain input objects. Container inspect JSON =2MiB and network inspect =1MiB, checked in UTF-8 bytes before JSON.parse. At most100 containers/services/peers, one network,100 binds/container,32 declared publications/service,200 combined env entries/container,100 argv entries, bounded paths/strings/maps. Authority retains C1's1MiB aggregate bound. No raw API error is returned.

This is a strict initial inspection profile, not a universal Docker adapter. Unknown HostConfig/config/endpoint options, implicit image healthchecks/volumes, non-TCP image exposure, alternate runtimes/logging profiles, API fields omitted where this schema requires explicit proof and Desktop path spelling differences may quarantine otherwise valid Docker objects. Do not loosen the checks to make a production engine pass without recording and independently accepting the specific supported normalization. Container/network top-level benign informational fields are ignored within aggregate raw bounds; security-critical subobjects remain closed. No running-versus-stopped real-engine shape has been measured here.

C1 currently returns safe plan metadata and does not retain the full private image-ID/config/default baseline needed here. Later read-only preparation/journal integration must obtain and seal those trusted facts before provisioning; infer neither image config ID from a manifest digest nor engine defaults from a candidate being adopted. Durable intent storage, field migrations, CLI create/start/stop/remove, collision discovery, original creation process/request proof, lease transfer and HTTP/browser container ownership remain subsequent units. This pure module cannot fill those missing lifecycle obligations.

## Observed validation

- `pnpm --filter switchyard-router exec vitest run tests/compose-ownership.test.ts`:51/51 passed. Full-ID positive with distinct config/manifest digests; engine/endpoint/run/install/generation/fence/nonce mismatch; no committed ID/issued intent; forged label/name collisions and replacement IDs; image mismatch; effective argv/user/env/workdir drift and image default/entrypoint rules; duplicate env; changed/extra/readonly/named/anonymous/tmpfs binds; public/changed/extra/publish-all ports; privilege/capability/namespace/resource/security/unknown settings; foreign network attachment/peer/options; inactive identity; sealed approval/default baseline mismatch; implicit image healthcheck; unmanaged resealed mount; malformed/oversized/cyclic input; safe diagnostic sentinel exclusion.
- `pnpm --filter switchyard-router typecheck`: passed.
- `pnpm --filter switchyard-router build`: passed after final source hardening.
- `git diff --check`: passed. No full-suite or real-engine compatibility claim.

No Docker command, engine probe/activation, process/service/install/provider, user-data or panel operation occurred. Tests use in-memory private fake inspection objects; no owned OS resources or fixture files require cleanup. Future actual disposable-engine acceptance remains mandatory.

## Official field provenance verified2026-10-22

Inspect accepts names or IDs and defaults to JSON arrays, so this verifier independently requires typed full committed IDs. [Docker inspect](https://docs.docker.com/reference/cli/docker/inspect/)

Container Id, Image, Path/Args, HostConfig, actual Mounts, NetworkSettings Ports/Networks and network inspect endpoint data are documented in the official Engine API schema. The pinned v28.5.1 schema was read to verify these fields; it is provenance, not an installed-version/support claim. [Official Moby Engine schema](https://raw.githubusercontent.com/moby/moby/v28.5.1/api/swagger.yaml)

Registry manifest config descriptors differ from the manifest reference; image config identity must be retained separately. [Docker manifest example](https://docs.docker.com/reference/cli/docker/manifest/)

Compose documents non-null entrypoint replacing image ENTRYPOINT and suppressing default image CMD, and environment overrides. Those rules determine effective approved defaults here. [Compose services](https://docs.docker.com/reference/compose-file/services/)

No external implementation was vendored. Some interactive API documentation could not be fetched through its generated links; the official pinned OpenAPI source supplied the field provenance instead. Recommend supervisor records the verified image-ID distinction and source-backed field contract in decisions docs when integrating, while keeping all real-engine compatibility and lifecycle limitations explicit.
