# Report: p2-remove

Worker report for brief `p2-remove` (direct-providers plan, phase P2, step 2 of 2). Worktree
`D:/sy-wt/dp`, branch `feat/direct-providers`. Nothing committed; no git index changes are left.

## Outcome

Done. FreeLLMAPI is gone from the router: no client, admin client, chains, chain verification,
chain routes, FreeLLMAPI scan mapping, `gateway` config, or FreeLLMAPI tables. Every endpoint
routes directly through `src/providers`, and every test runs against fake providers behind the
injectable provider fetch. All Done-when checks pass (see Commands).

`grep -ril freellmapi packages/router/src` finds one file only:
`src/storage/migrations.ts` lines 272-273. That comment belongs to an applied migration (the
one that created `fl_key_billing`), which must not be edited. It is history.

## What changed and why

### Deleted files

| File | Why |
| --- | --- |
| `src/gateway/freellmapi.ts`, `src/gateway/freellmapi-admin.ts` | The FreeLLMAPI inference and admin clients. |
| `src/models/chains.ts` | Chain manager and chain verification. |
| `src/paid/direct.ts` | The test-only `DirectClient` seam and `httpDirectClient`. `SwitchyardOptions.directClient` is gone too. |
| `src/paid/vault.ts` | A re-export shim for `src/providers/vault.ts`. Its one importer (`service.ts`) now imports from providers. |

### Tables (new migration appended to `src/storage/migrations.ts`; no applied migration edited)

- Dropped `fl_key_billing` (the billing class of FreeLLMAPI keys).
- Dropped `pool_verifications` (chain verifications).
- Deleted from `endpoints` every row whose `route.kind` is not `direct`. This covers chain rows
  and legacy rows that had no route.
- Removed `flModelDbId` from the remaining endpoint rows (`json_remove`).
- Rebuilt `paid_spend` keyed by credential ref:
  - `key_ref TEXT NOT NULL`; `key_id` removed;
  - old rows backfilled with `COALESCE(key_ref, 'vault:' || key_id)`;
  - index `paid_spend_key(key_ref, created_at)`.
- Kept `scans`. It now records direct scans, and the panel's "last scan" reads it.
- No other table was FreeLLMAPI-only. `meta` keys `circuit:*`, `paid_prices:*` and the
  catalog version are shared.

### Router source

- **`gateway/gate.ts`**
  - The chain branch of `round()` is gone.
  - New constructor: `Gate(db, cfg, admission, health, direct)`, where `direct` is required.
  - `ProviderHealth(now, source)` has no `InferenceClient`; `refresh()` re-reads key-derived health.
  - Timeouts use `providers.request_timeout_seconds`.
  - `quarantined()` no longer dates from a chain verification. A served-model quarantine still never lifts. That is pre-existing and now noted in the code; a release rule (a later discovery, or a panel action) is still needed.
- **`gateway/direct.ts`**
  - Paid key headroom and reservation use `PaidSpend.spendKey(cred)`, a `SpendKey` identified by `ref`.
  - A vault key that has disappeared is skipped.
- **`gateway/types.ts`**: `InferenceClient` removed; comments no longer mention a gateway pool.
- **`admission/admission.ts`** (outside the owned paths; a minimal compile change): `paid` now takes `key: SpendKey` and records `key.ref`.
- **`paid/spend.ts`**
  - Spend is recorded and summed by `key_ref`.
  - Removed: the negative-id map, `spendKeyId`, `key(id)`, `pickKey` (unused), and the three FreeLLMAPI billing methods.
  - New `SpendKey`: a vault key carries its cap and balance; a config key has neither, so only global and task budgets apply to it.
- **`providers/vault.ts`**: `remove()` keeps a key with spend by checking `key_ref = 'vault:<id>'`.
- **`src/paid/` decision.** I kept it for money only:
  - `spend.ts`: the ledger, budgets, and worst-case and actual cost;
  - `catalog.ts`: configured `paid.models` as endpoints, and price refresh from `pricing_url`.

  Its true concern is paid policy and spend. Keys, transport, and discovery already live in `src/providers/`. The vault shim and the client seam were the only provider-side code left there, and both are deleted.
