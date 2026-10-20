# Agent Instructions

These rules govern agents developing this repository. They are adapted from FluxIQ's
`AGENTS.md`. SwitchYard also implements supervisors and workers as product features; those
runtime roles are described in [docs/roles.md](docs/roles.md) and mirror the rules below.

## Agent Roles

**Senior supervisor agent** — the agent the user prompts directly. It owns
coordination, delegation, integration, verification, and the final result. It
declares the workflow mode, maintains working documents, and is the only role
that commits or pushes.

**Worker** — any agent invoked by another agent rather than by the user. A
worker executes one bounded brief, writes back to its own report file, and
reports what it did and did not verify. Workers never declare a mode, never
edit a shared document, and never commit or push.

A worker's completion report is a claim, not verification. The supervisor
confirms the result itself before treating it as done.

## Start Here

What you read depends on your role. Context is a budget; do not spend it on
documents your task will not use.

**Senior supervisor agent.** Read this file and `CLAUDE.md`. Before touching
work already in progress, read the [working document index](docs/working/README.md),
then the `Current State` section of the relevant document. Read
[Code Structure](#code-structure) before creating, moving, or splitting source
files.

**Worker.** Read your brief, the files it names, and the `Current State` of
the working document it points to. Read nothing else unless your brief says
to. If the brief is not enough to do the work correctly, say so instead of
reading broadly.

**Both roles.** Repository Boundary, Code Structure, Documentation
Maintenance, and Validation below are binding whether or not you read the
background documents.

Re-read background documents only when the task changes scope or the user
asks for their current guidance.

## Working Documents Are Agent Memory

Agent context does not survive a session, and workers share no context with
each other or with the supervisor. Documents under `docs/working/` are the
only channel through which one agent's knowledge reaches the next.

- Record findings, decisions, and validation results as the work happens, not
  as an end-of-task summary.
- Brief every worker in writing before dispatch; each writes back to its own
  report file. Partition briefs by file, never by topic. If two briefs need
  the same file, the work is serial.
- Commit working document updates with the work that changed them.

The [agent working document protocol](docs/working/agent-working-doc-protocol.md)
defines layout, status vocabulary, ledger format, compaction, brief format,
and the worker return contract. Read it when creating or restructuring a
working document, not for routine updates. SwitchYard's brain enforces the same
protocol at runtime (`packages/router/src/brain/protocol.ts`); keep the two in
step when either changes.

## Workflow Modes

The supervisor classifies each user prompt into one mode below and states it
in the first user-facing response as `Mode: <mode name>`. If more than one
applies, list them in execution order. Do not repeat the label in later
updates for the same prompt; announce a transition once when it happens.
Workers do not declare modes.

Follow the user's intent; the newest instruction takes precedence. If the
intended mode is genuinely unclear, ask before substantive work. Minimal
inspection to explain the ambiguity is allowed; silently choosing a broad
planning or implementation mode that could conflict with the user's intent
is not.

### 1. Plan And Write Working Doc

For investigation, audit, design, scoping, or planning before implementation.

Inspect the relevant implementation and documentation first. Create or update
a document under `docs/working/` recording findings, decisions, dependencies,
risks, validation requirements, and implementation phases and steps, concrete
enough that another agent can execute it without rediscovering the intended
architecture. Do not begin broad implementation unless the user also asks for
it; small probes needed to make the plan accurate are allowed.

### 2. Execute Plan With Workers

For implementing an existing plan, completing its phases, or when the user
asks for subagents.

- Read the current working document before assigning work.
- Divide independent phases among workers where parallel work is safe,
  partitioning by file.
- The supervisor owns coordination, integration, conflict resolution, review,
  validation, and the final result.
- Update the working document as each step is assigned, completed, validated,
  blocked, or revised, and record the results of checks run.
- Continue through every requested phase unless the user pauses the work or a
  genuine blocker requires user input.

### 3. Editing, Iteration, And Bug Fixes

For focused implementation, UI refinements, regressions, debugging, test
failures, and incremental changes that do not require executing a full plan.

Reproduce or inspect current behaviour before changing code whenever feasible.
Trace bugs to their cause instead of patching symptoms. Keep edits scoped,
preserve established architecture, and add or update tests in proportion to
risk. Validate the affected behaviour directly, including the panel when the
change touches it. Update authored documentation when the change is
substantial; a new working document is not required for every focused edit.

### 4. Testing And Live Validation

For testing existing behaviour, verifying completed work, reproducing a
problem live, operating the web panel for a testing session, or running
SwitchYard against real providers.

- Establish the expected behaviour, then choose the narrowest useful
  combination of unit, integration, MCP, CLI, panel, and live-provider tests.
- Inspect actual results. Do not report success from compilation alone or
  from a worker's report.
- Live provider checks spend real quota or money: state what will run and its
  budget before running it, and never with paid routing enabled unless the
  user authorized it.
- Preserve user data. Never point tests or demos at the user's real
  configuration, brain, or repositories; use temp directories and the panel
  demo (`apps/panel/.demo`). Clean up artifacts created solely by tests.
- Record exact failures, reproduction steps, environment details, and
  measured results. Distinguish verified behaviour from assumptions.
- This mode does not authorize broad product changes. If testing exposes a
  defect the user wants fixed, move to mode 3, then return here to verify.

If a prompt spans modes, begin with the earliest necessary one and announce
each transition.

### Delegation

Delegate to a worker when the task needs more than about five files read
whose content the supervisor will not need afterwards, when a run-fix-rerun
loop is expected, when edits are bulk and partitionable by file, or when
independent pieces touch no common file. Keep with the supervisor one- or
two-file edits it already understands, verification of worker claims,
integration, conflict resolution, and anything that needs the user's
conversation context. Dispatch has fixed overhead and a worker's claim still
needs verifying, so reads are the cost: route discovery through a worker or
`Explore` and read the conclusion. Briefs follow the protocol format, at most
40 lines; the worker's final message follows the protocol's return contract.

Prefer running independent workers in parallel. Typical splits here: router
library vs. panel (`packages/router/**` vs. `apps/panel/**`), separate
subsystems under `packages/router/src/`, and read-only reviews alongside
implementation. A worker that edits the router while another builds the panel
against it must be told which library API is stable.

## Repository Boundary

SwitchYard is a standalone, domain-neutral framework. It does not contain code
or data specific to any downstream project, including FluxIQ.

- Never commit secrets, API keys, FreeLLMAPI tokens, or paid-provider keys;
  tests use fakes. Never commit `.switchyard/`, databases, worktrees, brains,
  `.env` files, or `apps/panel/.demo`.
- External projects (FreeLLMAPI, OpenCode, provider APIs) are integrated
  through adapters and verified from their source or documentation; record
  verified behaviour in [docs/decisions.md](docs/decisions.md). Do not vendor
  their code.
- Model and provider facts (prices, limits, parameter counts) change; never
  hard-code them as truth. They come from scanning, configuration, or user
  confirmation, with provenance.

## Code Structure

The binding rules for this repository:

- **Placement by area.** Router code lives in `packages/router/src/<area>/`
  (`core`, `config`, `gateway`, `paid`, `routing`, `scoring`, `models`,
  `admission`, `storage`, `context`, `harness`, `runners`, `brain`,
  `attribution`, `qualification`, `workspaces`, `admin`, `roles`,
  `verification`, `sessions`, `operations`). Put a file
  in the area that owns its concern; create a new area only for a new
  concern. The panel's data access goes through `src/admin/insights.ts` (and the `src/admin/`
  files it re-exports) and
  the public exports in `src/index.ts`.
