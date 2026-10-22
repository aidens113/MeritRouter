# Labs: parallel, isolated, runnable lanes for agent teams

Status: Active
Status detail: L1-L4 integrated and independently validated locally; fresh package acceptance/push pending. L5 extensions remain active follow-on work.
Created: 2026-10-21
Last updated: 2026-10-22
Owner: Senior supervisor agent
Scope: Make labs (lanes) a native part of SwitchYard: each lab is an isolated, runnable copy of a
project on its own branch, with its own ports, data, and running services, where an agent team
builds and tests a feature without disturbing other labs; supervisors promote finished labs
through a gated merge.
Paired document: none
Related: [web-search](./web-search.md), [agent-sessions-and-teams](./agent-sessions-and-teams.md), [projects](./projects.md), [roles](../roles.md)

---

## Current State

**Origin:** the user wants FluxIQ's practice, testing the product on individual lanes or labs,
built into SwitchYard and taught to every agent. FluxIQ's repository is not on this machine
(no F: drive), so this plan is built from the user's description and SwitchYard's code;
assumptions about FluxIQ are listed under Open Questions for the user to correct.

**What exists (code map 2026-10-21; file:line in the ledger):**
- Isolation of code: a worktree per task attempt (`<storage>/worktrees`, detached), a job branch
  per writable repository (`switchyard/job-<id>`) with an integration worktree, sub-job branches,
  file leases on `allowedPaths`, one writer per repository by default, the merge queue
  (cherry-pick, rebase on conflict, one re-delegation), job checks after each integration.
- Delivery: the user merges the job branch by hand; SwitchYard never writes the user's branches.
- Not present: anything that runs. Every command is a bounded process (timeout, killed with its
  tree); no ports, per-branch data, long-running services, readiness checks, or process
  supervision; no cleanup of old worktrees (`Worktrees.remove()` has no caller).

**Implementation update 2026-10-22:** L1-L4 are integrated locally: validated recipes/store,
owned worktrees/data/ports, services, checks, refresh/promotion, team/task tools, CLI, persistent
brain lanes and project panel/editor/controls. Supervisor independently verified20 focused
core/integration tests,8 admin tests, production lifecycle/API/browser and legacy migration,
then701/701 integrated tests(78files), recursive typecheck/build. Final model-navigation browser
also passes after fixing catalog-version invalidation. Fresh tarball outside-install checks
remain active before push. See [roadmap-completion](roadmap-completion.md) for exact evidence.

Limits: max_active counts all retained, non-destroyed labs, including stopped/failed labs;
destroy preserves branches and refuses dirty worktrees. Per-lab recipes are snapshots.
Process/listener verification is tested on Windows; cross-platform acceptance remains separate.

**Next steps:** finish package/push acceptance; L5 static browser checks and R2's first async
accounting slice are isolated in progress. Hydrated JavaScript browser checks, ephemeral task
labs, Compose and multi-host persistence are not complete; see [extensions](distributed-and-lab-extensions.md).

**Blockers:** none.

---

## Concept

