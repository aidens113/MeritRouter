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
node packages/router/dist/cli.js init . --preset claude-code --project my-app --repo app=../my-app
SWITCHYARD_CONFIG=$PWD/switchyard.config.yaml pnpm --filter switchyard-panel start   # http://127.0.0.1:4477
```

`init` writes `switchyard.config.yaml` and `models.yaml`: one global config plus a first project.
- `--project <slug>` names the project (default `my-project`, or `SWITCHYARD_PROJECT`).
- `--name "<name>"` gives it a display name.
- Each `--repo <alias>=<path>` replaces the preset's placeholder repository.

```powershell
$env:SWITCHYARD_CONFIG = "D:\SwitchYardRouter\switchyard.config.yaml"   # use setx for persistence
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

### Projects

One install holds many projects. Each project has its own:
- repositories;
- brain folder (`projects/<slug>/` in the brain repository);
- jobs, tasks, sessions, and teams;
- optional overrides of verification, team policy, allowed commands, protected paths, branch
  prefix, and roles.

Everything else is global and shared: provider keys, models, routing, budgets, and the other
settings. One worker runs every project at once and takes turns fairly between them (see
[operations.md](operations.md#projects-fairness-and-limits)).

Projects live in the config file under `projects.<slug>`:

```yaml
brain:
  project: my-app            # the primary project: system tasks and rows from before projects
projects:
  my-app:
    name: My app
    repositories:
      app: { path: ../my-app }
  docs-site:
    repositories:
      web: { path: ../docs-site, writable: true }
    priority: 2              # optional fairness and limit fields, see operations.md
```

A slug is lower-case letters, digits, `.`, `_`, and `-`, starting with a letter or digit.

**Repository folders are set up for you.** A repository's folder does not have to exist or be a
git repository already. SwitchYard prepares it when the project is created, when its
repositories are saved, when a worker, the MCP server, or the daemon starts or reloads the
config, when the panel opens a project's overview, and before `switchyard doctor` checks it:
- a missing folder is created, set up with git, and given an empty first commit;
- a folder without git is set up with git, gets a default `.gitignore` if it has none
  (`node_modules/`, `.env`, `.env.*`, `*.log`, `dist/`, `build/`, `.venv/`, `__pycache__/`,
  `.DS_Store`), and its files are committed as a first snapshot;
- a git repository with no commits gets that snapshot (without a `.gitignore`);
- a repository with history is never touched.

These commits are made as `SwitchYard <switchyard@localhost>`, so no git identity is needed. The
project overview shows what was done for seven days. What SwitchYard cannot fix stays an
attention item with the fix: git not installed, a file where the folder should be, no write
permission, a folder holding files another repository tracks (a monorepo package: use the
monorepo's top folder), and a drive root or your home folder (SwitchYard will not commit
everything in it).

**In the panel.**
- `/` is the projects grid. Each card shows:
  - the project's repositories, with a "not set up" badge for a folder that is not a git
    repository yet;
  - its running and queued jobs and tasks;
  - its last activity;
  - an attention badge: questions, results awaiting a decision, brain requests, interrupted
    tasks, repositories SwitchYard could not set up.
- **New project** (`/new`) takes a name, a slug (derived from the name until you edit it),
  repositories, and optional brain mounts. Each folder is checked as you leave its field and
  says what will happen to it; on create the folders are prepared (see above), then
  `projects.<slug>` is written into the config. You land on the new project's page.
- The **project switcher** at the top left shows the current project. It lists every live
  project with an activity dot (green while running, amber while queued, grey when idle), plus
  "All projects", "Projects grid", and "New project".
- `/p/<slug>/...` holds one project's pages: Overview, Jobs, Teams, Tasks, Sessions, Requests,
  Brain, and Settings.
- `/all/...` holds the install-wide pages:
  - the dashboard: every project's jobs and queues, attention items, and usage and paid spend
    by project;
  - Requests (every project);
  - Models, Routing, Provider keys, Qualification, Calibration;
  - Knowledge (global lessons; see [roles.md](roles.md#global-knowledge-d9));
  - Settings (global sections only).
- Old flat URLs still work:
  - `/jobs`, `/tasks`, `/sessions`, `/teams`, `/requests`, and `/brain` go to the same page of
    the project you used last, or to `/`;
  - `/jobs/<id>`, `/tasks/<id>`, and `/sessions/<id>` go to that item's own project;
  - `/models`, `/routing`, `/keys`, `/qualification`, `/calibration`, and `/settings` go to
    `/all/...`.

**On the command line.**
- `switchyard projects` lists the projects. `*` marks the selected one, and `--all` adds
  archived ones.
- `switchyard projects create <slug> --name "<name>" --repo <alias>=<path>` adds a project. It
  prepares each repository folder (see above) and prints what it did.
- `switchyard projects archive|unarchive <slug>` archives a project or brings it back; see
  [operations.md](operations.md#archiving-a-project).
- Commands that work inside one project take `--project <slug>`. Without the flag, SwitchYard
  picks the project in this order:
  1. `SWITCHYARD_PROJECT`;
  2. the only project that is not archived;
  3. the project whose repository contains the current directory (the innermost one wins).
- `submit`, `run`, and `blame` need a project. With several projects and no way to choose, they
  stop and list them.
- Listing commands (`status`, `jobs`, `questions`, `sessions`, `usage`, `brain`) show every
  project when none is chosen.
- `doctor` checks each project's repositories and brain folder, or only `--project`'s.
- Install-wide commands ignore projects: `models`, `route`, `keys`, `qualify`, `compare`, and
  `worker` (which serves every project). `backup`, `restore`, `daemon`, and `service` refuse
  `--project`, because they cover the whole install.

**Upgrading a single-project config.** A config with top-level `repositories` and no `projects`
section keeps working unchanged:
- It is read as one project named after `brain.project` (`default` when unset).
- On first start, every existing task, job, session, brain request, and request record is given
  that project.
- The first `projects create`, from the CLI or the panel, converts the file: the top-level
  `repositories` move under `projects.<brain.project>`.
- Other top-level sections stay global after the conversion, including `brain.mounts`,
  `verification`, and `team`. They then apply to every project. To keep a setting for the old
  project only, move it under `projects.<slug>` yourself.

## 3. Add provider keys

Get a key from each provider you want to use (Groq, Google AI Studio, NVIDIA, OpenRouter,
Mistral, Cerebras, Cohere, Cloudflare Workers AI, SambaNova, Together, Hugging Face, Anthropic,
OpenAI, DeepSeek, Fireworks, DeepInfra, Nebius Token Factory, Scaleway, OVHcloud AI Endpoints,
Z.ai, Moonshot/Kimi, Vercel AI Gateway, Ollama Cloud), then add it in one of three ways. Local
servers (Ollama, LM Studio, llama.cpp) need no key: see [Local servers](#local-servers).

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
    ollama: {}                   # a local server: no key (see Local servers)
    vllm:                        # any other OpenAI-compatible server (see Custom providers)
      base_url: http://localhost:8000/v1
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

Some providers limit requests in flight rather than per minute (DeepSeek per account, DeepInfra
per model, Ollama Cloud per plan). The number depends on the account, so SwitchYard never assumes
it: set `team.provider_concurrency_limits: { deepseek: 4 }` and the gate's provider slots enforce
it across every process.

### Local servers

Ollama, LM Studio, and llama.cpp are built in. They take no key; an entry under `providers` (or
the panel's Provider keys, under "Local servers") turns one on, and nothing contacts a server
that is not configured. Discovery reads each server's own metadata:

| Server | Entry | Address | Models and metadata |
| --- | --- | --- | --- |
| Ollama | `ollama: {}` | `127.0.0.1:11434`; `OLLAMA_HOST` when set; `base_url` wins over both | `/api/tags`, then `/api/show` per model (cached by digest) and `/api/ps`: parameter count, trained and effective context, tools, vision, quantization; embedding-only models are left out. Falls back to `/v1/models` (ids only) behind a proxy that forwards only `/v1`. |
| LM Studio | `lmstudio: {}` | `localhost:1234` | `/api/v1/models`: context of loaded models, tool training, vision, quantization. Add its token as a key only if API tokens are turned on. |
| llama.cpp (`llama-server`) | `llamacpp: { base_url: http://127.0.0.1:8080/v1 }` | required: the default port is 9931 in the current README and 8080 in older releases | `/v1/models` `meta` (parameter count, trained context) and `/props` (runtime context). Add a key if it runs with `--api-key`. |

Budgets use the context the server actually runs a model with, not the model's maximum. Ollama
uses `num_ctx` from the model's parameters, else the context a loaded model was given, else the
server default (4k, 32k, or 256k depending on VRAM, or `OLLAMA_CONTEXT_LENGTH`). SwitchYard cannot
see that default, so it assumes the smallest (4096) unless you set
`providers.ollama.default_context_tokens` to your server's value. LM Studio and llama.cpp models
whose context is not reported take `default_context_tokens` too, and stay unroutable without it.
Ollama never receives `tool_choice` (it does not support it); a reply without a tool call is sent
back to the model, as for other providers without `tool_choice`. Ollama model ids are kept
exactly (`ollama/llama3.1:8b`); `llama3.1` and `llama3.1:70b` are different models.

OVHcloud AI Endpoints also works without a key (anonymous: 2 requests per minute per model and
IP): `ovhcloud: { rpm: 2 }`. A key raises the limit.

### Custom providers

Any other OpenAI-compatible server or provider is a custom entry: an id of your choice and a
`base_url` (the URL the `/chat/completions` and `/models` paths go under). Servers without auth
set `no_key: true`; others take `keys` like a built-in. `models_path` changes the list path,
`token_limit_param: max_completion_tokens` suits providers that deprecated `max_tokens`, and
`rate_limit_headers: openai` reads `x-ratelimit-*` headers. The panel's "Add a custom provider"
writes the same entry. Facts below are from each project's documentation (fetched 2026-10-20);
check them against your account.

| Server or provider | `base_url` | Key | Notes |
| --- | --- | --- | --- |
| vLLM | `http://localhost:8000/v1` | `--api-key`, else `no_key` | `tool_choice: auto` needs `--enable-auto-tool-choice` and a tool parser |
| LocalAI | `http://localhost:8080/v1` | `LOCALAI_API_KEY`, else `no_key` | such keys have full admin access |
| Jan | `http://127.0.0.1:1337/v1` | optional | |
| KoboldCpp | `http://localhost:5001/v1` | `--password`, else `no_key` | |
| text-generation-webui | `http://127.0.0.1:5000/v1` | `--api-key`, else `no_key` | start with `--api` |
| SGLang | `http://127.0.0.1:30000/v1` | `no_key` | |
| Hugging Face TGI | the server's `/v1` | | in maintenance mode; prefer vLLM, SGLang, or llama.cpp |
| xAI | `https://api.x.ai/v1` | Bearer | Chat Completions is deprecated in favour of Responses; set `token_limit_param: max_completion_tokens` |
| Alibaba Model Studio | `https://<WorkspaceId>.<region>.maas.aliyuncs.com/compatible-mode/v1` | Bearer | keys work only in their region |
| MiniMax | `https://api.minimax.io/v1` | Bearer | temperature and top_p are ignored |
| Venice | `https://api.venice.ai/api/v1` | Bearer | `rate_limit_headers: openai` (its reset header is an epoch-ms timestamp, which is read as such); more than 50 failed requests in 30 s blocks the key |
| Novita | `https://api.novita.ai/openai` | Bearer | |
| Hyperbolic | `https://api.hyperbolic.ai/inference/v1` | Bearer | |
| Chutes | `https://llm.chutes.ai/v1` | Bearer | no free tier |
| Featherless | `https://api.featherless.ai/v1` | Bearer | subscription with concurrency units |
| Baseten Model APIs | `https://inference.baseten.co/v1` | Bearer | 529 when overloaded |
| AI21 | `https://api.ai21.com/studio/v1` | Bearer | tools only without streaming; at most 4096 output tokens |
| SiliconFlow | `https://api.siliconflow.com/v1` | Bearer | `models_path: /models?type=text&sub_type=chat` |
| Azure OpenAI / Foundry | `https://<resource>.openai.azure.com/openai/v1` | the `api-key` header | model ids are deployment names; set `no_key: true` and `headers: { api-key: ... }` (the only way to send that header, so the key sits in the config file) |
| Amazon Bedrock | `https://bedrock-mantle.<region>.api.aws/v1` | a long-term Bedrock API key (Bearer) | `bedrock-runtime` has no model list; long-term keys are for exploration and short-term ones expire within 12 hours |

Providers that cannot be added this way (OAuth or request signing, retired APIs) are listed in
[decisions.md](decisions.md#wider-coverage-p4-2026-10-20).

## 3b. Configure and run

Edit `switchyard.config.yaml`, or use the panel: global settings are at `/all/settings`, a
project's at `/p/<slug>/settings`.

- `projects.<slug>.repositories`: the repositories that project's workers may read (and, for
  `implement`, edit).
- `brain.path` (default `~/.switchyard/brain`): one brain repository for every project. To mount
  an existing `docs/working/` folder, use `projects.<slug>.brain.mounts` for one project or
  `brain.mounts` for every project.
- Standalone and paid presets: set the paid model id and **current prices** in `paid.models` and
  `supervisor.endpoints`, and add a paid key for that provider
  (`keys add anthropic --billing paid_credits --balance 20`).
- Prompt caching: `routing.sticky_endpoints` (default true) keeps a conversation on the model
  that served its last turn while it is healthy, so the provider's prompt cache keeps working;
  it never moves a paid model ahead of a free one. `providers.<id>.prompt_cache:
  cache_control | prompt_cache_key | none` says how to ask a provider to cache the prompt prefix
  (Anthropic uses `cache_control`, OpenAI and OpenRouter `prompt_cache_key`, every other provider
  `none` unless set). `paid.models[].cached_input_usd_per_million` prices input served from the
  cache; without it the price comes from `pricing_url` (`input_cache_read`), or cached input is
  priced as ordinary input.

Then:

```bash
node packages/router/dist/cli.js models scan   # re-list every provider's models (adding a key already lists its provider's)
node packages/router/dist/cli.js doctor        # every line should say ok (WARN lines are advice)
node packages/router/dist/cli.js models        # review; confirm "pending" models
node packages/router/dist/cli.js models confirm groq/some-model --params 70
node packages/router/dist/cli.js route implement T2   # who would serve this, and why
```

Adding a key (panel or `keys add`), giving a key a new secret, or re-enabling it lists that
provider's models at once, and so does setting up a keyless local server in the panel. The
panel's Scan button does the same as `models scan` for every provider; a running worker repeats it every
`discovery.interval_minutes` (60). Point the CLI at the config with `--config` or
`SWITCHYARD_CONFIG` when you run it from another directory.

## 4. Connect an MCP client (Claude Code, Codex, ChatGPT)

`switchyard mcp` is SwitchYard's MCP server. It is the same as `node
packages/router/dist/cli.js mcp`, or `node packages/router/dist/mcp.js` for older registrations.
The server reads `SWITCHYARD_CONFIG`, or you pass `--config`. Paths below are examples. Use
`switchyard` when the package is installed or linked, otherwise `node <checkout>/packages/router/dist/cli.js`.

It speaks two transports:
- **stdio** (default). The client launches the server and talks over its stdin and stdout. Use
  this for Claude Code and Codex on the same machine.
- **Streamable HTTP** (`--http`). The server listens at `http://127.0.0.1:4478/mcp` and clients
  connect to that URL. Change the address with `--host` and `--port`; either one alone also turns
  on HTTP. Use this for ChatGPT, through a tunnel, or for several clients sharing one server.
  - `SWITCHYARD_MCP_TOKEN`: when set, every request must carry it, either as
    `Authorization: Bearer <token>` or as the last part of the URL, `/mcp/<token>`.
  - A `--host` other than loopback (for example `0.0.0.0`) refuses to start without the token.
  - Without a token, the server answers only requests addressed to a loopback name (Host and
    Origin). So a web page cannot reach it, and neither can a tunnel. Make a token with
    `openssl rand -hex 32` or any long random string.

One MCP server serves one project:
- Its tools default to that project. A tool with a `project` input may name another one.
- The brain tools work in that project's brain.

The server picks its project in this order:
1. `--project <slug>`;
2. `SWITCHYARD_PROJECT`;
3. the only project;
4. the project whose repository contains the client's working directory.

If none of these picks a project, the server does not start: it exits with an error that lists
the projects. A guessed default could write tasks and brain entries into the wrong project. So
once an install has several projects, pass `--project` unless the client always runs inside one
of the project's repositories.

Add `--no-worker` when a daemon or service already runs the worker (see below). The MCP server
then only submits and reads, and leaves recovery to the daemon. Without the flag, the server
runs a worker for every project in its own process.

The tools only add to the client. The client keeps its own login and model; nothing intercepts
its native requests.

### Claude Code

Run from the project you want Claude to work in:

```powershell
claude mcp add --transport stdio --scope local switchyard -- node "D:/SwitchYardRouter/packages/router/dist/cli.js" mcp --config "D:/path/to/switchyard.config.yaml" --project my-app
```

```bash
claude mcp add --transport stdio --scope local switchyard -- node /abs/SwitchYardRouter/packages/router/dist/cli.js mcp --config /abs/path/switchyard.config.yaml --project my-app
```

Check with `claude mcp get switchyard` and `/mcp` inside Claude Code. Merge
`packages/router/examples/CLAUDE.delegation.md` into the project's `CLAUDE.md`.

A `--scope local` entry is keyed by the folder path exactly as written. If your editor opens the
folder with another spelling (`d:\repo` against `D:/repo`), the entry does not load. A project
`.mcp.json` at the repository root avoids this:

```json
{ "mcpServers": { "switchyard": { "command": "node", "args": ["D:/SwitchYardRouter/packages/router/dist/cli.js", "mcp", "--config", "D:/path/to/switchyard.config.yaml", "--project", "my-app"] } } }
```

### Codex (CLI, IDE extension, app)

Codex keeps MCP servers in `~/.codex/config.toml` (or `$CODEX_HOME/config.toml`), shared by the
CLI and the IDE extension. Register the stdio server:

```bash
codex mcp add switchyard -- node /abs/SwitchYardRouter/packages/router/dist/cli.js mcp --config /abs/path/switchyard.config.yaml --project my-app
codex mcp list
codex mcp get switchyard
```

This writes:

```toml
[mcp_servers.switchyard]
command = "node"
args = ["/abs/SwitchYardRouter/packages/router/dist/cli.js", "mcp", "--config", "/abs/path/switchyard.config.yaml", "--project", "my-app"]
```

To use an HTTP server that is already running (`switchyard mcp --http`, with the token in
`SWITCHYARD_MCP_TOKEN` for both processes):

```bash
codex mcp add switchyard-http --url http://127.0.0.1:4478/mcp --bearer-token-env-var SWITCHYARD_MCP_TOKEN
```

Inside Codex, `/mcp` lists the servers and their tools. Codex reads a reduced form of JSON Schema
for tool inputs. SwitchYard's tool inputs stay inside that form, and the service still checks
every task in full. So a task Codex fills in wrongly is refused with the reason, not run.

### ChatGPT (developer mode)

ChatGPT connects only to a remote HTTPS URL, and it cannot send a bearer header: a connector
uses OAuth or no authentication. So the token goes in the URL, and the tunnel's address plus
the token is the secret.

1. Start the HTTP server with a token:

   ```bash
   export SWITCHYARD_MCP_TOKEN=$(openssl rand -hex 32)       # PowerShell: $env:SWITCHYARD_MCP_TOKEN = "<long random string>"
   switchyard mcp --http --config /abs/path/switchyard.config.yaml --project my-app
   ```

2. Expose port 4478 over HTTPS with a tunnel, for example
   `cloudflared tunnel --url http://127.0.0.1:4478` or `ngrok http 4478`. Note the
   `https://...` address it prints.
3. In ChatGPT, open Settings, then Apps & Connectors, then Advanced settings, and turn on
   Developer mode. Create a connector:
   - MCP server URL: `https://<tunnel address>/mcp/<token>`;
   - Authentication: No authentication.
4. In a chat, choose Developer mode and the connector. Each tool call shows its arguments before
   it runs.

Anyone with that URL can submit tasks that spend your provider quota, write to the project's
brain, and accept results. Keep it private. Stop the tunnel when you are done, and change the
token if the URL leaked. A tunnel to a server without a token gets 403 for every request, because
the tunnel's host name is not loopback.

Without `--no-worker`, the MCP process runs the worker loop, so tasks run while the Claude Code
session is open. For work that should continue after closing Claude, run
`node packages/router/dist/cli.js worker` in a terminal; any number of processes can share the
store. To keep a worker running across crashes and logins:
- `switchyard daemon start` runs the daemon in the background. It restarts the worker with
  backoff and logs under `.switchyard/logs/`. `daemon status` shows the daemon and each
  project's queued and running tasks, and `daemon stop` stops it. `switchyard daemon` alone runs
  it in the foreground.
- `switchyard service install` installs the daemon as a user service: a systemd user unit, a
  launchd agent, or a Windows scheduled task at logon. `--dry-run` prints the definition first,
  and `service status` / `service uninstall` manage it.

There is one daemon per install, and its one worker serves every project. Beside it, run each
project's MCP server with `--no-worker`.

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
node packages/router/dist/cli.js run "Add CSV export to the report page" --project my-app --repo app --check "npm test"
node packages/router/dist/cli.js job <id>                         # workers, branch, questions
node packages/router/dist/cli.js answer <question-id> "use semicolons"
git -C path/to/app merge --no-ff switchyard/job-<id>               # after you review the branch
```

## 6. Web panel

```bash
pnpm --filter switchyard-router build
SWITCHYARD_CONFIG=/path/to/switchyard.config.yaml pnpm --filter switchyard-panel start   # http://127.0.0.1:4477
```

You rarely start it by hand: while the MCP server or `switchyard worker` runs, SwitchYard
starts the panel when nothing answers on `panel.port` and checks again every minute
(`panel.auto_start`, default on). It runs detached on 127.0.0.1, outlives the session that
started it, and logs to `<storage>/logs/panel.log`. `switchyard panel` starts it on demand, and
the MCP server's `panel` tool does the same for Claude, whose server instructions carry the URL.
It needs the built panel from this repository checkout (`pnpm -r build`).

The panel opens on the projects grid (see [Projects](#projects)).
- Inside a project: its overview, jobs, teams, tasks, sessions, requests, brain (with its
  promotions to global knowledge), and settings.
- Under "All projects" (`/all`): the dashboard, every request, models and why each is or is not
  used, routing previews and overrides, provider keys and their status, qualification,
  calibration, global knowledge, and the global settings.

## 7. Qualify models (optional, uses your providers' quota)

```bash
node packages/router/dist/cli.js qualify openrouter/vendor/model:free --trials 3
node packages/router/dist/cli.js qualify status
```

A running worker executes and grades the runs. Set `qualification.required: true` once your
models have results.
