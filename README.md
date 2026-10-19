# SwitchYard Router

Delegate bounded work from a Claude Code session to free external models, without giving up
control of which models run, how many requests they spend, or what counts as "done".

- **Supervisor stays native.** Claude Code keeps its own login and model; SwitchYard adds MCP
  tools (`submit_tasks`, `await_results`, ...) and a CLI.
- **Every model is scanned and assigned.** Models in your FreeLLMAPI catalog are scanned for
  parameter counts (Hugging Face weights, provider descriptions, names), modalities, limits, and
  verified-free pricing. Uncertain counts wait for your confirmation.
- **Tasks are scored, then routed.** A versioned rulebook scores each task (scope, mode, checks,
  plus classifier tags when they can matter) into tiers T1-T3; T4 goes back to the supervisor.
  SwitchYard picks the smallest sufficient model for the tier and falls back across models
  itself, one single-model FreeLLMAPI chain per model.
- **Hard limits in code.** Per-task request budgets (including every coding-agent call), package
  allocations, deadlines, cancellation, and served-model verification are enforced before
  dispatch. Paid routing is off.
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
| `docs/setup.md` | Install, configure, register with Claude Code |
| `docs/operations.md` | Limits, results, recovery, known limitations |
| `docs/decisions.md` | Verified FreeLLMAPI behaviour and design decisions |

## Quick start

```bash
pnpm install && pnpm -r build
node packages/router/dist/cli.js init .
node packages/router/dist/cli.js doctor
```

See [docs/setup.md](docs/setup.md).

## Development

```bash
pnpm -r typecheck
pnpm -r test
```
