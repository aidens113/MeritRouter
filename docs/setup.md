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
