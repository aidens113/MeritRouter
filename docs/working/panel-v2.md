# Panel v2: live data and a calmer layout

Status: Active
Status detail: Plan written 2026-10-21 at the user's request; U1-U2 dispatched.
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

**Next steps:** U1 then U2 (worker panel-v2).

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
- **D5. Nothing is lost:** every datum shown today stays reachable in at most two clicks; links into
  old anchors keep working (`#id` sections map to the tab that holds them).

---

## Phases

| Phase | Deliverable | Acceptance |
| --- | --- | --- |
| U1 | Live data: `/api/live` SSE with topics and cursor, `LiveProvider`, topic subscriptions on every page that auto-refreshed, connection state in the header, pause kept; `AutoRefresh` polling removed | A change in the store (a task state, a new request, a brain commit) reaches an open page within ~2 s without a reload (verified on the demo with a script that writes to the store while headless Chrome watches the DOM); no request when nothing changes; reconnect after the server restarts |
| U2 | Layout: the information-architecture map (in the report), tabs and disclosures on the dense pages (job, task, session, project overview, install dashboard, models, keys, settings), shared components, phone layouts | Every touched page 200; screenshots before and after at desktop and phone widths, light and dark; each page's first view shows at most about five sections; deep links to old anchors land on the right tab |

---

## Worker Briefs

### Brief: panel-v2
- Repository: this repository; your own worktree on branch `feat/panel-v2`; run
  `pnpm install --frozen-lockfile` first. Another worker changes the router at the same time.
- Task: U1, then U2, as the Decisions describe. For U2, first write the information-architecture
  map (page by page: first view, tabs, what moves behind disclosures, what merges) into your report,
  then implement it. The panel's data access stays through `src/admin/insights.ts` and the
  router's public exports; the change watcher's queries go in a new router file `src/admin/live.ts`.
- Required reads: this document; `AGENTS.md` (Validation for panel changes); `apps/panel/app/**`
  page files you change; `apps/panel/components/**`; `packages/router/src/admin/insights.ts`.
- Owns: `apps/panel/**`, `packages/router/src/admin/live.ts` (new), its export line in
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
