# Delivery contracts implementation (P0)

Status: Complete — focused validation passed; awaiting supervisor integration
Owner: delivery-contracts-implementation worker
Date: 2026-10-23

## Current State

Implemented three new modules and a focused readiness test file. No existing schemas,
runners, configuration, exports or app files changed. No live calls or commits.

## Public contract

- `verification/product-spec.ts`: `DeliverySpecSchema`, `ProductCriterionSchema`,
  `ProductEvidenceKindSchema`, `ProductDigestSchema`, types and canonical SHA-256
  `deliverySpecDigest`/`productDigest` helpers.
- `verification/product-evidence.ts`: `ProductCandidateSchema`, `EvidenceReceiptSchema`,
  `ProductActorSchema`, `ProductFinalDecisionSchema`, types and `productCandidateDigest`.
- `verification/product-readiness.ts`: input/output/blocker schemas and types,
  `evaluateProductReadiness({spec,candidate,evidence,now?})`.

All structured inputs use strict Zod schemas. Spec source references an immutable authored
document digest; structured spec digest additionally binds criteria, version and scope.
Candidate identity binds every repository head/tree and test, recipe, environment,
dependency, fixture and browser-generation identities. Object-key ordering is canonical;
array order remains significant.

Readiness covers every applicable required/critical criterion by evidence kind. A build
cannot cover journeys, persistence or visual review. Claimed, future, expired, stale,
inconclusive, unavailable, unimplemented or unknown-bearing evidence does not satisfy gates.
Current observed failures remain blocking even beside passes; a repair changes candidate
identity. Independent/visual/usability/test-change reviews require reviewer/FINAL roles,
known subject identities and a distinct reviewing actor. Duplicate receipt IDs and unknown
criterion references block. Critical applicability cannot be waived. Optional unmet criteria
are visible without blocking. Readiness only returns `ready_for_final_review` or `blocked`;
FINAL acceptance is a separately attributed record.

## Trust and integration boundary

These are deterministic contract primitives, not an attached runtime or authorization system.
Caller must resolve identities, receipt provenance, artifact ownership and noncritical
applicability approvals using trusted stores/authority. Never feed raw worker-authored JSON
into this gate as authenticated evidence. A valid actor string or artifact reference does
not authenticate its author or prove an observation. The parent supervisor owns persistence,
public exports, authenticated adapters and `finish_job` enforcement in subsequent phases.

Non-browser tasks can use explicit applicability and null browser generation; hydrated
browser availability is neither fabricated nor enabled by these modules.

## Validation

After offline dependency setup, `pnpm exec vitest run tests/product-readiness.test.ts`
passed **25/25 tests**. An initial attempt before setup was blocked by missing Vitest.
Tests cover positive complete coverage, green-build negative control,
all stale/claimed/unavailable states, each candidate identity change, spec changes,
contradictory failures, independence, invalid references, critical waivers, optional gates,
canonical digests and separate FINAL authority. No repository-wide checks were run while
parallel workers edited source; FINAL owns the stable combined build/typecheck/test pass.

## Follow-up

Supervisor independently verifies and integrates the contracts into subsequent
authenticated runtime/control work.
