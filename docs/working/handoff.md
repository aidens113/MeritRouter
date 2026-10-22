# Handoff: state of every effort (2026-10-22)

Written for the next agent (Codex or Claude Code) picking this repository up cold. Read this,
then `AGENTS.md`, then the `Current State` of the effort you work on. Every effort below has its
own working document with decisions, phases, ledger, and reports.

## Repository state

- The user requested implementation of the remaining audit. [roadmap-completion.md](roadmap-completion.md) now owns active execution; its Current State supersedes the static audit below as work lands.
- Integrated Labs L1-L4, packaging, correctness/accounting/external/project/process follow-ups and reported panel regressions accepted at sourcee0aad08:701 tests, recursive typecheck/build, independent production browser/API and fresh outside-checkout package installation. Remaining L5/R2 and new configurable MCP final-supervisor ownership are active; read the master before dispatch. Actual4477 was not restarted.
- Next accepted source6d61b8e includes static browser checks/all-head evidence reuse, async Gate accounting and default-OFF MCP final-supervisor permission (bounded sub-supervisors remain allowed):734 tests/83files, recursive typecheck/build, production UI/MCP/model/Labs/legacy checks and fresh outside-checkout package install pass. Task-Lab lifecycle/async queue claims/Compose design continue in isolated worker trees. Actual4477/MCP remain untouched.

- Panel v2 U1-U3 and completion follow-up accepted; B2 budget UI implemented and accepted alongside it. Final supervisor checks: 622 tests, recursive typecheck/build, warning-free demo seed, 581 route checks, 40 anchors and independent live task/request/brain/budget DOM updates. See working documents and Git refs for integration state.
- Agent worktrees live under `.claude/worktrees/` (excluded from git locally).

## The user's live install (off limits to tests; use temp configs and `seed:demo`)

- Config `D:\SwitchYard\switchyard.config.yaml`, store `D:\SwitchYard\.switchyard\`, brain
  `C:\Users\mrjoh\.switchyard\brain`. One Ollama Cloud key (free plan) in the vault.
- Request caps raised for free models (T1 20, T2 60, T3 100, 150 per task attempt, 300 total,
  supervise 300, review deep 12 / strict 16); a backup of the earlier config is
  `switchyard.config.yaml.bak` next to it.
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
