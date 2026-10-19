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

**Decided** (user, 2026-10-19): paid routes go directly through SwitchYard, never through
FreeLLMAPI. Everything else uses the defaults recommended below. Everything must be
configurable, with presets including one for Claude Code.

**Done:** routing core, tiers, scanning, qualification, coding runner, CLI, MCP (see
`decisions.md`). Phase A (direct paid routes, vault, budgets) on `dev`. Panel first pass in
progress.

**Not done:** Phases B-F.

**Next steps:** the user asked to review the knowledge-base and harness plan before
implementation (2026-10-19). Open decisions: brain location (shared vs per project), default
access-request approver, supervisor commit policy, markdown export mode. Then B, C, D, E, F.

**Blockers:** none. Live checks still need FreeLLMAPI, provider keys, and paid credentials.

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

## Phase B: knowledge base

- **Storage**: `kb_entries` (current version), `kb_versions` (history), FTS5 index, `kb_grants`,
  `kb_access_requests`. Markdown export/import to a directory so the brain can be tracked in git
  (durability rule from FluxIQ).
- **Scopes** (hierarchical paths): `global`, `project/<name>`, `repo/<alias>`, `job/<id>`,
  `task/<id>`. Kinds: `working_doc`, `ledger_entry`, `brief`, `report`, `decision`, `fact`,
  `lesson`, `glossary`, `note`.
- **Working-document protocol** built in: a working doc has a header block, a `Current State`
  (rewritten, capped at 150 lines), a ledger (append-only entries with a mandatory
  `Validation` line), and open questions. Workers never edit `Current State` or the ledger.
- **Access**:
  - supervisor: read/write everywhere it is configured for (default `global` and its job).
  - worker: read its brief's grants (default: its task scope, its job's `Current State`, and the
    repo scopes of its repositories); write only its own `task/<id>` report.
  - classifier: none.
  - Workers call `kb_request_access(scope, mode, reason)`. Requests are decided by the policy:
    `auto` rules (e.g. read `repo/*` for T2+), the supervisor agent, or a human (panel/MCP).
    Default: supervisor decides; in the Claude Code preset, Claude Code decides via MCP.
- **Provenance**: every write records role, task, job, model endpoint, and evidence refs.
- **Promotion**: lessons in worker reports are promoted to `global` only by a supervisor.

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

## Open Questions

- Should the knowledge base also sync to FluxIQ-style `docs/working/` files in each repository
  automatically, or only on export? Default: export on demand. Owner: user.
