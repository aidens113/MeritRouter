# Direct providers (remove FreeLLMAPI)

Status: Active
Status detail: P1-P3 merged 2026-10-20. P4 (wider coverage incl. Ollama) in progress. A first live check with real keys remains (needs user approval).
Created: 2026-10-19
Last updated: 2026-10-20
Owner: Senior supervisor agent
Scope: SwitchYard calls model providers directly with keys the user enters in the SwitchYard panel or config; it discovers each provider's models itself; FreeLLMAPI is removed from the package entirely.
Paired document: none
Related: [agent sessions and teams](./agent-sessions-and-teams.md), [importance and verification](./importance-and-verification.md), [decisions](../decisions.md), [setup](../setup.md)

---

## Current State

**Requirement (user, 2026-10-19):** the user enters provider keys directly in SwitchYard's panel
or config files and never has to install, run, or log in to anything else. SwitchYard finds the
models those keys can use automatically. FreeLLMAPI is removed from the package.

**Done (2026-10-20), merged to `dev` and `main`:**
- P1 `src/providers/`: registry of 13 built-ins plus custom OpenAI-compatible providers, the
  vault (moved from `src/paid/`), config-declared keys, one client (`openai_compatible`,
  `anthropic`) with classified errors and normalized rate-limit headers, discovery with
  per-field provenance, per-key state and round-robin rotation, configured and per-model
  limits, health from key state.
- P2: every model request goes direct (`src/gateway/direct.ts`); FreeLLMAPI client, admin,
  chains, `gateway` config, and its tables are deleted; tests run through a fake provider.
- P3: Provider keys panel page on the vault (add, test, edit, status, models found; Paid
  routes folded in), CLI `keys add|list|test|enable|disable|remove` and per-provider `doctor`,
  offline demo, docs (`setup`, `operations`, `decisions` D1-D10 with upgrade notes, README).
- p3-fixes: secrets masked in provider errors at the source, discovery marks rejected keys,
  one shared key test, stale errors dropped from health, `base_url` overrides move absolute
  model-list URLs, a paid provider appears once in health.
- Decisions are in `docs/decisions.md` and the [reports](./direct-providers/reports/).

**Not verified:** nothing has run against a real provider. Unconfirmed against live APIs:
rate-limit header formats (OpenRouter reset, SambaNova `-day`, Anthropic periods), OpenAI
`insufficient_quota` as out of credits, Cloudflare/Cohere list pagination, Anthropic
`capabilities`, OpenRouter `/api/v1/key` shape, real proxy URL layouts, the upgrade migration on
a real store, two workers scanning at once, the panel's client-side forms in a real browser.

**Known issues:**
- Flaky under load: `operations.test.ts` "stop() during a backoff wait" (and once
  `scoring` classifier batching); they pass alone and on rerun.
- Served-model quarantine never lifts (pre-existing).
- Under `preferred` paid policy a cooling paid endpoint moves behind other paid endpoints but
  not behind free ones (pre-existing ordering).
- `refreshPaidPrices` uses the global `fetch`.

**P4 (user, 2026-10-20): add Ollama and wider coverage.** Research:
[research-coverage.md](./direct-providers/research-coverage.md) (official docs, 2026-10-20).
Built-ins to add: ollama, ollama-cloud, lmstudio, llamacpp, deepseek, fireworks, deepinfra,
nebius, scaleway, ovhcloud, zai, moonshot, vercel. Custom-provider examples: vLLM, LocalAI, Jan,
KoboldCpp, text-generation-webui, SGLang, TGI, xAI, Alibaba, MiniMax, Venice, Novita, Hyperbolic,
Chutes, Featherless, Baseten, AI21, SiliconFlow, Azure, Bedrock mantle. Excluded: Vertex (OAuth),
Bedrock SigV4, Azure Entra-only, Perplexity (Agent API), Lambda (winding down), Kluster (ended),
Inference.net (pivoted). `p4-coverage` dispatched 2026-10-20 on `feat/providers-p4`.

**Next steps:** a first live check, only with the user's approval and budget: one free-tier key
per provider the user has, `keys test`, `models scan`, and one small task, recording measured
header formats and list shapes in `docs/decisions.md`. Paid routing stays off unless the user
authorizes it.

**Blockers:** live checks need the user's keys and approval.

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

### Brief: p3-fixes (after p3-panel and p3-cli-docs)
- Task: (1) mask secrets in provider error text at the source: `requestJson` (auth header values
  and key query params) and `ProviderClient.complete` (the credential, for HTTP-200 error
  bodies); drop the CLI's own masking. (2) a 401/403/402 during discovery listing records the
  failure on that key (callback from `discoverModels`, wired in `discovery-run.ts`). (3) one
  shared key-test function in `src/providers/` used by `src/admin/provider-keys.ts` and
  `src/cli/keys.ts`. (4) `health.ts`: `lastError` only when newer than the key's last success;
  simplify the admin view's workaround to use it. (5) a `base_url` override also moves the
  model-list URL for providers whose registry list URL is absolute (google, cohere,
  cloudflare). (6) a provider under `paid.providers` appears once in health, not as both `x`
  and `paid:x`.
