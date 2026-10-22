# Panel v2: live data and a calmer layout

Status: Complete
Status detail: U1-U3 implemented and demo-validated 2026-10-22; final integration checks and merge recorded below.
Created: 2026-10-21
Last updated: 2026-10-22
Owner: Senior supervisor agent
Scope: Push changes to the panel as they happen instead of re-rendering on a timer, and
restructure pages so they show summaries first and details behind tabs and disclosures.
Paired document: none
Related: [budget-control](./budget-control.md), [labs](./labs.md), [projects](./projects.md)

---

## Current State

**Delivered 2026-10-22:** U1 scoped server-sent live events, reconnect/resume cursors and pause;
U2 shared headers, grouped navigation, query-addressable tabs, disclosures and mobile summaries;
U3 agent, repository, commit and request pages (including qualification and unassigned requests),
with related-entity links on task, job, session and model details. Old section anchors select
their tabs. The supervisor merged current dev into feat/panel-v2 before completing the work.

**Verified:** `pnpm -r typecheck`; `npx vitest run --maxWorkers=2` (603/603, 59 files);
production builds; demo HTTP crawl (492 checks, zero unexpected failures); browser live updates
(865 ms, no idle refresh, pause/resume and server restart recovery, scroll/disclosure state kept);
malformed cursor reset and resumed changes; five old-anchor mappings; a delegated coding task's
direct job/agent/session/model/request/commit links. Desktop and phone, light and dark screenshots
were inspected. See [supervisor validation](panel-v2/reports/validation.md) for exact evidence.

**Review fixes:** timestamp/older-row change detection, all configured brain roots, bounded
cursors, watcher resets; inherited repository aliases return 404; URL-decoded agent identities;
validated request citations; paid cost fallback; bounded-history labels; grouped sidebar pages
have a shared sibling-navigation strip. Workers' reports were independently verified.

**Limits:** live fingerprints scan mutable rows after database writes (quiet checks avoid those
scans); large-store performance is unbenchmarked. Some tab data is still queried eagerly.
Agent request usage covers 60 recent session logs; commits are capped at 200 (repository 50).
Archived project routes intentionally return 404 until unarchived. Brain commit hashes stay in
scoped history rather than exposing shared-brain diffs through repository pages.
The demo seed reported fixture-level brain-lock/integration/promotion warnings; those do not
establish live team correctness. No real provider calls or user install tests were run.

**Next:** budget-control B2, then a separately budgeted live team check. Labs, R2 and packaging
remain governed by the handoff's existing constraints.

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
- Follow-up: merge/push dev and fast-forward main; B2 next. Temporary demo/browser servers stopped. Automatic approval review blocked deletion of both the unregistered baseline directory and generated demo fixtures (only "blocked by policy" supplied); neither is committed.

## Open Questions

- None blocking; the information-architecture map is reviewed when U2's report arrives.
