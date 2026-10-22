# Panel v2: live data and a calmer layout

Status: Complete
Status detail: U1-U3 and completion follow-up accepted; 622 tests, production demo browser checks and repaired seed pass (2026-10-22).
Created: 2026-10-21
Last updated: 2026-10-22
Owner: Senior supervisor agent
Scope: Push changes to the panel as they happen instead of re-rendering on a timer, and
restructure pages so they show summaries first and details behind tabs and disclosures.
Paired document: none
Related: [budget-control](./budget-control.md), [labs](./labs.md), [projects](./projects.md)

---

## Current State

**Complete (2026-10-22):** U1-U3 and the reopened completion audit are implemented and
independently validated. Scoped live events, pause/reconnect, tabs/disclosures, entity pages,
Activity agents, plan/team/timeline links, brain commit/history/blame navigation and Related
panels are delivered. Brain history follows renames and copies only within visible scope;
private ancestry and mixed-commit metadata are withheld, safe subjects retained.

**Additional fixes:** shared-project brain initialization uses the same lock as writes;
shutdown drains active promotion settlement before database closure. Demo task grants and final
scripted turns now produce the intended nested integrations instead of fixture warnings.
Supervisor recovery annotations require later matching changes by the recorded supervisor on
the recorded job branch, while preserving failed task/acceptance states and explaining the
limits of that evidence. Transcript detail stays within two clicks; phone blame scrolls.

**Acceptance:** recursive typecheck/build passed; full router suite 622/622 in 63 files
(308.77 s); fresh demo seed exited 0 without fixture warnings. Production demo crawl: 581
checks, no failures. Forty legacy anchor checks passed. Independently inserted task/request/
brain changes reached the browser in 905/735/1222 ms without reload; quiet pages made zero
refreshes over 2500 ms. Earlier pause/resume/restart checks remain valid. Sixty-four full-page
and 28 focused viewport captures plus four final blame captures had no document overflow or
browser exceptions; representative changed sections were visually inspected. B2 acceptance
also passed (see budget-control.md). Evidence: [supervisor validation](panel-v2/reports/validation.md).

**Retention review:** nine dense baseline pages preserve section titles and IDs; dynamic
settings schemas/renderers are unchanged. All section/hash groups select their owning tabs.
Old settings tab=form lands on General; its former sections remain one tab click away and old
hashes select the intended section. Arbitrary model prose and raw tool JSON remain escaped
content, rather than guessed entity links.

**Limits:** large-store watcher performance is unbenchmarked; fingerprints scan mutable rows
following writes and some inactive tab data remains eager. Agent requests cover 60 session logs;
repository/agent commit lists are bounded. Archived routes require unarchiving. Shared-brain
commit views expose only a selected visible document, not whole shared-repository metadata.
No real providers, paid quota, or user-install tests were used. Labs, parked R2, packaging and
live-provider follow-ups are separate efforts, not claims of this completion.

**Integration:** implementation checkpoint 57f3d49; final acceptance/layout documentation commit
and dev/main merge are recorded in the ledger and Git refs. Temporary services are stopped at
session completion; generated fixtures and evidence remain untracked.

---
## Decisions (recommended defaults; the user may override)

