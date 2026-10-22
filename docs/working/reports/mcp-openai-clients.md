# Report: mcp-openai-clients

Worktree: `D:\SwitchYardRouter\.claude\worktrees\agent-ad1c142c37c069c15`, branch `feat/mcp-clients`
(fast-forwarded from d735298 to 6afc11e, the brief's commit, before any edit; nothing committed).

## Outcome

Done. One gap from the brief (a contradiction, not a skipped step): ChatGPT cannot send a bearer
token, so the token is also accepted as the last part of the URL. See Open questions.

## What changed and why

- `packages/router/src/mcp/tools.ts` (new): `buildMcpServer({ sy, cfg, project })` registers all
  34 tools. They moved verbatim from `mcp.ts`, except that `submit_tasks.tasks` items use
  `TaskArgumentSchema`. Each HTTP session gets its own McpServer (an McpServer serves one
  transport), and every session shares one Switchyard.
- `packages/router/src/mcp/schemas.ts` (new): `TaskArgumentSchema`. The old
  `z.record(z.string(), z.unknown())` emitted `propertyNames` and `additionalProperties: {}`.
  Codex reads a schema node without a type as a string, so every task field would have been typed
  as a string. The new schema is a loose object that names the main task fields (profile enum,
  goal, constraints.acceptanceCriteria, context.fileRefs, and others) and carries
  `additionalProperties: true` (zod `.meta`). Unknown keys still pass through to `WorkerTaskSchema`,
  which validates strictly, and the test checks that a `bogusField` is still refused.
- `packages/router/src/mcp/http.ts` (new): the Streamable HTTP transport on `node:http` with
  stateful sessions, path `/mcp`.
  - With `SWITCHYARD_MCP_TOKEN` set, every request needs `Authorization: Bearer <token>` or the
    URL `/mcp/<token>`. The comparison is constant-time (sha256 + timingSafeEqual). A failure gets
    401 with `WWW-Authenticate`.
  - Without a token, the server refuses to listen on a non-loopback host. It also returns 403 to
    any request whose Host or Origin is not a loopback name, which blocks DNS rebinding and keeps
    a tunnel from exposing a tokenless server.
  - A request for an unknown session gets 404. Bodies are capped at 32 MB. `--port 0` picks a free
    port.
- `packages/router/src/mcp/serve.ts` (new):
  - `MCP_FLAGS`, `mcpOptions(values)`, `parseMcpArgv(argv)`, `runMcpServer(opts, env)`.
  - Project choice, recovery, and the panel keepalive are the same as before.
  - The unsafe-host check runs before the config or the database is opened.
  - The promise resolves after `sy.close()`. On stdio, closing stdin ends the server; on HTTP,
    only SIGINT or SIGTERM do.
  - Defaults: host 127.0.0.1, port 4478. `--host` or `--port` alone imply `--http`.
- `packages/router/src/mcp.ts`: now an 18-line bin wrapper. `dist/mcp.js` keeps working with the
  old flags.
- `packages/router/src/cli.ts`: adds the `no-worker`, `http`, `host`, and `port` options. `switchyard mcp` is dispatched
  before `loadConfig` and the CLI's own Switchyard, and returns 0 when the server stops.
- `packages/router/src/cli/help.ts`: `mcp` entry under Setup.
- `packages/router/tests/mcp.test.ts`:
  - A portable-schema check runs over every tool. It allows only portable keywords, requires every
    node to have a type or anyOf and every array to have items, and requires `additionalProperties`
    to be a boolean when present.
  - Empty inputs are objects.
  - Unknown task keys are still refused.
  - A new test runs `cli.js mcp` over stdio.
- `packages/router/tests/mcp-http.test.ts` (new, 4 tests):
  - access policy unit checks;
  - a loopback server without a token: 34 tools listed, a call works, `submit_tasks` works, and a
    foreign Host or Origin gets 403;
  - a token server: missing or wrong token gets 401, the bearer and path forms both work, and any
    Host is accepted when the token is right;
  - `--host 0.0.0.0` without a token exits 1 with the message, and nothing is bound.
- `docs/setup.md` section 4 is now "Connect an MCP client". It explains the transports, the token,
  and project choice, with subsections for Claude Code (including the `.mcp.json` path-spelling
  pitfall from Current State), Codex (stdio and HTTP, with the resulting TOML), and ChatGPT
  developer mode (token, tunnel via cloudflared or ngrok, connector URL `/mcp/<token>`, "No
  authentication", and the risks).

## Commands run and observed results

- `git merge --ff-only 6afc11e` -> "Fast-forward", 6 files.
- `pnpm install --frozen-lockfile` -> "Done in 1m 34s". It warned about the `switchyard` bin
  because `dist/` was not built yet.
- `pnpm -r typecheck` -> `packages/router typecheck: Done`, `apps/panel typecheck: Done`.
- `pnpm -r build` -> router built; panel `build: Done` (route list printed).
- `npx vitest run tests/mcp.test.ts tests/mcp-http.test.ts` -> `Tests 6 passed (6)`.
- `npx vitest run` (full router suite):
  - first run: `Tests 2 failed | 500 passed (502)`. One failure was at `tests/resilience.test.ts:37`
    in the helpers' cleanup `rmSync` (Windows file lock, under load). I did not capture the
    second one.
  - rerun: `Test Files 53 passed (53)`, `Tests 502 passed (502)`.
  - `tests/resilience.test.ts` alone: `11 passed (11)`.
- Codex, with `CODEX_HOME` in the scratchpad (`codex-check\codex-home`), on a temp config
  (`codex-check\install`, brain `brain`, storage `.switchyard`, panel port 4999, auto_start off):
  - Binary: `codex-cli 0.162.0-alpha.17.2`.
  - `codex mcp add switchyard -- node <worktree>/packages/router/dist/cli.js mcp --config <temp> --project demo`
    -> "Added global MCP server 'switchyard'".
  - `codex mcp list` -> `switchyard  node ... mcp --config ... --project demo  enabled  Unsupported`.
  - `codex mcp get switchyard` -> `transport: stdio`, with the command and args.
  - `codex mcp add switchyard-http --url http://127.0.0.1:4588/mcp --bearer-token-env-var SWITCHYARD_MCP_TOKEN`
    -> listed as `streamable_http`, `auth_status: bearer_token`.
  - Beyond the brief: `codex app-server` over JSON-RPC (`initialize`, then `mcpServerStatus/list`;
    no model request, no login) with an HTTP server running on port 4588 with a token. Codex
    launched the stdio server and connected to the HTTP one: `switchyard tools: 34`,
    `switchyard-http tools: 34 auth: bearerToken err: null`. The server logged `serving project
    demo at http://127.0.0.1:4588/mcp (requests must carry SWITCHYARD_MCP_TOKEN)`. I stopped it
    afterwards.
  - Every Codex warning was only "could not create PATH aliases under temporary dir".
  - `~/.codex` and the Claude configuration were not touched.
- Schema dump before and after (a temporary test, since deleted):
  - before: keywords included `propertyNames` and `additionalProperties: {}`;
  - after: none, and all 7 `additionalProperties` are `true`.

## Not verified

- ChatGPT itself: no tunnel, no ChatGPT account. The path-token route was tested only with the
  SDK client on loopback.
- Codex model-side use of the tools (no model requests were allowed). Its reduced JSON Schema
  handling, that a node without a type becomes a string, comes from my knowledge of Codex's
  `sanitize_json_schema`, not from its source in this session.
- Binding a non-loopback address with a token. It was not run, to avoid a Windows firewall prompt.
  The token check is the same code path and was tested on loopback with a foreign Host header.
- Graceful SIGINT shutdown on HTTP: Windows tests kill the child process.
- The panel was not started or screenshotted; this brief has no panel change.

## Open questions or contradictions found

1. **ChatGPT cannot send a bearer token.** OpenAI's auth guide
   (developers.openai.com/plugins/build/auth) says ChatGPT supports OAuth 2.1 or no auth, and
   "cannot present custom API keys". So I added the `/mcp/<token>` path form and documented "No
   authentication" plus the token URL. The alternative is real OAuth, a larger change. The
   supervisor should accept or replace this, and may record it in decisions.md, which I do not own.
2. **A pre-existing panel hazard (from a6ccc06, now in my `serve.ts`).** The server's start calls
   `ensurePanel(cfg, { force: true })`, which starts the panel even with `panel.auto_start: false`.
   - The test config sets no `panel.port`, so it uses 4477. MCP tests pass `disabled|running` only
     because the user's real panel answers on 4477.
   - On a machine with a built panel and nothing on 4477, an MCP test would spawn a detached
     panel against a temp config.
   - The fix belongs in `tests/helpers.ts` (a spare port) or in whether a session start should
     honour auto_start. Neither is mine to change; I kept the behaviour.
3. Attribution still says Claude Code for every client:
   - `answer_question` records `"claude-code"`;
   - the brain actor and effort are `supervisor:claude-code` / `claude-code`;
   - `accept_result` already uses `mcp:<client name>`.

   Changing the effort would move working documents, so I left it. Codex answers are recorded as
   claude-code.
4. HTTP sessions are never expired. Each one holds a small McpServer until the client sends DELETE
   or the process stops.
