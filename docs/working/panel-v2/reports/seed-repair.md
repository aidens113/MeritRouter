# Report: seed-brain-repair
## Outcome
Done: initialization race and two nested fixture defects repaired; final isolated seed exits 0 with real successful integrations and all new fixture assertions passing.
## What changed and why
- `Brain.ensure()` used git outside the mutation lock. Independent per-project Brain instances share one repository, so initialization raced other initializations and ordinary writes. Serialize repository initialization, skeleton creation and its commit with the existing repository lock, and propagate initialization errors instead of silently swallowing them.
- Exclude `.switchyard-brain.lock` from initialization and external-edit adoption commits; the lock is runtime state, not content.
- The nested demo child receives 12 requests; its first turn and supervisor reserve leave 7 available. Its two default implement grants cost 8 each, so the actual delegate tool rejected the first grant and dispatched nothing. Specify exact scripted requests: mean 2, range 3. The next seed exposed a second fake-provider bug: final requests expose only submit_result, so tool-based dispatch mistook coding work for an unrelated read-only analysis, rejected its citations and exhausted the grant. Keep the coding script selected by the Implementer charter on that final request. No routing/admission bypasses or fabricated integrations.
- Seed now checks real integration outcomes, rebase, pending promotions and session lock errors and returns nonzero for those fixture failures after closing services.
## Commands run and observed results
- `pnpm install --frozen-lockfile --offline`: passed, 219 packages reused; expected CLI-bin warnings before router dist existed.
- `pnpm --filter switchyard-router build`: passed.
- Baseline `pnpm --filter switchyard-panel seed:demo`: exit 0, but nested job `completed/unmet; 1 sub-job, 0 integrations (0 rebased), 1 posts, survey twins verified`. Its stored delegate tool outcome says mean needs 8 requests, only 7 available, nothing dispatched.
- Baseline full seed did not reproduce missing pending promotions or git lock errors on this run. Both expected pending promotions were present; historical missing promotions must not be reported as independently reproduced.
- Regression run against baseline source reproduced `git add ... .git/index.lock: File exists`; fresh-repository variant also reproduced competing git init template copies. Fixed regression passes with actor provenance and no tracked lock.
- `pnpm exec vitest run tests/brain.test.ts tests/team-nesting.test.ts --maxWorkers=2`: 16/16 passed (2 files). Unmatched extra filenames supplied in the initial command were ignored by Vitest; actual files run are named here.
- `pnpm -r typecheck`: passed.
- `pnpm exec vitest run tests/brain.test.ts tests/projects-brain.test.ts tests/admin-promotions.test.ts tests/team-nesting.test.ts --maxWorkers=2`: 29/29 passed, 4 files.
- `node --check apps/panel/scripts/seed-demo.mjs`: passed.
- `git diff --check`: passed.
- `pnpm -r build`: passed router and production panel builds.
- Final full seed nested result: `completed/met; 1 sub-job, 3 integrations (1 rebased), 4 posts, survey twins verified`; real fixture assertions passed.
- Final `pnpm --filter switchyard-panel seed:demo` (third run, current script): exit 0, no warnings or fixture failures; nested job met with 3 integrations/1 rebase, exactly 2 pending approvals before the script approves one, no session index.lock/brain lock errors. Both Switchyard instances closed and the process exited.
## Not verified
No paid/live providers or user install touched. No panel server started. Supervisor still owns the full router suite and integrated review/validation. Missing historical promotions were not independently reproduced.
## Open questions or contradictions found
Missing pending promotions did not recur in baseline, so their exact historical cause remains uncertain. Initialization races can prevent the supervisor from reaching later promotion calls, but that connection is an inference, not separately established evidence.

Cleanup automatic approval review rejected PowerShell deletion of known test-only temp folder `C:/Users/mrjoh/AppData/Local/Temp/switchyard-test-JkTAXH` as `blocked by policy`, without further explanation. No alternate deletion was attempted; the folder may remain.
