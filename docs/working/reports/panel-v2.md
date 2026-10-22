# Report: panel-v2 (U1 live data, U2 layout, U3 entity pages)

Worker report for [panel-v2](../panel-v2.md), brief "panel-v2" (U3 added by the supervisor
mid-task). Worktree: `D:\SwitchYardRouter\.claude\worktrees\agent-a443248d6e5862bf6`, branch
`feat/panel-v2` (fast-forwarded to dev `1b3766d` at the start; not re-merged since).

## Information-architecture map (written before U2/U3 were implemented)

Conventions (D4): one `PageHeader` (back link, title, one-line purpose, live state, actions, a row
of status badges); one `Tabs` strip (links to `?tab=<id>`, server-rendered: only the open tab's
data is read); one `Disclosure` (native `<details>`, survives live refreshes); `ShowAll` for lists
longer than 10 rows; `EmptyState`; a `RelatedPanel` on every entity page (D6). Old `#anchors` map
to the tab that holds them (a small client component rewrites `#plan` to `?tab=plan#plan`).

### Sidebar (fewer top-level entries; grouped pages get a route tab strip)

| Scope | Before (count) | After |
| --- | --- | --- |
| Project | Overview, Jobs, Teams, Tasks, Sessions, Requests, Brain, Project settings (8) | Overview · Jobs (Jobs, Teams) · Tasks (Tasks, Agents, Sessions, Requests) · Code (repositories, commits) · Brain · Settings (6, two new entity kinds included) |
| All projects | Projects, Dashboard, Requests, Models, Routing, Provider keys, Qualification, Calibration, Knowledge, Settings (10) | Projects · Dashboard (Dashboard, Requests) · Models (Models, Routing) · Provider keys · Quality (Qualification, Calibration) · Knowledge · Settings (7) |

URLs do not change: `/p/<slug>/teams`, `/sessions`, `/requests`, `/all/requests`, `/all/routing`,
`/all/calibration` stay; the sidebar entry of their group is active and a route tab strip under
the header moves between the group's pages.

### Entity pages (U3, D6): every entity has a stable URL under its project

| Entity | URL | Status |
| --- | --- | --- |
| Task | `/p/<slug>/tasks/<id>` | exists; restructured |
| Job | `/p/<slug>/jobs/<id>` | exists; restructured |
| Session | `/p/<slug>/sessions/<id>` | exists; restructured |
| Agent (`<role>:<label>`) | `/p/<slug>/agents/<role:label>`; list `/p/<slug>/agents` | new |
| Model request | `/p/<slug>/requests/<id>`; `/requests/<id>` redirects to its project | new |
| Repository | `/p/<slug>/repos/<alias>`; list `/p/<slug>/repos` | new |
| Commit | `/p/<slug>/repos/<alias>/commits/<sha>` | new |
| Model | `/all/models/detail?id=` (install-wide) | exists; gains "Used by" (tasks, agents, projects) |
| Brain document | `/p/<slug>/brain?path=` | exists; blame lines link agent, task, commit |

Linking rule: wherever a task, job, session, agent, request, model, or commit is named (tables,
timelines, plan nodes, channel posts, blame lines, commit trailers), it is a link to its page.

### Page by page

**Job** (`/p/<slug>/jobs/<id>`). First view: header (state, acceptance, sub-job badges; Resume,
Cancel; live `jobs:<id>`), status callout, pending questions (they need you), a summary strip
(supervisor requests, worker tasks done/total, agents, wall-clock). Tabs:
- Overview: goal and acceptance criteria, result summary and unresolved criteria, details (working
  document, task page, parent job, supervisor agent); answered questions in a disclosure.
- Plan: the plan card (critical path, graph, nodes; nodes link to tasks and agents).
- Team: the team tree, worker tasks (task and agent links; first 10, show all), team metrics in a
  disclosure.
- Changes: branches (merge command), merge queue, commits on the job (attributed, linked), job
  branch diff in a disclosure.
- Checks: acceptance criteria, job checks, check results with logs.
- Channel: the team channel (authors link to agent pages).
- Sessions: sessions table, supervisor transcript.
Anchors: `#plan` → Plan, `#team`, `#metrics` → Team, `#merge-queue` → Changes, `#channel` →
Channel, `#questions` stays on every tab.

