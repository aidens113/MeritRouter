# Direct providers (remove FreeLLMAPI)

Status: Active
Status detail: Plan written 2026-10-19; paused by the user before implementation (no code changed). Resume at P1.
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

**P1 done (2026-10-20)** on `feat/direct-providers` (worktree `D:/sy-wt/dp`): `src/providers/`
has the registry, vault, credentials, client, discovery, enrichment, key state, limits, and
health; nothing is wired into Gate, the catalog, or the service yet. 359 tests green.

**Carried into P2 (from the P1 reports):**
- Gate: choose how key health reaches it (`providers()` calls `providerStatuses`, or
  `ProviderHealth.lookup` reads key state); an out-of-credits key shows as `invalid` in
  `ProviderStatus`, check against `pool_exhausted` handling in `gate.ts`.
- Catalog: make `supportsTools`/`supportsStructuredOutput` nullable (unknown is stored as
  `false` today); `Catalog.saveDiscovered` disables every row not passed in, so add a
  per-provider save that leaves failed listings alone.
- The discovery tool probe must be given a Gate-backed client.
- Config: remove `gateway`, `discovery.free_platforms`, `discovery.default_output_limit_tokens`;
  `schema.ts` is at 790 lines and must shrink.
- Export `src/providers` from `src/index.ts`.
- Live confirmation still needed: rate-limit header formats (OpenRouter reset, SambaNova -day,
  Anthropic periods), OpenAI `insufficient_quota` as out of credits, Cloudflare/Cohere list
  pagination, Anthropic `capabilities`, OpenRouter `/api/v1/key` shape.

**P2 done (2026-10-20):** FreeLLMAPI is removed from the router; every model request goes
direct through `src/providers` (`src/gateway/direct.ts`). Decisions are in the
[p2-wire](./direct-providers/reports/p2-wire.md) and
[p2-remove](./direct-providers/reports/p2-remove.md) reports: health read from key state;
out of credits disables only that key; a model is paid unless verified free at $0, a
key-basis free model uses only `free_tier` keys, and a paid key on a `:free`/$0 model is treated
as free; a 429 cools the key for every model of that provider; paid spend is keyed by
credential ref; upgrading deletes stored chain-routed endpoints (a scan with keys refills them).
367 tests green; `init` presets are valid again (supervisor fix plus a test).

**Next steps:** P3: `p3-panel` and `p3-cli-docs` in parallel (dispatched 2026-10-20). Their
inputs are the "P3 leftovers" and "Open questions" sections of the p2-remove report. Then
merge to `dev`, fast-forward `main`, and plan the first live check with the user (it spends
real quota).

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

### Brief: p2-wire (after P1; serial before p2-remove)
- Task: route every `{kind:"direct"}` endpoint, free or paid, through `src/providers`: the
  gate's existing direct path (`gate.ts` ~L363-460) uses `createProviderClient`,
  `ProviderCredentials`, `ProviderKeys.select` (a 429 cools the key and retries the next key
  before the next endpoint; 401/403/402 recorded), `ProviderLimits` reserve/settle, and per-model
  `rateLimits` when known. `isPaid` comes from price plus billing class; paid policy, budgets,
  and spend tracking still apply to paid. Provider health from `providerStatuses` feeds breakers
  and adaptive slots. Catalog: nullable `supportsTools`/`supportsStructuredOutput` (unknown is
  excluded from work that needs it), a per-provider save for discovery that leaves failed
  listings alone. Service: build providers, credentials, keys, limits, client; run
  `discoverModels` on `discovery.interval_minutes` and on demand (`models scan` path), with a
  Gate-backed client for the tool probe. Export `src/providers` from `src/index.ts`. The paid
  route (`src/paid/catalog.ts`, `direct.ts`) folds into this path. FreeLLMAPI stays working for
  `{kind:"chain"}` endpoints in this step; tests for the direct path use a fake provider fetch.
- Owns: `src/gateway/**` (not the FreeLLMAPI files), `src/models/catalog.ts`, `src/routing/**`,
  `src/core/service.ts`, `src/paid/**`, `src/providers/**`, `src/index.ts`,
  `src/storage/migrations.ts` (append), `tests/helpers.ts` (add, do not remove), new
  `tests/providers-routing.test.ts`.
- Report to: docs/working/direct-providers/reports/p2-wire.md

