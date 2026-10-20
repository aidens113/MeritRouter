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

## 2. Start the panel

```bash
node packages/router/dist/cli.js init . --preset claude-code   # writes switchyard.config.yaml and models.yaml
SWITCHYARD_CONFIG=$PWD/switchyard.config.yaml pnpm --filter switchyard-panel start   # http://127.0.0.1:4477
```

```powershell
$env:SWITCHYARD_CONFIG = "D:path	oswitchyard.config.yaml"   # use setx for persistence
pnpm --filter switchyard-panel start
```

`--preset` chooses who supervises and what may be paid (see [roles.md](roles.md) for each role):

| Preset | Supervisor | Workers | Paid |
| --- | --- | --- | --- |
| `claude-code` (default) | Claude Code, over MCP | free | off |
| `standalone-free` | SwitchYard, on the best free model | free | off |
| `standalone-hybrid` | SwitchYard, on a paid model you set | free; paid fallback at T3 | supervisor, T3 fallback |
| `standalone-paid` | SwitchYard, on a paid model | paid preferred at T2-T3, premium for T4 | on, budgeted |

The panel binds to 127.0.0.1. Set `SWITCHYARD_PANEL_TOKEN` to require a login. Nothing else has
to be installed or running: SwitchYard calls each provider's API itself.

## 3. Add provider keys

Get a key from each provider you want to use (Groq, Google AI Studio, NVIDIA, OpenRouter,
Mistral, Cerebras, Cohere, Cloudflare Workers AI, SambaNova, Together, Hugging Face, Anthropic,
OpenAI), then add it in one of three ways:

- **Panel**: Provider keys, pick the provider, paste the key, Test (lists the models it can
  use), choose the billing class and optional limits, save. Keys are stored encrypted.
- **CLI**: the secret comes from `SWITCHYARD_NEW_KEY` or a hidden prompt, never from the
  command line, and is stored encrypted in the same vault:

  ```bash
  SWITCHYARD_NEW_KEY=gsk_... node packages/router/dist/cli.js keys add groq --billing free_tier --label main
  node packages/router/dist/cli.js keys add mistral --billing free_tier --test   # prompts; stores only if the key lists models
  node packages/router/dist/cli.js keys add cloudflare --billing free_tier --account-id <account id>
  node packages/router/dist/cli.js keys list    # source, billing class, status, last four only
  node packages/router/dist/cli.js keys test    # the models each key can use
  ```

  In PowerShell, set the variable for one command and clear it afterwards:
  `$env:SWITCHYARD_NEW_KEY = "gsk_..."; node packages/router/dist/cli.js keys add groq --billing free_tier; Remove-Item Env:SWITCHYARD_NEW_KEY`.
  Without the variable, `keys add` asks for the key with a hidden prompt when it runs in an
  interactive terminal.

- **Config**: under `providers` in `switchyard.config.yaml`, preferably naming an environment
  variable (a literal `api_key` works, but `doctor` warns that the file then holds a secret):

  ```yaml
  providers:
    groq:
      keys:
        - { api_key_env: GROQ_API_KEY, billing_class: free_tier }
    local:                       # any OpenAI-compatible server: Ollama, llama.cpp, vLLM, LM Studio
      base_url: http://localhost:11434/v1
      no_key: true
  ```

**Billing class is required** and decides money: `free_tier` keys never cost anything;
`paid_credits`, `paid_postpaid`, and `trial` keys are paid and follow `paid.*` policy and
budgets. A model is free only when it is priced at $0, has a `:free` id, or is served by a
`free_tier` key (then only free_tier keys serve it). Several keys per provider are normal:
SwitchYard rotates between them. Keys of one provider quota (a Google project, a Cloudflare
account) share a `quota_group` (`--quota-group`). Optional `rpm`, `rpd`, `tpm`, `tpd`
limits apply per key, per quota group, or per provider. See [operations.md](operations.md#provider-keys).

Vault secrets are encrypted with a master key from `SWITCHYARD_MASTER_KEY` (64 hex characters)
or a generated `.switchyard/.master-key` file; back that file up (or set the variable) or the
vault keys cannot be decrypted.

## 3b. Configure and run

Edit `switchyard.config.yaml` (or the panel's Settings):

- `repositories`: the repositories workers may read (and, for `implement`, edit).
- `brain.project` (and optionally `brain.path`, default `~/.switchyard/brain`, shared across
  projects). Mount an existing `docs/working/` folder with `brain.mounts` if you have one.
- Standalone and paid presets: set the paid model id and **current prices** in `paid.models` and
  `supervisor.endpoints`, and add a paid key for that provider
  (`keys add anthropic --billing paid_credits --balance 20`).

Then:

```bash
node packages/router/dist/cli.js models scan   # list each provider's models with your keys, resolve params
node packages/router/dist/cli.js doctor        # every line should say ok (WARN lines are advice)
node packages/router/dist/cli.js models        # review; confirm "pending" models
node packages/router/dist/cli.js models confirm groq/some-model --params 70
node packages/router/dist/cli.js route implement T2   # who would serve this, and why
```

The panel's Scan button does the same as `models scan`; a running worker repeats it every
`discovery.interval_minutes` (60). Point the CLI at the config with `--config` or
`SWITCHYARD_CONFIG` when you run it from another directory.

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
config whose only provider is SwitchYard's per-job policy gateway, isolated HOME/XDG
directories, and no inherited provider keys) or `runner: command` for any other agent, which receives `SWITCHYARD_BASE_URL`,
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

Models and why each is or is not used, routing previews and overrides, tasks, sessions, jobs,
provider keys and their status, qualification, and every setting.

## 7. Qualify models (optional, uses your providers' quota)

```bash
node packages/router/dist/cli.js qualify openrouter/vendor/model:free --trials 3
node packages/router/dist/cli.js qualify status
```

A running worker executes and grades the runs. Set `qualification.required: true` once your
models have results.