A **lab** belongs to a project. It has:
- a name and a **lab branch** per repository (`switchyard/lab-<project>-<name>-<id-suffix>`), forked from the project's
  **target branch** (default the repository's current branch, e.g. `dev`);
- a **lab worktree** per repository (`<storage>/labs/<project>/<lab>/repos/<alias>`), the lab's running
  checkout;
- **allocated ports** (one per named port in the recipe), **its own data** (a lab folder for
  databases, uploads, caches), and **environment variables** derived from both;
- **services** started from the project's lab recipe (dev servers, APIs, workers), supervised by
  SwitchYard: started, health-checked, logged, restarted, stopped when idle, killed on teardown;
- **lab checks** (unit, integration, end-to-end) that run against the running lab;
- a **lane document** in the brain (`projects/<slug>/labs/<lab>.md`): goal, team, status, findings,
  with the same working-document protocol as everything else.

A **team works in one lab.** A job started in a lab uses the lab branch as its integration
branch: workers still edit in their own task worktrees (forked from the lab branch), the
supervisor integrates through the existing merge queue into the lab branch, the lab worktree
moves to the new head, services reload or restart, and lab checks run. Several labs, each with
its own team, run at once without touching each other's code, ports, data, or processes.

**Promotion** moves a finished lab into the target branch: refresh the lab onto the latest target
(merge or rebase, conflicts handed back to the lab's team), run the lab checks on that exact
revision in the lab, then merge into the target through a promotion queue (one at a time per
target branch), by the policy the project sets.

---

## Decisions (recommended defaults; the user may override)

- **D1. The recipe is configuration, not model output.** `projects.<slug>.lab` declares setup
  commands, services, ports, data, environment, readiness, and checks. Agents may start, stop,
  restart, and read declared services and run declared checks; they cannot add commands. The
  panel and the config file edit the recipe.
  ```yaml
  projects:
    shop:
      lab:
        ports: [web, api]                    # allocated per lab from labs.port_range
        data: [db]                           # per-lab folders: {lab.data.db}
        env: { DATABASE_URL: "file:{lab.data.db}/app.sqlite", API_URL: "http://127.0.0.1:{port.api}" }
        setup: ["pnpm install --frozen-lockfile", "pnpm db:migrate"]
        services:
          api: { repo: app, command: "pnpm --filter api dev --port {port.api}", ready: { http: "http://127.0.0.1:{port.api}/health" } }
          web: { repo: app, command: "pnpm --filter web dev --port {port.web}", ready: { http: "http://127.0.0.1:{port.web}/" }, after: [api] }
        checks:
          unit: "pnpm test"
          e2e: "pnpm e2e --base-url http://127.0.0.1:{port.web}"
  ```
- **D2. Plain processes first, containers later.** Services run as supervised child processes on
  127.0.0.1 with the lab's environment. A `compose` service kind (Docker Compose project per lab)
  is a later option, not required.
- **D3. Ports** come from `labs.port_range` (default 5100-5999), allocated per lab and recorded in
  the store; a port is checked free before use and released at teardown.
- **D4. Process supervision belongs to the long-running process.** The daemon (or a worker or MCP
  server when no daemon runs) owns lab services: records pid, process group, ports, and state in
  the store; restarts a crashed service with backoff (bounded); stops services idle for
  `labs.idle_stop_minutes` (default 30); a new owner adopts or restarts recorded services after a
  restart. Teardown kills process trees (taskkill /T on Windows, process groups elsewhere).
- **D5. Limits in code:** `labs.max_active` per install (default 4) and per project, a cap on running
  services, and the setup/check timeouts. Lab services bind 127.0.0.1 only.
- **D6. Agents' lab tools** (supervisor and workers of a lab job): `lab_status` (services, URLs,
  health, branch and head, ports), `lab_logs(service, tail)`, `lab_restart(service)`,
  `lab_check(name)` (a declared check against the running lab, recorded like checks), and
  `lab_http(method, path, service)`: an HTTP request to the lab's own services only (the SSRF
  guard's single, explicit exception: the lab's allocated ports on 127.0.0.1). Browser checks
  (headless screenshots, console errors) come in L5.
- **D7. Lab branch as the job's integration branch.** `start_job` (and `plan_work` nodes) take a
  `lab`; without one, jobs behave exactly as today. Integration into the lab branch uses the
  existing merge queue; after each integration the lab worktree advances, services reload
  (restart when the recipe says so), and lab checks marked `on_integrate` run.
- **D8. Promotion is gated and queued.** `promote_lab` (supervisor tool, CLI, panel) refreshes the
  lab onto the target, re-runs all lab checks on that revision, and merges into the target in a
  per-target promotion queue. Policy `projects.<slug>.labs.promotion: manual | supervisor | auto`
  (default `manual`: SwitchYard prepares a merge-ready branch and shows the command or a panel
  button; `supervisor`: the lab's supervisor may promote after checks pass; `auto`: promotion
  runs when checks pass). SwitchYard writes the user's target branch only under `supervisor` or
  `auto`, which the user opts into.
- **D9. Cross-lab awareness, not locks.** Labs may touch the same files; promotion order resolves
  it. SwitchYard reports overlaps (files changed in two active labs) to both supervisors and in the
  panel; after a promotion, the other labs are marked "behind target" and refreshed on request or
  before their own promotion.
- **D10. Labs are fundamental in the instructions.** The supervisor charter teaches: split work
  into lanes (one feature per lab), one team per lab, test in the lab, never reach into another
  lab, promote only with passing lab checks. Worker charters teach the lab tools. The MCP server
  and `CLAUDE.delegation.md` teach external supervisors (Claude Code, Codex, ChatGPT) the same.
- **D11. Cleanup:** destroying a lab stops its services, removes its worktrees and data folder, and
  keeps its branch (the work is never lost). Old task worktrees of finished jobs get a retention
  rule (`labs.keep_task_worktrees_days`, default 7) since nothing removes them today.

---

## Design

