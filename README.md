# MeritRouter

MeritRouter routes each task to the right model to reduce your AI costs.
It matches task requirements to the capabilities of your configured paid and free models,
within your routing policies and spending budgets.

It also gives coding agents a framework for testing and reviewing delegated work:
repository-scoped tasks, executable checks, independent review and recorded evidence.
The panel shows where requests and tokens went. Your initiating agent stays the FINAL
supervisor. By default, MeritRouter supervisors plan bounded deliveries, dispatch
workers, integrate changes and test the result before returning evidence for FINAL review.

**Want your agent to use MeritRouter? Copy this prompt into your agent’s chat:**

```text
Use MeritRouter for this repository. Read MeritRouter's own README and setup guide
at https://github.com/aidens113/MeritRouter or in its source checkout. Check whether
the MeritRouter MCP tools are connected. If setup is needed, help me build
it, register this repository and connect my agent; preserve existing configuration.
Keep my current agent as FINAL supervisor. Delegate bounded deliveries to the strongest eligible
MeritRouter supervisors; require specifications, worker delegation, integrated tests and
independent review. Review observed evidence before accepting the product.
Reduce model costs using capable free and paid routes within configured budgets.
Keep outside-repository access on human approval only.
Guide me to enter credentials in the panel and ask for required approvals.
Never put secrets in chat or Git.
Start by explaining what is ready and proposing one small task to verify setup.
```

## Get started

You need **Node.js 22.11 or later**, **Git**, and **pnpm 10.5**. You also need access
to a model provider or a compatible local model server to run model tasks. An existing
Claude Code or other MCP-capable agent can act as your supervisor.

Supervisor routing works with your eligible configured models by default. Current, sourced
capability evidence in `supervisor.routing.quality_evidence` improves selection; without it,
the router uses the strongest eligible route and labels its quality unverified. Model size
is a selection heuristic, not proof of supervisor ability. Set
`supervisor.routing.minimum_quality: frontier_or_qualified_supervisor` to require reviewed
evidence and block unqualified dispatch. See [supervisor setup](docs/setup.md). Legacy task-by-task
coordination remains available with `client_supervision.workflow: direct_tasks`.

If `pnpm` is missing, install it with `npm install --global pnpm@10.5.0`.

### 1. Download and build

Run these commands in PowerShell, Terminal or another shell:

```sh
git clone https://github.com/aidens113/MeritRouter.git
cd MeritRouter
pnpm install
pnpm -r build
```

### 2. Register your project and open the panel

Replace the example path with the repository you want workers to help with:

```sh
node packages/router/dist/cli.js setup --preset claude-code --project my-app --repo app="/absolute/path/to/your/repository"
```

On Windows, a path such as `app="D:/Projects/my-app"` works. Setup prints the configuration
location and starts the panel at **http://127.0.0.1:4477**. Existing configuration is retained.

In the panel:

1. Open **Provider keys** and add your model provider key. Keys are stored encrypted locally.
2. Open **Models** to review discovered models and confirm any unknown model sizes.
3. Open **Security settings** and keep **Human approval only** while getting started.

Paid routing is enabled by default with a **$5 rolling weekly cap**. T1-T3 workers can use
paid routes when eligible free routes are exhausted; T4 goes back to the supervisor.
Paid requests still require an eligible credential, known prices and budget headroom.
Free-tier availability depends on your provider and key. An existing coding-agent subscription
does not supply worker API credentials. Existing explicit policies and budgets are preserved.
For strictly free routing, choose `--preset standalone-free` or set `paid.enabled: false`.
See [cost controls](docs/setup.md#cost-controls-and-routing-defaults) before submitting work.

### 3. Connect your agent

For Claude Code, run this from the repository you registered. Replace both absolute paths
with your MeritRouter checkout and the configuration location printed by setup:

```sh
claude mcp add --transport stdio --scope local meritrouter -- node "/absolute/path/to/MeritRouter/packages/router/dist/cli.js" mcp --config "/absolute/path/to/meritrouter.config.yaml" --project my-app
```

Reconnect or restart your agent, then paste the prompt at the top of this page.
For other MCP clients, installed packages and standalone use, follow the
[setup guide](docs/setup.md).

### 4. Try a small task

Ask your agent:

> Use MeritRouter to inspect this repository and identify the files involved in one
> small bug. Do not change files yet. Review the worker’s findings and explain the next step.

Follow progress in the panel. For changes, your supervisor should give each worker a narrow
scope and acceptance criteria, then review its patch and check evidence. Commands requiring
host access wait for an exact approval on the task or job page.

## What you get

- **Controlled delegation:** role-specific workers, repository-scoped file tools, budgets,
  deadlines, cancellation and explicit outside-action approval.
- **Cost controls:** capable free and paid models, prompt-cache reuse, spending caps and
  per-task routing policies.
- **Model routing:** provider discovery, eligibility checks, task scoring and fallback.
- **Reviewable results:** task evidence, check logs, resumable sessions and attributed commits.
- **Usage visibility:** token and request graphs in global/project Overview, with hour/day/week/month ranges.
- **A connected workspace:** projects, jobs, delegated tasks, requests and a shared Markdown brain.
- **Local visibility:** a web panel for progress, keys, models, routing and security settings.

External autonomous coding runners are unavailable until an enforced OS sandbox exists.
Use the native runner; ordinary commands require approval. Automatic worker Task Lab execution
also requires durable execution proof. See [security and limits](docs/operations.md).

## Documentation

Start with the [documentation index](docs/README.md), or go directly to:

| I want to… | Read |
| --- | --- |
| Install, connect an agent or troubleshoot setup | [Setup](docs/setup.md) |
| Understand supervisors, workers and verification | [Roles](docs/roles.md) |
| Configure security, budgets, recovery or backups | [Operations](docs/operations.md) |
| Understand design choices and supported integrations | [Decisions](docs/decisions.md) |
| Upgrade an existing installation | [Migration](docs/setup.md#upgrading-from-switchyard) |
| Contribute to the implementation | [Agent instructions](AGENTS.md) |

## Development

```sh
pnpm install
pnpm -r typecheck
pnpm -r test
pnpm -r build
```

`packages/router` contains the `meritrouter` library, CLI and MCP server.
`apps/panel` contains the `meritrouter-panel` web application. Build a local installable
tarball with `npm pack` from `packages/router`; this builds and bundles the panel.
These instructions do not require the package to be published to npm.
