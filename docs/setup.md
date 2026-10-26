# Set up MeritRouter

Start with one project, one repository and the default `claude-code` preset. Your connected
MCP client stays the FINAL supervisor: it delegates multi-step execution to delivery supervisors
and independently reviews the resulting product and evidence.
Follow steps 1–4 first; local servers, custom providers and standalone jobs are optional.
Use [the documentation index](README.md) to find the detailed operating contracts.

## Quick path

1. Build the source using step 1. This does not require a published npm package.
2. Run `node packages/router/dist/cli.js init . --preset claude-code --project my-app --repo app=/absolute/path/to/my-app`
   from the checkout. On Windows, use a path such as `app=D:/code/my-app`.
3. Run `node packages/router/dist/cli.js panel --config /absolute/path/to/meritrouter.config.yaml`
   and open **http://127.0.0.1:4477**. In **All projects → Provider keys**, choose a provider,
   paste its key, test it, set its actual billing class and limits, then save. Testing contacts
   that provider. Inspect **Models** and **Routing** before submitting work.
4. Register the [stdio MCP server](#4-connect-an-mcp-client-claude-code-codex-chatgpt)
   with absolute executable/config paths and `--project my-app`, then reconnect your client.
5. Ask the connected client:

   > Use MeritRouter project `my-app`, repository `app`, for one read-only task: inspect the
   > README and report confusing setup instructions. Use at most three model requests.
   > Do not edit files, run commands or use the network. Read the result and explain what
   > you verified.

Watch the task's **Sessions** and **Requests** in the panel. A job's **Overview** links its
delegated tasks and sub-jobs; **Requests** includes supervisor and descendant calls.
If routing refuses the task, inspect its eligibility reason: check credentials, prices, tier
policy and budget headroom before changing any limits.
Host checks wait for an exact approval under **Settings → Security**; default policy is human
approval only. External coding runners are currently unavailable. See [security settings](#security-settings).

## Troubleshooting

| Symptom | Next step |
| --- | --- |
| Wrong config or project | Pass absolute `--config` and explicit `--project`; run `doctor`. |
| No eligible model | Inspect Models, Routing, key health, metadata and request budget. |
| Task stays queued | Run a worker/daemon or explicit `mcp --worker`; check capacity and key cooldowns. |
| Task waits for a check | Inspect its pending exact command approval on the task/job page. |
| Panel unavailable | Run `panel` with the same config; inspect `<storage>/logs/panel.log`. |
| MCP tools missing | Check absolute paths, build output and client registration; reconnect. |
| Vault unreadable | Restore the matching master key; generating a new one cannot decrypt old keys. |

## Upgrading from SwitchYard

The new executable/package is `meritrouter`, configuration is `meritrouter.config.yaml`,
environment variables use `MERITROUTER_*`, and new runtime directories use `.meritrouter`.
Old environment variables and default config filenames are not discovery aliases.

1. Stop old workers, MCP servers, panels and services. Back up configuration, storage/database,
   vault and its matching master key, brain repositories and working repositories. See
   [backup and restore](operations.md#backup-and-restore).
   Uninstall old service registrations with the old executable before replacing it, or retain
   that executable until you have removed those registrations.
2. Rename built-in runtime `SWITCHYARD_*` environment variables to `MERITROUTER_*`, preserving
   values, especially the master key, before opening the installation with the new executable.
   Keep the encrypted vault and `.master-key` together when using a file key. User-chosen provider
   environment names referenced by `api_key_env` stay valid: keep those names, or update both
   the configuration reference and the environment variable together.
3. Keep the old config in place. Before running the new executable, preserve storage, brain,
   repository, worktree and branch-prefix settings. Pin any previously omitted defaults to their
   old resolved paths so new defaults do not select an empty install. Then open it explicitly:
   `meritrouter doctor --config /absolute/path/to/switchyard.config.yaml`.
   In explicitly selected storage, an existing `switchyard.db` is reused when `meritrouter.db`
   does not exist; if both exist, `meritrouter.db` takes precedence. Do not manually rename
   database files, vaults or brain directories.
4. Re-register MCP as `meritrouter`, with the new executable and explicit old config path.
   Remove or disable the old registration and reconnect clients. Inspect
   `meritrouter service install --dry-run --config <old-config>`
   before installing the new service. Update daemon/startup commands too.
5. Verify projects, task history and vault access before resuming. If you later move or rename
   the config, adjust relative paths to preserve their exact targets: paths resolve against
   the config file's directory.

Keep historical Git refs and `.switchyard` worktrees/artifacts needed for recovery. The rename
does not automatically move or delete user data. The panel uses new login/preferences cookies;
sign in again with the configured token and reselect your project if necessary.

Library users should import from `meritrouter` and replace `Switchyard`, `SwitchyardOptions`
and `SwitchyardError` with `MeritRouter`, `MeritRouterOptions` and `MeritRouterError`.
The old package, executable and public class names are not compatibility aliases.

Local, single user. Tested on Windows 10 with Node 22.11; Linux/WSL use the same commands.

## 1. Install

Check prerequisites with `node --version`, `git --version` and `pnpm --version`.
The router declares Node.js >=22.11.0. If pnpm is missing, install the workspace's pinned
version with `npm install --global pnpm@10.5.0`, then reopen your terminal if needed.

```bash
git clone https://github.com/aidens113/MeritRouter.git
cd MeritRouter
pnpm install
pnpm -r build
```

Use a Node version that also meets the panel framework's installation requirements.

### Build an installable package

From the checkout, `pnpm --filter meritrouter package:build` builds the router and
bundled production panel. Run `npm pack` in `packages/router`, then install the resulting
tarball with `npm install -g <path-to-tarball>`. This does not publish to npm.
The consumer installation installs its own platform's native SQLite dependency.

After installing the tarball, use `meritrouter` wherever this guide shows
`node packages/router/dist/cli.js`. Source-checkout users keep the full `node` command.

Run `meritrouter setup` to create the default configuration and start the bundled panel, or
`meritrouter setup --no-panel` to create only the configuration. Existing files are retained.
Setup begins with no placeholder repositories; add them in project settings or supply
`--repo app=<path>`. `meritrouter init <directory>` still creates a local configuration.

Configuration discovery uses `--config`, then `MERITROUTER_CONFIG`, then the nearest ancestor's
`meritrouter.config.yaml`, then the application directory. Its defaults are
`%LOCALAPPDATA%/MeritRouter` on Windows, `~/Library/Application Support/MeritRouter` on macOS,
and `$XDG_CONFIG_HOME/meritrouter` (or `~/.config/meritrouter`) on Linux. `MERITROUTER_HOME`
overrides that directory. Relative configuration paths resolve beside the selected file.
The tarball was verified on Windows outside the checkout; Linux/macOS installation remains
separate acceptance work.

## 2. Start the panel

```bash
node packages/router/dist/cli.js init . --preset claude-code --project my-app --repo app=../my-app
MERITROUTER_CONFIG=$PWD/meritrouter.config.yaml pnpm --filter meritrouter-panel start   # http://127.0.0.1:4477
```

`init` writes `meritrouter.config.yaml` and `models.yaml`: one global config plus a first project.
- `--project <slug>` names the project (default `my-project`, or `MERITROUTER_PROJECT`).
- `--name "<name>"` gives it a display name.
- Each `--repo <alias>=<path>` replaces the preset's placeholder repository.

```powershell
$env:MERITROUTER_CONFIG = "D:\MeritRouter\meritrouter.config.yaml"   # use setx for persistence
pnpm --filter meritrouter-panel start
```

`--preset` chooses who supervises and what may be paid (see [roles.md](roles.md) for each role):

| Preset | Supervisor | Workers | Paid |
| --- | --- | --- | --- |
| `claude-code` (default) | Client FINAL supervisor plus qualified MeritRouter delivery supervisors | free and bounded paid fallback at T1-T3 | on, $5/week |
| `standalone-free` | MeritRouter delivery supervisor, with qualified eligible free evidence | free | off |
| `standalone-hybrid` | Qualified MeritRouter delivery supervisor; operator FINAL | free; paid fallback at T3 | supervisor, T3 fallback |
| `standalone-paid` | Qualified MeritRouter delivery supervisor; operator FINAL | paid preferred at T2-T3, premium for T4 | on, budgeted |

The panel binds to 127.0.0.1. Set `MERITROUTER_PANEL_TOKEN` to require a login. Nothing else has
to be installed or running: MeritRouter calls each provider's API itself.

### Projects

Projects may declare `projects.<slug>.directory` as their owner folder, relative to the
configuration file or absolute. When omitted, a single distinct repository folder supplies
the owner; multiple distinct repositories or no repositories leave ownership unspecified.
Explicit owner folders must not overlap another known project's owner folder.

This is ownership metadata in preparation for project-local runtime storage. It does not
move existing worktrees, databases, logs or Brain data. Current storage settings remain in
effect. Do not move managed worktrees manually; the project-local storage migration is
not implemented yet.

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
git repository already. MeritRouter prepares it when the project is created, when its
repositories are saved, when a worker, the MCP server, or the daemon starts or reloads the
config, when the panel opens a project's overview, and before `meritrouter doctor` checks it:
- a missing folder is created, set up with git, and given an empty first commit;
- a folder without git is set up with git, gets a default `.gitignore` if it has none
  (`node_modules/`, `.env`, `.env.*`, `*.log`, `dist/`, `build/`, `.venv/`, `__pycache__/`,
  `.DS_Store`), and its files are committed as a first snapshot;
- a git repository with no commits gets that snapshot (without a `.gitignore`);
- a repository with history is never touched.

These commits are made as `MeritRouter <meritrouter@localhost>`, so no git identity is needed. The
project overview shows what was done for seven days. What MeritRouter cannot fix stays an
attention item with the fix: git not installed, a file where the folder should be, no write
permission, a folder holding files another repository tracks (a monorepo package: use the
monorepo's top folder), and a drive root or your home folder (MeritRouter will not commit
everything in it).

**In the panel.**
- `/` is the projects grid. Each card shows:
  - the project's repositories, with a "not set up" badge for a folder that is not a git
    repository yet;
  - its running and queued jobs and tasks;
  - its last activity;
  - an attention badge: questions, results awaiting a decision, brain requests, interrupted
    tasks, repositories MeritRouter could not set up.
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
- `meritrouter projects` lists the projects. `*` marks the selected one, and `--all` adds
  archived ones.
- `meritrouter projects create <slug> --name "<name>" --repo <alias>=<path>` adds a project. It
  prepares each repository folder (see above) and prints what it did.
- `meritrouter projects archive|unarchive <slug>` archives a project or brings it back; see
  [operations.md](operations.md#archiving-a-project).
- Commands that work inside one project take `--project <slug>`. Without the flag, MeritRouter
  picks the project in this order:
  1. `MERITROUTER_PROJECT`;
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
- **CLI**: the secret comes from `MERITROUTER_NEW_KEY` or a hidden prompt, never from the
  command line, and is stored encrypted in the same vault:

  ```bash
  MERITROUTER_NEW_KEY=gsk_... node packages/router/dist/cli.js keys add groq --billing free_tier --label main
  node packages/router/dist/cli.js keys add mistral --billing free_tier --test   # prompts; stores only if the key lists models
  node packages/router/dist/cli.js keys add cloudflare --billing free_tier --account-id <account id>
  node packages/router/dist/cli.js keys list    # source, billing class, status, last four only
  node packages/router/dist/cli.js keys test    # the models each key can use
  ```

  In PowerShell, set the variable for one command and clear it afterwards:
  `$env:MERITROUTER_NEW_KEY = "gsk_..."; node packages/router/dist/cli.js keys add groq --billing free_tier; Remove-Item Env:MERITROUTER_NEW_KEY`.
  Without the variable, `keys add` asks for the key with a hidden prompt when it runs in an
  interactive terminal.

- **Config**: under `providers` in `meritrouter.config.yaml`, preferably naming an environment
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
MeritRouter rotates between them. Keys of one provider quota (a Google project, a Cloudflare
account) share a `quota_group` (`--quota-group`). Optional `rpm`, `rpd`, `tpm`, `tpd`
limits apply per key, per quota group, or per provider. See [operations.md](operations.md#provider-keys).

Vault secrets are encrypted with a master key from `MERITROUTER_MASTER_KEY` (64 hex characters)
or a generated `.meritrouter/.master-key` file; back that file up (or set the variable) or the
vault keys cannot be decrypted.

Some providers limit requests in flight rather than per minute (DeepSeek per account, DeepInfra
per model, Ollama Cloud per plan). The number depends on the account, so MeritRouter never assumes
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
server default (4k, 32k, or 256k depending on VRAM, or `OLLAMA_CONTEXT_LENGTH`). MeritRouter cannot
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

## Cost controls and routing defaults

MeritRouter aims to reduce the cost of capable results across paid and free models. Free
routes, task sizing, prompt-cache reuse and bounded paid routes all contribute. Routing follows
eligibility, tier policy and model ranking; it does not promise the globally cheapest model.

New configuration enables paid routing with `paid.enabled: true` and a **$5 rolling weekly
cap** (`paid.budgets.per_week_usd: 5`). T1-T3 default to `on_free_exhaustion`: eligible free
routes are tried before paid routes. T4 defaults to `never`, returning work to the supervisor
unless you explicitly select a premium policy. The standalone supervisor defaults to
`supervisor.paid_policy: on_free_exhaustion`; it shares the paid spending controls.

Enabling paid routing does not provide credentials or waive checks: a paid call needs an
eligible key, known prices and headroom in every applicable global, project, key and task
budget. Add keys with their actual billing class. Review current prices and your cap before
submitting work. Other presets have explicit policies; inspect their generated configuration.

For strictly free operation, set `paid.enabled: false`. The `standalone-free` preset also
sets a zero paid cap and `never` policies, including its supervisor. Enabling paid routing
with a zero weekly cap is rejected during configuration validation. A zero daily or monthly
cap blocks spend, and `never` keeps a tier unavailable for paid routing.

Existing explicit `false`, zero budgets and `never` policies are preserved. Omitted fields
use the new defaults, including when loading an older minimal configuration. To keep an
installation strictly free, write `paid.enabled: false` explicitly before upgrading. Changing
source defaults never rewrites your saved configuration.

## Supervisor quality evidence and strict routing

The default workflow is `client_supervision.workflow: delegated_delivery`. Your initiating
client remains FINAL supervisor and normally delegates multi-step execution to a MeritRouter
delivery supervisor. `dispatch_final_supervisor: false` keeps FINAL authority with the client;
do not turn it on merely to enable delegation. Use `direct_tasks` for explicit direct coordination.

The generated Claude/Codex preset includes `profiles.supervise`. Existing configurations that
define only worker profiles must add a supervisor profile before `start_job` can run:

```yaml
profiles:
  supervise:
    mode: supervisor
    tools: supervisor
    max_model_requests: null
    max_output_tokens: 8000
    classify: never
    min_tier: T3
```

This leaves the profile uncapped; the default delivery job still receives a 600-request aggregate
envelope. Existing explicit smaller caps remain effective. Supervisor delivery works without
manually entered benchmark scores: `supervisor.routing.minimum_quality` defaults to
`best_available`. Current reviewed evidence ranks first; otherwise the strongest eligible route
is used and reported as unverified, subject to supervisor size floors and existing access, tool,
modality and paid restrictions. `supervisor.routing.quality_evidence` is empty by default.
A discovered model, API key, vendor/model name or forced endpoint is not quality evidence.
Set `minimum_quality: frontier_or_qualified_supervisor` to require reviewed evidence. Under that
explicit policy, no eligible current record produces `supervisor_quality_unavailable`; the
router does not substitute an unverified supervisor. Unusable supervisor submissions are rejected
before queueing rather than becoming failed jobs.

For each catalog endpoint, record a reviewed evaluation/source, verification and expiry dates,
trial count, confidence and measured scores from 0 to 1. Every relevant capability and confidence
must reach 0.75. Image/video supervisor inputs additionally require `scores.visual`. This format
example is deliberately expired/under-floor: replace its values with actual evidence, rather
than copying scores to make routing pass.

```yaml
supervisor:
  routing:
    strategy: highest_eligible_quality
    minimum_quality: frontier_or_qualified_supervisor
    quality_evidence:
      - schemaVersion: 1
        endpointId: provider/model-from-your-catalog
        source: path/to/reviewed-supervisor-evaluation.md
        checkedAt: "2000-01-01T00:00:00.000Z"
        expiresAt: "2000-02-01T00:00:00.000Z"
        classification: qualified_supervisor # or frontier, supported by your evidence
        confidence: 0.0
        trials: 1
        scores:
          planning: 0.0
          architecture: 0.0
          supervision: 0.0
          integration: 0.0
          review: 0.0
          product: 0.0
          visual: 0.0
```

Use exact endpoint IDs from your catalog; records are not inferred across providers. Provenance
remains operator-owned: ordinary worker qualification does not generate supervisor evidence
automatically. Under strict policy, expired/revoked evidence stops subsequent dispatch too.
Under the default policy, such endpoints must meet the ordinary unverified-route requirements.
Review route explanations
with `meritrouter route supervise T3 --project <slug>` and inspect quality exclusions. Model
quality ranking never enables paid routing or raises spending caps; paid-disabled, `never`,
zero-dollar and explicit free-first settings still apply.

Delivery defaults under `supervisor.delivery_budget` are `total_requests: 600`,
`supervisor_reserve_requests: 80`, `validation_reserve_requests: 80`, and
`extension_requests: 200` (used when a supervisor omits the requested amount, not an automatic
grant). Workers must supply an amount; every request needs a justification. Root supervisors
request more from the FINAL client; nested supervisors request from their parent. Justified
request amounts, wall-clock limits, command approval and dollar budgets remain separate.

## 3b. Configure and run

Edit `meritrouter.config.yaml`, or use the panel: global settings are at `/all/settings`, a
project's at `/p/<slug>/settings`.

- `projects.<slug>.repositories`: the repositories that project's workers may read (and, for
  `implement`, edit).
- `brain.path` (default `~/.meritrouter/brain`): one brain repository for every project. To mount
  an existing `docs/working/` folder, use `projects.<slug>.brain.mounts` for one project or
  `brain.mounts` for every project.
- Paid routes: set model ids and **current prices** in `paid.models`; for a pinned standalone
  supervisor also configure `supervisor.endpoints`. Add an eligible paid key for the provider.
  For example, `keys add anthropic --billing paid_credits --balance 20` adds a prepaid
  credential; use the billing class and balance that match your account.
- Prompt caching: `routing.sticky_endpoints` (default true) keeps worker conversations on a
  healthy previously eligible model within the selected paid policy. Supervisor dispatch instead
  rechecks current quality ordering; stickiness cannot preserve a weaker supervisor route.
  `providers.<id>.prompt_cache:
  cache_control | prompt_cache_key | none` says how to ask a provider to cache the prompt prefix
  (Anthropic uses `cache_control`, OpenAI and OpenRouter `prompt_cache_key`, every other provider
  `none` unless set). `paid.models[].cached_input_usd_per_million` prices input served from the
  cache; without it the price comes from `pricing_url` (`input_cache_read`), or cached input is
  priced as ordinary input.

- Web search for agents (`web`): supervisors and workers get `web_search` and `web_fetch` as
  soon as any search backend has a key. Every configured backend serves, the way model providers
  do: an `ollama-cloud` provider key (Ollama's web search and web fetch), Tavily, Brave, and Exa
  keys, and a SearXNG instance (`web.search.searxng.base_url`; its `settings.yml` must allow the
  `json` format). Add search keys in the panel (Provider keys, "Web search backends") or with
  `MERITROUTER_NEW_KEY=... meritrouter keys add tavily` (also `brave`, `exa`; several keys per
  service rotate); in the config use `web.search.tavily.api_key_env`. Search keys are never used
  for chat. `web.search.backends` (default `[auto]`: ollama, tavily, brave, exa, searxng) is the
  pool's order; `web.search.strategy: spread` (default) spreads calls across backends so their
  free allowances add up, `fallback` uses the first until it fails. Optional caps per backend:
  `web.search.limits.tavily: { per_day: 30, per_month: 1000 }` (your plan's numbers; there are
  no built-in ones). `web.fetch.backends` (default `[builtin, ollama]`) is the page fetch chain.
  `web.roles`, `web.max_requests_per_task` (12) and `web.max_requests_per_day` (300,
  install-wide) limit use; `web.enabled: false` turns it all off. `doctor` shows each backend's
  state. See [operations.md](operations.md#web-search-and-fetch) for health, caps, and safety.

- Web search inside the model call (`web.native`): some models search the web as part of the
  request (OpenRouter models whose list says `web_search_options`, Anthropic models with the web
  search tool, and models that always search, such as OpenRouter's Perplexity models and OpenAI's
  search models). A scan finds them; the Models page marks them ("Web search", "Searches always")
  and filters on them. A task submitted with `hints: { web: true }` (or delegated with
  `web: true`) prefers them and has their search turned on; `hints: { web: false }` keeps
  always-searching models away. A priced search is paid: it needs paid routing, a paid key, and
  room in `paid.budgets`. `web.native.enabled: false` stops turning search on (always-searching
  models still search), `web.native.max_searches_per_request` (5) caps searches per request
  (Anthropic `max_uses`) and sizes the reserved worst case, `web.native.max_results` (5) is the
  OpenRouter plugin's results per search. Correct a model in an override:
  `nativeWebSearch: { via: always_on, usdPerSearch: 0.005 }`, or `nativeWebSearch: null`.

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
`MERITROUTER_CONFIG` when you run it from another directory.

## 4. Connect an MCP client (Claude Code, Codex, ChatGPT)

The connected client is the FINAL project supervisor by default. Multi-step work normally runs
through a bounded MeritRouter delivery supervisor that plans, delegates, integrates, reviews,
tests and repairs before returning an exact candidate. The client independently inspects the
product/evidence and decides acceptance and upward resource requests. Settings → General → Claude/Codex supervision
controls permission to dispatch a MeritRouter final project supervisor; it starts off. You can
also explicitly ask the model to change it through the policy tool. See [supervisor ownership](roles.md#who-supervises).

`meritrouter mcp` is MeritRouter's MCP server. It is the same as `node
packages/router/dist/cli.js mcp`, or `node packages/router/dist/mcp.js` for older registrations.
The server reads `MERITROUTER_CONFIG`, or you pass `--config`. Paths below are examples. Use
`meritrouter` when the package is installed or linked, otherwise `node <checkout>/packages/router/dist/cli.js`.

It speaks two transports:
- **stdio** (default). The client launches the server and talks over its stdin and stdout. Use
  this for Claude Code and Codex on the same machine.
- **Streamable HTTP** (`--http`). The server listens at `http://127.0.0.1:4478/mcp` and clients
  connect to that URL. Change the address with `--host` and `--port`; either one alone also turns
  on HTTP. Use this for ChatGPT, through a tunnel, or for several clients sharing one server.
  - `MERITROUTER_MCP_TOKEN`: when set, every request must carry it, either as
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
2. `MERITROUTER_PROJECT`;
3. the only project;
4. the project whose repository contains the client's working directory.

If none of these picks a project, the server does not start: it exits with an error that lists
the projects. A guessed default could write tasks and brain entries into the wrong project. So
once an install has several projects, pass `--project` unless the client always runs inside one
of the project's repositories.

MCP connections are passive by default: they submit/read work and leave execution and
recovery to a daemon or separate worker. Start `meritrouter daemon start --config <file>`
for background execution. `--no-worker` remains a compatible explicit passive option.
Use `mcp --worker` only when this MCP process should deliberately execute installation-wide
work; `--project` scopes its tools, not its worker. Conflicting worker flags are refused.

The tools only add to the client. The client keeps its own login and model; nothing intercepts
its native requests.

### Claude Code

Run from the project you want Claude to work in:

```powershell
claude mcp add --transport stdio --scope local meritrouter -- node "D:/MeritRouter/packages/router/dist/cli.js" mcp --config "D:/path/to/meritrouter.config.yaml" --project my-app
```

```bash
claude mcp add --transport stdio --scope local meritrouter -- node /abs/MeritRouter/packages/router/dist/cli.js mcp --config /abs/path/meritrouter.config.yaml --project my-app
```

Check with `claude mcp get meritrouter` and `/mcp` inside Claude Code. Merge
`packages/router/examples/CLAUDE.delegation.md` into the project's `CLAUDE.md`.

A `--scope local` entry is keyed by the folder path exactly as written. If your editor opens the
folder with another spelling (`d:\repo` against `D:/repo`), the entry does not load. A project
`.mcp.json` at the repository root avoids this:

```json
{ "mcpServers": { "meritrouter": { "command": "node", "args": ["D:/MeritRouter/packages/router/dist/cli.js", "mcp", "--config", "D:/path/to/meritrouter.config.yaml", "--project", "my-app"] } } }
```

### Codex (CLI, IDE extension, app)

Codex keeps MCP servers in `~/.codex/config.toml` (or `$CODEX_HOME/config.toml`), shared by the
CLI and the IDE extension. Register the stdio server:

```bash
codex mcp add meritrouter -- node /abs/MeritRouter/packages/router/dist/cli.js mcp --config /abs/path/meritrouter.config.yaml --project my-app
codex mcp list
codex mcp get meritrouter
```

This writes:

```toml
[mcp_servers.meritrouter]
command = "node"
args = ["/abs/MeritRouter/packages/router/dist/cli.js", "mcp", "--config", "/abs/path/meritrouter.config.yaml", "--project", "my-app"]
```

To use an HTTP server that is already running (`meritrouter mcp --http`, with the token in
`MERITROUTER_MCP_TOKEN` for both processes):

```bash
codex mcp add meritrouter-http --url http://127.0.0.1:4478/mcp --bearer-token-env-var MERITROUTER_MCP_TOKEN
```

Inside Codex, `/mcp` lists the servers and their tools. Codex reads a reduced form of JSON Schema
for tool inputs. MeritRouter's tool inputs stay inside that form, and the service still checks
every task in full. So a task Codex fills in wrongly is refused with the reason, not run.

### Remote MCP clients

The HTTP transport can serve remote clients through a separately managed HTTPS tunnel.
Set `MERITROUTER_MCP_TOKEN` and use a bearer header or `/mcp/<token>` URL according to
the client's supported authentication. Follow that client's current MCP setup instructions;
its UI and account requirements are outside MeritRouter. Anyone with the token can invoke
the server's tools. Keep it secret and stop the tunnel when finished.

With explicit `--worker`, the MCP process runs the worker loop while the client session is
open. Without it, discovery and submission do not start execution. For background work, run
`node packages/router/dist/cli.js worker` in a terminal; any number of processes can share the
store. To keep a worker running across crashes and logins:
- `meritrouter daemon start` runs the daemon in the background. It restarts the worker with
  backoff and logs under `.meritrouter/logs/`. `daemon status` shows the daemon and each
  project's queued and running tasks, and `daemon stop` stops it. `meritrouter daemon` alone runs
  it in the foreground.
- `meritrouter service install` installs the daemon as a user service: a systemd user unit, a
  launchd agent, or a Windows scheduled task at logon. `--dry-run` prints the definition first,
  and `service status` / `service uninstall` manage it.

There is one daemon per install, and its one worker serves every project. Beside it, run each
project's MCP server with the passive default (or explicit `--no-worker`).

## 5. Coding workers

Use the default `coding.runner: native`. Its repository tools enforce task paths.
There is no general worker OS shell sandbox. Every host command, including a declared
check, requires an exact outside-action approval under the security policy below.
External `opencode` and `command` coding runners currently fail closed with
`worker_sandbox_unavailable`; a worktree or allowlist does not make them safe to enable.

New native sessions use defensive v2 wrappers: `workspace_info`, `read_files`, `batch`,
`apply_edits`, declared `run_recipe`/`run_checks`, paged output and operation cancellation/status.
Read many files together instead of spending one model turn per file. Deadlines default to
30 seconds and can request up to 300 seconds within task/check caps. Wrappers retain the exact
approval/security policy; they cannot authorize undeclared setup or commands. See
[harness operations](operations.md#defensive-harness-and-batched-operations).

## 5b. Standalone jobs

With a standalone preset, give MeritRouter a whole goal:

```bash
node packages/router/dist/cli.js worker &                         # or explicitly run mcp --worker
node packages/router/dist/cli.js run "Add CSV export to the report page" --project my-app --repo app --check "npm test"
node packages/router/dist/cli.js job <id>                         # workers, branch, questions
node packages/router/dist/cli.js answer <question-id> "use semicolons"
git -C path/to/app merge --no-ff meritrouter/job-<id>               # after you review the branch
```

## 6. Web panel

```bash
pnpm --filter meritrouter build
MERITROUTER_CONFIG=/path/to/meritrouter.config.yaml pnpm --filter meritrouter-panel start   # http://127.0.0.1:4477
```

You rarely start it by hand: while the MCP server or `meritrouter worker` runs, MeritRouter
starts the panel when nothing answers on `panel.port` and checks again every minute
(`panel.auto_start`, default on). It runs detached on 127.0.0.1, outlives the session that
started it, and logs to `<storage>/logs/panel.log`. `meritrouter panel` starts it on demand, and
the MCP server's `panel` tool does the same for Claude, whose server instructions carry the URL.
It needs the built panel from this repository checkout (`pnpm -r build`).

The panel opens on the projects grid (see [Projects](#projects)). Pages receive scoped live
change events over one server-sent connection per browser tab. The header shows Live,
Reconnecting, or Paused; pausing holds page updates until resumed. Only changed topics refresh
the current page, preserving scroll and open disclosures. No provider calls are needed for updates.

Dense pages show a summary first, with bookmarkable `?tab=` sections for plans, teams, results,
verification, usage, and settings. Earlier section-anchor links open the corresponding tab.
The sidebar groups Teams under Jobs; Agents, Sessions and Requests under Tasks; and repositories
and commits under Code. Agent pages show their tasks, sessions, models, requests and attributed
changes. Task, session, job, model and request details link to related entities.
- Inside a project: its overview, jobs, teams, tasks, sessions, requests, brain (with its
  promotions to global knowledge), Labs, and settings. Project settings → Labs edits the
  human-authored recipe; the Labs page queues lifecycle controls and displays operation/check
  evidence. Creating/starting a lab does not start model work. Choose a ready lab in the new-job
  form to bind its team to that isolated environment. See [Labs operations](operations.md#labs-isolated-services-and-checked-promotion).
- Under "All projects" (`/all`): the dashboard, every request, models and why each is or is not
  used, routing previews and overrides, provider keys and their status, qualification,
  calibration, global knowledge, and the global settings.

Brain's **Memory & preferences** tab creates conflict-safe typed project memory and authorized
user preferences. `/all/brain` is the standalone global preference editor; revocation retains
history. Role-budgeted context is injected automatically within ACL/headroom limits. The lazy
receipt view shows actual historical injection manifests rather than predicted context.
Ordinary document editing uses expected digests and preserves conflicting drafts.

For human-only task acceptance or budget decisions, use the signed-in panel or explicitly add
`--human` to the CLI command in an interactive terminal. CLI automation is recorded as supervisor
activity; redirected/scripted commands cannot claim human authority.

## 7. Qualify models (optional, uses your providers' quota)

```bash
node packages/router/dist/cli.js qualify openrouter/vendor/model:free --trials 3
node packages/router/dist/cli.js qualify status
```

A running worker executes and grades the runs. Set `qualification.required: true` once your
models have results.

## Security settings

Open `/all/settings?tab=security` to choose outside-repository access:

- **Human approval only** (default): exact host actions wait for your approval on their job/task page.
- **Supervisor approval allowed**: supervisors can execute host actions and decide owned worker requests.
- **Disabled**: agents cannot execute outside-repository actions.

Repository file tools and scoped task/project services remain available. There is no general
worker OS shell sandbox: shell/check commands are executed only as explicitly approved actions,
not by giving a worker blanket host permission. Current policy is checked again when decisions
execute. See [operations](operations.md#repository-boundaries-and-outside-actions) for boundaries,
revocation, evidence and unsupported external-runner/automatic Task Lab behavior.

Job overview shows delegated tasks and sub-jobs. Its Requests tab includes the supervisor and
all descendants; the full request log keeps job filters and pagination. Task, job, request and
session links retain project scope, with pending action decisions visible above detail tabs.
