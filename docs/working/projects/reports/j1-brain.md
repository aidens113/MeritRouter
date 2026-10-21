# Report: j1-brain (projects plan, phase J1)

Worker report for the brief "j1-brain" in [projects.md](../../projects.md). Worktree
`D:/sy-wt/pj`, branch `feat/projects`. Nothing committed.

## Outcome

Done. Typecheck, build, and the full suite (429 tests) pass.
- **D4.** A supervisor reads `projects/<own>/**` and `global/**` and writes its own project.
- **D9.** Promotion to `global/` is gated in code: supervisors only, a deterministic check, an
  independent reviewer through a review task and the Gate, rejection into the project with the
  reason, provenance, and optional human approval.
- **Search.** Brain search is restricted in SQL to what the caller's grants can reach.

## What changed and why

### `src/brain/access.ts`
- The default supervisor grants are now `global/**` read and `projects/{project}/**` write. They
  were `**` read.
- New `systemManaged(path)`: true for `global/**` and `projects/*/promotions/**`.
  - `allows()` refuses every non-read mode on these paths for every agent principal. That covers
    default grants, `roles.<role>.brain_grants` (even `**` admin), brief grants, and approved
    requests.
  - `denial()` gives a specific message for these paths.
  - `BrainAccess.request()` refuses a non-read request on them before it is filed.
  - Humans are unaffected.
- Worker grants are unchanged. Cross-project reads use the existing request flow, which is
  tested.

### `src/brain/promotion.ts` (new)
The D9 workflow:
- `projectSpecificIssues(candidate, scope, io)`: the deterministic check (rules below).
- `candidateDigest`: what a verdict is bound to.
- The reviewer port types: `PromotionReviewPort`, `PromotionReviewRequest`, and `PromotionReviewResult`.
- `PromotionRecordSchema`: zod, validates every record read back.
- `GlobalPromotions`:
  - public methods: `promote`, `list`, `get`, `settle`, `approve`, and `reject`;
  - operations run one at a time per instance;
  - every record transition is compare-and-set under the brain's repository lock.

### `src/brain/brain.ts`
- The constructor takes an optional 4th argument, `{ reviewer }`: a port or a function that returns
  one, so the service can build the reviewer after its brains.
- New `brain.promotions` (`GlobalPromotions`, bound to the private `writeFile`) and
  `brain.scope()` (slug, name, repositories).
- `promoteLesson(p, actor, title, body, sources)` keeps its signature but now returns
  `PromotionOutcome { id, status, path, commit, reason, issues }`. The old return type was
  `{ path, commit }`; `path` is still present, so `mcp.ts` compiles unchanged.
- `search()`:
  - For an agent, the FTS query gets `AND (path LIKE <prefix>% OR ...)`. The prefixes are the
    literal directory prefixes of the principal's grants, and a `**` grant means no restriction.
  - Results are still checked with `denial()` afterwards.
  - New `scope: "project"` for people: this project, `global/`, and root files. The default for
    people stays "all", which the admin panel uses today.
- `refreshIndex()` is scoped per project. Each project's brain indexes and prunes only its own
  `projects/<own>/` folder, `global/`, and the root, and leaves other projects' rows alone.
  Without this, project A's refresh deleted project B's mount-backed rows, because A cannot see
  B's mounts. The FTS table is unchanged; there was no migration and no project column, and the
  path prefix does the filtering.

### `src/verification/promotion-review.ts` (new)
`PromotionReviewer` implements the port. It runs like the audit:
- One task per review, with purpose `promotion_review` and label `promotion-review`.
- The task type is the first configured completion type: `review`, else `summarize`. A
  read-only type would need a repository alias.
- The task is pinned with `routing.endpointId` to the chosen reviewer, has importance low, and
  has `budget { maxModelRequests: 4, maxPaidUsd: 0 }`. It is submitted in the promoting project.

So the review's requests go through the scheduler, admission, and the Gate.

How the reviewer is chosen:
- `router.planReviewer` runs with `avoidEndpoints` set to every endpoint the supervisor's task
  was served by, plus its model when that is a catalog endpoint, and `avoidFamilies` set to
  those endpoints' families plus `modelFamily(actor.model)`. For MCP that is `claude-code`,
  family `claude`.
- Candidates are then hard-filtered: free (`origin !== "paid"`), not an avoided endpoint, and
  not in an avoided family. `planReviewer` alone only ranks other families first.
- No candidate means `unavailable`, and the promotion is held as pending.

How the verdict is checked:
- `result()` re-checks independence against the served endpoint.
- The verdict object is validated with the existing `validateVerdict` against the rubric ids,
  the digest, and the rubric version.
- The evidence is rendered with the existing `renderEvidencePackage`.

