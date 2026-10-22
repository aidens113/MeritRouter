# Report: brain-navigation-completion

## Outcome
Done: scoped commit route, history/blame links and document Related navigation implemented; production browser acceptance remains with the supervisor.

## What changed and why
- New `admin/brain-entities.ts` validates project, canonical document path and commit hash before exposing a document-only diff. Only own-project documents, global knowledge and the already-visible root README are accepted. Commit subjects/bodies, unrelated file names and rename source paths are excluded. Literal Git pathspecs prevent glob widening; mounted documents resolve through the brain's existing mount interface.
- New `/p/[slug]/brain/commits/[sha]?path=...` page shows the selected document's diff and links back to its document, history and project. History and committed blame hashes link there; uncommitted blame stays text.
- Selected documents have Related groups for project, commits, agents, models, and attributed tasks/jobs. Task/job links are checked against stored project ownership by the service.
- Brain document UI scope uses the same canonical-path validator, closing its prior traversal-shaped scope checks.
- Public insights exports include the new services; public index exports their detail type.
- Historical paths are followed through same-project renames; commits before a rename from another project's private directory are denied rather than revealing that earlier document.
- Review follow-up: scoped history stops at the first private rename boundary and tracks paths in one Git traversal rather than calling commit detail per row. History and Related use it. To retain safe subjects, one bounded (4 MiB, at most 50 commits) batch inventories every changed path across all merge parents with rename detection disabled. Actual subjects appear only when all changed paths are visible; mixed/private/missing or oversized inventories retain generic labels. Nested mounts inventory the entire containing repository, including paths outside the mount. Commit detail never exposes subjects or bodies. Scoped blame preserves visible text while masking private-history attribution and filters all task/job identities by stored project ownership. Task fixtures use valid `completed` state.
- Brain agent links now require an existing session identity in this project; human/system attribution and actors belonging only to other projects remain plain text in History, Related, blame and Promotions.
- Added the link worker's requested `plan-recovery` insights/type exports by coordination; no recovery implementation changes.

## Commands run and observed results
- `cd packages/router; npx vitest run tests/admin-brain-entities.test.ts --maxWorkers=1` -> final 7/7 tests passed (one file, 7.03 s).
- Tests cover other-project denial, missing/invalid project and hash, canonical-path attacks, mixed project/global commits, safe-only subject retention, mixed/private subject masking, private rename-source omission and earlier-history denial, same-project rename history, nested mounted documents with out-of-mount changes, and cross-project attribution suppression.

## Not verified
- No broad builds or typechecks while workers change the shared checkout; supervisor owns those and browser/screenshot checks.
- History from before a document moved from another project's private directory intentionally returns 404. Same-project renames are covered and work. Commit content comes from the current HEAD's document history; dangling and unrelated commits are denied.
- The project brain UI now exclusively uses the scoped history/blame wrappers; the old general human-admin helpers retain their existing contract for other callers. This does not change general admin read/write authorization or expose an entire shared-brain commit as a code repository.

## Open questions or contradictions found
- The root README remains visible as in the existing page (it can name all projects); arbitrary root files are no longer implicitly considered visible. The project/global scope should not silently include arbitrary install files.

## Follow-up: shutdown ownership of promotion settlement
- Root brief: investigate the full-suite `projects-brain.test.ts` Windows EBUSY cleanup failure without weakening cleanup or the promotion test.
- Root cause in service lifecycle: a review's settled event launched an untracked timer and an untracked `settlePromotions` promise. The promotion record becomes readable before the full brain write/Git commit finishes. `close()` waited for scheduler tasks and executor report writes, but neither owned the promotion settlement; it could therefore return with its Git child still accessing the fixture directory.
- Fix confined to `core/service.ts`: track deferred timers and every in-flight public/deferred settlement, stop scheduling and cancel pending callbacks as shutdown begins, then drain active settlements after executor shutdown and before database closure. No cleanup retries, warning suppression or test helper changes.
- New `tests/service-close.test.ts` passed final 4/4 (3.44 s), covering explicit in-flight settlement, deferred settlement from a real completed review task, cancellation of queued callbacks/refusal of new settlement, and a draining settlement submitting a retry review after scheduler shutdown. The latter remains queued with zero active workers: `submitTasks` only calls `scheduler.kick()`, which exits when stop has cleared the timer; it does not call `start()` or restart claiming. Deferred promises reproduce ownership deterministically without relying on an intermittent Windows file lock.
- `npx vitest run tests/projects-brain.test.ts tests/service-close.test.ts --maxWorkers=1` passed 11/11 in 26.13 s before the fourth shutdown regression was added; the final shutdown-only rerun passed 4/4. No broad validation performed by this worker.

## Follow-up: inferred copy ancestry in generated README history
- Browser crawl found unrelated demo-project hashes listed for the storefront index. Read-only Git inspection reproduced `C051 projects/demo/README.md -> projects/storefront/README.md` from `git log --follow`: Git inferred a copy because generated indexes share content. The parser only tracked renames and added records without checking whether they touched the current historical path.
- Fixed `admin/brain-entities.ts` to parse copy statuses as two-path events, follow their source for older history with the same visibility boundary as renames, and emit only records that actually changed the tracked path. Own-project copied ancestry remains navigable; private sibling-project ancestry is excluded.
- New regression fixtures verify native Git actually reports a copy for both own-project and private-project sources. Initial fixture probes failed because `brain.ensure` had already created the destination README, producing a modification rather than a copy; corrected fixtures use a new destination directory. Final `npx vitest run tests/admin-brain-entities.test.ts --maxWorkers=1` passed 9/9 in 9.61 s.
- Did not mutate or reopen the supervisor's demo service; browser recrawl/build remain with the supervisor.
