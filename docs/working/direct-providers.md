# Direct providers (remove FreeLLMAPI)

Status: Active
Status detail: Plan written 2026-10-19; implementation starting.
Created: 2026-10-19
Last updated: 2026-10-19
Owner: Senior supervisor agent
Scope: SwitchYard calls model providers directly with keys the user enters in the SwitchYard panel or config; it discovers each provider's models itself; FreeLLMAPI is removed from the package entirely.
Paired document: none
Related: [agent sessions and teams](./agent-sessions-and-teams.md), [importance and verification](./importance-and-verification.md), [decisions](../decisions.md), [setup](../setup.md)

---

## Current State

**Requirement (user, 2026-10-19):** the user enters provider keys directly in SwitchYard's panel
or config files and never has to install, run, or log in to anything else. SwitchYard finds the
models those keys can use automatically. FreeLLMAPI is removed from the package (not kept as an
optional adapter).

**What exists today (verified 2026-10-19, `main` at d5c213e):**
- Free models go only through FreeLLMAPI: one single-model chain per endpoint (`auto:sy-*`),
  admin token required for scanning and chain verification, served-model checks from its
  headers, cooldowns from its `/v1/providers`, key rotation and per-key rate limits done inside
  FreeLLMAPI. `gateway` config is required and FreeLLMAPI-only.
- Paid models already go direct (`src/paid/`): an encrypted key vault (AES-256-GCM, master key
  from `SWITCHYARD_MASTER_KEY` or `<storage>/.master-key`), billing classes
  (`free_tier | paid_credits | paid_postpaid | trial`), OpenAI-compatible and Anthropic clients,
  spend tracking, price refresh from OpenRouter-style `/models`. Key choice is ordered fallback
  with no rotation on 429; billing class is not used in routing.
- SwitchYard already has its own circuit breakers, adaptive per-provider slots, admission
  budgets, and package allocation. Stored per-model `rateLimits` are never enforced.
- FreeLLMAPI itself gets models and limits from a signed catalog downloaded from its author's
  service (`api.freellmapi.co`) plus some `/models` discovery; source read from a local clone
  (v0.2.1, 0c456ea). Its provider base URLs are a useful cross-check (see research).
- The panel's Provider keys page talks only to FreeLLMAPI's admin API; the Paid routes page uses
  SwitchYard's vault.

**Next steps:** P1 (providers core) on `feat/direct-providers`.

**Blockers:** none.

---

## Design

### One key store, one direct path

- Every provider key lives in SwitchYard's vault (moved from `src/paid/` to `src/providers/`;
  same encryption and master key). Keys can also come from config: `providers.<id>.keys` entries
  with `api_key_env` (recommended) or a literal `api_key` (allowed; `doctor` warns that the file
  holds a secret). Several keys per provider are normal.
- Every model request goes direct to the provider through one client with per-API adapters:
  `openai_compatible` (most providers, and any custom or local server), `anthropic`, `gemini`
  (Google native or its OpenAI-compatible endpoint, whichever the research supports), and
  `cloudflare` (account id in the key). `fetch` is injectable for tests.
- Free vs paid is a property of the key's billing class and the model's price, not of the route:
  a `free_tier` key on a $0 model is free; anything with a positive price or a paid billing class
  is paid and obeys the existing paid policy, budgets, and spend tracking.

### Provider registry

- `src/providers/registry.ts`: built-in definitions (id, display name, API kind, default base
  URL, models path, auth style, required extra headers, known quirks such as single tool call),
  each with a source URL and the date it was checked (research report). Facts that change
  (limits, prices, model lists) are never hard-coded as truth; they come from discovery, response
  headers, or the user.
- Custom providers in config: any OpenAI-compatible `base_url` (including a local Ollama,
  llama.cpp, vLLM, or LM Studio server), with optional `no_key: true`.

### Model discovery (replaces `models scan` via FreeLLMAPI)

For each provider with at least one enabled key, on a schedule (`discovery.interval_minutes`) and
on demand (`models scan`, panel button, after adding a key):
1. Call the provider's model list with a key; keep only models the key can use.
2. Enrich in order, recording the source of every field: the provider's own metadata; the
   OpenRouter public catalog (no key) matched by model name; Hugging Face for parameter counts
   (existing code); a cheap probe for tool calling when still unknown (opt-in, budgeted, counted
   against `discovery.max_probe_requests_per_day`); user overrides in the panel or models file.