- Owns: `src/providers/**`, `src/admin/provider-keys.ts`, `src/cli/keys.ts`,
  `src/core/service.ts` (only for item 6), `tests/providers-*.test.ts`,
  `tests/admin-keys.test.ts`, `tests/cli-keys.test.ts`.
- Report to: docs/working/direct-providers/reports/p3-fixes.md

### Brief: p4-coverage (P4; parallel with projects J1, separate branch)
- Task: add the 13 built-ins from research-coverage.md with their registry facts and sources;
  registry support they need: providers with a default local base URL and no key (ollama,
  lmstudio, llamacpp; `OLLAMA_HOST` honoured), new model-list shapes (`ollama_tags`,
  `lmstudio_native`, `deepinfra_list`, `ovh_catalog`), a concurrency limit kind distinct from rpm,
  key-info shape for Ollama's `/api/balance`. Ollama discovery per research section 4 (`/api/tags`
  + `/api/show` cached by digest: parameter count, context length with the effective `num_ctx`,
  capabilities tools/vision, quantization; embedding-only excluded); never send `tool_choice` to
  Ollama (enforce `required` locally). Custom-provider examples in the example config comments
  and `docs/setup.md`; excluded list in `docs/decisions.md`. Panel Provider keys picker shows
  the new providers (local ones with a base-URL field and "no key").
- Owns: `src/providers/**`, `tests/providers-*.test.ts`, the `ProviderEntrySchema` and
  `ProviderKeyConfigSchema` blocks of `src/config/schema.ts` only (J1 edits other parts),
  `examples/switchyard.config.example.yaml` + regenerated presets, `docs/setup.md`,
  `docs/decisions.md`, `apps/panel/components/client/provider-keys.tsx`.
- Report to: docs/working/direct-providers/reports/p4-coverage.md

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

### 2026-10-20 — p3-panel and p3-cli-docs
- Agent: workers p3-panel and p3-cli-docs (parallel); verified by supervisor
- Changed: Provider keys page on the vault and config keys, `/api/keys*` routes, Paid routes
  folded in, panel FreeLLMAPI wording removed, offline demo, `src/admin/provider-keys.ts` and
  `config-edit.ts`; CLI `keys add|list|test|enable|disable|remove`, per-provider `doctor`,
  example config wording and regenerated presets, `setup.md`, `operations.md`, `decisions.md`
  (D1-D10, provider facts, upgrade notes, FreeLLMAPI history), README. Details:
  [panel](./direct-providers/reports/p3-panel.md), [CLI/docs](./direct-providers/reports/p3-cli-docs.md).
- Why: P3 surfaces.
- Validation: supervisor ran `pnpm -r typecheck` (pass), `pnpm -r build` (pass),
  `npx vitest run` four times (39 files, 386 passed three times; one run had a single failure
  that did not recur); `grep -i freellmapi` over panel, router src, examples, README, setup,
  operations finds only an applied migration comment and marked upgrade history. The panel
  worker confirmed the demo Scan stays on 127.0.0.1 with fetch/connect logging (it found and
  fixed a Google leak through the absolute model-list URL).
- Outcome: Accepted
- Follow-up: `p3-fixes`; contract changes for callers: `doctor --json` checks gain `level`,
  `models scan` exits 1 when nothing was listed and there were errors, `/api/paid/keys*` removed.

### 2026-10-20 — p3-fixes and handoff (effort complete)
- Agent: worker p3-fixes (items 1-5, then item 6 with `gate.ts` added); supervisor merge
- Changed: `src/providers/{secret-masking,key-test}.ts` (new), transport, client, discovery,
  discovery-run, health, registry, runtime; `src/gateway/gate.ts` health resolver;
  `src/core/service.ts`; `src/admin/provider-keys.ts`, `src/cli/keys.ts`; tests.
- Why: follow-ups raised by p3-panel and p3-cli-docs.
- Validation: `pnpm -r typecheck` printed `packages/router typecheck: Done`,
  `apps/panel typecheck: Done`; `pnpm -r build` printed `packages/router build: Done`,
  `apps/panel build: Done`; `npx vitest run` first printed `Tests 1 failed | 394 passed (395)`
  (`operations.test.ts > daemon > stop() during a backoff wait ends the daemon without another
  start`), then that file alone three times `Tests 23 passed (23)`, then the full suite
  `Tests 395 passed (395)`. Demo panel `/`, `/keys`, `/models` 200 and `/paid` 308; overview
  screenshot shows `anthropic` once in Provider health.
- Outcome: Accepted
- Follow-up: live check (Current State).

---

## Open Questions

- None blocking. Which providers ship as built-ins is settled by the research report (official
  docs only); others are reachable as custom OpenAI-compatible providers.
