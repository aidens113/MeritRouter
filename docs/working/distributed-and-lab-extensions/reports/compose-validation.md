# Compose validation C1 worker report

Status: Implemented bounded prerequisite; frozen after checks for supervisor review. This does not enable runtime Compose or complete L5.

## Scope and API

Only new labs/compose-recipe.ts, labs/compose-client.ts, tests/labs-compose-validation.test.ts, tests/fixtures/compose/fake-cli.cjs and this report were written. Existing recipes/services/Labs/core/migrations/config/panel/public exports/manifests are untouched. Working-document brief and prior plan shown modified/untracked in this tree were supervisor-prepared, not worker edits.

validateComposePlan(authorityInput, capabilitiesInput, options, signal?) validates human-authority paths/source SHA/project/service/image/environment/binds/ports and a supplied trusted local Linux engine capability DTO. Engine capability/identity is a prerequisite supplied by a future trusted caller, not discovered or proven in C1. Options' executable and launcherArgs are a trusted injection seam for fake CLI testing, never model input or public config. There is no runtime registration or mutating execution method.

Strict zod authored/canonical/authority/capability/image-response/result schemas reject imports/unknown security features before the CLI can consult them. First subset requires explicit canonical long-form bind/port/network/hardening fields, command/entrypoint arrays, pinned images, rootfs read-only, cap_drop ALL, no-new-privileges, restart:no. It deliberately rejects wider valid Compose applications, builds/secrets/named or anonymous volumes/remote engines/privilege/host namespaces/hooks. Legacy command recipe source remains unchanged; focused regression parses an existing command declaration.

Path checks verify realpath and every existing ancestor, refuse symlinks/junctions and sibling-prefix escapes. Approved mount sources are inside declared owned worktree/data; whole worktree/.git/storage/socket mounts refused. Worktree and data roots must be below separate lab root, protecting private control staging from direct whole-root mounts. Source manifest SHA and file size checked before normalization; source imports/env_file/interpolation and authored environment values refused. Private human environment is injected only into restricted private snapshot, with dollar escaping, and clean CLI environment uses empty env-file plus private HOME/DOCKER_CONFIG. No ambient COMPOSE/DOCKER env or shell invocation.

Fixed external verbs are only `--host <local> compose ... config --format json` and `--host <local> inspect --type image <approved digest>`. Normalized services/images/environment/mounts/loopback ports must exactly match human authority. Image inspection requires approved RepoDigests and no Config.Volumes. Returned plan is metadata only: deterministic SHA, service names/digest images/port numbers/mount counts, engine identity and runtimeEnabled:false; no canonical/environment/host paths/raw stderr.

CLI byte budget and timeout apply to the entire multi-command validation request, not multiplied per image; maximum2MiB output/120s plus bounded existing ownership-cleanup work. Abort/timeout/output overflow stop the positively identified Node wrapper/CLI/plugin descendants through existing process-ownership token and process-birth helpers. Windows fake test proves actual descendant gone. Wrapper stays alive until output checks finish, avoiding a fast-exit PID-inspection race found in initial tests. Successful/error/cancel fixtures remove private scratch. If ownership cleanup cannot be established, return sanitized compose_cleanup_unverified and retain private scratch/process proof; do not delete evidence or pretend cleanup succeeded. Scratch deletion failure also returns sanitized code rather than leaking private paths. Trusted executable/engine and same-user host are not adversarial sandbox boundaries.

## Observed checks

- `pnpm --dir packages/router exec vitest run tests/labs-compose-validation.test.ts`:10/10 passed. Actual fake subprocess validates deterministic snapshots; no mutation verbs; source has no private env while private snapshot does; literal private dollar escaping; imports/unsafe features pre-execution denial; canonical image/env/foreign mount/public-port denial; real Windows junction denial; source hash change; Windows path with spaces/ampersand/dollar; incompatible capability DTOs; image VOLUME refusal; malformed/oversized/raw-error sanitization; actual cancellation+timeout including fake descendant termination; scratch cleanup; legacy command parse.
- `pnpm --dir packages/router typecheck`: passed.
- `pnpm --dir packages/router build`: passed; final build repeated after final error-sanitization hunk.
- No full suite, Next build, real Docker command, engine/container/service/install/provider/user-config operation. No commits/push.

Official Docker facts used retain links in the earlier compose-services-plan report. Additional verified2026-10-22: Compose interpolates dollar expressions and documents `$$` for literal dollars; private injected values therefore escape each dollar in the snapshot and canonical output must match original authority. [Official interpolation reference](https://docs.docker.com/reference/compose-file/interpolation/). No installed CLI behavior was observed, so these are source-backed adapter expectations, not real-engine acceptance.

## Next journal integration contract / limitations

C2 must wait for task-Lab lifecycle/migrations freeze, add durable per-generation intent/resource journal and current immutable-ID proof, and adapt recipe/service/store/recovery/public endpoint ownership serially. C1 plan hashes are preparation metadata, not resource ownership or container readiness. Do not use config output or labels as deletion authority. Actual Docker/Desktop path normalization and supported-version canonical differences remain unverified; unknown fields/shape fail closed. No container HTTP/browser proof yet, no creates/start/stop/down, no named volumes/builds/secrets/remote support, no protection from engine administrators. Human-authority source hashes intentionally require human reapproval when model changes manifest.

Supervisor independently reruns10 tests/typecheck/build and reviews security subset before integration. Real two-isolated-Lab engine acceptance remains a later unmet dependency, with quarantined lost-create responses and exact-ID cleanup as designed in compose-services-plan.md.


## Supervisor review hardening

Environment maps now enforce100 entries/service and200-character names; serialized authority has1MiB aggregate bound, not merely per-value limits. Expanded private snapshot has separate1MiB byte bound before any scratch write/subprocess, including dollar-escape expansion. Endpoint max8192 matches host path bound; remote named pipes, UNC paths and NULs refused. Authored service set/image/mount/port authority is checked before config subprocess; canonical output remains checked again afterward. Added zero-CLI regressions for oversized count/aggregate/expanded snapshot and authored authority mismatch, plus oversized/foreign endpoint rejection. Targeted suite10/10 passes; final router typecheck/build passed exit0. Hardened source frozen for independent review. No runtime expansion.