3. A model whose context limit, output limit, or tool support stays unknown is excluded from
   work that needs it (existing exclusions), never routed on a guess.
4. Models no longer listed become unavailable; manual entries and overrides win, as today.

### Limits, rotation, health (replaces what FreeLLMAPI did)

- Per-key state: cooldown until (from `retry-after` / rate-limit reset headers on 429), remaining
  requests/tokens when headers report them, consecutive failures, invalid (401/403).
- Key rotation: each request picks the provider's next usable key with headroom (round-robin
  among healthy keys); a 429 cools that key and retries the next key before moving to the next
  endpoint; an invalid key is disabled and shown in the panel.
- Optional configured limits per provider or key (`rpm`, `rpd`, `tpm`, `tpd`) enforced with
  sliding windows; the stored per-model `rateLimits` become enforced when known.
- Provider health (`ProviderStatus`) is computed from this state instead of FreeLLMAPI's
  `/v1/providers`; breakers and adaptive slots keep working on it.
- Served-model check: the provider's reported `model` must match the requested one (exact, or the
  provider's documented alias forms); a mismatch is recorded and quarantines the endpoint.

### Removal

FreeLLMAPI client and admin client, chain manager and chain verification, `gateway` config
section (`request_timeout_seconds` moves to `providers.request_timeout_seconds`), chain routes,
`fl_key_billing`, the FreeLLMAPI keys panel page and copy, doctor checks, scanner FreeLLMAPI
mapping, presets' gateway block, setup instructions. A new migration drops the
FreeLLMAPI-only tables (`pool_verifications`, `fl_key_billing`); applied migrations are not
edited. Old configs with a `gateway` block fail validation with a clear message saying what to
do instead.

### Surfaces

- Panel Provider keys page: pick a provider (or add a custom one), paste a key, Test (lists the
  models it can use), billing class, optional limits, status (healthy, cooling down until,
  invalid), and models found. No FreeLLMAPI wording anywhere. The Paid routes page folds into it
  (paid policy and budgets stay in Settings).
- CLI: `keys add <provider>` (secret from `SWITCHYARD_NEW_KEY` or an interactive hidden prompt),
  `keys test`, `models scan` without any admin token, `doctor` checks each provider.
- `init` presets need no gateway; setup is: install, start the panel, add keys, run.

---

## Phases

| Phase | Deliverable | Acceptance |
| --- | --- | --- |
| P1 | `src/providers/`: registry, vault (moved), keys from config, client adapters, discovery with enrichment, per-key limits and rotation, health; migration | Unit tests with a fake fetch per adapter; discovery fills endpoints with provenance; 429 rotates keys and cools them; invalid key disabled |
| P2 | Integration and removal: gate, catalog, scanner, routing exclusions, config schema, service wiring, test helpers; FreeLLMAPI code deleted | Whole suite green on direct providers only; no `freellmapi` references outside history and decision records |
| P3 | Panel keys page, models/overview/settings without FreeLLMAPI, CLI `keys`/`doctor`/`init`, presets, setup and operations docs | Fresh setup works from the panel alone (demo seed uses fake providers); screenshots; docs describe no external gateway |

---

## Worker Briefs

Branch/worktree: `feat/direct-providers` at `D:/sy-wt/dp`. Provider facts come only from
[research.md](./direct-providers/research.md). Built-ins: groq, google, nvidia, openrouter,
mistral, cerebras, cohere, cloudflare, sambanova, together, huggingface, anthropic, openai.
GitHub Models is retired and excluded. Any other OpenAI-compatible server (including local Ollama,
llama.cpp, vLLM, LM Studio) is a custom provider.

### Brief: p1-foundation
- Task: create `src/providers/` foundation: `registry.ts` (built-in definitions with API kind,
  default base URL or URL template, models path, auth style, extra headers, token-limit parameter
  name, parameter allowlist/renames, `tool_choice` mapping, rate-limit header family, quirks,
  `sourceUrl` + `checkedAt`); custom providers from config; `vault.ts` moved from `src/paid/`
  (pure move, re-export from the old path until P2 removes it) plus keys declared in config
  (`providers.<id>.keys[]` with `api_key_env` or `api_key`, `billing_class`, optional limits,
  `quota_group`, `account_id` for Cloudflare); `client.ts`: one `ProviderClient.complete()` with
  adapters `openai_compatible` (applying the registry rules) and `anthropic` (moved from
  `paid/direct.ts`), injectable `fetch`, classified errors (rate_limited with retry-after, auth
  invalid, out of credits 402, server, timeout, policy), body errors on HTTP 200, rate-limit
  header parsing into a normalized snapshot; config schema `providers` section (do not remove
  `gateway` yet; P2 does).
