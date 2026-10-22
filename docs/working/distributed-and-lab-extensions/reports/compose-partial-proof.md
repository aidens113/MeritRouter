# Compose known-resource proof prerequisite

Status: implemented; frozen for supervisor verification. No engine/runtime acceptance claimed.

## Contract

`verifyComposeKnownResources` is a separate pure snapshot API in `labs/compose-ownership.ts`. It preserves the original complete normalized approval and its hash. It never constructs a subset approval, fabricates a full journal, or marks an issued operation committed.

The strict input journal separates `runState` (provisioning/uncertain/complete) from bounded resource creation receipts. Every receipt has an operation ID, resource kind/service slot, request digest, immutable original creation identity and engine binding. Issued receipts require a null resource ID; committed receipts require a full immutable ID. The current owner fence is checked through journal/current identity equality; original creation identity excludes that mutable fence. Duplicate operation IDs, resource slots and committed IDs refuse proof, including network/container ID collisions. These are trusted future durable-journal inputs, not authority derived from inspect output. Request digests are recorded bindings; this prerequisite does not yet implement an Engine request builder or independently authenticate the journal.

Selection names an exact service subset and network inspect/remove purpose. Every selected container and its network require committed receipts. The original full approval is validated, including all declared service authorities and mount/publication constraints, before resource inspection. Selected containers receive the same image/config/environment/hardening/bind/port/network checks as the full verifier. Observed network ID and labels must match the committed original network. Selected endpoint and network peer evidence must agree reciprocally. Known unselected peers must have same-run committed receipts but are explicitly not claimed inspected or proved; foreign/uncommitted peer IDs refuse proof. Network removal additionally requires an empty observed endpoint map and no selected containers. Missing container observations never establish network emptiness.

The strict public result contains only safe fixed codes/counts and explicit qualifiers: `scope: known_resources_only`, `generationCompleteness: not_proved`, `readiness: not_proved`, `runDisposition: unchanged`, `authority: none`, `runtimeEnabled: false`. Even a positive result does not authorize mutation, release paths/ports, clear unknown effects, permit a replacement generation, or resolve uncertain run state. Network-only identity proof is supported without making those claims.

## Full-verifier compatibility

The existing `verifyComposeResourceProof` signature, strict schema, full-cohort requirements and result shape remain unchanged. Its approval/container policy checks were extracted into private shared primitives; the full path still requires the exact complete committed service cohort and exact attached peer set. All 51 prior cases pass. The partial path does not call the full verifier with invented state.

## Validation

- Focused `vitest run tests/compose-ownership.test.ts`: 80/80 passed (51 existing, 29 added), 138 ms test time; overall 763 ms on this Windows fixture run.
- Final router typecheck and build both passed after all 80 cases were present.
- Added cases cover original full multi-service approval with only one committed/observed container, an additional issued unknown creation, unchanged full seal/input/run disposition, network-only receipt, empty-network removal, original creation/engine/fence/request/intent bindings, missing/issued network/container receipts, issued receipt carrying an ID, duplicate/colliding IDs/slots/selections, unknown service/extra observations, replacement network, foreign peers, forged labels, reciprocal endpoint/config changes, bounded malformed/cyclic/accessor input and safe output.
- No engine commands, services, migrations, runtime registration, public exports, user data or panel changes. No full-suite or actual-engine/profile acceptance attempted.

## Remaining integration prerequisites

The supervisor must independently verify this claim. Eventual runtime must construct receipts from durable acknowledged create intents, retain unknown-effect quarantine separately, freshly inspect exact IDs immediately before bounded mutation, and supply a separately approved engine-default baseline. Labels and names are checks/discovery only; they cannot create receipt authority. Trusted-engine boundary remains explicit and does not protect against Docker-admin peers. Proof success is not a lock against mutation after inspection and carries no deletion permission.
