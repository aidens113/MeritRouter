# Report: brain-performance implementation

## Outcome

Partial: implemented P8 navigation/search/indexing and memory-management source changes. Narrow
Brain/metadata/privacy tests have passed; final integrated production build, API/browser journeys
and screenshots remain supervisor-coordinated gates. No user Brain, application files, live
configuration, providers or running panel was modified. No commit/push performed by this worker.

## What changed and why

- Brain View/Edit no longer loads history, blame or related attribution. Provenance is selected
  explicitly; only Brain events refresh the page. Document/history links disable eager prefetch.
  Requests/promotions/memory views skip the document catalog; inactive promotions aren't read.
- Brain browse uses indexed metadata, with 50 documents/page, visible next/first links, freshness
  and explicit reconciliation. Scope precedes pagination/ranking. Search supports pages and
  generation invalidation; document cursors bind project/prefix/generation. No full-body tree
  traversal is used by the page. Legacy `brainTree` remains unchanged for compatible callers.
- Index reconciliation inspects owned-project/global metadata and parses only changed documents,
  skips symlinks/foreign project traversal, deduplicates concurrent refresh and caches freshness
  for five seconds. Changed-file indexing uses bounded transactions and yields between batches.
  API writes update the index/generation immediately. External edits reconcile on request/refresh.
- A 10k-file fixture exposed unconditional initialization `commitAs(paths:["."])`: reopening a
  Brain adopted all untracked fixture documents and took 57.3 seconds once. Initialization now
  commits only newly created skeleton paths and does no commit when none were created. Outside
  edits still use the established adoption-on-write path and retain user attribution.
- History requests are bounded to a 50-entry page and at most 1,051 traversed changes, with
  ten-second/4MB Git limits. Scope-masked rename ancestry and whole-commit subject masking remain.
  A bounded, in-flight cache binds project/mount/path/HEAD/paging; log queries pin that HEAD.
  History errors surface separately from empty. Blame renders 200 lines/page and long View text
  renders 64k characters/page. Their underlying requested document/blame still loads in full.
- Brain reads/writes return SHA-256 digests. Optional final `Brain.write`/`brainWrite` options
  preserve legacy callers; explicit null means create-only, a digest means compare-and-swap,
  omitted means legacy write. Comparison runs under the existing repository lock. Panel PUT
  requires digest/null and returns 409 on conflict. Editor preserves dirty text across refresh,
  shows the latest saved text for merging, updates its saved baseline and warns on link/unload.
- Added note creation and typed project fact/decision creation with Markdown preview. Added a
  Memory & preferences tab and typed-memory endpoint for project/global user preferences,
  project facts/decisions/lessons, revisions, source/author visibility and preference revocation.
  Global inference remains in the existing promotion workflow. Typed memory bypasses the raw
  editor and is saved through `MemoryPreferences` with CAS and request-bound authorization.
- Preference mutations require the panel's auth/origin protection plus a direct same-origin
  Origin. The server creates a private, short-lived operation/ID/scope/exact-body capability;
  request fields cannot supply actor/authorization. Attribution is `panel-user`, role `human`,
  for an actual panel operator request, rather than relabeling an AI CLI action.

Files: project Brain page/loading; Brain document/catalog/search/history/memory APIs;
`components/client/brain.tsx`, new `brain-memory.tsx`; `admin/brain-catalog.ts`,
`admin/brain-entities.ts`, reserved Brain wrappers/exports in `admin/insights.ts`;
`brain/brain.ts`; `tests/brain-catalog.test.ts`, `tests/brain-performance.test.ts`.
Shared public memory exports, access and memory services are owned by the supervisor/P4 worker.

## Commands run and observed results

- `pnpm exec vitest run tests/brain-catalog.test.ts` passed 2 tests: scope-before-limit,
  disjoint metadata pages, no unchanged body reads, stale-write/create conflicts. Later added
  generation/cursor invalidation assertions passed in the selected run below.
- Initial selected privacy/core/index/benchmark run passed **28 tests in 4 files**. It covered
  all 15 existing project/mount/rename privacy tests and 10 existing Brain tests.
- A later selected run passed 26/28 while P4 briefly widened legacy facts read grants. Both
  failures were existing ACL expectations; P4 removed that widening. Rerun on the frozen tree
  is required. This worker did not weaken those tests. Latest cache/UI changes were not in
  the earlier all-green run.
- Router source-inclusive `tsc --noEmit` reported parallel delivery-tools/supervisor
  `cfg.project` and supervisor-quality test errors; no Brain errors. A temporary panel config
  resolving directly to router source produced known Next NODE_ENV augmentation conflicts;
  removed it. Normal built-library panel typecheck remains required.
- `git diff --check` passed for owned source. Every fixture uses `makeEnv()` temporary paths
  and is cleaned by its afterEach. The opt-in benchmark is enabled with
  `$env:MERITROUTER_BRAIN_BENCH='1'; pnpm exec vitest run tests/brain-performance.test.ts`.

Measured Windows, Node v22.11.0, 10,000 Markdown files/three projects (3,334 in the selected
project), local temporary storage. Service-layer measurements, **not production navigation**:

| Measurement | Samples | p50 ms | p95 ms | max ms |
| --- | ---: | ---: | ---: | ---: |
| Warm 50-row catalog | 30 | 0.285 | 0.390 | 0.454 |
| Warm scoped search | 30 | 3.326 | 4.519 | 4.557 |
| New Brain instance, existing index | 5 | 259.772 | 318.867 | 318.867 |

Initial owned-scope indexing took **3,928 ms** in that run. A preceding run measured 3,035 ms,
catalog p95 0.401 ms, search p95 4.524 ms, new-instance p95 259.97 ms. The original 57.3-second
initialization outlier was diagnosed and fixed as described above. Do not claim a controlled
baseline speedup from those repeated source-evolving runs. Final cooperative-yield changes and
production navigation require remeasurement.

## Not verified

Production page/API build and screenshots, interactive create/edit/CAS/global preference/revoke,
injection after revocation, mobile/keyboard flow and >=30 production latency samples are pending.
No paid/live provider or original clone run was used. Compilation alone is not product acceptance.

## Open questions or contradictions found

- Cold initial indexing is still above the proposed two-second complete-view target. Warm
  service timings are strong; loading/cooperative yielding must be checked in a production UI.
- History pages pin their cache revision internally, but the next-page URL is offset-based
  and does not yet bind HEAD; a concurrent commit can shift page boundaries. Scope masking
  remains enforced. Add a revision-bound cursor before claiming stable history paging.
- Blame obtains complete underlying attribution; rendering is bounded, but the attribution
  subprocess itself still needs a deadline/range seam. Ten-second history deadlines alone do
  not establish a total end-to-end provenance deadline.
- Typed global preference management currently uses the project's Memory tab. A standalone
  global management route independent of an active project is not implemented in this slice.
- External-edit freshness is a five-second reconciliation window; no filesystem watcher or
  automatic periodic background indexer is claimed. Browser-back draft retention needs review.
