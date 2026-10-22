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
- Review follow-up: new scoped history reads no commit subjects/bodies, labels changes generically, and stops at the first private rename boundary. It tracks paths in one Git history traversal rather than calling commit detail once per row. Both History and Related now use it. Scoped blame preserves visible document text while masking attribution inherited from private history, and never links an unavailable hash. Task fixtures now use valid `completed` state.
- Added the link worker's requested `plan-recovery` insights/type exports by coordination; no recovery implementation changes.

## Commands run and observed results
- `cd packages/router; npx vitest run tests/admin-brain-entities.test.ts --maxWorkers=1` -> final 6/6 tests passed (one file, 6.26 s).
- Tests cover other-project denial, missing/invalid project and hash, canonical-path attacks, mixed project/global commits, private rename-source omission and earlier-history denial, same-project rename history, mounted documents, and cross-project attribution suppression.

## Not verified
- No broad builds or typechecks while workers change the shared checkout; supervisor owns those and browser/screenshot checks.
- History from before a document moved from another project's private directory intentionally returns 404. Same-project renames are covered and work. Commit content comes from the current HEAD's document history; dangling and unrelated commits are denied.
- The project brain UI now exclusively uses the scoped history/blame wrappers; the old general human-admin helpers retain their existing contract for other callers. This does not change general admin read/write authorization or expose an entire shared-brain commit as a code repository.

## Open questions or contradictions found
- The root README remains visible as in the existing page (it can name all projects); arbitrary root files are no longer implicitly considered visible. The project/global scope should not silently include arbitrary install files.
