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
  `anthropic` adapters. Ollama, LM Studio, and llama.cpp are built in (D11); any other
  OpenAI-compatible server (vLLM, LocalAI, ...) is a custom provider with a `base_url` and
  optional `no_key`.
- **D2. A built-in registry from documentation, not from a catalog service.** Built-ins: groq,
  google, nvidia, openrouter, mistral, cerebras, cohere, cloudflare, sambanova, together,
  huggingface, anthropic, openai (2026-10-19), and from the coverage research (2026-10-20)
  ollama, ollama-cloud, lmstudio, llamacpp, deepseek, fireworks, deepinfra, nebius, scaleway,
  ovhcloud, zai, moonshot, vercel, each with its source URL and check date
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

### Wider coverage (P4, 2026-10-20)

Source of record: [research-coverage.md](working/direct-providers/research-coverage.md) (official
documentation, fetched 2026-10-20); worker report
[p4-coverage.md](working/direct-providers/reports/p4-coverage.md).

- **D11. Local servers are built in and keyless.** `ollama` (never takes a key), `lmstudio` and
  `llamacpp` (keys optional: sent when configured, for servers with auth turned on). An entry
  under `providers` turns one on and gives it one keyless `free_tier` credential; an unconfigured
  local server is never contacted. `llamacpp` has no default address (its README says port 9931,
  older releases 8080): without `base_url` its credential is unusable and the client refuses
  locally. `OLLAMA_HOST` sets Ollama's address when `base_url` is not configured (`host`,
  `host:port`, or a URL; bind-all addresses become `127.0.0.1`). OVHcloud's documented anonymous
  tier uses the same optional-key path.
- **D12. Budgets use a local server's effective context.** Ollama: `num_ctx` from `/api/show`,
  else a loaded model's context from `/api/ps`, else `providers.ollama.default_context_tokens`,
  else 4096, the smallest documented server default (the real default depends on VRAM and
  `OLLAMA_CONTEXT_LENGTH`, which SwitchYard cannot see), always capped at the trained maximum.
  A local server's output is bounded by that context (Ollama: `num_predict` when set). LM Studio
  uses a loaded instance's context; an unloaded model's load-time context is undocumented, so it
  stays unknown unless configured. `/api/show` answers are cached per process by digest.
- **D13. New list shapes** `ollama_tags`, `lmstudio_native`, `deepinfra_list`, `ovh_catalog`,
  with an OpenAI-shaped fallback list (`{base}/models`, ids only) for Ollama and LM Studio when
  the native list fails for a reason other than the key. `models_path` on a native-list provider
  switches it to the OpenAI list. Server-reported exact parameter counts (Ollama
  `general.parameter_count`, llama.cpp `n_params`) are exact and confirmed; the catalog's
  evidence sources have no "provider" value, so they are stored as `description` evidence whose
  detail names the field.
- **D14. `tool_choice` is omitted where it is unsupported or unverified.** Ollama (local and
  cloud) never receives it; LM Studio, llama.cpp, Fireworks, Scaleway, Nebius, OVHcloud, and Z.ai
  receive only `auto`. A required tool call is enforced locally: the agent loop sends a reply
  without a tool call back to the model.
- **D15. Concurrency is a limit kind of its own.** DeepSeek (per account), DeepInfra (per model),
  and Ollama Cloud (per plan) document concurrent-request limits, recorded as `concurrency` in
  the registry. The number is account-specific and never assumed; the existing
  `team.provider_concurrency_limits.<id>` caps the gate's provider slots, which are shared across
  processes and already halve on 429s.
- **D16. Free per model without prices.** Z.ai's list states no prices, so its documented free
  models (GLM-4.7-Flash, GLM-4.5-Flash, GLM-4.6V-Flash) are listed in the registry with the check
  date; a `free_tier` key reaches only those, and any other Z.ai model is paid.
- **D17. Ollama Cloud's balance** (`/api/balance`) has its own key-info shape and probe
  (`probeOllamaBalance`); it is not OpenRouter's free daily quota and is not yet stored or shown.

**Excluded providers** (not built in and not addable as a custom provider):

