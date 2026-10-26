# C3.5 repair hydration — supervisor implementation

Status: Targeted final cases verified; full final aggregate pending.

`hydrateRepairWorkspace` now acquires a common-Git lifecycle scope for source and target
before checking or recording hydration state and before cherry-picking. Physical common
owners must match before acquiring the combined scope. Existing source provenance, task
authority, bounded chain/patch, scope/mode and quiescence checks remain in place.

`verifyRepairHydration` gates the target workspace before accepting a retained hydration.
Both entrypoints accept an optional host-only third `{mutation}` control; an outer runner
scope can reuse its opaque capability without reacquiring its own lock. Internal verification
does not acquire a second lease. No provider, human approval or arbitrary command runs here.

Validation:

- Actual selected-commit head-published/index-pending fixtures in source and target:
  2/2 PASS, 23 selection skips,35.37s. Target HEAD and hydration event rows unchanged.
- Earlier complete existing repair suite:22/23 PASS,1 FAIL,326.63s. The fresh-lease resume
  case loaded finish.ts before its nested verification capability was forwarded and timed out
  on its own lock. Current finish.ts forwards that capability; exact final-case rerun required.
  No production/test timeout was increased, and no stale lock was removed to bypass it.
- Added nested-capability hydration+verification regression. Final focused rerun could not
  collect because concurrent runner activation imports repository-command.ts before its
  worker has written that module. This is an incomplete-source snapshot, not a passing check;
  rerun after command module readiness. No assertion or import stub added to bypass it.
- Physical-owner equality check added after the first focused pass; final source needs rerun.
- Final-source focused repair run4/4 PASS,22 selection skips,70.07s tests: nested host
  capability, pending source/target, and the previously failing fresh-lease resume.
  Capability forwarding resolves the self-lock without changing any timeout.

Next Brain audit observations (read-only, no Brain edits yet): `writeFile`, `remove`,
`removeProjectFolder`, external-edit adoption and initialization currently write before
the selected-commit fence. Preserve mount/literal scopes and optimistic digests; introduce
prewrite scopes with nested capability forwarding. Do not hold lifecycle leases across
optional remote Git push. Initialization needs handling for a new non-Git root; pending
existing roots must refuse before skeleton files. Existing Brain lock's age-based stealing
does not replace the new common-owner lifecycle protocol.

No provider calls, live project edits, new checkout or source-repository runtime directory.
