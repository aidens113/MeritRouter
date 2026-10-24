# Client-supervision regression investigation

Status: Complete — targeted build and tests passed
Owner: delivery-contracts-implementation worker
Date: 2026-10-23

## Current State

Reproduced the narrow-write failure and inspected both client-supervision implementations.
The writer correctly preserved unrelated authored YAML; its test deleted an existing policy
section before comparison. Two transport initialization failures were obsolete wording checks
after the intentional FINAL/delegated product-ownership guidance change. Product behavior
did not require a source change. Only the owned test file and this report changed.

## Findings and corrections

1. The shared legacy fixture now explicitly authors `client_supervision.workflow: direct_tasks`.
   The old test removed the whole changed policy section, then compared with the original
   document that still contained that field. The observed diff consisted solely of the
   test's own removed workflow field. The corrected assertion compares the entire YAML
   object with exactly the requested dispatch/instruction changes; it now also proves the
   authored workflow survives. The comment-preservation assertion remains.
2. Live stdio/HTTP initialization expected “intended project outcome”; current guidance
   intentionally says FINAL supervisor responsible for “intended product outcome.” Updated
   checks assert FINAL responsibility, delegated delivery-supervisor jobs, runtime testing/
   repair and retention of FINAL acceptance, rather than merely deleting the old assertion.
3. Added a distinct new-policy regression with an explicitly empty authored policy. It proves
   delegated delivery is the missing-field default, final project dispatch remains disabled,
   instruction-only writes do not materialize unrelated defaults, and an explicit direct-task
   workflow change preserves customization and final-authority policy.

No authority, dispatch, parent, project, race or resume controls were changed. Existing tests
still verify disabled project-final dispatch, entire-batch validation before insertion,
same-project supervisor parents, no child project scope, permission revocation inside the
insertion lock, legacy resume policy, and exactly-once live policy feedback.

## Validation observed

- Before correction: isolated narrow-write test failed with only the removed authored
  `client_supervision.workflow: direct_tasks` section in the diff.
- `pnpm --filter meritrouter build`: passed, rebuilding current router dist before transport
  subprocess checks. FINAL authorized this feature-tree build; snapshot validation is separate.
- `pnpm exec vitest run tests/client-supervision.test.ts`: **8/8 passed**, including actual
  stdio and HTTP MCP initialization and subsequent policy updates.
- No live model calls, real user data/config changes, commits or pushes.

FINAL owns stable combined typecheck/full-suite checks and integration of these assertions.
