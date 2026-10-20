# Decision record

Verified interfaces, routing boundaries, and every departure from the original plan
(`plan.md`, written for "fluxiq-workers"). Dates are 2026-10-19 unless noted. FreeLLMAPI, the
gateway SwitchYard used until 2026-10-20, appears here only as history (last section).

## Direct providers (user decision, 2026-10-19; implemented 2026-10-20)

The user enters provider keys in SwitchYard (panel, CLI, or config) and never installs or runs
anything else; SwitchYard calls each provider and finds the models those keys can use. FreeLLMAPI
was removed from the package rather than kept as an optional adapter. Plan and phase reports:
[docs/working/direct-providers.md](working/direct-providers.md).

- **D1. One key store, one direct path.** Every key lives in the encrypted vault
  (`src/providers/vault.ts`, AES-256-GCM, master key from `SWITCHYARD_MASTER_KEY` or
  `<storage>/.master-key`) or in config (`providers.<id>.keys[]` with `api_key_env`, or a literal
  `api_key`, which `doctor` flags). Every model request, free or paid, goes through the gate's
  direct path (`src/gateway/direct.ts`) and one provider client with `openai_compatible` and
  `anthropic` adapters. Any other OpenAI-compatible server (Ollama, llama.cpp, vLLM, LM Studio)
  is a custom provider with a `base_url` and optional `no_key`.
- **D2. A built-in registry from documentation, not from a catalog service.** Built-ins: groq,
  google, nvidia, openrouter, mistral, cerebras, cohere, cloudflare, sambanova, together,
  huggingface, anthropic, openai, each with its source URL and check date
  (`src/providers/registry.ts`). GitHub Models is excluded (retired 2026-07-30). Limits, prices,
  and model lists are never hard-coded; they come from discovery, response headers, or the user.
- **D3. Billing class is required on every key** (`free_tier | paid_credits | paid_postpaid |
  trial`), in config, in the panel, and as `keys add --billing`, because it decides whether money
  moves.
- **D4. Free vs paid.** A model is paid unless verified free: priced at $0 or a `:free` id (model
  basis), or served by a `free_tier` key (key basis: such a model is then served only by
  free_tier keys). A paid key on a `:free` or $0 model is treated as free. Paid models obey the
  paid policy, budgets, and spend tracking.
- **D5. Key-level state replaces FreeLLMAPI's rotation.** Round-robin among available keys. A
  429 cools that key for every model of its provider (the provider's wait, else 30 s doubling up
  to 15 minutes) and the request moves to the provider's next key before the next model. A
  401/403 marks the key invalid until fixed. Out of credits (402, spend caps) disables only that
  key and rechecks after 6 hours. Configured `rpm/rpd/tpm/tpd` per provider, key, and quota
  group, and known per-model rate limits, are sliding windows kept in the store.
- **D6. Provider health is computed from key state** (`healthy`, `rate_limited` with `resumeAt`,
  `invalid`, `unknown`), in the `ProviderStatus` shape the breakers, adaptive slots, routing, and
  panel already used. Nothing polls a gateway.
- **D7. Discovery per provider.** Each provider with a usable key is listed with the first key
  whose listing works, and each model is enriched with field provenance (provider metadata,
  OpenRouter public catalog, Hugging Face, an opt-in budgeted tool probe, overrides). A failed
  listing leaves that provider's stored models alone; a successful one marks unlisted models
  unavailable. Unknown context, output, or tool support excludes a model from work that needs
  it; `supportsTools` and `supportsStructuredOutput` are nullable (unknown is not `false`).
- **D8. Paid spend is keyed by credential ref** (`vault:<id>`, `config:<provider>:env:<VAR>`,
  ...), so config keys keep their identity across restarts.
- **D9. The served-model check stays.** A response naming a different model than the one
  requested is discarded and quarantines the endpoint. The quarantine does not lift yet (a known
  gap, unchanged from before).
