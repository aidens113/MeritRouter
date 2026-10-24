# Report: brain-panel

## Outcome

Done: source-grounded planning for the user-reported slow and incomplete Brain page. Only this
report changed. No private Brain, service, project configuration or runtime data was touched.
Actual latency was not measured; the user-reported navigation delay remains a credible symptom,
and the expensive paths below are verified source behavior rather than measured root causes.

## What changed and why

### Initial navigation and refresh path

1. `/brain` redirects to the last project's `/p/<slug>/brain`. The project layout and page obtain
   the shared panel `MeritRouter` instance through `lib/sy.ts`; cold creation loads config/DB and
   starts repository preparation asynchronously. This possible cold-start cost is not isolated.
2. Brain page is `force-dynamic`. Before returning its page tree it loads an agent inventory
   (limit 2,000), calls `insights.brainTree(sy, '', project)`, reads all access requests and loads
   all project promotion records. These happen even for requests/promotions-only views.
3. `brainTree` awaits ensure then calls `Brain.list(HUMAN, '')`. `Brain.list` recursively performs
   synchronous `readdirSync`, `statSync`, `readFileSync` and Markdown parsing for every document
   it visits, including the shared Brain. The page filters to project/global paths afterwards.
   A folded report group still creates all server-rendered document links; folding is not lazy
   loading, pagination or virtualization.
4. Default selected document is the project index (or root/first document). `DocPanel` reads its
   full content synchronously and eagerly awaits `brainDocumentHistory`, then
   `brainDocumentRelated` before rendering any tab, including View and Edit.
5. `brainDocumentHistory` walks full rename history with `git log --follow` without an initial
   count bound, only then slices 50 entries and runs a bounded whole-commit path inventory.
   Scope masking is intentional and must be preserved.
6. `brainDocumentRelated` invokes `brainDocumentBlame`, which walks document history again,
   invokes Git blame and commit attribution, and performs per-line/per-ID project lookups.
   Thus View pays for blame it does not display. Selecting Blame runs it again for the visible
   table. History/related are sequential independent waits in the page.
7. Git subprocesses use asynchronous execFile, not synchronous exec. Their result parsing and
   filesystem traversal are synchronous. Current generic `workspaces/git.ts` has a byte cap but
   no timeout/signal option, so a slow Git request can stall a section without a deadline.
8. Page subscribes to `brain`, `tasks`, and `sessions`. `client/live.tsx` coalesces events but
   calls whole-page `router.refresh()` up to roughly once a second under active work. That can
   repeatedly rerun all of the above for irrelevant task/session changes. Mutation success
   also refreshes the page. No Brain-specific loading boundary appears in the source file list.

### Search correctness and loading issue

`insights.brainSearch` calls `refreshIndex()` on every search. That scans indexed metadata,
then calls full synchronous `Brain.list(HUMAN)` (reading/parsing every file even unchanged),
then stats and indexes changed files. The page has already loaded the full tree first.

It subsequently calls `brain.search(HUMAN, query, {limit:30})` without project scope, then the
page filters results to the current project/global. Other-project hits can occupy the top 30
before filtering, hiding available in-scope matches. This is a source-verifiable correctness
hazard, not proof of a privacy disclosure: hidden results are not rendered. Scope must be part
of the query before ranking/count/limit, not a presentation-only filter.

### Existing functionality and actual gaps

Already present: grouped project/global document browse; full-text search; view/edit of existing
Markdown; inline protocol errors; Git history, scoped commit diffs and blame; attribution links;
access decisions; project promotion status. Global Knowledge separately supports human
approve/reject/revert and renders glossary/lessons. Do not describe the whole feature as absent.

Missing or incomplete for the requested memory workflow:

- No first-class create-document/create-project-memory UI on Brain, despite empty-state text
  suggesting documents can be edited there. Existing PUT can write new files but has no creation
  flow. No typed user preference create/edit/scope/revoke or memory injection preview exists.
- No paginated folder tree, folder counts on demand, kind/status/active-vs-archive filters,
  paginated search/history/blame or bounded long-document rendering. Current search tops out
  at 30; history at 50 after an unbounded walk. Access lists are bounded in service but have no
  cursor/navigation for older records. Promotion enumeration reads Markdown records eagerly.
- No explicit conflict detection in editor: sends only project/path/content, no expected digest.
  User can overwrite a changed ordinary note; protocol append-only protection is not general CAS.
  Editor `text` state is initialized once while dirty compares refreshed `initial`; server refresh
  while editing needs explicit reconciliation rather than stale/dirty ambiguity.
