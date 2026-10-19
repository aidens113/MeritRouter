# Decision record

Verified interfaces, routing boundaries, and every departure from the original plan
(`plan.md`, written for "fluxiq-workers"). Dates are 2026-10-19 unless noted.

## Verified FreeLLMAPI behaviour (server v0.2.1, commit 0c456ea)

Read from source, not documentation. Paths are relative to `server/src/`.

| Topic | Fact | Consequence here |
| --- | --- | --- |
| Inference | `POST /v1/chat/completions`, Bearer auth (unified key or `sk-cp-` client key). Body `model` is overwritten with the routed id; `_routed_via {platform, model}` and `X-Routed-Via: platform/model` identify the served route. | The gate verifies every response's served (platform, model). |
| Usage | OpenAI `usage`; `cached_tokens`/`reasoning_tokens` are subsets. When the upstream sends none, FreeLLMAPI fills a chars/4 estimate flagged `estimated: true`. No cost field. | Estimated usage is labelled `unknown` basis, never reported as provider usage. |
| Named chains | `auto:<name>` resolves global sort aliases first (`smart`, `fast`, `cheap`, `reliable`, `balanced`, ...) to a **whole-catalog** sort, then profiles. Disabled rows are skipped. An exhausted chain returns 429/503; it never falls through to other models. | Pool names are validated; SwitchYard only ever sends `auto:sy-<hash>`. |
| `auto_include_new_models` | Defaults to 1 for non-empty profiles: catalog sync adds new models to the chain **enabled**. Profiles created with `empty: true` get 0. | Chains are created empty and verified to contain exactly one model. |
| Raw model ids | Route over that model's whole provider group, ignoring chain flags. | The adapter refuses anything that is not `auto:<chain>`. |
| Retries | Up to 20 attempts within a 45 s budget; `X-Fallback-Attempts` (failed hops) and `X-Fallback-Trail` report them after the fact. | Provider attempts are reported with `providerAttemptsExact: false`; no "hard attempt cap" is offered. |
| Keys | `api_keys` table: multiple keys per platform, AES-GCM at rest, `/api/keys` CRUD, `groupLabel`, per-key monthly caps. Keys rotate within a platform. | The panel manages keys through FreeLLMAPI; SwitchYard stores no provider keys. |
| Client keys | `sk-cp-` keys carry only a name and system prompt; they cannot be scoped to a chain. | Per-job scoping is done by SwitchYard's own job gateway. |
| Cache | Exact-match cache, off by default; key ignores the client key (shared). `X-FreeLLM-Cache: bypass` skips it. | `gateway.bypass_cache: true` by default. |
| Admin API | `/api/*` needs a dashboard session token (`POST /api/auth/login`, 30 days). `GET /api/models`, `/api/profiles`, `/api/profiles/:id/models`, `PUT /api/profiles/:id/reorder` (replaces members). Profile names: `[A-Za-z0-9_-]{1,20}`. | Chain names are `sy-` + 10 hex chars. |
| Health | `GET /v1/providers` (unified key): per-platform status, cooldown resume time. | Route ordering moves cooling-down platforms to the end. |
| Decision routing | Optional `decision` strategy sends messages to a separate decision model to reorder the active chain. | Documented risk; it cannot add chain members. Keep it off. |

Not verified from code: streaming chunk `model` fields, `/v1/responses` parity. SwitchYard uses
non-streaming chat completions only.

## Departures from the plan

1. **Per-model routing instead of per-profile pools.** The plan used one curated chain per profile
   and let FreeLLMAPI pick. SwitchYard now creates one single-model chain per endpoint, ranks
   endpoints itself, and falls back across them. Every attempt is admitted at our gate, so the
   per-task request cap covers fallbacks exactly; hidden retries remain only within one model's
   keys. (User decision, 2026-10-18.)