### Brief: p2-remove (after p2-wire)
- Task: delete FreeLLMAPI: client, admin client, `models/chains.ts` and chain verification,
  `{kind:"chain"}` routes, scanner FreeLLMAPI mapping, `gateway` config (`request_timeout_seconds`
  now under `providers`), `discovery.free_platforms` and `default_output_limit_tokens`,
  `fl_key_billing` and `pool_verifications` (dropping migration). Old configs with `gateway`
  fail with a clear message. Move every test to the fake provider fetch. Keep `src/admin/**`,
  `cli.ts`, and `mcp.ts` compiling with minimal changes (their UI and wording are P3).
- Also (from p2-wire): record paid spend by `key_ref` (the credential ref) so config-declared
  keys keep their identity across restarts, replacing the in-memory negative ids in
  `paid/spend.ts`; move `tests/paid.test.ts` and `tests/session-faults.test.ts` to the
  `FakeProvider` helper and delete the test-only `directClient` adapter; schedule the
  OpenRouter free daily quota refresh (`probeFreeDailyQuota`) with discovery. The served-model
  quarantine that never lifts is pre-existing; leave it and note it.
- Owns: `src/gateway/**`, `src/models/**`, `src/routing/**`, `src/core/**`, `src/config/**`,
  `src/storage/migrations.ts`, `src/paid/**`, `src/providers/**`, `tests/**`, minimal compile
  fixes elsewhere.
- Done: whole suite green; `grep -ri freellmapi packages/router/src` finds nothing outside
  comments that record history.
- Report to: docs/working/direct-providers/reports/p2-remove.md

### Brief: p3-panel and p3-cli-docs (after P2, parallel)
- Both: start from the p2-remove report's "P3 leftovers" list; no FreeLLMAPI wording may remain
  outside history records.