- **No catch-all files.** No `utils`, `helpers`, `misc`, or `common`. Name a
  file for what it does.
- **Tests** live in `packages/router/tests/`, named for the subsystem they
  cover. Test support stays in `tests/helpers.ts` and `tests/fixtures/`.
- **Boundaries in code.** Every runtime input (config, tasks, model output,
  stored rows, API bodies) is validated with zod. Every model request goes
  through `Gate`. Limits that matter (scope, budgets, access, attribution)
  are enforced by the tool or service, never by prompt text alone. Worker and
  model output is untrusted data.
- **Schema changes** to the SQLite store are new entries appended to
  `src/storage/migrations.ts`; never edit an applied migration.
- **Generated files** (`examples/presets/*.yaml`) are regenerated with their
  script (`scripts/build-presets.mjs`), never edited by hand.
- **Never extract-and-drop.** Code pulled out of a large file goes where its
  concern belongs, not beside the file it came from. When a file grows past
  roughly 800 lines, diagnose why before cutting.

**Enforcement.** There is no structure-audit script yet; `pnpm -r typecheck`
and the tests are the machine checks, and placement and boundary rules are a
review obligation for the supervisor.

## Documentation Maintenance

After a substantial change, update authored documentation in the same work
unit unless the user says not to. Substantial means: routing, admission, or
budgets; paid routes or the key vault; the brain or the working-document
protocol; attribution and undo; harness tools and their containment; agent
roles, charters, or presets; the configuration schema; CLI or MCP contracts;
storage, migrations, or recovery; panel behaviour.