### `src/harness/tools.ts`
`brain_promote_lesson` (the supervisor's tool):
- `sources` is now required.
- The description states the rules.
- The result reports `approved`, `rejected` (with the reason and where the lesson was kept), or
  pending.

**Deviation:** this tool lives in `tools.ts`, not in `supervisor-tools.ts` (the brief named the
latter). `supervisor-tools.ts` has no promotion tool and was not edited.

### `src/config/schema.ts`
**Deviation:** I added one field, `brain.global_requires_approval: boolean`, default false. This
file is outside my owned paths, but the brief requires the field and `BrainConfigSchema` is
strict.

### `src/core/service.ts`
Separate small hunks:
- imports;
- a `promotionReviewer` field, built after the auditor;
- the brains get `{ reviewer: () => this.promotionReviewer }`;
- a `settled` listener: when a task of purpose `promotion_review` settles, it calls
  `settlePromotions(project)` on a `setTimeout(0)`;
- new methods `promotions()`, `settlePromotions()`, and `decidePromotion()` (API below).

### `src/index.ts`
One hunk:
- `PROMOTION_RUBRIC`, `PROMOTION_RUBRIC_VERSION`, and `PromotionReviewer`;
- `GlobalPromotions`, `PROMOTION_STATUSES`, `projectSpecificIssues`, and the promotion types;
- `systemManaged`.

### `tests/projects-brain.test.ts` (new, 7 tests, temp brains)
1. **Isolation (D4).** A supervisor of alpha cannot read, list, write, or search beta's working
   document, and reads its own project and `global/`. Each project's search returns only its own
   hits. Alpha's index refresh leaves beta's rows alone. People see both, or one project with
   `scope: "project"`. A worker's cross-project read request, once approved, reads and searches
   the beta entry.
2. **No writes to `global/`.** A worker with `**` and `global/**` write brief grants, a
   supervisor, and a role configured with `**` admin all fail to write `global/`. A worker's
   promotion is refused. A write request for `global/**` is refused. A supervisor cannot forge a
   promotion record.
3. **Project-specific lesson.** A lesson naming the project's name and a file in its repository
   is rejected before any review is spent. It is saved to
   `projects/alpha/decisions/lessons/ledger-double-charges.md` with the reason and provenance,
   and the record is `rejected`. The slug and an alias are each refused, and so are missing,
   out-of-project, and global-only sources.
4. **Generic lesson, fake passing reviewer (port).** The record is `pending_review`. The reviewer
   gets the sources' text. After `settle` the lesson is approved into
   `global/lessons/retry-idempotent-calls-with-jittered-backoff.md`, and its front matter holds
   the project, supervisor, supervisor model, sources, and review (verdict, reviewer endpoint,
   reviewer model, review task, rubric). A second settle does nothing. A failing reviewer sends
   another lesson to the project with the reviewer's reasons.
5. **Approval flag.** With `brain.global_requires_approval: true` the promotion becomes
   `pending_approval`, and nothing is written to `global/`. A supervisor cannot approve it; a
   person can, and `approved_by` is recorded.
6. **No eligible reviewer.** The catalog has only the supervisor's family, through the real
   `Switchyard`. The promotion is `pending_review` with "no eligible reviewer ... (alpha)". No
   review task exists, and `settlePromotions` changes nothing. `sy.promotions` lists it.
   `decidePromotion` by a person approves it.
7. **End to end through the Gate.** `Switchyard` runs with the worker and a `ScriptedClient`. The
   review task runs on `groq/beta/beta-2`, the other family, and is the only provider request.
   Its project is `alpha`, its purpose `promotion_review`, its type `summarize`, pinned and
   `maxPaidUsd: 0`. The requests are charged to the review task. When it settles, the promotion
   is approved with the reviewer in the front matter.

## D9 check rules (deterministic, `projectSpecificIssues`)

Over the title and body (case-insensitive):
- The project slug, the project name, and every repository alias of the project, as a whole
  word. The boundary is any non-alphanumeric character, so `my-app` contains `app`.
- Every repository's absolute path, with slashes normalised.
- Every path-like token (at least one `/` or `\` between name characters), with leading `./`
  removed. A token that is relative and without `..` is rejected if it exists inside any of the
  project's repositories, for example `src/payments/ledger.ts`.
- The title and body must be present; the title is at most 200 characters and the body at most
  20000.

Sources:
- At least one and at most 20.
- Each must be under `projects/<own>/` or `global/` and must exist in the brain.
- At least one must be an existing path under `projects/<own>/`.

People (`kind: "human"`) skip the gates and write to `global/` directly with provenance
(`approved_by` is the person).

## D9 rubric (`PROMOTION_RUBRIC`, version `global-lesson-rubric-1`)

Every criterion must pass:
- `beyond_project`: it holds unchanged for other codebases, teams, and domains.
- `no_project_detail`: it names nothing specific to one project (products, people, customers,
  repositories, paths, services, identifiers, internal terms) and does not depend on one
  project's architecture or configuration.
- `actionable`: it is a concrete, reusable practice, rule, or fact, not a status report or a
  one-off observation.
- `supported`: the cited sources support it.

## Decision rules

The reviewer submits the standard verdict object with `examinedRevision` set to the candidate
digest, `policyVersion` set to the rubric version, and `"inline"` as evidence references.
- **pass:** approved, or `pending_approval` when the approval flag is on.
- **fail:** rejected; the lesson goes to the project with the reviewer's reasons.
- **inconclusive, invalid, or a failed review task:** stays `pending_review` and another review
  is tried. After `MAX_PROMOTION_REVIEWS` (3) started reviews, a person decides.

## Pending-promotion API (for j1-surfaces and J2)

Records are files at `projects/<p>/promotions/<id>.md`: YAML front matter validated by
`PromotionRecordSchema`, then the lesson. Agents cannot write them.

The fields are `id`, `project`, `title`, `status` (`pending_review | pending_approval | approved |
rejected`), `sources`, `digest`, `supervisor`, `created_at`, `review`, `reason`, `decided_by`,
`decided_at`, `global_path`, and `lesson_path`:
- `supervisor` is `{ agent, model, task, job }`;
- `review` is `{ attempts, task_id, reviewer, reviewer_model, verdict, reasons, rubric }`.

```ts
// Switchyard
promotions(opts?: { project?: string; status?: PromotionStatus }): PromotionRecord[]   // newest first
settlePromotions(project?: string): Promise<number>          // collect reviews, retry waiting ones
decidePromotion(project: string, id: string, approve: boolean, by: string, reason?: string): Promise<PromotionRecord>
readonly promotionReviewer: PromotionReviewer
// Brain (per project)
brain.promotions.list({ status? }) / get(id) / settle() / approve(human, id, note?) / reject(human, id, reason)
brain.promoteLesson(p, actor, title, body, sources): Promise<PromotionOutcome>
brain.search(p, q, { prefix?, limit?, scope?: "project" | "all" })
```

A rejection needs a reason. `approve` and `reject` refuse agent principals. A global lesson's
front matter names its `promotion` id, so a revert (D9(d), J2) can find the record.

## Commands run and observed results

- `npx tsc --noEmit -p .` (router): clean, several times while working.
- `npx vitest run tests/brain.test.ts tests/mcp.test.ts tests/supervisor.test.ts`: 12 passed
  (after the D4 and access changes).
- `npx vitest run tests/projects-brain.test.ts`: "Tests 7 passed (7)".
- Mutation check: with the `systemManaged` refusal in `allows()` removed, "no grant lets an agent
  write global/" failed. The file was restored from a copy, and grep confirmed the marker was gone.
- `pnpm -r typecheck`: router Done, panel Done.
- `pnpm -r build`: router Done, panel Done.
- Full suite (`cd packages/router && npx vitest run`), with the other two workers' files in the
  tree: "Test Files 43 passed (43) / Tests 429 passed (429)", exit 0. The baseline was 404; the
  rest are mine (7) and the other workers'. No timing test flaked.

## Problems found and fixed while working

- **Review task was refused at submit.** A `review` task type in `read_only` mode is refused
  without a repository alias ("profile review needs at least one repository alias"). Promotion
  reviews now use a completion type.
- **Endless review loop in my first version.**
  - What happened: the promotion's review task settled so fast with the scripted provider that
    the `settled` handler ran before the promotion had recorded its review task id. It started
    another review, and so on, entirely in microtasks, so timers and git I/O starved and the run
    hung (1488 requests in 2 minutes).
  - Fix: operations of one `GlobalPromotions` run one at a time, the `settled` handler defers to
    `setTimeout(0)`, and the status checks prevent a duplicate review.
  - After the fix, one review request per promotion was observed.

## Not verified

- No live provider or real supervisor job promoted a lesson. In tests 1 to 6 the supervisor is a
  principal built in the test. The end-to-end test uses an MCP-like principal (no task, named
  model). For a runtime supervisor, the "served endpoints of its task" path (`actor.task`)
  appears only in the code and has no test.
- A cross-process race: two processes settling the same promotion. Transitions are
  compare-and-set under the brain lock file, but a second process could start a duplicate review
  task before the first records its id. This was not exercised.
- Brain repositories mounted elsewhere for `projects/<p>/promotions` or `decisions/lessons`
  (should work through `resolve()`; not tested).
- The panel, CLI, and MCP do not show promotions yet; that is j1-surfaces and J2. MCP's
  `brain_promote_lesson` now goes through the gates automatically (via `sy.brainFor(...)`), but
  its result shape changed (it is still JSON).

## Open questions or contradictions found

1. **Brain index file.** `README.md` at the brain root lists every project's working documents,
   but the narrowed supervisor grants no longer allow reading it. The MCP `brain_list` description
   still mentions it. Options: a per-project index (`projects/<p>/README.md`), or a filtered
   read. I left both unchanged.
2. **Panel search scope.** `admin/insights.ts` searches with a human principal and the default
   scope "all". j1-surfaces or J2 should pass `scope: "project"` for the per-project brain page
   and refresh each project's brain (`sy.brainFor(p).refreshIndex()`), because each brain now
   indexes only its own folder.
3. **Common-word aliases.** Aliases such as `app` or `core` match as whole words, so a lesson
   that says "the app" is rejected. That follows the D9 wording, is conservative, and the
   rejection is kept in the project with the matched term. The supervisor may want a narrower
   rule.
4. **Docs.** `docs/roles.md` and `docs/decisions.md` do not yet describe D4 and D9 in code. That
   is supervisor work (I own no docs).