- **D10. CLI.** `switchyard keys add <provider>` reads the secret from `SWITCHYARD_NEW_KEY` or a
  hidden prompt, never from argv; `keys test` lists the models a key can use and marks a
  rejected key invalid; `keys list` shows vault and config keys with status and last four only;
  `models scan` needs no admin token; `doctor` reports each provider (keys, cooldowns, invalid
  keys, last listing) and warns when the config file holds a literal `api_key`. Doctor reads
  stored state only and never calls a provider.

### Provider facts (official documentation, fetched 2026-10-19)

Source of record: [research.md](working/direct-providers/research.md). Free-tier numbers change
often and are never used as truth in code.

| Provider | API and auth | Model list | Rate-limit signals | Free tier (as documented) | Source |
| --- | --- | --- | --- | --- | --- |
| Groq | OpenAI-compatible `api.groq.com/openai/v1`, Bearer | `/models`: context window, max completion tokens; no prices | `x-ratelimit-*`: requests per day, tokens per minute; `retry-after` | yes, per model | https://console.groq.com/docs/openai, https://console.groq.com/docs/rate-limits |
| Google AI Studio | OpenAI-compatible `generativelanguage.googleapis.com/v1beta/openai` (beta), Bearer; the native list uses `x-goog-api-key` | native `/v1beta/models`, paginated, token limits | none documented; 429 `RESOURCE_EXHAUSTED`; limits per project | yes, per project | https://ai.google.dev/gemini-api/docs/openai, https://ai.google.dev/gemini-api/docs/rate-limits |
| NVIDIA | OpenAI-compatible `integrate.api.nvidia.com/v1`, Bearer | `/v1/models` (fields unverified) | not documented | free trial | https://docs.api.nvidia.com/nim/reference/llm-apis |
| OpenRouter | OpenAI-compatible `openrouter.ai/api/v1`, Bearer | `/models`: context, prices, modalities, supported parameters | `X-RateLimit-*`, `Retry-After`; 402 with `limit_source`; `GET /api/v1/key` free daily quota; HTTP 200 may carry an error | `:free` or $0 models, daily quota | https://openrouter.ai/docs/api-reference/limits |
| Mistral | `api.mistral.ai/v1`, Bearer | `/v1/models`: capabilities, context | `Retry-After` only | lowest tier (numbers unverified) | https://docs.mistral.ai/api/ |
| Cerebras | OpenAI-compatible `api.cerebras.ai/v1`, Bearer | ids only | header names unverified | no; trial credits | research.md |
| Cohere | OpenAI-compatible `api.cohere.ai/compatibility/v1` | `api.cohere.com/v1/models?endpoint=chat` | none | trial keys | https://docs.cohere.com/docs/compatibility-api |
| Cloudflare Workers AI | `api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1`, Bearer token | `/ai/models/search` | none | daily Neurons allowance | research.md |
| SambaNova | OpenAI-compatible `api.sambanova.ai/v1`, Bearer | `/v1/models`: context, prices | `x-ratelimit-*` per minute and `-day` | yes | research.md |
| Together | OpenAI-compatible `api.together.ai/v1` | type, context, prices | unverified | none documented | research.md |
| Hugging Face | OpenAI-compatible `router.huggingface.co/v1`, chat only | | unverified | no monthly credits for free users | research.md |
| Anthropic | native Messages `api.anthropic.com/v1`, `x-api-key` and `anthropic-version` | `/v1/models` | `anthropic-ratelimit-*`, `retry-after`; the spend-cap 429 is not retried | none | research.md |
| OpenAI | `api.openai.com/v1`, Bearer | ids only | `x-ratelimit-*`, `Retry-After` | none | research.md |

Still unconfirmed against live providers: rate-limit header formats (OpenRouter reset, SambaNova
`-day`, Anthropic periods), OpenAI `insufficient_quota` as out of credits, Cloudflare and Cohere
list pagination, Anthropic `capabilities`, and the shape of OpenRouter's `/api/v1/key`.

