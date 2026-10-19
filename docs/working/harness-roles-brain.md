# Harness, roles, knowledge base, and paid routes

Status: Active
Status detail: Design approved in principle by the user on 2026-10-19; implementation in progress.
Created: 2026-10-19
Last updated: 2026-10-19
Owner: Senior supervisor agent
Scope: Make SwitchYard a standalone multi-agent system: native agent harness, role charters for supervisors and workers, a shared knowledge base with scoped access, direct paid routes, and configuration presets (Claude Code is one preset, not a requirement).
Paired document: none
Related: [decisions](../decisions.md), [operations](../operations.md)

## Current State

**Decided** (user, 2026-10-19): direct paid routes; brain as markdown working docs in git (shared,
mounts, supervisor approves access with human override); per-agent line attribution with
supervisor undo; local job branches, never pushed; everything configurable with presets.

**Done** (on `dev`): A paid routes, B brain, C charters, D harness (read-only and native coding
workers, standalone supervisor with delegation, integration, blame/undo, questions, resume),
G attribution, E presets and `docs/roles.md`, CLI and MCP for jobs/brain/blame. Panel first
pass merged; second pass (jobs, brain, paid, new settings) in progress.

**Not done:** live checks against real FreeLLMAPI, paid providers, and OpenCode; panel second
pass verification.

**Next steps:** verify and merge the panel second pass, then fast-forward `main`.

**Blockers:** none.

## Concepts

- **Role**: what an agent is for. Built-in roles: `supervisor`, `worker` (with specialisations
  `summarizer`, `inspector`, `analyst`, `implementer`, `reviewer`), `classifier`. Each role has a
  charter (rules text), a tool set, a knowledge-base access level, a model policy, and budgets.
- **Supervisor**: owns a job. Plans, writes the job's working document, briefs workers,
  verifies their claims, integrates results, records memory. In the Claude Code preset the
  supervisor is Claude Code itself and talks to SwitchYard over MCP. In standalone presets
  SwitchYard runs the supervisor with a model you choose (paid or free).
- **Worker**: executes one bounded brief (a task), reads only what the brief grants, writes only
  its own report, never edits shared state or commits. Its completion report is a claim.
- **Job**: a supervisor's unit of work: goal, repositories, supervisor model, budgets, a working
  document in the knowledge base, and the tasks it dispatched.
- **Knowledge base (KB)**: durable, shared memory. Entries live in scopes; access is granted per
  role and per brief; workers can request more.

## Phase A: direct paid routes

