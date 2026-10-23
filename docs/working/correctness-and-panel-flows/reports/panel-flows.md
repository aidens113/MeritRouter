# Panel flows worker report
Status: Implemented; pending supervisor acceptance

## Findings and implementation
- Job immediate children were hidden under Team, and no hierarchy appeared on default Overview. Overview now shows linked job/task tree regardless of structured plan rows. Existing tree and immediate child admin data now reject inconsistent cross-project descendants.
- Job request list used taskId=job and omitted worker/subjob model calls. New jobId request scope recursively follows persisted same-project task ancestry, returns each physical request once and rejects non-job roots. Job Requests tab shows100 latest with total and scoped full-log link.
- Request log purpose/tier/problem filters ran after LIMIT, hiding older matches. All filtering now happens in admin SQL before limit. Count + deterministic limit/offset pagination added, with project scope preserved and request task refs validated against stored request project.
- Request links now identify Job versus Task and show labels where available. Request details link directly back to supervising jobs as well as tasks and sessions. Task and session pages already expose owning job/task navigation.
- Plan tab previously blank without structured plan; now explains how to find delegated work.
- Unknown cached usage previously became zero/new-token certainty on request summary, task result and dashboard. Unknown is explicit, measured zero preserved; dashboard partial new-token totals show upper bounds and cache lower bounds.
- Supervisor action requests exposed above tab content on job/task pages with exact command/operation, cwd, timeout, source identity, reason, recorded result/history, strict project-scoped POST decision API. Commands approved+run once; generic operations require operator-supplied performed result and are labeled reports rather than check evidence. Security policy enforced by backend, UI shows active mode and disables execution when disabled.
- Added dedicated global Settings Security tab with disabled/human_only/supervisor selection, human-only default and option explanations. Config save uses existing prepared-config validated path.

## Validation so far
- vitest tests/admin-job-navigation.test.ts:3 passed.
- vitest tests/admin-job-navigation.test.ts tests/projects-surfaces.test.ts:11 passed.
- TypeScript transpile syntax check:13 changed/new panel files passed after security setting additions. Full typecheck/build not run yet: waiting for shared-source freeze and fresh router dist.
- No providers, actual4477, or real user config accessed.

## Acceptance route matrix / screenshots
- /all/settings?tab=security: enum labels, current mode, save/invalid enum route response (demo only).
- /all and /p/<demo>: upper-bound cache labels on desktop and mobile.
- /p/<demo>/jobs/<root>: hierarchy shown default, child task and subjob links, pending supervisor actions visible; ?tab=plan empty state; ?tab=requests includes root/worker/nested requests and full-log link; ?tab=team existing list; ?tab=sessions links.
- /p/<demo>/requests?job=<root>: scoped label/back link, purpose/model/status/task filters, pagination/counts, Unknown versus measured0 cache.
- /p/<demo>/requests/<id>: Jobs, charged Tasks and Sessions links.
- /p/<demo>/tasks/<child>: owning job link, pending decisions visible above tabs; result cache unknown.
- /p/<demo>/sessions/<id>: owning job/task/request links, timeline unknown cache.
- POST /api/worker-actions/<id>: wrong project404, invalid body400, already decided409, disabled policy409; no real command approval during UI checks.

## Remaining
- Shared freeze typecheck/build + production demo routes/API and screenshot review owned by supervisor.
- Final review after integration may require minor adjustments; worker source frozen. No commits made by worker.

## Final read-only UX review: live approval invalidation (material correction)
- Confirmed defect: WorkerActionRequests.file/save/reconcilePending write worker_action_requests without task/session events. admin/live.ts SOURCES/MUTABLE_TABLES omit that table. An approval filed after the last task/session refresh can remain invisible on an already-open Live task/job page while the worker waits. Global pending inbox is a separate enhancement; this invalidation defect is material.
- No additional blocking job/task/request/session navigation defects found in scoped final review. Browser desktop/mobile evidence supplied by supervisor, not rerun by worker.