### Upgrade notes (from a FreeLLMAPI-based install)

- **A config with a `gateway` section fails to load**, with a message saying SwitchYard calls
  providers directly: delete the section and add provider keys under `providers` or in the panel;
  `request_timeout_seconds` moves to `providers.request_timeout_seconds`.
  `discovery.free_platforms` and `discovery.default_output_limit_tokens` fail the same way, each
  saying what to set instead.
- **Chain endpoints are deleted on upgrade.** A migration drops `fl_key_billing` and
  `pool_verifications` and deletes every stored endpoint whose route is not direct (FreeLLMAPI
  chains and legacy rows without a route). The catalog holds only manual and paid entries until
  a scan with provider keys refills it. Panel overrides keyed to deleted ids stay, unused.
- **A models-file entry without `route`** now routes directly to its `providerId` (it used to go
  through a chain); `route.kind: chain` fails with a message.
- **`ScanSummary` changed** (`models scan --json`, the panel's last scan): it is now
  `{scanned, added, pendingConfirmation, unavailable, providers, errors}`. `chainsSynced` and
  `chainsDisabled` are gone; `providers` (the providers whose model list was read) is new.
  Without `--json`, `models scan` now prints a short text summary, and it exits 1 when nothing
  could be listed and there were errors.
- **`doctor --json`** checks gained `level` (`ok | warn | fail`); `ok` is false only for `fail`.
- **`keys add` requires `--billing`**, and `keys list` lists config keys too, by ref.
- **A 429 cools the key for every model of that provider** (FreeLLMAPI cooled per chain).

## Departures from the plan

1. **Per-model routing instead of per-profile pools.** The plan used one curated chain per profile
   and let the gateway pick. SwitchYard ranks endpoints itself and falls back across them; every
   attempt is admitted at our gate, so the per-task request cap covers fallbacks exactly. (User
   decision, 2026-10-18.) Until 2026-10-20 each endpoint was a single-model FreeLLMAPI chain,
   with hidden retries inside one model's keys; since then each endpoint is a provider model
   called directly and every key retry is an admitted, exact attempt (D1, D5).
2. **Difficulty tiers.** Task types (the plan's profiles) choose tools and sandbox; a versioned
   rulebook scores measured features plus classifier tags into T1-T3 (or T4: returned to the
   supervisor). The plan said "no classifier call on every submission": the classifier runs only
   when tags can change the tier, sees metadata only (no file contents), is batched across tasks,
   and is cached by spec hash. Supervisor hints skip it. (User decision.)
3. **Automatic model scanning.** Every model a provider lists for your keys is scanned (until
   2026-10-20: every model in FreeLLMAPI's catalog); parameter counts come from Hugging Face
   weight metadata (exact), OpenRouter descriptions, and names, with provenance. Name-only counts
   wait for confirmation. Free is decided per model and key (D4); `discovery.free_platforms` is
   gone. (User decision.)
4. **Qualification** gates tiers once `qualification.required` is enabled (off by default so new
   installs can route before any model has been evaluated).
5. **Paid routes are direct** (user decision, 2026-10-19): Anthropic Messages API or any
   OpenAI-compatible endpoint, one attempt per key, worst-case cost reserved before dispatch and
   settled to billed cost, keys in an encrypted vault with billing classes. Since 2026-10-20 free
   routes are direct too, through the same vault and client (D1).
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
17. **Teams plan as task graphs with enforced file leases** (user requirement, 2026-10-19):
    parallelism comes from dispatching every ready node of a versioned plan, bounded by
    `team.max_agents`; write conflicts are prevented by file leases taken at claim (the old
    per-delegate overlap refusal is advisory); dependents receive upstream results; whether a
    dependent may start on unaccepted inputs follows its importance.
18. **Teams nest and integrate through a queue** (user requirement, 2026-10-19): sub-supervisors
    fork their branch from the parent's and run on a carved budget; integration onto a job
    branch is serialised by a crash-safe merge queue that preserves worker trailers; a per-job
    channel carries findings and contracts between agents as untrusted, quoted data; redundant
    execution is opt-in per small node and decided by verification, not by speed alone.
19. **Parallelism is bounded by measured provider capacity** (user requirement, 2026-10-19):
    per-provider AIMD slot limits shared through the store decide how many requests run at
    once, rather than fixed numbers; supervisors and reviewers are never starved by their own
    workers; team effectiveness is measured from stored data and compared against a single
    agent on the same goals, with every comparison budgeted up front.
20. **FreeLLMAPI removed; providers called directly** (user decision, 2026-10-19; done
    2026-10-20). See "Direct providers" above.

## History: verified FreeLLMAPI behaviour (server v0.2.1, commit 0c456ea)

FreeLLMAPI was removed on 2026-10-20 (see Direct providers). None of this applies to the current
code; it is kept as the record of why SwitchYard routed the way it did before. Read from source,
not documentation. Paths are relative to `server/src/`.

| Topic | Fact | Consequence then |
| --- | --- | --- |
| Inference | `POST /v1/chat/completions`, Bearer auth (unified key or `sk-cp-` client key). Body `model` is overwritten with the routed id; `_routed_via {platform, model}` and `X-Routed-Via: platform/model` identify the served route. | The gate verified every response's served (platform, model). |
| Usage | OpenAI `usage`; `cached_tokens`/`reasoning_tokens` are subsets. When the upstream sends none, FreeLLMAPI fills a chars/4 estimate flagged `estimated: true`. No cost field. | Estimated usage was labelled `unknown` basis, never reported as provider usage. |
| Named chains | `auto:<name>` resolves global sort aliases first (`smart`, `fast`, `cheap`, `reliable`, `balanced`, ...) to a **whole-catalog** sort, then profiles. Disabled rows are skipped. An exhausted chain returns 429/503; it never falls through to other models. | Pool names were validated; SwitchYard only ever sent `auto:sy-<hash>`. |
| `auto_include_new_models` | Defaults to 1 for non-empty profiles: catalog sync adds new models to the chain **enabled**. Profiles created with `empty: true` get 0. | Chains were created empty and verified to contain exactly one model. |
| Raw model ids | Route over that model's whole provider group, ignoring chain flags. | The adapter refused anything that was not `auto:<chain>`. |
| Retries | Up to 20 attempts within a 45 s budget; `X-Fallback-Attempts` (failed hops) and `X-Fallback-Trail` report them after the fact. | Provider attempts were reported with `providerAttemptsExact: false`. |
| Keys | `api_keys` table: multiple keys per platform, AES-GCM at rest, `/api/keys` CRUD, `groupLabel`, per-key monthly caps. Keys rotate within a platform. | The panel managed free keys through FreeLLMAPI. |
| Client keys | `sk-cp-` keys carry only a name and system prompt; they cannot be scoped to a chain. | Per-job scoping was done by SwitchYard's own job gateway (still the case). |
| Cache | Exact-match cache, off by default; key ignores the client key (shared). `X-FreeLLM-Cache: bypass` skips it. | `gateway.bypass_cache: true` was the default. |
| Admin API | `/api/*` needs a dashboard session token (`POST /api/auth/login`, 30 days). `GET /api/models`, `/api/profiles`, `/api/profiles/:id/models`, `PUT /api/profiles/:id/reorder` (replaces members). Profile names: `[A-Za-z0-9_-]{1,20}`. | Chain names were `sy-` + 10 hex chars. |
| Health | `GET /v1/providers` (unified key): per-platform status, cooldown resume time. | Route ordering moved cooling-down platforms to the end. |
| Decision routing | Optional `decision` strategy sends messages to a separate decision model to reorder the active chain. | Documented risk; it could not add chain members. Kept off. |
| Catalog | Models and limits come from a signed catalog downloaded from its author's service (`api.freellmapi.co`) plus some `/models` discovery. | Its provider base URLs were a cross-check for the direct-provider registry. |
