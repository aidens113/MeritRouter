# Panel v2: live data and a calmer layout

Status: Active
Status detail: Stopped by the user 2026-10-22 mid-way; unfinished work on feat/panel-v2 (f24b9ae), unverified.
Created: 2026-10-21
Last updated: 2026-10-21
Owner: Senior supervisor agent
Scope: Push changes to the panel as they happen instead of re-rendering on a timer, and
restructure pages so they show summaries first and details behind tabs and disclosures.
Paired document: none
Related: [budget-control](./budget-control.md), [labs](./labs.md), [projects](./projects.md)

---

## Current State

**User requests (2026-10-21):** "The panel should have live updating for data, not just be static
and on refresh." "The UI is fundamentally good, but there is way too much information on one page,
too many tabs, and everything is shown immediately. More tab structures."

**What exists:** 38 pages under `apps/panel/app` (project pages under `/p/<slug>`, install-wide
under `/all`, redirects from old flat URLs). "Live" is `AutoRefresh` (`components/client/actions.tsx`):
`router.refresh()` every 8 s on 10 pages, with a pause button. The densest pages render every
section at once: job detail (473 lines), install dashboard (457), project overview (296).

**Stopped (2026-10-22, at the user's request):** worker panel-v2 was stopped mid-task; its work is
committed as WIP on `feat/panel-v2` (`f24b9ae`, pushed), not merged, not browser-checked. Present:
`/api/live` server-sent change events (`apps/panel/lib/live-hub.ts`, `app/api/live`), a client
`LiveProvider` (`components/client/live.tsx`), shared `PageHeader`, `Tabs`, `Disclosure`,
`ShowAll`, `RelatedPanel`, entity links, and restructured pages under `/p/<slug>` and `/all`;
the information-architecture map (sidebar groups, entity URLs, page by page) is in
`docs/working/reports/panel-v2.md` on that branch. Missing: U3's new pages (agents, repos, commits,
requests), the acceptance checks, screenshots. Panel typecheck passes on the branch.

**Next steps:** merge dev into `feat/panel-v2`, finish U2 and U3 to the map, validate, merge.

**Blockers:** none.

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

## Work Ledger

### 2026-10-21 — Plan written
- Agent: supervisor
- Changed: this document; `docs/working/README.md`.
- Why: user requests (live data; a calmer layout).
- Validation: not validated (design only). Evidence: page inventory (38 `page.tsx`), `AutoRefresh`
  in `components/client/actions.tsx:152-170` (router.refresh every 8 s; used on 10 pages).
- Outcome: Accepted

---

## Open Questions

- None blocking; the information-architecture map is reviewed when U2's report arrives.