### Exact bounded implementation recommendation (after current full suite)
1. Edit packages/router/src/admin/live.ts only for behavior: add SOURCES.workerActions with topic tasks, project-scoped count mark (project_id authority), and topics returning tasks, jobs, tasks:* and jobs:*. Add workerActions:[worker_action_requests] to MUTABLE_TABLES so value_json status/decision/output changes and same-createdAt updates invalidate via existing fingerprint logic. Existing task/job headers already subscribe; no UI or public topic enum changes required.
2. Keep source scoped through existing scoped(project) helper. Do not call listWorkerActions/getWorkerAction from the watcher because reconciliation mutates rows. Watch stored rows only; no side effects and no supervisor access grants.
3. Optional optimize count+fingerprint later; correctness uses existing mutable-source pattern and honors quiet-tick skip. Hash includes value_json rather than timestamp-only marks because decisions have no updated_at column.
4. Edit packages/router/tests/admin-live.test.ts with one scoped regression using temp twoProjects fixture; no providers and no command approvals needed. Insert task fixtures before cursors, then insert/update/delete worker_action_requests directly through test fixture SQL while task/session tables remain unchanged.

### Scoped regression acceptance
- Initial alpha/all cursors; pending alpha row insertion alone emits tasks:*/jobs:* (and coarse tasks/jobs), matches current task/job subscriptions; beta cursor yields no topics.
- Update older row value_json pending->running->completed/denied/cancelled, decision reason/output, keeping created_at/id constant; each write alone invalidates alpha/all. Assert task/session event counts unchanged to prove no incidental trigger.
- Separate beta action insertion/update/deletion invalidates beta/all; after acknowledged alpha cursor it produces no alpha topics (foreign project isolation).
- Delete alpha row invalidates alpha/all, none beta. Repeat check without any DB writes returns no topics.
- Perform one mutation via a second SQLite connection to verify data_version path in addition to same-connection total_changes path.
- Existing admin-live tests plus new focused case must pass. Then browser at open waiting task page should discover a filed request without navigation/manual refresh; root final build/demo rerun after source thaw.
- Current source/test freeze preserved; report-only change.

## Read-only full-suite diagnosis: nested brain mount history
- admin-brain-entities.test.ts nested mount subject test fails because Brain.resolve returns mount root repo/docs as repo and note.md as repoRel; documentHistory calls protected git from that nested cwd. New Git root guard rejects, outer catch returns[], so expected generic subject is undefined. This is a legitimate nested mount regression, not a reason to relax generic Git containment.
- Safe service-specific fix: admin/brain-entities.ts normalizes each resolved document to {gitRoot,mountPrefix,virtualPrefix,repoPath}. Discover Git root through existing metadata-only rev-parse --show-toplevel; canonical mount must remain within canonical root. Verify git common-dir identity from mount and discovered root is equal (reject misleading core.worktree redirect to an unrelated enclosing Git repo). Then invoke ordinary protected git at actual Git root with repo-relative literal pathspec.
- Example mount repo/docs -> projects/alpha/notes: mountPrefix docs/, virtualPrefix projects/alpha/notes/, document repoPath docs/note.md. History tracks full repo paths; every old rename/copy path must begin mountPrefix before mapping virtualPrefix+suffix and checking project visibility. Stop at mount boundary. Whole-commit raw inventory must inspect ALL paths from actual root with --no-relative; exposing subject requires every path inside mountPrefix and visible virtual mapping. Do not simply reuse empty show-prefix from gitRoot, which would leak outside-mount subjects.
- Detail uses selected historical full repoPath and literal pathspec, with --no-renames and explicit --relative=docs/ for mount-local patch names. Blame currently delegates Brain.blame (also nested git cwd); admin can use root-aware attribution blame with path mapping while preserving private-history masking, or normalize at a dedicated Brain service helper with equally narrow scope.
- Focused acceptance after full freeze ends: existing10 admin brain tests; nested mixed commit stays generic; nested mount-only commit may show safe subject; nested detail excludes private sibling; rename/copy across mount boundary cannot expose earlier history/subjects/attribution; malicious core.worktree still rejected; legitimate managed worktree mount works. No generic Git guard exemptions and no broad source edits recommended.
- Brain write/history/blame methods also pass mount root to Git directly; legitimate nested mounted mutation compatibility merits separate explicit normalization if required by acceptance, preserving path-specific staging rather than granting general parent-repository access.
- Source freeze preserved; report-only diagnosis.