- Project Promotions sends users to a separate Global Knowledge screen for decisions. Global
  documents open through an arbitrary live project's Brain page, which is confusing and fails
  to provide a standalone global editor/view when no project is available.
- History failures are often caught and returned as empty lists. UI can say no history/empty
  file when the operation actually failed. Distinguish unavailable, timeout, untracked and empty.
- No clear index freshness, memory authority/type/provenance, supersession or per-role injected
  context preview. These should integrate with the memory contracts in memory-acceptance.md.

### Proposed design and exact partitions

P1: Measure and unblock first render (small coherent first implementation).

- Add request-scoped timing spans/counters for initial shell, tree metadata, selected read,
  promotions/access counts, history, blame, Markdown render and total; record cold/warm, index
  generation, document count and Git invocation count without recording private content.
- Remove eager history/blame/related from View/Edit critical path. Load selected tab only;
  stream optional related attribution through a separate boundary and deduplicate its work.
- Requests/Promotions views load their own data plus cheap counts, not a document tree.
- Add `loading.tsx` and section skeleton/error boundaries; page navigation should paint a useful
  shell promptly even if Git history is slow. Time out optional sections without losing editor.
- Narrow live updates to relevant project/document/index generations. Task/session changes must
  not invalidate static document text/history unless they changed its content/provenance.

P1 files: `app/p/[slug]/brain/page.tsx`, new scoped `loading.tsx`, Brain view components split
by concern under `components/brain/` (browser/document/history/blame/editor),
`admin/brain-entities.ts`, `admin/insights.ts`, and scoped event topic consumers. Do not extract
into an adjacent catch-all file; the current large page combines unrelated view loading.

P2: Indexed scoped browse and search API.

- Add `brain/catalog.ts` for paginated indexed metadata operations, with explicit project/global
  visibility predicates before limit/order/count. Existing `brain_files`/FTS can support this;
  append migrations for needed scope/generation metadata, never rewrite old migrations.
- Add bounded read/search/history endpoints through public `admin/insights.ts` exports. Example
  contracts: GET `/api/brain/catalog?project=&prefix=&cursor=&limit=50`; GET
  `/api/brain/document?project=&path=&section=`; GET `/api/brain/search?project=&q=&cursor=`;
  GET scoped history/blame with opaque cursor/range. Zod validate every input/output/cursor.
- Read initial tree from indexed metadata, not reading document contents. Refresh catalog in
  background on events plus periodic external-edit reconciliation; deduplicate simultaneous
  refreshes and batch DB updates. Filesystem stat remains necessary for external changes, but
  walking/parsing all files must not be on every page/search request. Show index freshness and
  offer explicit refresh. Scope traversal to own project/global and configured mounts.
- Directory paging loads expanded groups only. Stable ordering/cursors include generation;
  return stale-cursor recovery instead of silently skipping/duplicating changed entries.
- Search applies scope and ACL before FTS ranking/limit and provides next cursor/total semantics.
  Test many higher-ranked foreign matches so an in-project match is still discoverable.

P2 files: new `brain/catalog.ts`, `admin/brain-catalog.ts` re-exported through insights/public
index; extend `brain/brain.ts` index write/reconciliation; append `storage/migrations.ts` only
as necessary; new explicit Brain read/catalog/search/history route files; browser components.
Shared migration/config/public exports are serial integration work, not overlapping workers.

P3: Versioned caches and bounded provenance.

- Cache selected documents by project+canonical path+content digest; cache history/blame by
  project+mount identity+Git head+document identity. Scope is always part of key. Use bounded LRU,
  in-flight deduplication and explicit invalidation after writes/promotions/reverts/mount/config
  changes; handle external Git edits with generation refresh. Never share raw human-wide payloads
  into project caches then filter afterwards.
- Paginate rename-aware history without breaking the existing visibility boundary: cursor tracks
  revision and historical visible path, with a bounded batch per request. Privacy masking and
  generic subjects remain mandatory if full-commit scope cannot be established.
- Add timeout/signal support to Git with careful owned-process cleanup; use optional bounded
  provenance deadlines rather than indefinite request waits. Blame line ranges and attribution
  lookups should be batched/cached; retain exact provenance even if rendering is paginated.

