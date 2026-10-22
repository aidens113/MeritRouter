# Report: budget-panel-b2

## Outcome
Done within the assigned implementation scope. B2 UI/API, strict scope fix and live budget topics are implemented in the isolated feat/budget-panel worktree. Supervisor still owns seed fixtures, browser approve/deny/cap checks and integration.

## What changed and why

- Added `components/budget-requests.tsx`: pending requests with task/job links, asked/used/cap/approver/reasons, recorded decision history, a job pool with cap/supervisor usage/worker grants/held/reserve/available, and per-task initial/extra/total grants and usage.
- Added accessible `components/client/budget-decision.tsx`: required decision reason, editable whole-number partial grant, pool availability guidance, approve/deny actions, busy state and actionable API feedback. Phone controls stack; wide pool/task tables scroll.
- Added `POST /api/budget/requests/[id]`: zod ID/body validation, required explicit project scope (empty means unassigned), human:panel attribution, authoritative library decisions. Already-decided, task-finished and pool-exhausted errors become 409; malformed input/reason/grant becomes 400. Not-found/project-denied remains 404.
- Fixed `admin/budget.ts` project guard: a supplied project must exactly match, including rows whose project is empty. Previously any supplied project could decide an unassigned row.
- Job detail: pending decisions on every tab, linked pending count, pool and decision history in Overview. Task detail: pending decisions on every tab, linked pending count, grant summary and decision history in Usage. Existing anchors map budget history/pool sections to their tab.
- Project overview and install dashboard: pending counts in attention views link to on-page decisions. The install list includes unassigned requests explicitly; these do not leak into a project's list.
- Added `budget` live source/topic. Fingerprints pending/settled requests, grants, carved budgets, usage charges and grant-holder states after database writes. Same-millisecond/older-row decisions and returned holds refresh budget views. Project scoping and quiet-tick behavior are preserved. Subscribed job/task/project/install pages include budget changes.
- Added meaningful service regression coverage for cross-project/unassigned denials, partial grants, pool invariants, invalid requests/reasons, repeated decisions, unchanged paid budget spec, budget events and finished-task expiration. Added live regression coverage for project isolation, timestamp collisions and released grants.
- Parent-requested final D5/D6 audit fixes in the same owned files: Supervisor transcript opens by default so inner content is within two clicks; job Branches repository/base commit and job/task metadata repositories (including writable repository) link to entity routes, with qualification fallback text.
- No seed script, runtime brain, export files or shared working docs changed. No commits/pushes and no real provider calls. No panel server started.

## Commands run and observed results

- `pnpm install --frozen-lockfile --offline`: completed in 51.6s. Two missing CLI-bin warnings occurred before router dist existed; all 219 packages came from cache, no downloads.
- `pnpm --filter switchyard-router build`: passed.
- `pnpm --filter switchyard-panel build`: passed production build, TypeScript and route generation, including the new budget API.
- `pnpm -r typecheck`: passed router and panel after correcting initial test-only narrow config typing, and passed again after the final parent-requested D5/D6 JSX edits. Production build preceded those final link/defaultOpen edits; supervisor rebuilds the integrated tree.
- `npx vitest run tests/budget-control.test.ts tests/admin-budget-panel.test.ts tests/admin-live.test.ts --maxWorkers=1`: 33/33 tests passed, 3 files, 43.90s. Existing budget-control behavior remains covered.
- Initial focused run had 17 live tests passing and three new fixture failures due an invalid task label; corrected to schema-compliant alpha-worker before the final passing run.
- `git diff --check`: passed; only Windows CRLF normalization warnings.

## Not verified

- Supervisor must add the approved demo pending fixtures, run production-demo HTTP and browser checks for approve/deny/partial grants/pool caps, inspect desktop/phone screenshots, verify cross-tab live budget updates and stop its temporary server.
- API error status mapping is compiled and follows existing panel handle/body patterns; direct HTTP status assertions are part of supervisor acceptance, not the router unit tests.
- No live providers, user's install, full router suite or live team execution tested in this worker's isolated checkout.
- Lists are bounded: up to 1000 pending rows per scope, latest 200 decision/history rows; the card labels truncated-sized results. Pending queries run separately so newer settled history cannot hide older pending rows within that pending limit.
- The budget fingerprint adds scans of scoped grant/charge rows after database writes, consistent with existing live watcher strategy; large-store performance is not benchmarked.

## Open questions or contradictions found

None blocking. The public library permits a human to override any approver policy; the UI preserves that existing contract and displays the configured approver rather than restricting human controls to human-only requests. Extra model requests never modify paid dollar limits.

Integration note: the worktree fork already contained Panel v2 source. Apply only this worktree's owned diff/new files; do not replace root files wholesale because root continued Panel v2 fixes concurrently. Authored current-state setup/operations documentation remains the supervisor's integration responsibility.