- **D1. Changes are pushed.** A Server-Sent Events route (`/api/live`, scoped to a project or `all`)
  watches the store cheaply on the server (about once a second: the newest event id, newest model
  request and its settle state, task and session update times, the brain's head) and sends a small
  "changed: topics" message only when something changed, with a resume cursor. One connection per
  tab; reconnects with backoff; heartbeats keep proxies open.
- **D2. Pages subscribe to topics.** A client `LiveProvider` holds the connection; a page (or a
  section) declares the topics it shows (`tasks`, `jobs:<id>`, `requests`, `sessions:<id>`, `brain`,
  `keys`, `web`...) and refreshes only when one of them changes (debounced to at most about once a
  second, server components re-rendered in place: no full reload, scroll and open disclosures
  kept). Hot widgets (a running session's timeline, the request log's newest rows) may fetch JSON
  directly. The header shows connection state (live / reconnecting / paused); the pause control stays.
- **D3. Summaries first.** Each page opens with what a person needs in five seconds (status,
  what needs them, the key numbers) and at most a few sections; everything else moves behind:
  - **tabs** (URL-addressable, `?tab=`), e.g. a job: Overview, Plan, Team, Changes, Checks,
    Channel, Sessions; a task: Result, Verification, Routing, Usage, Sessions; the project overview:
    Overview, Activity, Usage; the install dashboard: Projects, Activity, Usage, Health;
  - **disclosures** for detail inside a tab (provenance, raw JSON, long lists beyond the first
    five or ten rows with "show all");
  - **fewer top-level tabs** where sections overlap: merge or nest them (the worker proposes the
    map in its report before restructuring, and follows it).
- **D4. Consistency:** one page-header pattern (title, one-line purpose, actions, live state),
  one tab component, one disclosure component, one empty state; phone layouts first-class.
- **D6. Entity pages and links (user request 2026-10-21: "when I click on a task it should take me
  to that task's page, with links to related things like the agent page, which shows the tasks
  that agent did").** Every entity has its own page under its project with a stable URL: task,
  job, session, agent, model, request, brain document, commit, repository. An **agent** is the
  attribution identity (`<role>:<label>`, e.g. `implementer:posts`, `supervisor:<job>`): its page
  lists the tasks it worked on, its sessions, the models it used, the lines it wrote (from
  attribution), its requests and spend, and its parent job and supervisor. Each entity page has a
  "Related" panel linking everything connected (a task: its job, agents, sessions, models,
  requests, commits, brain reports; a model: the tasks and agents that used it; and so on).
  Lists show summaries and link to entity pages instead of expanding detail inline. Every place an
  entity is named (tables, timelines, plan nodes, channel posts, blame lines) is a link.
- **D5. Nothing is lost:** every datum shown today stays reachable in at most two clicks; links into
  old anchors keep working (`#id` sections map to the tab that holds them).

---

## Phases

| Phase | Deliverable | Acceptance |
| --- | --- | --- |
| U1 | Live data: `/api/live` SSE with topics and cursor, `LiveProvider`, topic subscriptions on every page that auto-refreshed, connection state in the header, pause kept; `AutoRefresh` polling removed | A change in the store (a task state, a new request, a brain commit) reaches an open page within ~2 s without a reload (verified on the demo with a script that writes to the store while headless Chrome watches the DOM); no request when nothing changes; reconnect after the server restarts |
| U3 | Entity pages and links (D6): agent pages (new), commit and repository pages, a Related panel on every entity page, entity names linked everywhere | Demo seed: from a task page reach its job, agent, session, model, request, and commit in one click each; an agent page lists that agent's tasks, sessions, models, lines written, and requests; screenshots |
| U2 | Layout: the information-architecture map (in the report), tabs and disclosures on the dense pages (job, task, session, project overview, install dashboard, models, keys, settings), shared components, phone layouts | Every touched page 200; screenshots before and after at desktop and phone widths, light and dark; each page's first view shows at most about five sections; deep links to old anchors land on the right tab |

---

## Worker Briefs

### Brief: panel-v2
- Repository: this repository; your own worktree on branch `feat/panel-v2`; run
  `pnpm install --frozen-lockfile` first. Another worker changes the router at the same time.
- Task: U1, then U2 and U3 (U3 added 2026-10-21), as the Decisions describe. For U2, first write the information-architecture
  map (page by page: first view, tabs, what moves behind disclosures, what merges) into your report,
  then implement it. The panel's data access stays through `src/admin/insights.ts` and the
  router's public exports; the change watcher's queries go in a new router file `src/admin/live.ts`.
- Required reads: this document; `AGENTS.md` (Validation for panel changes); `apps/panel/app/**`
  page files you change; `apps/panel/components/**`; `packages/router/src/admin/insights.ts`.
- Owns: `apps/panel/**`, `packages/router/src/admin/live.ts` and `packages/router/src/admin/entities.ts`
  (both new; entities.ts holds the agent and related-entity queries), their export lines in
  `packages/router/src/admin/insights.ts`, `packages/router/tests/admin-live.test.ts` (new),
  `docs/working/reports/panel-v2.md`.
- Must not touch: any other router file (the budget-control worker owns them), this document,
  other working documents.
- Never the user's install (D:\SwitchYard, panel 4477): demo data (`seed:demo`) on spare ports only.
- Definition of done: U1 and U2 acceptance; `pnpm -r typecheck`; full router suite; `pnpm -r build`;
  screenshots before/after reviewed; panels you started are stopped.
- Report to: docs/working/reports/panel-v2.md

---



---

### Brief: panel-layout-resume
- Repository: D:/SwitchYardRouter, feat/panel-v2, shared checkout.
- Task: Finish U2 tabs, disclosures and anchor mappings to the existing architecture map.
- Required reads: Current State; docs/working/reports/panel-v2.md; owned pages.
- Owns: apps/panel/app/all/**/page.tsx; project overview, job detail and project settings pages; components/task-detail.tsx and session-detail.tsx.
- Must not touch: router, new entity routes, shared working docs; no commits.
- Definition of done: map implemented; supervisor validates build, scope and browser.
- Report to: docs/working/panel-v2/reports/layout.md

### Brief: panel-entities-resume
- Repository: D:/SwitchYardRouter, feat/panel-v2, shared checkout.
- Task: Finish U3 entity pages using existing public insights.
- Required reads: Current State; architecture map; admin/entities.ts; link components.
- Owns: new agent, repository, commit and request routes; entity-links.tsx; related.tsx; lib/links.ts; request-detail.tsx and new qualification request route.
- Must not touch: existing dense pages, router, shared working docs; no commits.
- Definition of done: scoped entity routes, citations and related links; supervisor validates.
- Report to: docs/working/panel-v2/reports/entities.md

### Brief: panel-live-resume
- Repository: D:/SwitchYardRouter, feat/panel-v2, shared checkout.
- Task: Review/fix U1 timestamp collisions, scope, cursor and reconnect behavior with regressions.
- Required reads: Current State; router live watcher and focused tests; SSE hub/route/client.
- Owns: admin/live.ts; tests/admin-live.test.ts; panel lib/live-hub.ts, api/live/route.ts, components/client/live.tsx.
- Must not touch: other source files, shared working docs; no commits.
- Definition of done: focused tests pass; report limitations; supervisor runs browser acceptance.
- Report to: docs/working/panel-v2/reports/live.md

### Brief: brain-navigation-completion
- Repository: D:/SwitchYardRouter, feat/panel-completion, shared checkout.
- Task: Close Current State item 1: scoped brain commit pages, linked history/blame commits and Related navigation for selected documents. Service must restrict all returned commit content to visible project/global documents; test cross-project denial and mixed commits.
- Required reads: Current State, D5/D6, existing brain page, admin brain helpers, attribution git and brain access interfaces.
- Owns: new packages/router/src/admin/brain-entities.ts; new tests/admin-brain-entities.test.ts; apps/panel/app/p/[slug]/brain/**; export lines in admin/insights.ts and src/index.ts; docs/working/panel-v2/reports/brain-completion.md.
- Must not touch: src/brain/**, seed script, other panels, shared working docs; no commits.
- Definition of done: document related links and scoped commit detail exist; meaningful denial tests pass. No broad builds while shared tree changes.
- Report to: docs/working/panel-v2/reports/brain-completion.md

### Brief: panel-link-completion
- Repository: D:/SwitchYardRouter, feat/panel-completion, shared checkout.
- Task: Close Current State item 2: recent-agent Activity summary, planned task/agent links on plan/team surfaces, and entity links in session timeline. Also implement handoff's failed-but-finished-by-supervisor plan annotation only from reliable stored/git evidence; add regression coverage or report missing prerequisites precisely.
- Required reads: Current State and architecture map; project overview, job-plan/team and session-timeline components; admin/job-plans.ts and sessions public data.
- Owns: apps/panel/app/p/[slug]/page.tsx; components/job-plan.tsx, job-team.tsx, session-timeline.tsx; packages/router/src/admin/job-plans.ts; tests/team-surface.test.ts; new tests/admin-panel-links.test.ts if needed; report below.
- Must not touch: other files, brain UI/service, seed/runtime brain, shared docs. No commits or broad builds.
- Definition of done: audit owned rendered entity names, implement links and Activity summary; regression-test evidence-based annotation. Report unhandled surfaces precisely.
- Report to: docs/working/panel-v2/reports/link-completion.md

### Brief: seed-brain-repair
- Repository: D:/SwitchYardRouter/.claude/worktrees/seed-repair, feat/demo-brain-repair; isolated worktree for run/fix/re-run.
- Task: Reproduce and fix demo seed brain index.lock, missing nested integrations/rebase and missing pending promotions. Trace causes; do not suppress warnings or fabricate successful rows. New budget semantics may require explicit fake-script grants. No real providers.
- Required reads: root working doc Current State; seed script, brain git mutation code; budget request/pool contracts as needed. Install with pnpm install --frozen-lockfile --offline.
- Owns: apps/panel/scripts/seed-demo.mjs; packages/router/src/brain/**; src/workspaces/git.ts only if root cause lives there; relevant brain/team/seed regression tests, excluding admin-brain-entities.test.ts and team-surface.test.ts; report below.
- Must not touch: other source, root shared checkout, other working docs. Never user install, no commits/push. All services stopped after tests.
- Definition of done: isolated seed exits 0 with expected integrations/rebase/promotions and no brain lock error; meaningful root-cause tests; report exact outputs and unresolved failures.
- Report to: docs/working/panel-v2/reports/seed-repair.md in your worktree (supervisor integrates).

### Brief: remaining-panel-audit
- Repository: D:/SwitchYardRouter, feat/panel-completion, read-only source audit while supervisor/other worker validate and edit.
- Task: Audit remaining D5/D6 acceptance against e00dfd5 baseline and architecture map: preserved data/old anchors/query links and rendered entity links outside the already-covered brain, plan/team and timeline surfaces. Identify concrete missing links/data/navigation, not arbitrary model text/tool JSON. Inspect current pending fixes but do not change source.
- Required reads: this Current State/D5/D6; docs/working/reports/panel-v2.md; relevant apps/panel page/components and source baseline via git show. Supervisor static inventory found no removed literal CardHeader titles or literal IDs in nine dense pages; verify dynamic settings/groups too.
- Owns: docs/working/panel-v2/reports/remaining-audit.md only.
- Must not touch: any source or other docs; no builds/tests/commits/services. No user config.
- Definition of done: report concrete source references, expected behavior and suggested smallest fixes, plus bounded baseline-section/anchor inventory and explicit unverified cases.
- Report to: docs/working/panel-v2/reports/remaining-audit.md

### Brief: promotion shutdown regression (2026-10-22)
- Worker: brain_completion; owns core/service.ts, tests/service-close.test.ts and its report only.
- Trigger: default-parallel full suite 611/612; projects-brain cleanup EBUSY after review completion.
- Inspect deferred promotion settlement versus close; track/cancel pending scheduling and await
  active work before database closure. Preserve review semantics; no cleanup retries or weakened tests.
- Deterministic narrow regression and report required; supervisor runs integrated acceptance.

## Work Ledger

### 2026-10-21 — Plan written
- Agent: supervisor
- Changed: this document; `docs/working/README.md`.
- Why: user requests (live data; a calmer layout).
- Validation: not validated (design only). Evidence: page inventory (38 `page.tsx`), `AutoRefresh`
  in `components/client/actions.tsx:152-170` (router.refresh every 8 s; used on 10 pages).
- Outcome: Accepted

---



---

### 2026-10-22 — Resume and integrate Panel v2
- Agent: supervisor (Codex)
- Changed: merged dev into feat/panel-v2; assigned layout, entity routes and live correctness by file; added citations and identity links.
- Why: continue Claude's unfinished panel effort per the handoff.
- Validation: `pnpm -r typecheck` passed. First `npx vitest run`: 598 passed, 5 failed (timeouts/Windows cleanup locks), 1 worker-reporting timeout under concurrent build/seed load. Full rerun and browser acceptance pending.
- Outcome: Partial
- Follow-up: finish review fixes, clean checks, demo acceptance and merge. Interrupted build/seed outputs were unavailable after turn interruption; rerunning with retained log files.

### 2026-10-22 — U1-U3 acceptance complete
- Agent: supervisor (Codex), workers panel-layout-resume, panel-entities-resume, panel-live-resume
- Changed: live watcher and client; dense layouts/group navigation; entity routes and related links; setup, index and handoff documentation. Details: reports/validation.md under this effort.
- Why: finish the interrupted Panel v2 plan and verify the worker claims independently.
- Validation: final `pnpm -r typecheck` and `pnpm -r build` passed; `npx vitest run --maxWorkers=2` passed 603/603 in 59 files. Final production-demo crawl: 492 checks, zero unexpected failures; old anchors, SSE reset/resume, direct entity links and light/dark desktop/phone screenshots verified. Live DOM update 865 ms, idle refreshes 0; pause/resume, restart and state preservation passed.
- Outcome: Accepted
- Follow-up: B2 next. Merge into dev: 672a697; final narrow admin-live rerun passed 16/16 after confirming dev was current. Push state is recorded by Git refs. Temporary demo/browser servers stopped. Automatic approval review blocked deletion of both the unregistered baseline directory and generated demo fixtures (only "blocked by policy" supplied); neither is committed.

### 2026-10-22 — Completion claim corrected after user challenge
- Agent: supervisor (Codex)
- Changed: status and Current State reopened; index/handoff and validation outcome corrected.
- Why: the full plan was not complete despite passing tests and selected acceptance checks. Brain commit navigation/Related, Activity's recent agents, broader U1/D5/D6 coverage and seed failures remain.
- Validation: read panel-v2 decisions and map against brain/page.tsx, project overview and worker reports; confirmed plaintext brain commit hashes, no brain RelatedPanel, and omitted Activity agent summary. Broader pending work confirmed in budget-control, labs and handoff. No code changed or tests rerun.
- Outcome: Partial
- Follow-up: execute the numbered remaining work in Current State; do not equate test counts with requirement completeness.

### 2026-10-22 — Scoped navigation and links integrated, acceptance pending
- Agent: supervisor; brain-navigation-completion and panel-link-completion
- Changed: scoped brain history/blame/commit views and Related; Activity agents; plan/team/timeline links; evidence-backed supervisor plan annotation; durable validate:live browser script.
- Validation: supervisor ran 13/13 targeted tests across admin-brain-entities, admin-plan-recovery, team-surface. Router build caught a picomatch callback typing/argument bug; wrapped matcher, added same-commit unrelated-file regression, router build and recovery rerun 1/1 pass. Browser and full-suite integration remain pending.
- Outcome: Partial
- Follow-up: integrate isolated brain/seed fix; verify all browser requirements. B2 implementation may proceed in its own isolated worktree while this tree is validated.

### Integration checkpoint (2026-10-22)
- Seed repair merged; root seed independently reproduced nested completion, three integrations,
  one rebase and verified survey twins. Final seed assertions still running.
- B2 source merged from 901161a; root acceptance pending. Budget demo adds two genuine pending
  human decisions on idle tasks with held grants, without model calls.
- D5/D6 audit found/fixed workspace, parent-job and model links; B2 also fixes job/task repository
  metadata and opens the transcript wrapper to keep nested tool details within two clicks.
- Root recursive typecheck passed before B2 integration; full initial suite 611/612 (one cleanup
  EBUSY); bounded full rerun and production build underway. No completion claim yet.
### 2026-10-22 - Completion follow-up accepted
- Agent: supervisor (Codex); brain_completion, link_completion and seed_repair.
- Changed: scoped brain navigation/copy history, Activity and structured links, supervisor recovery evidence, brain initialization/shutdown races, deterministic demo repairs, B2 UI/API and phone blame layout.
- Validation: supervisor reviewed worker code and reproduced the repaired seed (exit 0, no warnings); 622/622 tests, 63 files, 308.77 s; recursive typecheck/build pass. Production demo: 581 crawl checks, 40 anchor checks, independent task/request/brain live updates 905/735/1222 ms; budget partial approve/deny and 400/404/409 paths; independent budget live update preserves disclosure. 64 page, 28 focused and four final blame captures: no overflow/browser exceptions; representative sections inspected.
- Outcome: Accepted. U1-U3 and reopened completion requirements closed. B2 accepted separately; real-provider, Labs, R2 and packaging work are not claimed complete.
- Follow-up: merge/push complete unit to dev and fast-forward main under standing authorization. Temporary demo services stopped; generated fixtures/evidence remain outside commits. Git refs record final push state.

## Open Questions


- None for this completed phase. Large-store benchmarking and real-provider checks retain their separate scope.