- p3-panel: Provider keys page on the vault (provider picker incl. custom, paste key, Test,
  billing class, limits, status, models found), Paid routes folded in, models/overview/settings
  without FreeLLMAPI, demo seed with fake providers on an offline base URL so Scan never reaches
  the network; `addPaidKey` accepts every registry and configured provider; check the provider
  health badge against key cooldowns (the demo showed "healthy" beside "all keys cooling
  down"). Owns `apps/panel/**`, `src/admin/**`.
- p3-cli-docs: CLI `keys add|test|list|remove`, `models scan`, `doctor`, `init`, presets and
  example config, `docs/setup.md`, `docs/operations.md`, `docs/decisions.md` (FreeLLMAPI section
  becomes history), README. Owns `src/cli.ts`, `src/cli/**`, `src/mcp.ts`, `examples/**`,
  `scripts/build-presets.mjs`, `docs/*.md`. Record in `decisions.md` the P2 decisions listed in Current State, and the
  upgrade notes (chain endpoints deleted, `ScanSummary` lost `chainsSynced`/`chainsDisabled`).

---

## Work Ledger

### 2026-10-19 — Plan written
- Agent: supervisor (code map and provider research by subagents)
- Changed: this document; `docs/working/README.md`.
- Why: user requirement to enter keys directly and drop FreeLLMAPI.
- Validation: not validated (design only).
- Outcome: Accepted
- Follow-up: P1.

### 2026-10-19 — Paused before P1
- Agent: supervisor
- Changed: this document (Current State, briefs), `research.md`, handoff in `CLAUDE.md`.
- Why: user asked to write the plan down and wrap up.
- Validation: not validated (no code changed; the stopped worker's worktree had no edits).
- Outcome: Accepted
- Follow-up: resume at P1.

### 2026-10-20 — p1-foundation
- Agent: worker p1-foundation; verified by supervisor
- Changed: `src/providers/` (registry, vault, credentials, client, transport, errors,
  rate-limits, openai-compatible, anthropic, index); `src/paid/vault.ts` and `direct.ts` shims;
  `providers` config section; migration adding account/quota-group/limit columns to `paid_keys`;
  `tests/providers-client.test.ts`. Details: [report](./direct-providers/reports/p1-foundation.md).
- Why: P1 foundation.
- Validation: supervisor ran `pnpm -r typecheck` (pass), router build (pass), `npx vitest run`
  (34 files, 323 passed). No live provider calls.
- Outcome: Accepted
- Follow-up: unverified header formats (OpenRouter reset, SambaNova -day, Anthropic periods) and
  OpenAI `insufficient_quota` as out-of-credits need live confirmation; `schema.ts` at 786 lines,
  P2's `gateway` removal must shrink it.

### 2026-10-20 — p1-limits and p1-discovery (P1 complete)
- Agent: workers p1-limits and p1-discovery (parallel, disjoint files); verified by supervisor
- Changed: `src/providers/{keys,limits,health}.ts`, migration for `provider_key_state` and
  `provider_usage`, `tests/providers-limits.test.ts`; `src/providers/{discovery,enrich}.ts`,
  `discovery` config fields `probe_tools` and `max_probe_requests_per_day`,
  `tests/providers-discovery.test.ts`. Details: [limits](./direct-providers/reports/p1-limits.md),
  [discovery](./direct-providers/reports/p1-discovery.md).
- Why: P1 key state, rotation, limits, health, and discovery.
- Validation: supervisor ran `pnpm -r typecheck` (pass), `pnpm -r build` (router and panel
  pass), `npx vitest run` (36 files, 359 passed). The discovery worker saw one
  `operations.test.ts` ENOTEMPTY temp-dir failure under load that passed on re-run; not seen
  in the supervisor's run. No live provider calls.
- Outcome: Accepted
- Follow-up: the P2 carry-over list in Current State.

### 2026-10-20 — p2-wire
- Agent: worker p2-wire; verified by supervisor
- Changed: `src/gateway/direct.ts` (new direct path), `gate.ts`, `src/providers/{runtime,
  discovery-run}.ts` (new), catalog nullable tool/structured support and per-provider save,
  routing exclusions, service wiring and scheduled discovery, paid route folded in, spend
  `key_ref` migration, `src/index.ts` exports, `FakeProvider` test helper,
  `tests/providers-routing.test.ts`; panel types widened to `boolean | null` (accepted
  out-of-ownership edit; needed for typecheck); two P1 discovery test expectations `false` to
  `null` (accepted; they pinned interim behaviour).
- Why: P2 step 1, route all direct endpoints through `src/providers`.
- Validation: supervisor ran `pnpm -r typecheck` (pass), `pnpm -r build` (router and panel
  pass), `npx vitest run` (37 files, 369 passed); demo panel `/models` and a model detail page
  returned 200 and the detail screenshot shows tool/structured fields correctly. No live
  providers; migration not tried on an upgraded store.
- Outcome: Accepted
- Follow-up: in the p2-remove brief.

### 2026-10-20 — p2-remove (P2 complete)
- Agent: worker p2-remove; supervisor fix for `init` presets
- Changed: FreeLLMAPI client, admin client, chains, `gateway` config, chain routes deleted;
  migration dropping `fl_key_billing`/`pool_verifications`, chain endpoint rows, and rekeying
  `paid_spend` by `key_ref`; scan runs direct discovery and the OpenRouter quota refresh; tests
  moved to the fake provider (7 FreeLLMAPI-only tests deleted, 4 added); minimal panel changes
  (read-only keys list, `/api/keys*` 410). Supervisor: example config and presets carry a
  `providers` section instead of `gateway`, `models.example.yaml` comment, and a test that
  parses the example and every preset (fails on the old presets, passes now).
- Why: P2 step 2, remove FreeLLMAPI.
- Validation: supervisor ran `pnpm -r typecheck` (pass), `pnpm -r build` (pass),
  `npx vitest run` (37 files, 367 passed), `switchyard init --preset standalone-free` then
  `doctor` in a temp dir (config ok; asks for provider keys; nothing written to `~/.switchyard`);
  demo panel `/`, `/keys`, `/paid`, `/models`, `/settings`, `/routing`, `/requests`,
  `/qualification` returned 200, screenshots of `/` and `/keys` checked. The worker's panel
  check pressed Scan on the demo, which sent model-list requests with fake keys to nvidia,
  groq, cerebras, openrouter, google, OpenRouter `/key`, and Hugging Face (no chat requests,
  no real keys); P3 makes the demo offline.
- Outcome: Accepted
- Follow-up: P3.

---

## Open Questions

- None blocking. Which providers ship as built-ins is settled by the research report (official
  docs only); others are reachable as custom OpenAI-compatible providers.