P3 files: `admin/brain-entities.ts`, `brain/mount-git.ts`, `attribution/index.ts`,
`workspaces/git.ts`, new specifically named `admin/brain-cache.ts` if separate concern merits it,
history/blame API/view components. Generic Git changes require full affected regression checks.

P4: Complete memory management.

- Create typed project decision/fact/note and authorized user preference; preview rendered
  Markdown and protocol requirements; versioned save with expected digest returns 409 conflict
  and explicit diff/reload/merge actions. Dirty edits survive live updates and navigation warns
  before discard. Save updates the baseline correctly without resetting unsaved text silently.
- Explicit Project/Global scope selector with real standalone global routes. Keep global
  preferences separate from inferred lesson promotions; show source authorization, actor,
  supersession/revocation and project exceptions. No "human" attribution for AI-origin actions.
- Integrate promotion/access inbox counts/actions and injection-manifest preview without loading
  every item. Global Knowledge remains available independent of any arbitrary active project.

P4 files: Brain APIs/editor/browser and global Knowledge route/components; memory schema,
authority and service APIs from memory-acceptance.md first. Ordinary edits must preserve working
doc/worker report protocol and global promotion gates. Human deletion/reversion requires explicit
visible scope/reason and retained history, not filesystem deletion shortcuts.

### Validation and proposed performance gates

No baseline figures were measured in this planning pass. These are proposed acceptance budgets,
to be calibrated transparently on recorded hardware using production builds, not invented results.

Fixture matrix: temporary/demo Brain with 100, 1,000 and 10,000 Markdown entries across at least
three projects, 1,000 revisions of one document, mount-backed docs, 1 MB long doc, many foreign
high-ranking search hits, external edits and an actively changing task/session stream. Preserve
real user data; clean only owned fixture artifacts. Record Windows/Unix and warm/cold separately.

- For warm local production fixture: shell/action feedback within 200 ms; scoped first metadata
  page and selected short document p95 under 500 ms; indexed search p95 under 300 ms; first
  requested history page p95 under 1 second. Cold first-use shell should still stream within
  500 ms while initialization is separately visible; full initial bounded document view target
  under 2 seconds. Report p50/p95/max over >=30 warm repetitions and 5 cold samples.
- Architectural hard gates independent of hardware: View/Edit performs zero blame/history Git
  calls before optional attribution request; requests/promotions-only view performs no full
  document scan; warm unchanged browse/search reads no unrelated document bodies; single page
  returns <=100 metadata rows and <=200 KB initial data excluding a requested document chunk.
- Under unrelated task/session events, selected Brain view performs no redundant full tree or
  Git rebuild; <=1 relevant in-flight refresh per resource, cancellation handles superseded
  searches/navigation, and typing never loses text. Avoid multiplying work with link prefetch.
- Correctness: scope-before-limit search; cursor stability; save CAS races; create/edit/global
  preference/revoke journey; no project/global cache bleed; mount/rename privacy regression;
  invalidation after API and external writes; timeout/error distinct from empty; keyboard/mobile
  browse/search/edit/access/promotions flows and real screenshot inspection.
- Use temp fake Git adapters/counters for deterministic no-work assertions, plus actual Git
  fixture timings. Broad typecheck/router tests/build plus demo production page/API/headless
  validation remain required for implementation. A loading spinner alone does not pass the
  performance gate if expensive work remains unchanged.

## Commands run and observed results

Read-only `Get-Content` and `rg` inspected scoped Brain page, legacy redirect, editor/API,
global Knowledge UI/actions, live refresh controller, admin insights/brain entities/promotions,
Brain indexing/list implementation and Git/attribution functions. Confirmed eager dependency
calls and synchronous full traversal directly in source. Some guessed paths and PowerShell
wildcard paths failed; corrected scoped files used `-LiteralPath`. No benchmark, build, test,
live navigation or private Brain mutation performed. Documentation diff checking only.

## Not verified

No measured navigation latency, profiling flame graph, cold-start attribution, index size or
cache improvement. The exact dominant delay on the user's installation remains to reproduce
with permitted read-only timing/isolated fixture profiling. No code fix or new UI implemented.

## Open questions or contradictions found

Current Brain has more functions than its apparent usability suggests, but it eagerly pays for
unselected functionality and lacks direct creation/preferences workflows. Performance and
completeness need separate acceptance gates. Existing scope-safe rename/history behavior must
survive pagination/cache optimization; deleting it for speed would regress privacy. No user
decision blocks the proposed phased plan.
