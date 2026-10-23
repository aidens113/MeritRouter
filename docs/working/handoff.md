# Handoff: state of every effort (2026-10-23)

Written for the next agent (Codex or Claude Code) picking this repository up cold. Read this,
then `AGENTS.md`, then the `Current State` of the effort you work on. Every effort below has its
own working document with decisions, phases, ledger, and reports.

## Current audit (2026-10-23)

[Correctness and panel flows](correctness-and-panel-flows.md) owns user-authorized execution of
the [post-change fix audit](post-change-fix-audit.md). Source on feat/post-change-corrections
includes the preserved live-run fixes, default human-only outside-action policy, disabled and
supervisor alternatives, one-shot broker decisions, worker/external-runner fail-closed containment,
queued Lab authority, fresh repeat observations and recovered evidence. Job overview links children;
job-wide Requests and scoped task/request/session navigation plus Security settings are implemented.
Recursive typecheck/build pass; production-demo browser/API and live DOM acceptance pass. Full
suite1150passed/15failed/2Linuxskips was corrected; final affected162/162 pass. Installed package
CLI/MCP42tools/bundled panel and live approval pass (1324ms, no reload/browser errors). Final
native/resume61/61 and package operations16/16 pass. Final fingerprinted package reinstalls
without warning; live approval1220ms passes. Owned demo/package panels and Chrome stopped.
Coherent commit/publication receipt follows; no live deployment. External autonomous coding runners and automatic worker Task Lab execution
remain deliberately unavailable without enforced sandbox/durable execution proof. Native editing
and exact approved ordinary checks remain supported. Read the execution document's current state.
Older source/deployment/active-worker snapshots below are historical; current live processes
were not inspected. Read the audit before treating those snapshots as current acceptance.

## Repository state

- Active local integration now includes recovery-retention943a74a, request protocol2b22160
  (migration30), root project request blockers/private purgea1dfec5 and Linux helper95907bd.
  Independent checks: recovery10/10 with full two-day cadence301 receipts; lifecycle42/42;
  admission38/38 then final classifier15/15; project protocol4/4 + project/Lab12/12;
  native helper38/38 including17 Python cases. Full frozen1525960 router acceptance is running
  in roadmap-package (TEMP/switchyard-admission-integration-full-supervisor.log), source untouched.
  Previous e3abcb5 recursive build/typecheck and warning-free seeded production browser20 images
  passed, before admission merge; next final build/browser/package still required.
  Workers: roadmap-labs feat/compose-journal exclusively owns next migration31; roadmap-team
  feat/linux-browser-proc-policy fixes measured ordinary-user proc-mask mismatch; roadmap-process
  feat/admission-fixture-integration owns named test fixtures only. Read current briefs/reports.
  None of these local units are pushed/deployed. Actual4477 remains accepted663626d/PID24040.


- Request evidence release accepted:783/783 tests in88files (943.08s), recursive typecheck/build,
  production request and historical-session browser acceptance (16 screenshots, scoped route/API
  checks). Includes classifier project partition, rich historical request details and session
  scope privacy. See roadmap-completion/reports/request-page-release-acceptance.md. Panel
  deployment completed: accepted663626d rebuilt at root and4477 restarted asPID24040. Read-only
  live model/request browser checks passed, populated exchange viewed, config unchanged
  (SHA256AF4F6543B85F12321E79A9799107D7AEC012F56C65CB6A741E8ED5E2297D72A0). Existing MCP
  process still requires client reconnect.
  Task-Lab/capture/Compose and distributed lifecycle units remain in separate local branches.

- Async default queue claim/companion prerequisite accepted after753 tests/85files (542.28s),
  recursive typecheck/build. R2 renew/finish/session/Git and actual PostgreSQL remain open.
  Richer request-detail inputs/response/tools/files projection is newly active, separate from
  accepted queue source. Read latest master/worker briefs before assigning overlapping files.

- The user requested implementation of the remaining audit. [roadmap-completion.md](roadmap-completion.md) now owns active execution; its Current State supersedes the static audit below as work lands.
- Integrated Labs L1-L4, packaging, correctness/accounting/external/project/process follow-ups and reported panel regressions accepted at sourcee0aad08:701 tests, recursive typecheck/build, independent production browser/API and fresh outside-checkout package installation. Remaining L5/R2 and new configurable MCP final-supervisor ownership are active; read the master before dispatch. Actual4477 was not restarted.
- Next accepted source6d61b8e includes static browser checks/all-head evidence reuse, async Gate accounting and default-OFF MCP final-supervisor permission (bounded sub-supervisors remain allowed):734 tests/83files, recursive typecheck/build, production UI/MCP/model/Labs/legacy checks and fresh outside-checkout package install pass. Task-Lab lifecycle/async queue claims/Compose design continue in isolated worker trees. Actual4477/MCP remain untouched.

- Panel v2 U1-U3 and completion follow-up accepted; B2 budget UI implemented and accepted alongside it. Final supervisor checks: 622 tests, recursive typecheck/build, warning-free demo seed, 581 route checks, 40 anchors and independent live task/request/brain/budget DOM updates. See working documents and Git refs for integration state.
- Agent worktrees live under `.claude/worktrees/` (excluded from git locally).