Router (new area `src/labs/`, per AGENTS.md Code Structure):
- `recipe.ts` (zod schema, placeholder substitution, validation: services refer to known ports,
  repos, and data), `ports.ts` (allocation in the store), `lab.ts` (create, refresh, destroy,
  status), `services.ts` (process supervisor: spawn, readiness, logs to
  `<storage>/labs/<project>/<lab>/logs/<service>.log`, restart backoff, idle stop, adoption),
  `checks.ts` (run declared checks with the lab env), `promotion.ts` (promotion queue and policy),
  `overlap.ts` (changed files across active labs).
- Storage (appended migrations): `labs`, `lab_ports`, `lab_services`, `lab_checks`,
  `lab_promotions`; events for every lifecycle step.
- Integration points: supervisor runner (job branch = lab branch when `lab` is set), integration
  tools (after-integration hook), harness tools (lab tools), SSRF guard (lab-port exception),
  daemon/worker (service ownership), MCP tools (`lab_*`, `start_job({lab})`), CLI `switchyard labs`.

Panel: a Labs page per project (cards: branch, ahead/behind target, services with URLs, health
and restart, ports, the team and its jobs, last checks, overlaps), lab detail (logs viewer,
checks, promotion with confirmation), create and destroy (confirmation), recipe editor in project
settings. The global dashboard shows active labs across projects.

Docs: setup (recipe), operations (lifecycle, limits, recovery), roles (labs in the role model),
decisions (D1-D11 as adopted).

---

## Phases

| Phase | Deliverable | Acceptance |
| --- | --- | --- |
| L1 | Lab core: recipe schema, ports, lab create/refresh/destroy with branches and worktrees, setup, service supervisor (readiness, logs, restart backoff, idle stop, adoption after restart), CLI `switchyard labs` | Fixture app (tiny Node HTTP server + a check): two labs of one project run at once on different ports with separate data; readiness by HTTP; crash restart; idle stop; destroy kills the process tree and keeps the branch; a second process adopts running services |
| L2 | Teams in labs: `start_job({lab})`, lab branch as integration branch, after-integration reload and checks, lab tools for supervisor and workers (with the SSRF lab-port exception), lane documents in the brain, MCP tools, charters and `CLAUDE.delegation.md` | Scripted-model job in a lab: workers integrate into the lab branch; the service reloads; `lab_check` and `lab_http` work; `lab_http` to another lab's port or any other address is refused |
| L3 | Promotion and coordination: refresh, promotion queue per target, policy (manual / supervisor / auto), overlap reports, "behind target" marking, conflicts handed back to the lab team | Two labs changing the same file: the first promotes, the second is marked behind, refreshes, and its conflict goes back to its team; manual policy never writes the target |
| L4 | Panel and docs: Labs page, detail with logs and checks, controls, promotion and destroy confirmations, recipe editor, dashboard row; docs | Demo seed with two labs; every page 200; screenshots at desktop and phone widths, light and dark |
| L5 (later) | Browser checks (headless screenshots and console errors as lab checks), per-task ephemeral labs before integration, Docker Compose services | To be planned when L1-L4 are in use |

---

## Work Ledger

### 2026-10-21 — Plan written
- Agent: supervisor (code map by an Explore agent)
- Changed: this document; `docs/working/README.md`.
- Why: the user asked for labs as a native part of the package.
- Validation: not validated (design only). Evidence: worktrees `workspaces/worktree.ts:54-70,104`,
  `runners/coding/finish.ts:13-57,105-124`; branches and integration
  `runners/supervisor.ts:93-115,334-347`, `harness/supervisor-tools.ts:255-331,510-579,638-647`,
  `harness/integration-tools.ts:61-192,211-286`, `workspaces/merge-queue.ts:163-480`; leases
  `storage/file-leases.ts:31-65`, `storage/tasks.ts:307-386`; processes
  `runners/coding/process.ts:16-111` (bounded only); charters `packages/router/charters/`.
- Outcome: Accepted
- Follow-up: the user's answers to the Open Questions; L1.

---

## Open Questions

For the user (FluxIQ's lanes are not on this machine, so these are assumptions to confirm):
- Does a FluxIQ lane run the whole product (frontend, API, workers, database), and how is its data
  separated (separate database per lane, a schema, SQLite files, Docker)?
- Who merges a finished lane into the main line in FluxIQ: a human, a merge supervisor, or
  automatically when checks pass? (Default here: manual, opt-in supervisor or auto.)
- How many lanes run at once, and are they long-lived (a lane per area of the product) or one per
  feature, destroyed after merging? (Default here: one per feature, a cap of 4 active.)
- Are lane tests browser end-to-end tests (Playwright or similar) that need a running instance?
  (L5 adds browser checks; L1-L4 run any declared command against the running lab.)