- Owns: `src/providers/**`, `src/paid/vault.ts` and `src/paid/direct.ts` (move + re-export
  shims), `src/config/schema.ts` (`providers` section), a migration if the vault needs new
  columns, `tests/providers-client.test.ts`.
- Done: adapter tests with a fake fetch for openai_compatible (Groq-, Mistral-, OpenRouter-,
  Cloudflare-style rules), anthropic, every error class, header families; config keys parse;
  full suite still passes.
- Report to: docs/working/direct-providers/reports/p1-foundation.md

### Brief: p1-discovery (after p1-foundation; parallel with p1-limits)
- Task: `src/providers/discovery.ts`: list models per provider with a usable key (pagination,
  per-provider list shapes), map to catalog endpoints `<provider>/<model>` with route
  `{kind:"direct"}`, enrich with field provenance (provider metadata, OpenRouter public catalog,
  Hugging Face parameter counts via existing code, optional budgeted tool probe, overrides), mark
  free from billing class plus $0 or `:free`, mark unlisted models unavailable.
- Owns: `src/providers/discovery.ts`, `src/providers/enrich.ts`, `tests/providers-discovery.test.ts`.
- Report to: docs/working/direct-providers/reports/p1-discovery.md

### Brief: p1-limits (after p1-foundation; parallel with p1-discovery)
- Task: `src/providers/limits.ts` and `src/providers/keys.ts`: per-key state (cooldown until,
  remaining from headers, invalid, consecutive failures) persisted in the store; key selection
  round-robin among healthy keys with headroom; 429 cools the key and the caller retries the
  next key; 401/403 disables the key; configured `rpm/rpd/tpm/tpd` per provider/key/quota group
  as sliding windows; OpenRouter `/api/v1/key` free daily quota probe; provider health
  (`ProviderStatus`) derived from key state.
- Owns: `src/providers/limits.ts`, `src/providers/keys.ts`, `src/providers/health.ts`, a
  migration, `tests/providers-limits.test.ts`.
- Report to: docs/working/direct-providers/reports/p1-limits.md

### Brief: p2-integrate (after P1)
- Task: route every request through the provider client; catalog from discovery; delete
  FreeLLMAPI (client, admin, chains, chain verification, `gateway` config, scanner mapping,
  `fl_key_billing`, `pool_verifications` via a dropping migration); `isPaid` from price and
  billing class; health, breakers, slots fed by provider key state; test helpers move to a fake
  provider fetch; old configs with `gateway` fail with a clear migration message.
- Owns: `src/gateway/**`, `src/models/**`, `src/routing/**`, `src/core/service.ts`,
  `src/paid/**`, `src/config/**`, `src/storage/migrations.ts`, `tests/**`.
- Report to: docs/working/direct-providers/reports/p2-integrate.md

### Brief: p3-panel and p3-cli-docs (after P2, parallel)
- p3-panel: Provider keys page on the vault (provider picker incl. custom, paste key, Test,
  billing class, limits, status, models found), Paid routes folded in, models/overview/settings
  without FreeLLMAPI, demo seed with fake providers. Owns `apps/panel/**`, `src/admin/**`.
- p3-cli-docs: CLI `keys add|test|list|remove`, `models scan`, `doctor`, `init`, presets and
  example config, `docs/setup.md`, `docs/operations.md`, `docs/decisions.md` (FreeLLMAPI section
  becomes history), README. Owns `src/cli.ts`, `src/cli/**`, `src/mcp.ts`, `examples/**`,
  `scripts/build-presets.mjs`, `docs/*.md`.

---

## Work Ledger

### 2026-10-19 — Plan written
- Agent: supervisor (code map and provider research by subagents)
- Changed: this document; `docs/working/README.md`.
- Why: user requirement to enter keys directly and drop FreeLLMAPI.
- Validation: not validated (design only).
- Outcome: Accepted
- Follow-up: P1.

---

## Open Questions

- None blocking. Which providers ship as built-ins is settled by the research report (official
  docs only); others are reachable as custom OpenAI-compatible providers.
