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
- Token accounting (user request): new input (input minus cached) is reported beside the total
  with cached, per task, in usage summaries, the panel, and the CLI. The Tetris job read 143k
  input tokens, 128k of them from Ollama's cache.
- 1ba099c panel auto-start: the MCP server and `switchyard worker` start the panel when
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

## Worker Briefs

### Brief: projects-delete-panel-power
- Repository: this repository; your own worktree on branch `feat/panel-controls`; run
  `pnpm install --frozen-lockfile` first. Two other workers edit other files at the same time.
- Task 1, delete a project (user request): router `previewProjectDeletion(sy, slug)` (counts:
  tasks, sessions, brain entries, worktrees) and `deleteProject(sy, slug, { confirm })`
  (`confirm` must equal the slug). Refuse while it has running or queued tasks, and refuse the
  last live project. Remove `projects.<slug>` through the config editor (backup kept); delete its
  per-project rows, session logs, artifacts, and SwitchYard worktrees (`git worktree remove`;
  keep branches); remove `projects/<slug>/` from the brain with a commit. Keep request, charge,
  and paid-spend rows for accounting (unlink them from the project). Never touch repository
  folders. New code in `src/projects/`, exposed through `src/admin/projects.ts`. CLI:
  `switchyard projects delete <slug> --confirm <slug>`.
- Task 2, panel: a Danger zone on the project settings page; "Delete project" opens modal 1
  (what is removed and what is kept, with the counts; Continue), then modal 2 (type the slug;
  red "Delete permanently"); `DELETE /api/projects/<slug>`; then go to `/`. Reuse
  `components/client/confirm-dialog.tsx`.
- Task 3, power button (user request) in the shell's top bar: a confirm dialog ("Agents keep
  running; the panel starts again when a new agent session begins or you run `switchyard
  panel`"); `POST /api/panel/stop` calls `markPanelStopped` (operations/panel.ts, on dev) and
  exits the process after responding; the page then shows a static "Panel turned off".
- Task 4, root cause: the panel build bundles router code although `next.config.ts` lists
  `switchyard-router` in `serverExternalPackages` (built chunks contain router strings), so a
  router change needs a panel rebuild. Make it external; if Turbopack cannot, make
  `ensurePanel` and `doctor` report a panel build older than the router's `dist/`.
- Owns: `packages/router/src/{admin/projects.ts,projects/**,operations/panel.ts,brain/**}`,
  `packages/router/src/cli/projects.ts`, `packages/router/tests/**` (new files or tests of these),
  `apps/panel/**` except the files the caching brief owns, `docs/operations.md`,
  `docs/working/reports/projects-delete-panel-power.md`.
- Must not touch: `src/{mcp.ts,cli.ts,cli/help.ts}` (put help text in your report), the
  caching brief's files, `docs/setup.md`, `docs/decisions.md`, this document.
- Definition of done: tests for refusal, confirm mismatch, what is deleted and kept, and the stop
  route; `pnpm -r typecheck`; full router suite; `pnpm -r build`; demo panel on a spare port
  (never 4477 or the user's config): both modals and the power button screenshotted at desktop
  and phone widths, light and dark; panel stopped afterwards.
- Report to: docs/working/reports/projects-delete-panel-power.md

### Brief: mcp-openai-clients
- Repository: this repository; your own worktree on branch `feat/mcp-clients`; run
  `pnpm install --frozen-lockfile` first. Two other workers edit other files at the same time.
- Task: make SwitchYard's MCP server usable from Codex and ChatGPT as well as Claude Code.
  Split `src/mcp.ts` into building the server and choosing a transport: stdio (default) and
  Streamable HTTP (`--http`, `--host` default 127.0.0.1, `--port` default 4478, path `/mcp`; a
  bearer token from `SWITCHYARD_MCP_TOKEN` is required whenever the host is not loopback,
  optional on loopback). Add `switchyard mcp [same flags]` to the CLI so an installed package
  needs no dist path. Check every tool's input schema suits OpenAI clients (no unsupported JSON
  Schema features; empty schemas are objects). No config-schema changes: flags and env only.
- Verify with Codex without touching the user's real Codex setup: the bundled binary
  `C:/Users/mrjoh/.vscode/extensions/openai.chatgpt-26.1007.21434-win32-x64/bin/windows-x86_64/codex.exe`
  with `CODEX_HOME` set to a temp folder: `codex mcp add` the stdio server on a temp test config,
  then `codex mcp list` and `get`. Make no model requests. ChatGPT needs a remote HTTPS URL:
  test the HTTP transport with the MCP SDK's Streamable HTTP client, and document the tunnel
  route and token for ChatGPT developer mode.
- Owns: `packages/router/src/{mcp.ts,cli.ts,cli/help.ts}`, new files under `src/` for the
  server split (not `operations/panel.ts`, which you only call), `packages/router/tests/mcp*.test.ts`,
  `docs/setup.md`, `docs/working/reports/mcp-openai-clients.md`.
- Must not touch: the other briefs' files, `docs/operations.md`, `docs/decisions.md`, this document.
- Definition of done: stdio and HTTP tests (tools listed, a call works, the token enforced off
  loopback); Codex lists the server with a temp `CODEX_HOME`; `pnpm -r typecheck`; full router
  suite; `pnpm -r build`; setup.md has Claude Code, Codex, and ChatGPT sections.
- Report to: docs/working/reports/mcp-openai-clients.md

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
