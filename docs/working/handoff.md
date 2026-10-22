# Handoff: state of every effort (2026-10-22)

Written for the next agent (Codex or Claude Code) picking this repository up cold. Read this,
then `AGENTS.md`, then the `Current State` of the effort you work on. Every effort below has its
own working document with decisions, phases, ledger, and reports.

## Repository state

- `dev` and `main` hold everything finished (last merge: budget control, `7f8d2df`).
  `pnpm -r typecheck` and `pnpm -r build` pass on `dev`; the router suite passed 587 tests on the
  merged budget-control branch.
- `feat/panel-v2` (pushed) holds unfinished, unverified panel work (`f24b9ae`); see Panel v2 below.
  It is not merged. Its worktree may still exist at `.claude/worktrees/agent-a443248d6e5862bf6`.
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
| Budget control | [budget-control.md](budget-control.md) | B1 done and merged (job request pool, `max_requests` on briefs, `request_more_budget` and decisions, delegate-only supervisors, `run_check` for implementers). B2 (panel UI for requests and pools) not started. Never run against a live job yet |
| Panel v2 | [panel-v2.md](panel-v2.md) | Stopped mid-way by the user. U1 (server-sent live updates) appears built; U2 (calmer layout: tabs, disclosures, grouped sidebar) partly done; U3 (entity pages: agents, repositories, commits, requests, Related panels) not started. On `feat/panel-v2`, unverified |
| Labs | [labs.md](labs.md) | Planned (L1-L5); waiting on the user's answers to four questions about FluxIQ's lanes (or "use the defaults") |
| Projects | [projects.md](projects.md) | Done (J1-J3) plus deletion, repository auto-setup, panel power button |
| R2 (Postgres, several hosts) | [agent-sessions-and-teams.md](agent-sessions-and-teams.md) | Parked; the user has not answered whether to do it |
| npm packaging | (no document yet) | Open: `switchyard mcp` exists; still no default config location, no panel in the package, no one-step setup |

## What to do next (in order, each needs the user's go-ahead where noted)

1. Panel v2: merge `dev` into `feat/panel-v2`, finish U2 and U3 against the map in
   `docs/working/reports/panel-v2.md` (on that branch), then the panel validation in `AGENTS.md`
   (demo data on a spare port, screenshots desktop and phone, light and dark).
2. Budget control B2 (panel for budget requests) once panel v2 has landed (same files).
3. A live team job on the user's install to exercise budget control, `run_check`, and the
   delegate-only supervisor (spends free Ollama quota: state the budget first).
4. The job page's plan should show "failed; finished by the supervisor" for segments the supervisor
   completed itself (follow-up in live-validation.md).
5. Labs L1 after the user answers labs.md's Open Questions; R2 and npm packaging only on request.

## Known gaps and risks

- Integration bugs between parts written by different agents pass unit tests and show up only in a
  browser (two in the Facebook clone); labs L5 browser checks are the planned answer.
- The OpenCode and command coding runners lack `run_check` and `request_more_budget`.
- Three tests are timing-sensitive under full-suite load (`projects-brain` promotion review,
  `session-recording` batching, `operations` daemon stop); they pass alone and on rerun.
- Windows: bash heredocs mangle backslash escapes; use the edit tool or a script file.