- **`models/catalog.ts`**
  - `route` is direct-only and optional; it defaults to `{provider: providerId, model: gatewayModelId}`.
  - `kind: "chain"` fails with "the only route is direct: delete route ... or set kind: direct".
  - Removed: `chainName`, `chainNameFor`, `flModelDbId`, `saveDiscovered`, and the chain skip in `saveProviderDiscovery` (it now returns `{saved}`).
- **`models/scanner.ts`** (rewritten). `Scanner` is the `models scan` path:
  - it runs provider discovery (which also refreshes free daily quotas), then refreshes paid prices;
  - it records the run in `scans`; `lastScan()` is kept for the panel;
  - `ScanSummary` is now `{scanned, added, pendingConfirmation, unavailable, providers, errors}`. `chainsSynced` and `chainsDisabled` are gone; `providers` is new;
  - with no usable key and no `paid.providers`, it reports "no provider has a usable key: add one under providers in the config, or in the panel's Provider keys page".
- **`providers/discovery-run.ts`**
  - New `refreshFreeQuotas(runtime, only)`. For each listed provider that has a `keyInfoUrl` (OpenRouter), it calls `probeFreeDailyQuota` for every usable key and stores the result with `keys.recordQuota`.
  - A 401 records the key as invalid. Other failures become run warnings.
  - It runs at the end of every `runProviderDiscovery` (opt out with `refreshQuotas: false`).
  - `DiscoveryRun.quotasRefreshed` is new; `skipped` is gone.
- **`providers/discovery.ts`**: a known discovered row is matched by provider without checking `route.kind`.
- **`providers/enrich.ts`**: `modelKey` moved here from the scanner, its only user.
- **`routing/select.ts`, `routing/router.ts`**: chain exclusions, `paidPlatforms` (`fl_key_billing`), and the FreeLLMAPI wording are removed.
- **`config/schema.ts`** (776 lines, down from 790)
  - `gateway` is `z.never` with the message "the gateway section is no longer supported: SwitchYard calls providers directly. Delete it and add your provider keys under providers (or in the panel's Provider keys page); request_timeout_seconds now lives under providers".
  - `discovery.free_platforms` and `discovery.default_output_limit_tokens` fail the same way, each saying what to set instead.
- **`core/service.ts`**
  - Removed: `client`, `admin`, `chains`, `createGatewayClient`, `createAdminClient`, and the options `client`, `admin`, `directClient`, `fetchImpl`.
  - `scan()` delegates to `Scanner`.
  - The single scheduled job now runs `scan()` every `discovery.interval_minutes`: discovery, quotas, and prices, recorded. The start-up check still reads `provider_discovery_last`.
- **`core/watchdog.ts`**: the request allowance uses `providers.request_timeout_seconds`.
- **`index.ts`**: removed the FreeLLMAPI exports, `createGatewayClient`, `createAdminClient`, `chainNameFor`, and `InferenceClient`.
- **`admin/insights.ts`** (minimal)
  - `Overview.gatewayConfigured` is now "any usable provider key"; `adminConfigured` is always true.
  - Removed: `ModelView.chain`, `paidSummary().freeLlmApiKeyBilling`, and `setFreeLlmApiKeyBilling`.
  - The free-platforms attention item is gone.
- **`cli.ts`**: `doctor`'s gateway and admin checks are replaced by one "provider keys" check, plus a comment update. **`cli/help.ts`**: the `models scan` and `doctor` lines.
- **Comments only**: `gateway/breaker.ts`, `gateway/capacity.ts`, `providers/health.ts`, `paid/catalog.ts`.

### Tests

**`tests/helpers.ts`**
- `ScriptedClient` is now an HTTP-level fake provider: an injectable `fetch` passed as `providerFetch`.
  - Each chat body becomes a `ScriptedRequest` (a `ChatRequest` plus `provider`, `url`, and `key`) for the handler.
  - The returned `ChatResponse` becomes the OpenAI-compatible HTTP answer.
  - A thrown `GatewayError` becomes the provider's HTTP answer: 429 with `retry-after`, 402, 401, 400, 404, 408, 451, or 5xx. A `transport` error becomes a dropped connection; an abort becomes an abort.
  - Every test therefore goes through the real provider client, key selection, limits, and key state.
- The handler also receives the abort signal.
- `providerOfUrl` maps built-in base URLs and `https://[api.]<id>.test` hosts to a provider id.
- `baseConfig` has no `gateway`. It sets free_tier literal test keys for openrouter, groq, cerebras, and mistral (`testProviders()`), and `discovery.interval_minutes: 0`.
- `open(env, fake)` passes `providerFetch`.
- `servedFor` maps a request to its endpoint by route.
- Removed: the `InferenceClient` double, chain mapping, `admin: null`, and `reply({attempts})`.

