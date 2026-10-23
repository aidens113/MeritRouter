# Isolated supervisor action clock correction

Status: Complete; isolated source frozen for supervisor review and integration
Worker: worker_containment
Workspace: D:\SwitchYardRouter\.claude\worktrees\meritrouter-clock
Branch: feat/meritrouter-clock-fix

## Diagnosis and scope

The two action-store constructors in `await_tasks` default to wall time, even when the
supervisor's task store and authority use an injected clock. Merely listing actions then
cancels valid historical-clock leases. Both the pending-action loop predicate and the final
projection must use `s.ctx.now`. Elapsed wait deadlines continue to use `Date.now()`.

Read the rename working document and the checked-in docs worker's bounded-seed diagnosis.
The child worktree snapshot does not contain the newer Isolated clock brief section; the
supervisor's explicit dispatched brief supplies the same exact scope and acceptance contract.

Only the specified supervisor tool source, new regression test, and this report are owned.
No primary checkout edits, Git mutations, builds, full suite, demo, or provider operations.

## Evidence

- Authorized `pnpm install --offline --frozen-lockfile` completed successfully in
  this isolated worktree: 219 cached packages reused, no downloads. Expected bin warnings
  reported the intentionally unbuilt router CLI; no build was performed.
- Regression invokes the actual `await_tasks` tool with deterministic service responses,
  while using real task rows, immutable captured leases, and action storage. Separate cases
  reach the pending-action predicate and the completed-target short-circuit projection.
- The pending case explicitly approves an exact command as fixture operator and verifies
  its real exit code, output, and created repository file. The expiry case advances only
  the injected clock and checks cancellation and absence of execution.

## Results and final diff

- Before source correction, focused regression: **2 failed, 1 passed**. The actual pending
  predicate failed to break, and the completed-target result omitted the live worker action.
  Injected-clock expiry already passed.
- Runtime diff is exactly two constructor arguments in `harness/supervisor-tools.ts`:
  `new WorkerActionRequests(s.db)` becomes `new WorkerActionRequests(s.db, s.ctx.now)`.
  Real elapsed-wait `Date.now()` calls remain unchanged.
- After correction:
  `pnpm --filter meritrouter exec vitest run tests/supervisor-action-clock.test.ts tests/worker-containment.test.ts`
  **17/17 passed**, two suites, 16.09 seconds.
- Replaced the test's partial service assertion with an explicitly typed deterministic
  service stub; reran `pnpm --filter meritrouter exec vitest run tests/supervisor-action-clock.test.ts`:
  **3/3 passed**, 5.25 seconds.
- Final worktree status contains only the intended modified source, new regression test,
  and this report. No lockfile or manifest diff from installation. No commits or builds.

Supervisor must review this isolated claim, run integrated typecheck/acceptance after merge,
and perform any Git commit/merge. The primary checkout and its frozen full suite were untouched.
