# Setup

Local, single user. Tested on Windows 10 with Node 22.11; Linux/WSL use the same commands.

## 1. Install

```bash
git clone https://github.com/aidens113/SwitchYardRouter.git
cd SwitchYardRouter
pnpm install
pnpm -r build
```

Node 22.11 works; 22.12+ or 24 LTS is recommended.

## 2. Run FreeLLMAPI

Install and start FreeLLMAPI (https://github.com/tashfeenahmed/freellmapi) on
`http://localhost:3001`. Add your provider keys in its dashboard or later from the SwitchYard
panel (Keys). Then collect two credentials:

- **Unified API key** (inference): FreeLLMAPI dashboard, Settings, API key.
- **Dashboard session token** (admin API: catalog, chains, keys): `POST /api/auth/login` with
  your dashboard credentials; the token lasts 30 days.

Keep FreeLLMAPI's routing strategy off `decision` (that strategy sends prompts to an extra model).

## 3. Configure SwitchYard

Pick a preset (see [roles.md](roles.md) for what each role does):

| Preset | Supervisor | Workers | Paid |
| --- | --- | --- | --- |
| `claude-code` (default) | Claude Code, over MCP | free | off |
| `standalone-free` | SwitchYard, on the best free model | free | off |
| `standalone-hybrid` | SwitchYard, on a paid model you set | free; paid fallback at T3 | supervisor, T3 fallback |
| `standalone-paid` | SwitchYard, on a paid model | paid preferred at T2-T3, premium for T4 | on, budgeted |

```bash
node packages/router/dist/cli.js init . --preset claude-code   # writes switchyard.config.yaml and models.yaml
```

Edit `switchyard.config.yaml`:

- `repositories`: the repositories workers may read (and, for `implement`, edit).
- `discovery.free_platforms`: the FreeLLMAPI platforms that are free tiers **on your accounts**
  (for example `groq`, `nvidia`, `google`). Nothing is treated as free unless declared here or
  priced at $0 by OpenRouter.
- `brain.project` (and optionally `brain.path`, default `~/.switchyard/brain`, shared across
  projects). Mount an existing `docs/working/` folder with `brain.mounts` if you have one.
- Standalone and paid presets: set the paid model id and **current prices** in `paid.models` and
  `supervisor.endpoints`, then add keys (secrets are read from the environment, never typed on
  the command line):

  ```bash
  SWITCHYARD_NEW_KEY=sk-... node packages/router/dist/cli.js keys add anthropic --label main --billing paid_credits --balance 20
  ```

Set the credentials as environment variables (never in the config file):

```powershell
# PowerShell (current session); use setx for persistence
$env:FREELLMAPI_API_KEY = "freellmapi-..."
$env:FREELLMAPI_ADMIN_TOKEN = "..."
$env:SWITCHYARD_CONFIG = "D:\path\to\switchyard.config.yaml"
```

```bash
export FREELLMAPI_API_KEY=freellmapi-... FREELLMAPI_ADMIN_TOKEN=... SWITCHYARD_CONFIG=/path/to/switchyard.config.yaml
```

Then:

```bash
node packages/router/dist/cli.js doctor        # every line should say ok
node packages/router/dist/cli.js models scan   # discover models, resolve params, sync chains
node packages/router/dist/cli.js models        # review; confirm "pending" models
node packages/router/dist/cli.js models confirm groq/some-model --params 70
node packages/router/dist/cli.js route implement T2   # who would serve this, and why
```

## 4. Register the MCP server with Claude Code

Run from the project you want Claude to work in. Paths are examples. The server reads
`SWITCHYARD_CONFIG` (or pass `--config`).

```powershell
claude mcp add --transport stdio --scope local switchyard -- node "D:/SwitchYardRouter/packages/router/dist/mcp.js" --config "D:/path/to/switchyard.config.yaml"
```

```bash
claude mcp add --transport stdio --scope local switchyard -- node /abs/SwitchYardRouter/packages/router/dist/mcp.js --config /abs/path/switchyard.config.yaml
```

Check with `claude mcp get switchyard` and `/mcp` inside Claude Code. Merge
`packages/router/examples/CLAUDE.delegation.md` into the project's `CLAUDE.md`.

This only adds tools. Claude Code keeps its own login and model; nothing intercepts native
Claude requests.

The MCP process runs the worker loop, so tasks run while the Claude Code session is open. For
work that should continue after closing Claude, run `node packages/router/dist/cli.js worker`
in a terminal; any number of processes can share the store. To keep a worker running across
crashes and logins, use `switchyard daemon` (restarts the worker with backoff; logs under
`.switchyard/logs/`) or install it as a user service with `switchyard service install`
(systemd user unit, launchd agent, or a Windows scheduled task at logon; `--dry-run` prints the
definition first, `service status` / `service uninstall` manage it).

## 5. Coding workers

The default `coding.runner: native` is SwitchYard's own harness: edits are confined to
`allowedPaths` by the tools themselves and each editing response is committed under the agent's
identity. Shell commands are available only for patterns in `coding.allowed_commands`.

Alternatives: `runner: opencode` (install OpenCode so `opencode` is on PATH; it runs with an inline
config whose only provider is the job gateway, isolated HOME/XDG directories, and no inherited
provider keys) or `runner: command` for any other agent, which receives `SWITCHYARD_BASE_URL`,
`SWITCHYARD_JOB_TOKEN`, `SWITCHYARD_MODEL`, and `SWITCHYARD_PROMPT_FILE`.

## 5b. Standalone jobs

With a standalone preset, give SwitchYard a whole goal:

```bash
node packages/router/dist/cli.js worker &                         # or keep the MCP server running
node packages/router/dist/cli.js run "Add CSV export to the report page" --repo app --check "npm test"
node packages/router/dist/cli.js job <id>                         # workers, branch, questions
node packages/router/dist/cli.js answer <question-id> "use semicolons"
git -C path/to/app merge --no-ff switchyard/job-<id>               # after you review the branch
```

## 6. Web panel

```bash
pnpm --filter switchyard-router build
SWITCHYARD_CONFIG=/path/to/switchyard.config.yaml pnpm --filter switchyard-panel start   # http://127.0.0.1:4477
```

It binds to 127.0.0.1. Set `SWITCHYARD_PANEL_TOKEN` to require a login.

## 7. Qualify models (optional, uses free quota)

```bash
node packages/router/dist/cli.js qualify openrouter/vendor/model:free --trials 3
node packages/router/dist/cli.js qualify status
```

A running worker executes and grades the runs. Set `qualification.required: true` once your
models have results.