| Provider | Reason |
| --- | --- |
| Google Vertex AI | OAuth access tokens from Application Default Credentials, valid one hour; no static key |
| Amazon Bedrock with SigV4 credentials | request signing, not a key (a long-term Bedrock API key on `bedrock-mantle` works as a custom provider) |
| Azure with Entra ID only | token auth (an Azure resource key works as a custom provider) |
| Perplexity | Sonar Chat Completions superseded by the Agent API (July 2026); search-specialised |
| Lambda Inference API | winding down |
| Kluster.ai | inference end of life 2025-07-24 (from a search snippet of kluster.ai's blog; the site no longer resolves) |
| Inference.net | pivoted to tracing and gateway products; no documented serverless model API (unverified) |

xAI, Alibaba Model Studio, MiniMax, Venice, Novita, Hyperbolic, Chutes, Featherless, Baseten,
AI21, SiliconFlow, Azure (resource keys), Bedrock (`bedrock-mantle`), vLLM, LocalAI, Jan,
KoboldCpp, text-generation-webui, SGLang, and TGI are custom-provider examples in
[setup.md](setup.md#custom-providers) rather than built-ins: deprecated or unverified APIs (xAI
Chat Completions), per-account URLs (Alibaba workspace, Azure resource), or no free tier and
unverified list fields.

Still unconfirmed against live servers: every new list shape, Ollama `/api/show` on ollama.com,
`OLLAMA_HOST` forms beyond `host:port`, which OVHcloud catalog field is the request model id,
whether Z.ai and Moonshot serve `/models`, LM Studio's `key` as the chat model id, and
`tool_choice` values on LM Studio, llama.cpp, Fireworks, Scaleway, and Nebius.

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

## Projects (user decision, 2026-10-20)

One install holds many projects. Each has its own repositories, brain folder, jobs, tasks,
sessions, and teams. Providers, models, routing, budgets, and settings stay global. One worker
runs every project at once. The user asked for a projects grid as the starting screen, a project
switcher, per-project pages, and a global dashboard. Plan and phase reports:
[docs/working/projects.md](working/projects.md).

1. **D1. One install, one store.** Projects are rows in the existing database, not separate
   databases. Shared state therefore stays shared: keys, catalog, usage, provider slots,
   breakers, and paid spend. Per-project data carries a `project_id`, stamped by insert triggers
   from the task. Separate databases would have let each project believe it owned the whole quota
   and paid budget.
2. **D2. Project settings live in the global config** under `projects.<slug>` (user decision).
   A project has its name and repositories, plus brain mounts, access approver, and
   auto-approve rules. It may override `verification`, `team` (`max_agents`, `max_depth`,
   `child_budget_share`, `channel_*`), `coding` (`allowed_commands`, `protected_paths`),
   `supervisor` (`allowed_commands`, `branch_prefix`), and `roles`. Any other key is refused.
   Overrides are merged onto the global section and validated with its schema when the config
   loads. The panel writes them through the same validated config writer, so every setting is
   still editable in the panel or the file.
3. **D3. Automatic upgrade.** A config with top-level `repositories` and no `projects` section is
   read as one project named after `brain.project`. Every existing row is given that project at
   each start; the backfill is idempotent. The first `projects create` converts the file:
   top-level `repositories` move under `projects.<brain.project>`, and every other top-level
   section stays global.
4. **D4. Brain isolation** (user decision). A project's agents read `projects/<own>/**` and
   `global/**` only. The supervisor's default read grant narrowed from `**` to those two.
   Reaching another project goes through the existing access-request flow. Brain search is
   limited to what the caller's grants reach, and each project's index refresh touches only its
   own folder, `global/`, and the root. Each project has a generated index
   (`projects/<p>/README.md`); the root index lists only `global/` and the project names.
5. **D5. Fair claiming.** Claims rotate across projects that have ready tasks, oldest first
   within a project, using stride scheduling weighted by `priority`. The rotation lives in the
   store (`meta`), inside the claim transaction, so it holds across restarts and processes.
   `max_concurrent_tasks` caps a project's running worker tasks, and a held task records
   `waiting_for_project_cap`. Global caps and provider capacity still apply on top. Prompt
   batches never mix projects.
6. **D6. Repository keys are per project.** File leases, the merge lock, and
   `tasks.writable_repo` use `<project>/<alias>`, so two projects with an `app` alias never block
   each other. Users keep writing the bare alias inside a project.
7. **D7. Budgets stay global, with optional per-project limits.** `paid_budgets` (USD per day,
   week, month) and `request_share` (a fraction of the package allocation) are enforced in the
   same reservation as the global limits. Each has its own denial reason:
   - `project_paid_budget_exhausted` skips paid models for that project, which falls back to
     free ones;
   - `project_allocation_exhausted` defers the task to the window's reopening.
8. **D8. MCP per project.** `mcp.js --project <slug>` chooses the project. Without the flag, the
   server takes `SWITCHYARD_PROJECT`, then the only project, then the project whose repository
   contains the working directory. `--no-worker` is for running beside a daemon. Brain tools
   work in the server's project. The CLI uses the same selection order.
9. **D9. Gated global knowledge** (user decision). Only supervisors and people add to `global/`,
   and a supervisor's lesson must be worth sharing. Code enforces this, not prompt text:
   - a deterministic check refuses the project's slug, name, repository aliases, paths, and
     files inside its repositories, and requires a source in the project's brain;
   - an independent reviewer on a free model from another family judges the lesson against a
     fixed rubric, through a review task and the gate;
   - a rejected lesson is kept in the project with the reason;
   - every global entry records its project, supervisor, sources, and verdict;
   - people can revert a global entry from `/all/knowledge`;
   - `brain.global_requires_approval` adds a person's approval.

   No agent grant can write `global/**` or `projects/*/promotions/**`.

### Departures recorded during the build

- **`workspaces.repo_alias` and `merge_queue.repo_alias` stay bare.** The plan namespaced every
  alias column. These two rows are keyed by task, so they cannot collide across projects, and
  five readers resolve them inside the task's own project. Only the cross-task keys are
  namespaced: `tasks.writable_repo`, `file_leases.repository`, and `merge_queue.lock_key`.
- **Idempotency keys are unique per install, not per project.** A key used in one project is
  refused in another. Scoping it would need a table rebuild for a composite unique index.
- **The global panel section lives under `/all/...`** (dashboard, requests, models, routing,
  keys, qualification, calibration, knowledge, settings), not at the top level.
  - The URL alone tells the shell its scope: `/p/<slug>` is a project, `/all` is every project,
    and `/` and `/new` are home.
  - Requests exist in both scopes (`/p/<slug>/requests` and `/all/requests`), so a top-level
    `/requests` would be ambiguous.
  - Old flat URLs redirect.
- **Qualification runs in a reserved internal project, `_qualification`.** Qualification and
  eval-goal comparison runs, with their fixture repositories, go there instead of the primary
  project.
  - Putting them in the primary project would have shown fixtures in a user project's
    repositories, grid, `doctor`, MCP, and D9 check.
  - The slug cannot collide, because user slugs start with a letter or digit.
  - It is never listed, and users cannot submit into it.
- **The MCP server fails fast.** When no project can be chosen, it exits with the list of
  projects instead of starting with a guessed default or with tools that require `project`. A
  wrong default would write tasks and brain entries into the wrong project.
- **The legacy project slug defaults to `default`**, the schema default of `brain.project`, not
  `my-project` as the plan said. `init` names the first project `my-project` unless `--project`
  is given.
- **The archived flag lives in the store's `projects` table**, not in the config file.
- **One daemon for every project.** `daemon`, `daemon start`, and `service` refuse `--project`
  rather than start per-project workers. `daemon status` reports per-project queues from the
  store.
- **Backups include the brain repository** as a git bundle (backup format 2). A restore refuses
  a brain with uncommitted changes even with `--force`, and moves a replaced brain aside. Brain
  mounts are listed in the manifest as not included.

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
21. **One install, many projects** (user decision, 2026-10-20). See "Projects" above.

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
