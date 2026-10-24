# Delivery acceptance integration review

Worker: harness-v2. Read-only review of checkpoint 7152295 plus concurrent root fixes, 2026-10-23. Source and tests were not edited. No provider calls or Docker execution.

## Findings returned to supervisor

1. **High — FINAL observations and decisions could silently bind to a different candidate.** `packages/router/src/mcp/tools.ts`, original observation/decision handlers around lines 100–110, refreshed the candidate and stamped its current digest without accepting the digest the FINAL supervisor actually inspected. Reproduction: inspect candidate A, let a worker commit B, submit A's observation; receipt would describe B. The same race affected acceptance. Root has now added expectedSpecDigest/expectedCandidateDigest and a post-refresh comparison in the reviewed source (around lines 100–116). Source-reviewed correction; regression verification remains supervisor-owned.

2. **High — final checks could certify a candidate created by the check itself.** `packages/router/src/runners/supervisor.ts`, original lines 385–428: patch/scope collection preceded final commands, while structural receipts were bound only to the candidate captured afterward. A command could validate A, change/commit to B, exit zero, and produce a receipt for B plus an outdated patch/scope report. Root acknowledged and is implementing before/after candidate binding and moving patch/scope inspection after checks. This finding was traced in source, not exercised with a mutating integration test.

3. **High — dirty sources originally reused committed candidate evidence.** `packages/router/src/verification/product-candidate.ts` originally considered HEAD/tree/manifests without rejecting uncommitted ordinary source changes. MCP refresh could retain old green receipts after a source edit. Latest source now rejects dirtyPaths before constructing the candidate. The new real temporary-Git regression passed in this review's narrow test run.

4. **High — initial all-optional specification admitted zero-observation readiness.** `product-spec.ts` permits optional criteria, and `product-readiness.ts:42` intentionally excludes their missing evidence from blockers. Initial save therefore needed its own meaningful mandatory-criterion guard; monotonic revision protection alone did not cover it. Latest `product-delivery.ts:29` now requires an applicable required/critical criterion. This closes the concrete empty-mandatory-coverage bypass. Semantic coverage of the original goal still requires FINAL review: a required structural-only criterion can describe far less than the requested product.

5. **Medium — acceptance can coexist with later blocked readiness.** `packages/router/src/verification/product-delivery.ts`, finalDecision/status: acceptance checks current readiness but not persisted handoff or active execution. A subsequent observed failure on the same candidate blocks readiness while preserving finalDecision=accept. Reproduction at the service boundary: complete evidence; accept; append a current observed fail; read status. Consumers must not equate a historical accepted decision with current accepted readiness. Returned to root for stage/execution and decision-invalidation policy; not assumed fixed.

## Operational limitations and observations

- FINAL rejection changes the product stage to validate and blocks handoff, but does not itself resume/requeue a completed task. Repair currently requires the initiating supervisor to use the explicit resume workflow. The tool description's “reopens validation” describes persisted delivery state, not automatic worker execution.
- Self-authored waiver data is rejected by saveSpec; there is no authenticated waiver operation in the reviewed delivery MCP tools. A legitimate noncritical applicability exception therefore currently requires an explicit product/API extension rather than a model-authored approvedBy string. Safe restriction, but incomplete waiver workflow.
- FINAL observation artifact references are nonempty strings, not resolved artifact existence/digest proofs. The external initiating supervisor is explicitly trusted to attest observations; this is not a delegated worker receipt-injection bypass. Reviewability still depends on that supervisor supplying retrievable evidence.
- Required criteria cannot be removed/weakened in later revisions; originalInstruction is compared to the persisted task goal. Spec changes clear candidate/evidence/current decision and retain history. Evidence is scoped to spec/candidate digests; stale passes do not count. Observed failures cannot be erased by a later pass on the same candidate.
- Delegated delivery tools do not expose raw evidence receipt or FINAL decision writers. Independent review/visual/usability evidence requires an independent trusted role. FINAL delivery acceptance is distinct from legacy task acceptance; version-2 runner results do not automatically mark acceptance met.
- Latest finish guard synchronizes the candidate and requires persisted handoff plus readiness. This addresses the earlier stale-readiness/no-handoff completion path.
- Runtime conversion derives journey/runtime criterion coverage only from successful assert/wait steps. Persistence additionally needs a successful restart_service followed by a successful assert/wait for the same criterion. The retained journey resolver rechecks current heads/trees, fixture final state, recipe/test digest, service identity, actual engine/image and artifact integrity, selecting the latest journey only. An unavailable/failed latest journey does not fall back to an older successful journey.
- Actual browser/Docker platform acceptance remains unverified because the Docker daemon is unavailable. No capability claim is inferred from fake adapter tests or source review.

## Validation observed

Command: `pnpm exec vitest run tests/product-delivery.test.ts tests/product-readiness.test.ts` in packages/router.

Result: **27 passed, 1 failed** across 28 tests. product-readiness: 25 passed. product-delivery: dirty-source regression and project/CAS/history regression passed; waiver test failed at line 34 because the new applicable-required-criterion guard rejects before the expected `/authenticated FINAL/` waiver message. Both paths safely reject; root notified to correct ordering or fixture. This run read a moving source tree and is narrow regression evidence, not final repository validation.

No full build/typecheck or source-mutating adversarial test was run by this worker. Root owns implementation repairs and final integrated verification.