The FreeLLMAPI test doubles (`FakeAdmin`, `flModel`, `fakeGateway`, and the custom `InferenceClient`s) are gone. So are the `directClient` uses in `paid.test.ts` and `session-faults.test.ts`.

**Tests deleted (7):**

| Test file | Deleted test | Why |
| --- | --- | --- |
| `execution.test.ts` | "hidden gateway retries are recorded but never reported as exact" | FreeLLMAPI's hidden fallback hops. A direct call is one exact attempt. |
| `paid.test.ts` | "a FreeLLMAPI key marked paid blocks its platform from free routing" | Covered `fl_key_billing`. |
| `providers-client.test.ts` | "paid direct shim: keeps the paid client's interface" | Covered the deleted seam. |
| `discovery.test.ts` | "catalog scanning: scans every model ... syncs single-model chains" | Covered the FreeLLMAPI scanner and chains. |
| `discovery.test.ts` | the three "FreeLLMAPI adapter" tests | Covered the deleted client. |

**Tests added (4):**

| Test file | Added test |
| --- | --- |
| `discovery.test.ts` | "models scan lists every provider with a usable key, records the scan, and refreshes free daily quotas" |
| `discovery.test.ts` | "with no provider key, says what to add" |
| `discovery.test.ts` | "removed configuration": `gateway`, `free_platforms`, and `default_output_limit_tokens` each fail with their message |
| `providers-routing.test.ts` | "store upgrade". It builds a store at the previous schema version with `fl_key_billing`, `pool_verifications`, a chain row, a legacy no-route row, a direct row with `flModelDbId`, and `paid_spend` rows (vault `key_id` 4 with no ref, and a config ref). It then checks that the tables are dropped, only the direct row survives and parses, `key_ref` is `vault:4` and the config ref, `key_id` is gone, and `foreign_key_check` is clean. |

369 − 7 + 4 = 366.

**Tests changed:**

- **`execution.test.ts`**:
  - the first test asserts the direct request (provider, model, test key);
  - the fallback test puts its second model on groq: a 429 now cools the key, and so every model of that provider;
  - the queued test asserts `openrouter/only`.
- **`native.test.ts`**: the same fallback change.
- **`policy.test.ts`**: a priced manual model is now excluded because paid routing is off, not "not verified free".
- **`team-capacity.test.ts`**: the new `ProviderHealth` signature, and a 150 ms wait for the 0.1 s key cooldown after the 429 burst.
- **`providers-discovery.test.ts`**: the defaults test accounts for `baseConfig`'s interval of 0; the chain "known" row is dropped.
- **`providers-routing.test.ts`**: the `noChains` client is removed; spend is checked by `key_ref` with no `key_id` column; the discovery test uses a groq discovered row instead of a chain row.
- **`providers-client.test.ts`**: the default `providers` section.
- **`paid.test.ts`**: rewritten on one `ScriptedClient` that serves both free providers and the paid `acme` provider. It now also asserts `key_ref = vault:<id>`.
- **`session-faults.test.ts`**: the paid provider is served by a `ScriptedClient`.
- **`verification-resume.test.ts`, `resilience.test.ts`**:
  - the hanging clients are now `ScriptedClient` handlers that use the signal;
  - `gateway.request_timeout_seconds` becomes `providers.request_timeout_seconds`;
  - the R1 acceptance test spawns the real CLI worker against a fake HTTP provider, configured as the custom provider `local`.
- **`operations.test.ts`**: opens with `providerFetch`.

### Panel (minimal, to compile and build; the UI is P3's)

