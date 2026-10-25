# Authoritative specification binding

## Cause and change
The model was required to supply a 64-character digest and reproduce the full original task instruction exactly merely to save a structured specification. Those values already exist authoritatively in the runtime.

Only set_delivery_spec input now makes source and originalInstruction optional using a strict tool-input object copied from the existing schema shape. Omitted originalInstruction is taken from ctx.spec.goal. Omitted source becomes {ref:task:<taskId>:goal,digest:SHA256(raw UTF8 task goal)}. The advertised JSON schema and tool/field descriptions tell the model to omit these fields rather than invent a digest or echo the goal.

After binding, the complete object is explicitly parsed through DeliverySpecSchema (including its cross-field refinements), then saved. ProductDeliveries.saveSpec and the persisted DeliverySpecSchema are unchanged and remain strict. Explicit originalInstruction replacements are rejected by the same exact goal check. Supplied source fields retain original strict validation. CAS revision checks, required criterion/evidence protections, lifecycle guards and approvals are unchanged.

## Files
- packages/router/src/harness/delivery-tools.ts
- packages/router/tests/delivery-spec-binding.test.ts (new)
No app source, configuration, runtime state or shared working document edits; no commits.

## Validation
pnpm exec vitest run tests/delivery-spec-binding.test.ts tests/product-delivery.test.ts ->2files/7tests passed,8.51s,exit0.
New4cases verify advertised optional fields and full strict storage; invalid explicit sources and wrong goals refuse without a saved row; CAS revisions and required criteria protections; and an actual fake-provider supervisor tool call saves a specification with neither hash nor a repeated5k-character goal. Existing3product-delivery cases remain green.

No test processes running. Parent owns integrated checks, publication, activation and actual product oversight.

## Limits
The model still authors the observable specification content and must satisfy its schema; this change only binds the already authoritative original instruction/source. It does not synthesize acceptance evidence or relax model-authored criterion protections.

## Typecheck correction
Root caught TS2322 because safeExtend disallows widening required fields to optional. Replaced it with a strict input-only object schema copied from DeliverySpecSchema.shape, followed by explicit full DeliverySpecSchema.parse after canonical binding. No casts or persisted-schema relaxations. pnpm exec tsc --noEmit ->exit0; focused binding/product rerun7/7 passed,7.52s,exit0. No tests running.