When the user asks for documentation, it is required work, not a follow-up.
Current-state design lives in `docs/` (`roles.md`, `operations.md`,
`decisions.md`, `setup.md`); task plans live in `docs/working/`.

## Validation

Before the final response for a code change, run the relevant checks and
read their output:

```bash
pnpm -r typecheck
cd packages/router && npx vitest run    # router tests (the MCP test needs dist/: pnpm --filter switchyard-router build)
pnpm -r build
```

For panel changes, also build the router and the panel, seed the demo, start
a production build on a spare port, request every touched page and API route,
and look at headless Chrome screenshots of changed pages.

Agents may start a temporary panel against the demo data for verification and
must stop it afterwards. Do not leave the panel running, or run it against the
user's real configuration, unless the user has explicitly authorized panel
management for the session; otherwise tell the user to run
`pnpm --filter switchyard-panel dev` themselves.

## Branches And Worktrees

Isolation is per unit of work, never per agent. A branch bounds a change, not
a worker: workers are ephemeral, several may serve one brief, and a
re-dispatched worker is still the same unit of work. Workers never commit, so
agent identity travels in commit trailers rather than in a branch name.

The supervisor picks the tier when it writes the brief:

- **Direct on `dev`** for supervisor edits it already understands and for
  self-contained changes that pass validation. This stays the common case.
- **A feature branch** `feat/<slug>` off `dev` for a briefed unit of work that
  may take several commits or be abandoned; merge it back with `--no-ff` and
  delete it.
- **A feature branch plus its own worktree** when another agent is running
  repository-wide validation concurrently, when the work is experimental and
  may be thrown away, or for a long build run. The trigger is validation, not
  editing: concurrent workers editing disjoint files in one checkout are safe,
  but a validation run that reads a tree someone else is editing reports false
  failures.

Commits produced from a worker's change carry `Worker: <agent-label>`. Merge
commits read `Merge feat/<slug>: <title>`. Commits are never squashed: they
are the step-by-step record. (SwitchYard's own runtime commits additionally
carry `Agent`, `Model`, and `Task` trailers; keep that convention intact.)

Merge `dev` into a feature branch and re-run the narrowest relevant checks
before merging back.

## Committing And Pushing

Only the supervisor commits or pushes.

Push `dev` without being asked when all of the following hold:

1. The work is a complete, coherent unit, not a partial refactor or an
   experiment left mid-flight.
2. The relevant checks were run and observed to pass. Compilation alone, or a
   worker's report, does not qualify.
3. Nothing known to be broken is included.

Fast-forward `main` to `dev` without being asked when a phase or a coherent
group of features is complete, its acceptance checks pass, documentation is
updated, and `pnpm -r build` succeeds. The user granted this standing
authorization for this repository on 2026-10-18; it replaces FluxIQ's
per-push approval for `main`.

Otherwise commit locally and say what is holding the push. Always state what
was pushed and what was not.

Require explicit user approval every time for: any force-push; any history
rewrite, including `filter-repo`, interactive rebase, and amending pushed
commits; deleting remote branches or tags; opening pull requests.

Never commit secrets, private project data, or generated runtime state.
Never use `--no-verify`. End commit messages with the attribution trailer the
session provides.