- **`app/keys/page.tsx`**: replaced with a read-only list of provider credentials from `sy.providers.credentials()`. It shows label, last four, billing class, source, unusable reason, and provider health. A callout says to add keys under `providers` for now.
- **`app/api/keys/route.ts`, `app/api/keys/[id]/route.ts`, `app/api/keys/[id]/billing/route.ts`**: return 410 with what to do instead.
- **`app/api/scan/route.ts`**: no admin-token check.
- **`app/page.tsx`**: provider-health empty state, scan card description, "unavailable" in place of "chains synced", and the admin-token note removed.
- **`app/paid/page.tsx`**: removed the "FreeLLMAPI keys marked as paid" card.
- **`app/models/detail/page.tsx`**: the chain-name cell shows `provider/model`.
- **`lib/models.ts`**: `chainState` returns "unchecked" with detail "Sent directly to <provider>".
- **`lib/keys.ts`**: a local `RemoteKey` type replaces `FreeLlmApiKey`.
- **`lib/settings-schema.ts`**: the Gateway section is replaced by Providers (`providers.request_timeout_seconds`). The `free_platforms` and `default_output_limit_tokens` fields are removed, so a Settings save can no longer write keys that now fail validation.
- **`scripts/seed-demo.mjs`**:
  - fake free_tier keys under `providers`, and no `gateway` or `free_platforms`;
  - the scripted and fake paid clients sit behind `providerClient`;
  - `served()` looks up by route;
  - the "free exhausted" scenario is a short 429, not `pool_exhausted`, which would disable the keys for 6 h of demo time;
  - groq's demo `tpm: 8000` is removed. Per-model limits are now enforced, which pushed the deep-review scenario onto another model and left no qualified reviewer, so the seed warned "repaired deep review did not end met". The seed now runs without warnings.

## Commands run and observed results

- `npx tsc -p tsconfig.json --noEmit` (router, src and tests): no output.
- `pnpm -r typecheck`: `packages/router typecheck: Done`, `apps/panel typecheck: Done`.
- `pnpm -r build`: `packages/router build: Done`, `apps/panel build: Done`.
- `npx vitest run` in `packages/router`, final run: **37 files passed, 366 tests passed**.
- Two earlier full runs each had one timing failure, and each test passed on rerun:
  - `operations.test.ts` "daemon stop() terminates the worker"; the full suite was running alone;
  - `scoring.test.ts` "classifies concurrent tasks with one shared request"; the demo seed was running at the same time. It passed 3 of 3 runs alone.

  Both are timing tests unrelated to this change.