**Task** (`/p/<slug>/tasks/<id>`). First view: header (state, tier, importance, acceptance,
verification; Resume, Cancel; live `tasks:<id>`), callouts (part of a job, state reason, decision
needed), goal and criteria with their status, a Related panel (job and its ancestors, agents,
sessions, models, requests, commits, brain reports, dependencies, child tasks). Tabs:
- Result (default): summary, findings, unresolved criteria, checks, changed paths; artifacts.
- Verification: contract and verification record, follow-ups.
- Routing: difficulty score, models tried, pinned model, escalation.
- Usage: requests, tokens, cost, the requests table (rows link to request pages), web requests.
- Sessions: sessions table; the task's event timeline in a disclosure.
Anchors: `#web-requests` → Usage.

**Session** (`/p/<slug>/sessions/<id>`). First view: header (status, role, agent link; Resume),
callouts, four stats, Related panel (task, job, agent, parent session, previous/next run,
requests it made, models). Tabs: Timeline (default, paged event log), Details (details,
workspace, runs of this task, spawned sessions), Requests (the requests the session made).

**Agent** (new, `/p/<slug>/agents/<role:label>`). First view: header (role, label; live
`sessions`), stats (tasks, sessions, requests, lines written, cost), Related panel (jobs and their
supervisor agents). Tabs: Tasks (default), Sessions, Models, Requests, Changes (commits with
lines added and removed, linked to commit pages). List page `/p/<slug>/agents`: one row per agent
(role, tasks, sessions, last active, last status), filter by role.

**Request** (new). Header (purpose, status, model), key values (time, latency, tokens, cost,
attempts, error, policy, route note, web search), Related (tasks charged, sessions and agents that
made it, model, project), citations in a disclosure.

**Repository** (new). Path, writable, current branch and head, branches (SwitchYard job branches
first by date), recent commits with attribution (agent, task, job links; first 10, show all).
**Commit** (new): subject, attribution trailers as links (agent, role, model, task, job, request),
files with lines added/removed, branches containing it, the diff in a disclosure.

**Project overview** (`/p/<slug>`). First view: header (live, New job), needs-attention, five
stats, then tabs: Overview (running and queued jobs, repositories linked to repository pages),
Activity (worker, tasks by state, most recent agents), Usage (requests per hour chart, tasks by
tier).

**Install dashboard** (`/all`). First view: header (live), five stats, needs-attention, tabs:
Projects (queues by project), Activity (running and queued jobs), Usage (usage and paid spend by
project), Health (worker, provider health).

**Models** (`/all/models`, with Routing in its group). The model table keeps its filters (it is
one table already). Model detail: first view header and four stats, tabs Overview (facts,
parameter evidence in a disclosure), Eligibility, Qualification, Usage (recent requests, used by
tasks, agents, projects), Controls. Anchor `#controls` → Controls.

**Provider keys** (`/all/keys`). Tabs: Keys (default: one card per provider), Add a key, Web
search, Paid spend. Anchors `#add`, `#provider-<id>`, `#web-search`, `#paid` map to their tab.

**Settings** (`/all/settings`). The 25 sections move from one long page into tabs of related
sections, each tab keeping the in-page section menu: General (providers, model catalog,
discovery, panel, repositories), Routing (tiers, routing, scoring, qualification, capacity),
Task types (execution, coding workers, each type, supervisor jobs, project settings), Web and paid
(web search, caps, paid routing, providers, models), Brain and roles, then Rulebook and Raw YAML
(already tabs). Every section anchor maps to its tab.

**Project settings** (`/p/<slug>/settings`). Tabs: General (general, repositories, brain),
Scheduling (scheduling and budgets), Policy (verification, team policy, commands and paths, roles
and charters), Danger zone. Anchors map to their tab.

What merges: Teams under Jobs; Agents, Sessions, Requests under Tasks; Requests under Dashboard;
Routing under Models; Calibration under Quality. Nothing is removed: every datum on a page today is
on the same page in a tab or disclosure, or one click away on an entity page.
