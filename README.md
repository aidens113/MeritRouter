# SwitchYard Router

A multi-agent router and harness: a supervisor (Claude Code, or SwitchYard's own on models you
choose) delegates bounded work to free, and optionally paid, worker models, without giving up
control of which models run, what they may touch, what they spend, or what counts as "done".

- **Use it with Claude Code or on its own.** With Claude Code, Claude supervises through MCP
  tools. Standalone, SwitchYard runs its own supervisor on the models you choose (free or paid):
  it plans, delegates to workers, verifies, and integrates onto a job branch.
- **Many projects, one install.** Each project has its own repositories, brain folder, jobs,
  tasks, sessions, and settings overrides; keys, models, routing, and budgets are shared. One
  worker (or one daemon) runs every project at once with fair turns, optional per-project caps,
  paid budgets, and request shares. Start with `init --project <slug>`, add more with
  `switchyard projects create` or the panel's projects grid. See [docs/setup.md](docs/setup.md#projects).
- **Supervisor and worker roles with rules.** Charters (built out from FluxIQ's agent protocol)
  define each role; the harness enforces what code can: edit scope, commands, budgets, brain
  access. See [docs/roles.md](docs/roles.md).
- **A shared brain.** Markdown working documents in git, shared by every agent and by you, with
  scoped access and an access-request workflow. Each project's agents see only their project and
  `global/`; supervisors add to `global/` only through a deterministic check and an independent
  review.
- **Every line attributed.** Commits carry the agent and model that wrote them; supervisors can
  undo any task, model, commit, or individual lines.
- **Your keys, no other service.** Enter provider keys in the panel, with `switchyard keys add`,
  or in the config: Groq, Google AI Studio, NVIDIA, OpenRouter, Mistral, Cerebras, Cohere,
  Cloudflare, SambaNova, Together, Hugging Face, Anthropic, OpenAI, or any OpenAI-compatible
  server (Ollama, llama.cpp, vLLM, LM Studio). SwitchYard calls each provider directly, rotates
  between your keys, honours cooldowns and limits, and marks bad keys. Keys are encrypted at rest.
- **Paid credits, safely.** Billing classes on every key and hard budgets; paid routing is off by
  default.
- **Every model is found and assigned.** The models your keys can use are listed from each
  provider and scanned for parameter counts (Hugging Face weights, provider descriptions, names),
  modalities, limits, and verified-free pricing. Uncertain counts wait for your confirmation.
- **Tasks are scored, then routed.** A versioned rulebook scores each task (scope, mode, checks,
  plus classifier tags when they can matter) into tiers T1-T3; T4 goes back to the supervisor.
  SwitchYard picks the smallest sufficient model for the tier and falls back across models and
  keys itself.
- **Hard limits in code.** Per-task request budgets (including every coding-agent call), package
  allocations, deadlines, cancellation, and served-model verification are enforced before
  dispatch. Paid routing is off by default.
- **Evidence, not claims.** Results carry cited evidence, patches with base commits, check logs,
  and separate execution and acceptance statuses.
- **Qualification.** A private eval suite with hidden tests measures each model per task family
  and tier.
- **Web panel.** Opens on a projects grid with a project switcher: each project's jobs, tasks,
  sessions, brain, and settings; an all-projects dashboard; models and why each is or isn't used,
  routing previews and manual overrides, requests, provider keys, qualification, global
  knowledge, and every setting.

## Layout

| Path | What |
| --- | --- |
| `packages/router` | Library, `switchyard` CLI, MCP server, eval suite |
| `apps/panel` | Next.js web panel |
| `docs/setup.md` | Install, presets, configure, register with Claude Code, standalone jobs |
| `docs/roles.md` | Supervisors, workers, choosing models per role, the brain, attribution |
| `docs/operations.md` | Limits, provider keys, project fairness and limits, results, recovery, backup, the daemon, known limitations |
| `docs/decisions.md` | Design decisions, provider facts and sources, upgrade notes |

## Quick start

```bash
pnpm install && pnpm -r build
node packages/router/dist/cli.js init . --preset claude-code --project my-app --repo app=../my-app   # or standalone-free, standalone-hybrid, standalone-paid
SWITCHYARD_NEW_KEY=gsk_... node packages/router/dist/cli.js keys add groq --billing free_tier   # or the panel's Provider keys page (/all/keys)
node packages/router/dist/cli.js doctor   # adding a key already listed its provider's models
```

See [docs/setup.md](docs/setup.md).

## Development

```bash
pnpm -r typecheck
pnpm -r test
```
