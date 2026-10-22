# Compose Engine contract worker report

Status: Implemented, worker checks passed; supervisor verification pending.
Date: 2026-10-22
Worker: link_completion
Branch: feat/compose-engine-contract
Baseline: c3110a0
Scope: Pure C3 prerequisite. Compose runtime remains disabled.

## Inventory

Only these new files were authored:

- `packages/router/src/labs/compose-engine-schema.ts`: strict private profile, build input, closed request/body, plan and response schemas; injected `ComposeEnginePort` interface.
- `packages/router/src/labs/compose-engine.ts`: pure full-approval validation, request builder and safe observation diagnostics.
- `packages/router/tests/compose-engine-contract.test.ts`: 38 focused cases.
- This report.

No existing source, public exports, client, proof, recipe, manager, config, migration or shared working document changed. No commits or pushes. No Docker/Engine/API probe, OS service, paid provider, real project or live panel interaction occurred. Existing C1 tests launched only their isolated fake CLI fixtures and observed fixture cleanup.

## Typed integration contract

`ComposeEngineBuildInputSchema` requires the normalized FULL C2 approval, `original` and `current` C2 identities, independently trusted `ComposeEngineProfileSchema`, and a closed `effect`. API version is pinned to 1.51. A profile includes accepted-platform declaration, engine capabilities/endpoint/identity, independent sealed baseline/AppArmor and a trusted profile-record fingerprint. The fingerprint is an opaque trusted reference; this pure module does not attest, sign, fetch or independently approve a host profile. No installed profile is provided.

`buildComposeEnginePlan(raw)` returns either private `{state:'planned',plan}` or fixed safe `{state:'refused',code,authority:'none',runtimeEnabled:false}`. Successful plans contain secrets/absolute paths/argv and MUST stay private. Plans are recursively frozen and include `version:1`, `authority:'none'`, `runtimeEnabled:false`, original/current identity, profile, operation/service, a closed request, expected image config ID and `planSha256`.

`ComposeEnginePort.perform(plan, signal): Promise<ComposeEngineResponse>` is an interface only; there is no connecting implementation or default client. A future implementation must serialize engine-identity check and effect on one live checked local channel. Reconnection, retries, context/TCP fallback, discovery adoption and journal commits are not implicit. Port comments explicitly require separate current journal fencing and positive resource proof before mutation. This contract is not capability-safe against a malicious in-process caller/transport; trusted profile/journal input and future transport enforcement remain essential.

`inspectComposeEngineResponse(plan,raw)` validates bounds, plan digest, response identity, checked same-connection engine identity and operation/status/body shape. It returns only fixed diagnostic codes, `authority:'none'`, `runtimeEnabled:false`, `durableReceipt:false`. A matching inspect observation does not run the C2 ownership verifier or establish readiness. A same-engine 404 is an observation, never resource/path/port release permission. Raw Engine error envelopes must be discarded by the future transport; the typed 404 observation uses null body.

## Create identity and digest semantics

Original `identity.requestSha256` and `identity.intentId` remain immutable C2 label bindings. They are not redefined to hash their own containing request body. Separately, computed `planSha256` covers the exact closed request, operation ID, service, original identity, trusted profile and expected image config ID. The mutable current owner fence is deliberately outside that original create-request digest: a renewed owner retains the identical original network receipt digest. The complete plan still carries current identity, and live journal fencing must validate it before any effect.

Network/container creation each carries an explicit original operation ID; generated labels preserve original nonce/run/generation/intent/request, without a mutable fence label. Container creation requires a trusted original committed network receipt, matching immutable creation identity, engine and the recomputed exact network request digest. Issued/unknown receipts, replacement identity, operation collision and changed request/profile are refused. Its full network ID is supplied as `HostConfig.NetworkMode`; there is no name-based fallback or discovery adoption. The builder does not create or persist a receipt, and cannot prove a caller-provided committed receipt actually came from a durable journal.

Exact inspect/start/stop/remove plans consume committed C2 resource receipts, use only full IDs and fixed versioned paths, and reject network start/stop. Network receipts also have their original request digest recomputed. Container exact-ID receipts retain their trusted original request digest but this unit does not authenticate it against an original container request body: that needs the durable journal/original network binding. No exact-ID request is a positive C2 ownership proof or mutation authorization. Stop uses bounded 10-second grace; container removal uses `force:false,v:false`. No force removal, volume deletion, exec, pull, build, update, prune or arbitrary endpoint/operation is exposed.

## Fidelity and refusal boundaries

The builder validates the complete normalized approval seal and exact service cohort, including unselected services. It compares canonical image/env/ports/binds to full authority; checks lexical managed roots, unique publications/targets, reserved mounts; and refuses unsupported image config, duplicate image environment names and non-TCP image exposures. It does not run filesystem containment checks, resolve symlinks or attest host-path ownership. Future live preparation must repeat physical containment and current capability checks.