- **Provider adapters** (direct HTTPS, no FreeLLMAPI): `openai_compatible` (OpenAI, DeepSeek,
  Gemini's OpenAI endpoint, OpenRouter credits, Groq paid, any compatible base URL) and
  `anthropic` (Messages API). One attempt per request; no SDK retries.
- **Key vault**: paid keys stored in SQLite, AES-256-GCM, master key from
  `SWITCHYARD_MASTER_KEY` or a generated key file in the storage directory. Secrets are
  write-only through every interface.
- **Billing class per key**: `free_tier | paid_credits | paid_postpaid | trial` (+ expiry).
  FreeLLMAPI keys are free by default; a FreeLLMAPI key marked paid blocks its platform from free
  routing.
- **Endpoints**: paid models are catalog endpoints with `route.kind = "direct"`, a provider key,
  and a price table (OpenRouter prices fetched; others entered). They pass the same eligibility
  checks except "verified free"; instead they need a known price.
- **Cost control**: worst case per request = input estimate x input price + max_tokens x output
  price, reserved atomically with the request; reconciled to billed usage. Budgets: global
  week/month, per key (monthly cap, prepaid balance), per tier, per role, per task
  (`budget.maxPaidUsd`). The tightest applies. Balances refresh from provider APIs where they
  exist (OpenRouter, DeepSeek); otherwise you enter them.
- **Policy**: per tier and per role, `paid: never | on_free_exhaustion | preferred | premium`.
  Default `never` for every worker tier. `premium` makes T4 go to paid models instead of back to
  the supervisor. Supervisors in standalone-paid presets use `preferred`.

## Phase B: knowledge base (revised 2026-10-19: markdown files in git)

Source of truth is a git repository of markdown files, not a database. SwitchYard adds what
plain files lack: scoped access (agents reach the brain only through SwitchYard tools), per-file
locks with atomic writes, protocol validation on write, and a disposable full-text index cached
under `.switchyard/` and rebuilt from the files.

```text
brain/
  README.md                         generated index: status, owner, size, scope per document
  global/lessons/  global/glossary.md
  projects/<name>/
    decisions/  facts/  repos/<alias>.md
    working/<effort>.md             FluxIQ protocol document
    working/<effort>/reports/<task-label>.md
    working/<effort>/archive/YYYY-MM-DD-<topic>.md
```

- Mounts: a project scope can point at a repository's `docs/working/` (FluxIQ's existing docs
  become that project's brain without copying).
- Working docs keep FluxIQ's header block; other notes use YAML front matter.
- Validation: `Current State` <= 150 lines, ledger entries need a real `Validation` line (hearsay
  rejected), workers never write `Current State` or the ledger, compaction past 800 lines.
- Every write is a git commit with attribution trailers (same as code, Phase G); human edits made
  outside SwitchYard are committed as `Role: human` before SwitchYard writes.
- Access: scopes are folder paths; grants, access requests, and approval as designed earlier.

## Phase C: roles and charters

- Charters are markdown files shipped in `packages/router/charters/` and overridable per role in
  config. They flesh out FluxIQ's `AGENTS.md`: supervisor modes, delegation rule, brief format,
  verification, integration, memory upkeep, push policy (only supervisors commit, never
  workers); worker start rules, scope discipline, report format, return contract; reviewer and
  classifier rules.
- The harness assembles each agent's system prompt from: charter, role-specific tool rules,
  the brief (workers) or job goal (supervisors), and granted KB context. Rules that code can
  enforce are enforced by tools, not prompts (e.g. a worker's write tool only accepts allowed
  paths; KB writes outside grants are rejected).

## Phase D: harness and supervisor

- **Agent loop**: one engine for every role. Tools come from a registry filtered by role and
  brief; every model call goes through `Gate` (budgets, routing, paid policy); transcripts and
  tool results are artifacts; context compaction keeps requests inside the model's limits.
- **Tools**: repository read (list/read/search), workspace edit (write/replace/delete, confined
  to `allowedPaths`), run allowed commands, KB (search/read/write/request access), and for
  supervisors: `delegate`, `await`, `inspect_result`, `apply_patch` (to the job's integration
  worktree), `review`, `grant_access`, `finish_job`.
- **Native coding worker** replaces OpenCode as the default: edits are confined at the tool
  level, which is real containment for file writes. OpenCode stays available as a runner.
- **Jobs**: `switchyard run "<goal>" --repo app`, `sy.startJob()`, panel "New job", and MCP
  `start_job` for clients that want SwitchYard's supervisor. Jobs are durable and resumable like
  tasks.
- **Supervisor model selection**: `roles.supervisor.model` = an endpoint id, a list in order,
  or a selection rule (tier + prefer + paid policy).

## Phase G: line-level attribution and undo

- Commit trailers on every change: `Model`, `Role`, `Task`, `Job`, `Tier`, `Request`.
- Native harness: one commit per model response that edits files; OpenCode: worktree snapshot
  committed each time a new request reaches the job gateway; check commands that rewrite files
  commit as `Role: tool`.
- Integration cherry-picks worker commits onto `switchyard/job-<id>` (no squash); final merge
  into the user's branch with `--no-ff`.
- `switchyard blame`, panel blame view, MCP blame tool (git blame -> commit -> trailers).
- Supervisor-only undo tools: `undo_task`, `undo_model`, `undo_commit`, `undo_lines(file,
  ranges)`; each undo is a revert commit with a reason, recorded in the job ledger; confined to
  the job branch; never rewrites history.

## Phase E: presets and documentation

`switchyard init --preset <name>`:

| Preset | Supervisor | Workers | Paid |
| --- | --- | --- | --- |
| `claude-code` | Claude Code via MCP | free pools, tiers T1-T3 | off |
| `standalone-free` | best qualified free model (T3, most capable) | free pools | off |
| `standalone-hybrid` | a paid model you pick (e.g. Claude, Gemini, DeepSeek) | free pools; paid only on free exhaustion for T3 | supervisor preferred, workers T3 fallback |
| `standalone-paid` | paid | paid preferred for T2-T3, free for T1 | on, with budgets |

Docs: `docs/roles.md` (how supervisors and workers operate, model choice per role, KB use),
updated setup and operations.

## Phase F: panel second pass

Jobs (start, watch supervisor transcript, stop), knowledge base browser and editor with scopes,
access requests (approve/deny), paid keys (billing class, budgets, balance, spend), role and
preset configuration.

## Work Ledger

### 2026-10-19 — Design recorded
- Agent: supervisor
- Changed: this document
- Why: user asked for a standalone harness with roles, a shared knowledge base, and paid routes.
- Validation: not validated (design only).
- Outcome: Accepted
- Follow-up: Phase A.

### 2026-10-19 — Phase A: direct paid routes
- Agent: supervisor
- Changed: `packages/router/src/paid/*`, gate, admission, catalog, routing, config schema, CLI, insights, tests
- Why: user chose direct SwitchYard routing for all paid providers.
- Validation: `npx vitest run` in packages/router -> 66 passed; example config parsed with `parseConfig`.
- Outcome: Accepted
- Follow-up: live check against a real paid provider once a key is available.

### 2026-10-19 — Phases B, C, D, E, G
- Agent: supervisor
- Changed: `packages/router/src/{brain,attribution,harness,roles}/`, runners, charters, presets, CLI, MCP, docs
- Why: user asked for a standalone harness with roles, a shared brain, and line attribution.
- Validation: `npx vitest run` in packages/router -> 83 passed; `switchyard init --preset standalone-free` + `run` + `jobs` + `brain ls` smoke-tested by hand.
- Outcome: Accepted
- Follow-up: panel second pass; live provider checks.

## Open Questions

- None open; all four decisions took the recommended options (2026-10-19).
