# Live validation

- **Owner:** senior supervisor agent
- **Status:** Active
- **Scope:** First runs against real providers and a real Claude Code client: what broke, what was
  fixed, what is still open. Each finding names its commit.
- **Started:** 2026-10-21

## Current State

**Environment (2026-10-21):** the user's install at `D:\SwitchYard` (config
`switchyard.config.yaml`, standalone-free preset, paid routing off), one Ollama Cloud key
(`free_tier`, free plan), projects `my-project` (`D:\my-app`) and `tetris` (`D:\SwitchYardTests`).
Claude Code reaches SwitchYard through a project `.mcp.json` at the repository root, excluded
from git locally (`.git/info/exclude`): the `claude mcp add --scope local` entry is keyed
`D:/SwitchYardRouter` while VS Code opens `d:\SwitchYardRouter`, so it never loaded.

**Verified live:**
- Ollama Cloud discovery: 22 models, exact parameter counts and contexts from `/api/show`.
- A standalone Tetris job (`t_0mviuxwvqa4f3a521f085`, supervisor on `ollama-cloud/beam`) completed
  in 47 s with 13 requests: it wrote index.html, style.css, game.js, README.md itself (no
  delegation), passed `node --check game.js`, and left the job branch for review. Played in
  headless Chrome: loads without errors (only a favicon 404), pieces, ghost, next preview, game
  over, and restart work. Merged into `D:\SwitchYardTests` master and served at
  http://127.0.0.1:8080 (python http.server, detached).
- `switchyard panel` started the real panel on 4477; pages answer 200.

**Fixed (all on dev):**
- f26f932: hosted Ollama has no `num_ctx`/`/api/ps`: use `model_info.<arch>.context_length`
  (every model had been "context limit unknown"). Adding or re-keying a key lists its models.
- cab760a, 77f2762: a 402 "not included in your free usage" or a 403 "being rolled out ... not yet
  available to you" is `not_in_plan` for that model, not the key out of credits or invalid (the
  first Tetris job failed because the key was disabled for six hours).
- 398f29f: routing leaves out a model every usable key's plan refused (preview and requests).
- 04a5616: status showed a supervisor's tier cap (12) instead of its profile cap (60): "14/12".
- (this commit) panel auto-start: the MCP server and `switchyard worker` start the panel when
  nothing answers on `panel.port`; `switchyard panel`; MCP `panel` tool; URL in the server's
  instructions.

**Ollama Cloud free plan (probed 2026-10-21, one 1-token request per model):** included: beam,
minimax-m3.1-flash, nemotron-3-super, gpt-oss:120b (all >= 100B), gemma4:31b,
nemotron-3-nano:30b, gpt-oss:20b, nemotron-3-ultra (context unreported, so unused). Refused (402):
12 others. mistral-large-4: 403 rolling out. Plans change: SwitchYard rechecks a refusal after a day.

**Open:**
- Packaging for npm (user question): no `switchyard mcp` command, no default config location,
  the panel is not in the package, no one-step Claude setup. Needs a plan before caching.
- The supervisor did all the work itself rather than delegating; fine for a small job, untested
  for larger ones on free models.
- The failed first job left branch `switchyard/job-t_0mviuljha00e255d946d0` and its worktree.
- Line clearing in the Tetris game was reviewed in code, not exercised in the browser.

**Next steps:** a delegation-heavy live job; the packaging plan; then caching-and-continuity.

**Blockers:** none.

---

## Work Ledger

### 2026-10-21 — first live runs, fixes as found
- Agent: senior supervisor (no workers)
- Changed: see Current State, Fixed.
- Why: the user's first MCP test (Tetris) failed; the user asked to fix SwitchYard while running it.
- Validation: `pnpm -r typecheck` (router and panel Done); `npx vitest run` `Tests 495 passed
  (495)`; panel build checked in a separate worktree for f26f932; live: model scan, plan probe,
  Tetris job completed, game played headlessly, `switchyard panel` started the real panel.
- Outcome: Accepted

---

## Open Questions

- Packaging: should the panel ship inside the npm package (prebuilt standalone) or as a second
  package? See Open in Current State.