2. **Difficulty tiers.** Task types (the plan's profiles) choose tools and sandbox; a versioned
   rulebook scores measured features plus classifier tags into T1-T3 (or T4: returned to the
   supervisor). The plan said "no classifier call on every submission": the classifier runs only
   when tags can change the tier, sees metadata only (no file contents), is batched across tasks,
   and is cached by spec hash. Supervisor hints skip it. (User decision.)
3. **Automatic model scanning.** Every model in FreeLLMAPI's catalog is scanned; parameter counts
   come from Hugging Face weight metadata (exact), OpenRouter descriptions, and names, with
   provenance. Name-only counts wait for confirmation. Pricing is "free" only when declared
   (`discovery.free_platforms`) or published as $0 by OpenRouter. (User decision.)
4. **Qualification** gates tiers once `qualification.required` is enabled (off by default so new
   installs can route before any model has been evaluated).
5. **Paid routes are direct** (user decision, 2026-10-19): Anthropic Messages API or any
   OpenAI-compatible endpoint, never through FreeLLMAPI, one attempt per request, worst-case cost
   reserved before dispatch and settled to billed cost, keys in an encrypted vault with billing
   classes.
6. **SwitchYard has its own agent harness** for every role: read-only workers, the native coding
   worker (default), and the standalone supervisor. Tools enforce scope in code; OpenCode remains
   an optional runner.
7. **`await_results` waits up to `execution.await_max_seconds` (240 s)** and returns a bounded
   "still waiting" response; the installed Claude Code version's MCP backgrounding behaviour was
   not verified here.
8. **Package and storage naming:** `switchyard-router`, `.switchyard/`, MCP server `switchyard`.
9. **better-sqlite3 pinned to 12.x**: 13.0.3's N-API prebuild segfaults on Node 22.11 (Windows).
   **Vitest 3.2 + Vite 6**: Vitest 4/5 need Node >= 22.12.

10. **Standalone operation** (user decision): Claude Code is one preset. SwitchYard runs its own
    supervisor on models chosen per role; presets `claude-code`, `standalone-free`,
    `standalone-hybrid`, `standalone-paid`.
11. **The brain is markdown working documents in git**, not a database (user decision): FluxIQ's
    protocol, enforced on write; a disposable SQLite FTS index for search; shared across projects
    with mounts for existing `docs/working/` folders. Access requests are decided by the
    supervisor by default, with human override.
12. **Per-agent, per-line attribution via git** (user request): commits under the agent's identity
    with Agent/Model/Task trailers, one commit per editing model response, cherry-picked onto job
    branches (no squash); supervisors undo by task, model, agent, commit, or line as new commits.
13. **Supervisors commit only to local `switchyard/job-<id>` branches and never push**; the brain
    repository pushes only when `brain.push` is set.
14. **Every model-driven run is a durable agent session** (user requirement, 2026-10-19): an
    append-only JSONL event log per session, fsynced per event, indexed in SQLite; a tool journal
    writes each call's intent before it runs and its outcome after, so a resume (Phase S2) can tell
    which side effects happened. Recording failures fail the run rather than continue unrecorded.
15. **Interrupted sessions resume where they stopped** (user requirement, 2026-10-19): in-flight
    tool calls are settled by side-effect class before the agent continues (edits committed as
    recovered, delegations re-run idempotently, unknown outcomes reported to the agent); a stuck
    run is interrupted by a watchdog and resumed the same way; failing providers are isolated by
    per-provider circuit breakers rather than failing tasks.
16. **Importance drives verification, not difficulty** (user request, 2026-10-19, adapted from a
    consultant's proposal): an immutable contract per task; levels basic/standard/deep/strict
    from tier x importance plus rules re-evaluated on the actual change; Standard stays
    deterministic; Deep/Strict use an independent reviewer that never served the task;
    reviewer qualification is preferred for Deep and required for Strict; strict acceptance is
    automated by the job's supervisor unless `strict_acceptor: human`; verification reserves sit
    on top of execution caps under a ceiling and the level is never lowered to fit.