Create bodies preserve literal argument arrays, dollar characters, multiline values and first-equals environment splitting without shell/Compose interpolation. Explicit entrypoint suppresses image default CMD; omitted command inherits only when the recipe entrypoint is omitted. Empty effective argv is refused. Engine reset `Entrypoint:[""]` is used when the C2 effective entrypoint is empty, with the effective CMD supplied explicitly. An authored single empty entrypoint token is refused rather than reinterpreted as a different C2 effective argv.

`body.Image` retains the approved immutable manifest reference. `expectedImageConfigId` separately pins the approved image configuration ID for future pre-effect image verification. Environment/image labels are merged explicitly. Image labels using reserved SwitchYard/Compose prefixes are refused: Engine merges omitted image labels back, so filtering them from request JSON would not erase them safely. Binds carry `rprivate` propagation and `CreateMountpoint:false`; publications bind only 127.0.0.1; hardening and independent C2 baseline values are explicit. AppArmor remains the independently accepted engine-default profile, not a guessed or container-derived setting. Bridge networking does not imply zero egress or an OS sandbox.

Input inspection precedes zod/hash/serialization: 4 MiB aggregate string/key budget, 75,000 nodes, depth24, 10,000 own keys per object; finite JSON primitives and plain objects/arrays only; own data descriptors, no accessors/cycles/symbols/hidden fields/sparse arrays/prototype-sensitive keys/NUL. Field-level limits then constrain closed schemas. No arbitrary Engine JSON is accepted. These checks assume an ordinary JSON boundary; they do not sandbox malicious in-process JavaScript Proxy traps.

Transport-unknown/cancellation-unknown remains explicit. Successful HTTP creation is only an observation of a returned ID, never a fabricated committed receipt. Nonempty warnings and unsupported response shapes are refused by the safe projection; a future journal/transport must retain unknown outcomes conservatively, including any bounded private returned ID, before cleanup/retry decisions. This unit does not implement that persistence.

## Primary source verification

Pinned source is [Moby v28.5.1 Engine swagger](https://github.com/moby/moby/blob/v28.5.1/api/swagger.yaml), API1.51: container create body/query and entrypoint reset; bind `CreateMountpoint`; network create fields; exact inspect/start/stop/delete responses and query semantics. `CheckDuplicate` is absent from that versioned network-create schema and was removed during review. Fixed NetworkMode full-ID use still needs actual accepted engine validation; no host support is inferred from this schema.

[Moby v28.5.1 Config merge implementation](https://github.com/moby/moby/blob/v28.5.1/daemon/commit.go) independently confirms inherited environment/labels, entrypoint and default CMD merge behavior. The source review establishes request semantics, not availability or normalization of an installed daemon. No broad extraction or copied upstream implementation was added.

## Validation ledger

- Initial narrow run: 32/33; clear-entry fixture retained a stale object reference after schema normalization. Corrected the fixture to update its current normalized approval; no production assertion weakened.
- Intermediate run: 113/113 across new engine33 and existing C2 proof80; 761ms. This preceded removal of schema-unsupported CheckDuplicate and final five added cases; it is not final-source evidence.
- Final frozen source: `pnpm exec vitest run tests/compose-engine-contract.test.ts tests/compose-ownership.test.ts tests/labs-compose-validation.test.ts` in router: **128/128**, 3 files, **9.35s**. New engine38, C2 proof80, C1 validation10. New tests cover exact requests, immutable plans, original/renewed identity, committed network requirement, image/argv/env/bind/security fidelity, full-cohort refusal, unsupported operations/endpoints, bounds/getters/cycles, exact-ID paths, response mismatch/unknown/404 and safe secret exclusion.
- `pnpm --filter switchyard-router typecheck`: passed on final frozen source.
- `pnpm --filter switchyard-router build`: passed on final frozen source.
- No repository-wide/panel acceptance, actual transport, actual engine/profile or durable-journal tests were run; those remain supervisor/follow-on work.

Frozen SHA256:

- schema: `A1A621459111DF4797B142323C64F67E82C74291E0CB08EF26C3E15E29BCBB8D`
- builder: `BD3F1AA3FF135E49D5F4EEF29C830EC6C6424C97063F0DC2335A48916FB12869`
- tests: `8888BCB80E115AF4E82D24D38B13036FB1C7F759D32D1DD712EEDBC0E561E058`

Remaining C3 dependencies: durable intent/receipt journal and fencing, real checked local Engine transport, independently accepted host baseline/profile, live image config verification, pre-effect C2 full/known resource proofs, uncertainty quarantine/recovery and actual two-Lab engine/kill/cleanup acceptance. No C3 or complete L5 claim.
