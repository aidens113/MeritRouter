# Report: panel-link-completion

## Outcome
Done within the brief: Activity and the owned plan/team/timeline entity navigation implemented; evidence-backed supervisor recovery query and optional PlanCard annotation implemented. Supervisor integrates the async call and verifies the browser.

## What changed and why

- Project Activity now shows the five most recently active project-scoped agents, linking their pages and showing status, tasks, sessions and recency; a link opens the full list. Queries only when Activity is selected.
- `jobPlan` now returns deduplicated recorded session attribution identities for each dispatched node. The identity is never guessed from the node label. Regression covers duplicate retries, distinct roles, unrelated task identities and nodes without sessions.
- Plan table labels, critical-path task labels, dependencies, lease-holder tasks and redundant-node labels link to tasks. Node agents link to agents; twin endpoints link to models. Valid attribution identities in plan authorship/version history link to agents; human authors remain text.
- Team tree shows recorded session agents for each task/job using public `insights.sessionsView`; merge queue repository names link to repository pages. Existing tree task/job and channel author/task/job links were retained.
- Session startup links its agent, task and job. Model responses link request IDs; workspace events link repository aliases and base/head commits. Existing endpoint/fallback model links remain.
- Added parent-authorized `admin/plan-recovery.ts` and `tests/admin-plan-recovery.test.ts`: exact recorded job supervisor attribution, later timestamp, matching failed segment paths and reachability on the recorded job branch are required. Reads a captured branch head rather than `--all` or current checkout HEAD. PlanCard accepts optional `recovery` data and retains original failure/acceptance beside the requested annotation, commit and agent links. A visible explanation distinguishes later changes from independent verification, and exposes the 500-commit history cap and any read errors.
- Only brief-owned source/test files, parent-authorized recovery files and this report changed. No commits, broad builds, real providers or user configuration used.

## Commands run and observed results

- `npx vitest run tests/team-surface.test.ts --maxWorkers=1` in packages/router: 6 tests passed, 1 file, 13.03 seconds including the new attribution assertions. An earlier run before the assertion insertion also passed 6 tests; it is not the regression evidence.
- `npx vitest run tests/admin-plan-recovery.test.ts --maxWorkers=1`: 1 test passed in 3.15 seconds. Real temporary Git history verifies positive evidence, before/same-second rejection, wrong agent/job, unrelated paths and non-job branches, missing branches and unchanged failed task data.
- Final combined `npx vitest run tests/admin-plan-recovery.test.ts tests/team-surface.test.ts --maxWorkers=1`: 7/7 passed, 2 files, 16.99 seconds after validating recorded branch inputs with zod.
- `git diff --check`: no whitespace errors; Windows CRLF normalization warnings only.
- Reviewed Git diffs to confirm pre-existing Unicode remained byte-preserved. New shell-fed non-ASCII literals that PowerShell reduced to question marks were replaced with ASCII separators; Python edits thereafter explicitly use UTF-8.

## Not verified

- No production build, browser screenshots, HTTP navigation crawl or request/brain propagation acceptance; supervisor owns those after concurrent edits settle.
- This is the owned-surface entity inventory, not an audit of every panel page. Raw transcripts, tool argument/output JSON and arbitrary model-produced note/post text intentionally remain escaped data rather than guessed entity links.
- Plan SVG nodes retain their task link and its SVG title includes plain status/wait text. File-lease repository keys remain explanatory scope text (some are qualified project/alias keys); workspace repository aliases and merge queue aliases link.
- Agent summaries rely on existing agentsView recency semantics; team identity summaries are bounded by the public sessionsView 1000-session limit per task.

## Open questions or contradictions found

The parent clarified the explicit handoff criterion: annotation means the supervisor subsequently changed the failed segment's scoped paths on the job branch, rather than a new independent verification claim. The implemented query follows that criterion, and the UI explains its meaning and preserves failure/acceptance. Git author names, whole-job success and overlap from unrelated branches/jobs cannot produce annotations. Same-second commits are conservatively omitted because Git time resolution cannot prove they followed a millisecond-resolution failure.

The parent owns the job-page call `const recovery = await insights.planRecovery(sy, id)` and `recovery={recovery}` on PlanCard. Brain worker owns insights/index exports for the new service/types. These integration changes are outside this worker's owned files. Full browser/build acceptance remains the supervisor's responsibility.
