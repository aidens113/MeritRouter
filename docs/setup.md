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

```bash
node packages/router/dist/cli.js init .     # writes switchyard.config.yaml and models.yaml
```

Edit `switchyard.config.yaml`:

- `repositories`: the repositories workers may read (and, for `implement`, edit).
- `discovery.free_platforms`: the FreeLLMAPI platforms that are free tiers **on your accounts**
  (for example `groq`, `nvidia`, `google`). Nothing is treated as free unless declared here or
  priced at $0 by OpenRouter.

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
in a terminal; any number of processes can share the store.

## 5. Coding workers (OpenCode)

Install OpenCode (https://opencode.ai) so `opencode` is on PATH. SwitchYard launches it with an
inline config that allows only the job gateway as a provider, isolated HOME/XDG directories, and
no inherited provider keys. Shell commands are denied unless listed in `coding.allowed_commands`.
Any other agent can be used with `coding.runner: command`; it receives `SWITCHYARD_BASE_URL`,
`SWITCHYARD_JOB_TOKEN`, `SWITCHYARD_MODEL`, and `SWITCHYARD_PROMPT_FILE`.

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
