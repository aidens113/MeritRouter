# Demo historical phase clock fix

Status: complete; source frozen for supervisor acceptance.

Owned changes only: `apps/panel/scripts/seed-demo.mjs` and this report in the isolated
`feat/meritrouter-clock-fix` worktree. Primary checkout unchanged.

- A phase now records an explicit fixture failure if its wait times out or any tasks remain
  pending, closes the service to drain/abort owned work while time is unchanged, and throws
  before the caller can move the historical offset. It never prints a success line or skips
  missing completed results in that case.
- Only the rounding escalation/review phase receives an explicit 120-second wait. Recorded
  classification/T2/failing review consumed about 49s and T3 read began around 55s, leaving
  insufficient room for its remaining review under the generic 60-second phase limit.
  Other phase timeouts, evidence requirements and lease expiry behavior are unchanged.

Validation: `node --check apps/panel/scripts/seed-demo.mjs` passed. No seed execution, build,
provider request, user-data access, full test run or commit. Supervisor owns fresh quiet seed
acceptance after the runtime clock fix is built.
