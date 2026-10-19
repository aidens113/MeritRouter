# SwitchYard Router

A multi-agent router and harness: a supervisor (Claude Code, or SwitchYard's own on models you
choose) delegates bounded work to free, and optionally paid, worker models, without giving up
control of which models run, what they may touch, what they spend, or what counts as "done".

- **Use it with Claude Code or on its own.** With Claude Code, Claude supervises through MCP
  tools. Standalone, SwitchYard runs its own supervisor on the models you choose (free or paid):
  it plans, delegates to workers, verifies, and integrates onto a job branch.
- **Supervisor and worker roles with rules.** Charters (built out from FluxIQ's agent protocol)
  define each role; the harness enforces what code can: edit scope, commands, budgets, brain
  access. See [docs/roles.md](docs/roles.md).
- **A shared brain.** Markdown working documents in git, shared by every agent and by you, with
  scoped access and an access-request workflow.
- **Every line attributed.** Commits carry the agent and model that wrote them; supervisors can
  undo any task, model, commit, or individual lines.
- **Paid credits, safely.** Optional direct routes to Anthropic, Gemini, DeepSeek, OpenRouter, ...
  with an encrypted key vault, billing classes, and hard budgets; off by default.
- **Every model is scanned and assigned.** Models in your FreeLLMAPI catalog are scanned for
  parameter counts (Hugging Face weights, provider descriptions, names), modalities, limits, and
  verified-free pricing. Uncertain counts wait for your confirmation.
- **Tasks are scored, then routed.** A versioned rulebook scores each task (scope, mode, checks,
  plus classifier tags when they can matter) into tiers T1-T3; T4 goes back to the supervisor.
  SwitchYard picks the smallest sufficient model for the tier and falls back across models
  itself, one single-model FreeLLMAPI chain per model.
- **Hard limits in code.** Per-task request budgets (including every coding-agent call), package
  allocations, deadlines, cancellation, and served-model verification are enforced before
  dispatch. Paid routing is off by default.
- **Evidence, not claims.** Results carry cited evidence, patches with base commits, check logs,
  and separate execution and acceptance statuses.
- **Qualification.** A private eval suite with hidden tests measures each model per task family
  and tier.
- **Web panel.** Models and why each is or isn't used, routing previews and manual overrides,
  tasks, requests, provider keys, qualification, and every setting.

## Layout

| Path | What |
| --- | --- |
| `packages/router` | Library, `switchyard` CLI, MCP server, eval suite |
| `apps/panel` | Next.js web panel |
| `docs/setup.md` | Install, presets, configure, register with Claude Code, standalone jobs |
| `docs/roles.md` | Supervisors, workers, choosing models per role, the brain, attribution |
| `docs/operations.md` | Limits, results, recovery, known limitations |
| `docs/decisions.md` | Verified FreeLLMAPI behaviour and design decisions |

## Quick start

```bash
pnpm install && pnpm -r build
node packages/router/dist/cli.js init . --preset claude-code   # or standalone-free, standalone-hybrid, standalone-paid
node packages/router/dist/cli.js doctor
```

See [docs/setup.md](docs/setup.md).

## Development

```bash
pnpm -r typecheck
pnpm -r test
```