## The user's live install (off limits to tests; use temp configs and `seed:demo`)

On2026-10-22 the user explicitly authorized rebuilding/restarting their panel. Accepted9682e92
was built and panel4477 restarted (PID6288). Read-only live browser checks confirmed default-OFF
final-supervisor setting, exact reported model link and populated Verification explanation;
config SHA256 remained97D0B30CA734B1CEDC595AAF1727C28B5617450B0C2309F4942D37AED941CB60.
Existing MCP process was not restarted. User briefly requested Facebook clone running for viewing,
then explicitly requested complete removal before a future fresh Next.js/Node.js build test.
Stopped verified serverPID12580; supported project deletion removed10 tasks,16 sessions,
38 artifacts,10 worktrees and9 brain files without problems. Billing/request audit and brain Git
history remain per deletion contract. Automatic approval review rejected permanent recursive
repository deletion as blocked by policy; safer Recycle Bin removal succeeded. Repository path
D:/SwitchYardProjects/facebook-clone is absent and8082 is not listening. Do not recreate it yet;
user wants a readiness update when router changes are complete, then will issue the fresh build.
Leave authorized panel4477 running. Automated tests still use temp/demo data, never user projects.

- Config `D:\SwitchYard\switchyard.config.yaml`, store `D:\SwitchYard\.switchyard\`, brain
  `C:\Users\mrjoh\.switchyard\brain`. One Ollama Cloud key (free plan) in the vault.
- Request caps raised for free models (T1 20, T2 60, T3 100, 150 per task attempt; review deep 12 /
  strict 16). The uncapped-default change is built and deployed to the panel: `supervise.max_model_requests`
  and `verification.max_total_requests_per_task` are null in the live config; finite worker tier
  and per-task limits remain. The original `switchyard.config.yaml.bak` was preserved, and a
  separate pre-change rollback snapshot was saved beside the live config. Panel 4477 was restarted
  on the new build and project task routes returned HTTP 200. The existing MCP process was not
  restarted; reconnect its client to load the new Router build. No live-provider job was run.
- Panel: `node packages/router/dist/cli.js panel` (port 4477; it also auto-starts from MCP use).
  The panel bundles router code: after router changes run `pnpm -r build` and restart the panel.
- MCP: Claude Code via the repo-root `.mcp.json` (git-excluded; VS Code keys local MCP config by a
  lower-case drive letter, so `claude mcp add --scope local` did not load); Codex via
  `[mcp_servers.switchyard]` in `~/.codex/config.toml` (global, `--project my-project`).
- Projects: `my-project` (`D:\my-app`), `tetris` (`D:\SwitchYardTests`, served on 8080),
  `pomodoro` (`D:\SwitchYardProjects\pomodoro`, 8081), `facebook-clone`
  (`D:\SwitchYardProjects\facebook-clone`, 8082). The demo servers are plain processes
  (`python -m http.server`, `node server.js`); nothing restarts them.
- No SwitchYard worker is running. A new MCP session (Claude Code or Codex) starts one, or run
  `node packages/router/dist/cli.js worker`.

## Efforts

| Effort | Document | State |
| --- | --- | --- |
| Live validation and fixes | [live-validation.md](live-validation.md) | Ongoing record of live runs (Tetris, Pomodoro, Facebook clone) and every fix they led to; open follow-ups listed there |
| Web search | [web-search.md](web-search.md) | W1-W3 done: backend pool (Ollama, Tavily, Brave, Exa, SearXNG), SSRF-guarded fetch, budgets; native search in model calls (OpenRouter, Anthropic, OpenAI) priced as paid. Live-checked on Ollama only |
| Caching and continuity | [caching-and-continuity.md](caching-and-continuity.md) | C1-C2 done: cache hints, endpoint stickiness, cached pricing, truncation recovery, prefix-stable compaction. Not checked live |
| Budget control | [budget-control.md](budget-control.md) | B1 done and merged (job request pool, `max_requests` on briefs, `request_more_budget` and decisions, delegate-only supervisors, `run_check` for implementers). B2 panel requests, approve/deny, pools and task grants accepted (622 integrated tests plus production demo/browser checks). Never run against a live job yet |
| Panel v2 | [panel-v2.md](panel-v2.md) | Complete: U1-U3 plus scoped brain navigation, Activity/link audit, repaired seed and full follow-up acceptance; 622 tests and production browser checks pass |
| Labs | [labs.md](labs.md) | L1-L4 accepted using documented defaults; static browser checks accepted; task-Lab lifecycle active, hydrated JS and Compose remain open |
| Projects | [projects.md](projects.md) | Done (J1-J3) plus deletion, repository auto-setup, panel power button |
| R2 (Postgres, several hosts) | [distributed-and-lab-extensions.md](distributed-and-lab-extensions.md) | Implementation authorized; async Gate ledger accepted, queue boundary active; PostgreSQL/multi-host not enabled or verified |
| npm packaging | [roadmap-completion.md](roadmap-completion.md) | Config discovery/setup/bundled panel accepted in fresh outside-checkout install; publication/cross-platform install not performed |

## Remaining-work audit (2026-10-22)

Audit method: reviewed indexed plans' Current State, phases/acceptance and open questions,
cross-checked later live-validation/Panel v2 evidence, and inspected selected source/test
boundaries. This is a consolidated document audit, not a fresh end-to-end test of every gap.
No code changed or provider tests ran during this audit. Start correctness follow-ups with
reproductions before changing implementations; keep parked decisions separate from approved work.

Panel v2 U1-U3, its reopened completion audit, budget B1/B2 and the supervisor-recovery plan
annotation are implemented and accepted. Earlier next-step lists that still name those tasks
are stale. Passing their acceptance does not close the entire roadmap.

### Unimplemented features and follow-ups

- **Labs L1-L4:** lab recipes, isolated branches/worktrees/data and allocated ports; service
  readiness/restart/adoption/idle teardown; team/MCP integration; refresh/promotion queue and
  conflict handling; panel/editor/controls/docs. All remain planned, not started. The four
  lane semantics questions in labs.md still await answers or acceptance of its defaults.
- **Labs L5 (later):** browser checks, per-task ephemeral labs and Docker Compose. This is
  explicitly future scope, not an implemented phase.
- **External runners:** OpenCode/command runners lack run_check and request_more_budget.
- **Cache accounting:** Anthropic cache-write premium is not modelled separately; the caching
  plan records potentially understated settled cost. Live pricing confirmation is also pending.
- **npm distribution:** default config discovery/location, bundled or separately shipped panel,
  and one-step setup. No implementation plan yet; handoff reserves packaging for user request.
- **R2:** Postgres and multiple worker hosts remain explicitly parked, not started.
- **Session/team correctness follow-ups** (`agent-sessions-and-teams.md:94-103`): parent
  allowed_paths do not constrain sub-jobs; a batch runner failure can discard already-finished
  member results; external runner TASK.md context omits inline text/file refs; a dead session
  remains without Resume until recovery runs. These are recorded gaps, not completed acceptance.
- **Provider follow-ups** (`direct-providers.md:42-63`): served-model quarantine has no recovery;
  preferred paid-route cooldown ordering; injectable price fetching; registry-driven local
  provider metadata/free-quota handling; richer parameter-source/quantization/trained-context
  catalog metadata and clearer no-key Ollama validation. The old missing-providers config
  expansion issue is superseded by the project settings rewrite.
- **Project/restore follow-ups** (`projects.md:47-66`): a brain restore failure can leave the
  store already restored; strict repository alias matching can reject natural-language aliases;
  archived project name/read-only presentation and repository setup hints need refinement.
  Generic settings edits prepare repository paths on the next reload/overview rather than save.

### Implemented, with validation still outstanding

- Delegation-heavy real-provider run of new budget approval/resume, delegate-only supervisors,
  run_check, nested teams and integration behavior; fake-provider/demo coverage is complete.
- Budget CLI commands and MCP budget tools over an actual transport.
- Real-provider cache hints/stickiness/continuation/compaction and cache savings/accounting;
  verification/reviewer/calibration behavior beyond scripted providers.
- Other provider adapters and rate-limit/billing behavior, paid routes, non-Ollama search
  backends and native search. Ollama discovery, free calls and web search/fetch already have
  live evidence; old documents claiming no provider was ever called are stale.
- OpenCode live integration; ChatGPT MCP connection through a tunnel; native service installation
  on real Windows/Linux hosts; project deletion while another process uses the store.
- Large-store live watcher performance has no benchmark. Historical suite timing sensitivity
  remains a monitoring item; the reproduced promotion shutdown race was fixed and regression-tested.
- Genuine concurrent-process claim, promotion/scan, same-session resume, provider-slot and
  same-branch integration races; real kills while holding a slot or mid-integration; wait expiry
  into deferral; paid contention/carving; nesting beyond depth two; redundancy/batch crash
  boundaries; external-runner repair/resume and reset-edits against Git. Existing tests already
  cover simulated merge/replay and side-effect faults plus a real native-worker kill/restart;
  this list must not be read as claiming that recovery has no test coverage.
- T3's measured team-throughput advantage on the evaluation suite is not established by the
  scripted metrics tests or the demo comparison. Verification also records untested external
  repair, batch review and failed-audit behavior, and noisy shared-branch escaped-defect attribution.

No live calls or deployment are authorized by this audit alone. Provider checks need a stated
budget and appropriate credentials; paid routing requires explicit authorization. Use isolated
test installs rather than the user's real store for destructive/fault validation.

## Known gaps and risks

- Integration bugs between parts written by different agents pass unit tests and show up only in a
  browser (two in the Facebook clone); labs L5 browser checks are the planned answer.
- The OpenCode and command coding runners lack `run_check` and `request_more_budget`.
- Historical full-suite timing sensitivity: batching and daemon stop. The concrete promotion
  shutdown race is fixed (tracked/drained settlement); final integrated suite passed 622/622.
- Windows: bash heredocs mangle backslash escapes; use the edit tool or a script file.
