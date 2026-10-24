# Independent evaluator-change review (P6 verification)

Status: Complete — focused tests passed; pending FINAL stable validation
Owner: delivery-contracts-implementation worker
Date: 2026-10-23

## Current State

Implemented the previously unavailable `evaluator_change_review` as an actual independently
routed review, not a deterministic pretend pass. Source edits stopped for supervisor review.
No live calls, commits, shared product-module changes or downstream app edits.

## Changes

- `verification/contract.ts` and `core/acceptance.ts` predict explicitly declared writable
  evaluator paths using configured protected-path patterns. Read-only test context does not
  trigger a write prediction. Submission/contract compilation reserves independent deep review
  before worker execution; infeasible budgets are rejected before coding. Required reviews
  reserve at least one request even if a custom level previously disabled its review reserve.
- `verification/policy.ts` requires deep independent review plus the evaluator gate for
  predicted/actual protected changes. Re-evaluation cannot weaken that requirement.
- `verification/review.ts` reuses the existing reviewer session, model pool, qualification,
  Gate, budget and independent-route machinery. The evaluator-specific structured verdict
  must assess every protected path, cite the immutable comparison, give a reason and agree
  with the overall verdict. Missing comparison cannot accompany a pass.
- Before review, Git validates the baseline and candidate object identities. Candidate is
  the runner's immutable submitted tree; baseline comes from runtime-collected base commits
  and must match a contract pin when present. Each changed protected file has original and
  candidate content/digest, or explicit absence for deletion/creation. A file absent in both
  revisions is refused. Missing/oversized/unavailable snapshots leave review pending.
- The reviewer's current and baseline repository aliases are pinned to those objects.
  Small comparison bundles are shown completely; larger ones require scoped artifact reads.
  Reviewer instructions explicitly reject weakened assertions, skipped tests, weakened fixtures
  or defects hidden by green edited suites and require comparison against original behavior.
- `verification/phase.ts` bypasses the old general verdict cache for protected changes. Its
  cache records do not carry evaluator snapshot/sub-verdict provenance, so none is reused.
- `verification/checks.ts` validates runtime reviewer identity against actual served author
  endpoints, exact revision/policy/changed paths and snapshot citations. Outcomes are passed,
  failed, not-run, stale or inconclusive; no `not_implemented` placeholder remains for this gate.
  The protected-path check is satisfied only by the applicable successful independent review.
- A failed evaluator review becomes a blocking failed check even when every criterion or
  changed test is green. It cannot be converted to accepted by overruling an ordinary review.

## Validation observed

`pnpm exec vitest run tests/evaluator-review.test.ts tests/verification.test.ts`
passed **35/35 tests** on the final source (13 new, 22 existing verification units).

The new cases prove predictive reserve without already asking for criterion review, rejection
of infeasible budgets, no prediction from read-only context, pending unreviewed tests, exact
revision/policy/path bindings, self-review refusal, missing snapshot refusal, malicious test
weakening blocking otherwise-green criteria, and mandatory structured terminal comparison.

Three real framework runs with fake providers exercise native edits through independent
review and acceptance: retained assertions pass; a tautology replacing the regression test
fails/unmet; a pool containing only the author has no independent reviewer and remains pending.
The successful reviewer is a different endpoint, charged under verification, and sees the
actual original assertion plus immutable before/after snapshot instructions.

An initial test run exposed a malformed test configuration (strict reserve omitted) and an
unnecessary extra not-applicable row in legacy check output. Those were corrected; existing
verification-unit behavior now passes. No existing test files were weakened or edited.

## Limits and follow-up

This gate consumes protected changes computed by the workspace collector, never worker text.
Configured fixture coverage and path/rename handling remain that collector's responsibility.
Declared broad scopes that do not explicitly match protected patterns may still discover a
review requirement after editing; the current reserve-adjustment path then applies honestly.

The structured independent review is model judgment, with authenticated provenance and exact
immutable inputs, not a proof of semantic correctness. Large comparison artifacts are scoped
and citable; the system does not claim it can verify a model's internal reasoning. More than
50 protected files or unconstructible snapshots returns pending rather than silently truncating.
Historical general verdict caches remain available for non-evaluator work. FINAL owns combined
typecheck/build/full regression tests and documentation/public API integration.

## Cancellation and reviewer-context follow-up

ReviewRun.signal now reaches review preparation. Immutable snapshot work has a shared
30-second AbortSignal deadline; every Git/object/file read receives it. Parent cancellation
rethrows as cancellation, while preparation timeout leaves review pending rather than passing.
An already-cancelled preparation test proves it exits before touching stores or dispatching.
The actual independent-reviewer memory adapter now applies role ACLs and real prompt/tool
headroom. `tests/reviewer-memory.test.ts` plus evaluator tests passed **15/15** after these
changes. In-flight OS Git termination was not separately re-proven by this follow-up test.

Ordinary review cache reuse is also disabled whenever automatic memory is enabled, because
legacy keys do not bind memory/ACL revisions. Calibration records are preserved; correct
memory-aware cache key design remains future work. This does not weaken the unconditional
evaluator-change cache bypass described above.