- `grep -ril freellmapi packages/router/src`: only `src/storage/migrations.ts` (lines 272-273; an applied migration's comment).
- `wc -l src/config/schema.ts`: 776.
- `pnpm --filter switchyard-panel seed:demo`:
  - first run: one warning ("repaired deep review did not end met"). The cause was groq's `tpm: 8000`. The task's routing showed `skipped: no groq key available (config:groq:literal:0: limit until ...)`, then cerebras;
  - after the fix, a clean run;
  - re-seeded at the end, clean.
- The panel production build on port 4593 against the demo returned 200 for `/`, `/keys`, `/models`, `/models/detail?id=groq%2Fopenai%2Fgpt-oss-120b`, `/paid`, `/settings`, `/routing`, and `/requests`.
- `POST /api/keys` returned `410` with the message.
- Headless Chrome screenshots of `/`, `/keys`, and the model detail page render correctly. The server was stopped afterwards (PID 25300).
- **Live network call (read this).** `POST /api/scan` against the demo config made real provider requests:
  - the model-list GETs for nvidia, groq, cerebras, openrouter, and google;
  - OpenRouter `/key`, the OpenRouter public catalog, and Hugging Face;
  - all with the fake demo keys.

  What came back:
  - NVIDIA's public list returned 103 models;
  - groq answered 401 ("Invalid API Key");
  - OpenRouter `/key` answered 401, so the demo OpenRouter key was marked invalid in the demo store.

  No chat or completion request was made (`probe_tools` is off), and no real key or account was involved. I re-seeded the demo afterwards. The demo config should not reach the network from Scan; see the P3 list.

## Not verified

- No live provider with real keys. Rate-limit header formats, the shape of OpenRouter `/key` (`free_model_daily_requests`), and the upgrade on a real user store remain unconfirmed. The upgrade was checked only on the synthetic store in the new test.
- Behaviour across processes of the scheduled scan (two workers both scanning).
- `refreshPaidPrices` still uses the global `fetch`, not `providerFetch`. No test configures a `pricing_url`, so tests make no network calls through it.
- The panel pages beyond the ones listed were not opened. Settings was opened but not saved.
- The CLI was not run by hand. The R1 test runs `switchyard worker` from `dist`.

## Open questions or contradictions found

1. **`switchyard init` and presets now write invalid configs.**
   - `examples/presets/*.yaml` (claude-code, standalone-free, standalone-hybrid, standalone-paid) and `examples/switchyard.config.example.yaml` still have a `gateway:` block, which now fails validation. `scripts/build-presets.mjs` generates them.
   - These files are P3-owned (p3-cli-docs), so I did not touch them.
   - This should be the first item of P3, or done before P2 merges.
2. **Behaviour changes for upgrading users.**
   - Stored FreeLLMAPI-discovered endpoints are deleted. The catalog holds only manual and paid entries until a scan with provider keys runs. Panel overrides keyed to deleted ids stay orphaned (harmless).
   - A models-file entry without `route` now routes directly to `providerId`. Before, it went through a chain.
3. **A 429 cools the key for every model of that provider.** Tests that relied on falling back between two models of one platform had to move one model to another provider. This is intended (key-level cooldown, p1-limits), but it differs from FreeLLMAPI's per-chain behaviour.
4. **The served-model quarantine still never lifts.** Pre-existing; noted in `Gate.quarantined`.
5. **The demo scan reaches real providers.** The demo should use custom providers on an offline base URL, or the panel should not offer Scan against fake keys.

## P3 leftovers (FreeLLMAPI wording or dead features, by file)

### Router (`src/admin/**`, `src/cli*`, `src/mcp.ts`)

- **`src/admin/insights.ts`**
  - `Overview.gatewayConfigured` and `adminConfigured` are vestigial names; `adminConfigured` is always true.
  - `addPaidKey` refuses providers not under `paid.providers`, so vault keys for registry providers cannot be added from the panel.
- **`src/cli.ts`**
  - `keys add|list` are vault commands with paid-centric options (`--balance`, `--cap`); there is no `keys test`.
  - `doctor` has one aggregate "provider keys" check, not per-provider checks.
  - `init` copies the presets that still contain `gateway` (see Open question 1).
- **`src/cli/help.ts`**: the `keys add` line is paid-centric.
- **`src/mcp.ts`**: no FreeLLMAPI wording found. Callers that read `ScanSummary.chainsSynced` or `chainsDisabled` from `models scan --json` will find those fields gone.
- **Outside P3's panel and CLI scope but P3-owned**: `examples/presets/*.yaml`, `examples/switchyard.config.example.yaml`, `scripts/build-presets.mjs` (the `gateway` block), and `docs/setup.md`, `docs/operations.md`, `docs/decisions.md`.

### Panel (`apps/panel/**`)

- **`app/page.tsx`**: line 210, Provider health description: "As reported by FreeLLMAPI (GET /v1/providers)".
- **`app/models/detail/page.tsx`**
  - line 125: "Available in FreeLLMAPI";
  - the "Chain" row with its `HelpTip term="chain"` always shows "Not checked".
- **`components/client/models-table.tsx`**
  - the "Chain" column (line 100) always shows "Not checked";
  - line 77, empty state: "discover FreeLLMAPI's models".
- **`lib/models.ts`**: `ModelRow.chain` and `chainDetail`, and `chainState`, are vestigial.
- **`lib/glossary.ts`**: the `chain` entry (lines 10-11), the quarantine entry (line 13: "until its chain is verified"), and the `billingClass` entry (line 55) mention FreeLLMAPI.
- **`app/paid/page.tsx`**: line 41, description "(never through FreeLLMAPI)". The page is still the paid-only key page; the design folds it into Provider keys.
- **`app/qualification/page.tsx`**: line 65, "sends real requests through FreeLLMAPI".
- **`lib/settings-schema.ts`**
  - `routing.respect_provider_cooldowns` help (line 79);
  - `allocation` description, "FreeLLMAPI capacity" (line 125);
  - paid section description (line 174).
- **Dead FreeLLMAPI key UI**
  - `components/client/keys.tsx`: `AddKeyForm` and `KeyRow`, now unused, with FreeLLMAPI copy at lines 122 and 169;
  - `components/client/paid.tsx`: `FreeKeyBilling`, unused, line 271;
  - `lib/keys.ts`: `safeKey`, `normalizeProviders`, and `RemoteKey`.
- **`app/api/keys/**`**: 410 placeholders. **`app/keys/page.tsx`** is read-only, with no add, test, limits, or models-found.
- **`scripts/seed-demo.mjs`**: the header comments still say "scripted in-process gateway". The demo scan reaches real providers (Open question 5).
