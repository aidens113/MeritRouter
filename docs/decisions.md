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
5. **Paid routing is not implemented.** The config rejects `paid_fallback_enabled: true`. A design
   for direct, cost-bounded paid routes is proposed and awaiting a decision (see below).
6. **Read-only workers use an in-package tool loop** (list/read/search confined to configured
   repositories through git), not OpenCode, for exact request counting and path containment.
7. **`await_results` waits up to `execution.await_max_seconds` (240 s)** and returns a bounded
   "still waiting" response; the installed Claude Code version's MCP backgrounding behaviour was
   not verified here.
8. **Package and storage naming:** `switchyard-router`, `.switchyard/`, MCP server `switchyard`.
9. **better-sqlite3 pinned to 12.x**: 13.0.3's N-API prebuild segfaults on Node 22.11 (Windows).
   **Vitest 3.2 + Vite 6**: Vitest 4/5 need Node >= 22.12.

## Open decision: paid credits

Proposed: paid keys live in SwitchYard (not FreeLLMAPI, which rotates every key on a platform
and retries invisibly), one attempt per request, worst-case cost reserved before dispatch
(input estimate x price + max_tokens x price), reconciled to billed usage; billing classes
`free_tier | paid_credits | paid_postpaid | trial`; budgets global/per key/per tier/per task;
per-tier policy `never | on_free_exhaustion | preferred | premium_tier` (default `never`).
Not built until confirmed.
