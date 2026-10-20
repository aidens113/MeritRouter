# Report: p2-wire

Worker report for brief `p2-wire` (direct-providers plan, phase P2, step 1 of 2). Worktree
`D:/sy-wt/dp`, branch `feat/direct-providers`. Nothing committed.

## Outcome

Done, with two edits outside the owned paths. Both were needed to meet the brief's own Done
condition (see Open questions).

Every `{kind:"direct"}` endpoint, free or paid, now goes through `src/providers`:

- key rotation, cooldowns, disables, and configured and per-model limits;
- paid policy, budgets, and spend tracking for priced models;
- key-derived health feeding the breakers and adaptive slots.

The catalog stores unknown tool and structured-output support as `null` and excludes it from
work that needs it. Discovery saves per provider. The service runs discovery on a schedule and on
demand, with a Gate-backed tool probe. `src/providers` is exported from `src/index.ts`.
FreeLLMAPI `{kind:"chain"}` routing is unchanged.

All three checks pass:

- `pnpm -r typecheck`
- `pnpm --filter switchyard-router build`
- `npx vitest run`: 369 tests (the 359 baseline plus 10 new)

## What changed and why

| File | Change |
| --- | --- |
| `src/gateway/direct.ts` (new, 290 lines) | The direct path, split out of `gate.ts` because it is its own concern. See "Direct path" below. |
| `src/gateway/gate.ts` (460 to 408 lines) | Removed the old `requestDirect`/`dispatchDirect` and `PaidRuntime`; `Gate` takes `direct: DirectRuntime \| null` (`{providers: ProviderRuntime, spend: PaidSpend}`). See "Gate" below. |
| `src/providers/runtime.ts` (new) | `ProviderRuntime`: the per-process holder. See "Provider runtime" below. |
| `src/providers/discovery-run.ts` (new) | `runProviderDiscovery`: calls `discoverModels` with the stored rows, the models-file entries, and the merged overrides. It then saves through `Catalog.saveProviderDiscovery`, scoped to the providers whose listing succeeded, and returns `added`, `saved`, and `skipped`. |
| `src/providers/discovery.ts` | `freeStatus` returns `basis: "model" \| "key"`. `toEndpoint` stores `supportsTools`/`supportsStructuredOutput` as `null` when unknown, and sets `pricing.freeBasis`. |
| `src/providers/index.ts` | Exports for the runtime and the discovery runner. |
| `src/models/catalog.ts` | See "Catalog" below. |
| `src/routing/select.ts` | See "Routing" below. |
| `src/routing/router.ts` | `gate.paid` became `gate.direct` (2 lines). |
| `src/core/service.ts` | See "Service" below. |
| `src/paid/direct.ts` | `asProvider` moved to `providers/runtime.ts` as `paidProviderAsDirect`. Kept `DirectClient`/`httpDirectClient` as a seam, and added `directClientAsProviderClient(direct, paidProviders, fallback)`, which serves `paid.providers` through an injected `DirectClient` and everything else through `fallback`. |
| `src/paid/catalog.ts` | `paidEndpoints` takes `paidKeys(provider) => number`: usable vault or config keys that are not `free_tier`. The fingerprint includes `cfg.providers`. |
| `src/paid/spend.ts` | `spendKeyId(cred)`: the vault id, or a stable negative FNV-based id for a config key, registered so `key(id)` returns a key with no cap or balance (global and task budgets still apply). `record` writes `key_ref`. |
| `src/storage/migrations.ts` | Appended `ALTER TABLE paid_spend ADD COLUMN key_ref TEXT`. No applied migration was edited. |
| `src/index.ts` | `export * from "./providers/index.js"` and `export { isPaid, freeKeyOnly }`. |
| `tests/helpers.ts` (additions only) | `FakeProvider` (an injectable fetch that records calls, with a default OpenAI-compatible chat, an empty model list, and 404 for anything else), `providerJson`, `providerChat`, `providerModels`, and `directEndpoint`. |
| `tests/providers-routing.test.ts` (new) | 10 tests; see Commands. |
| `tests/providers-discovery.test.ts` | Not owned. Two expectations changed from `supportsTools: false` to `null`. |
| `apps/panel/lib/models.ts`, `components/client/override-editor.tsx`, `app/models/detail/page.tsx` | Not owned. Widened `boolean` to `boolean \| null` for the two capability fields, and show "Unknown" for null (7 lines in all). |

### Direct path (`src/gateway/direct.ts`)

`requestDirect` makes one endpoint attempt:

1. It resolves the provider. `isPaid(ep)` decides paid or free.
2. It excludes keys the endpoint may never use (`ineligibleKeys`):
   - `free_tier` keys on a priced model;
   - non-`free_tier` keys on a model that is free only through a free key;
   - vault keys without headroom for the worst case.
3. It then loops:
   - `ProviderKeys.select`, with an `exclude` set that grows, `estimatedTokens`, the model, `ep.rateLimits`, `freeQuota` for `:free` models on providers with a `keyInfoUrl`, and `ProviderLimits` reserved atomically;
   - takes a slot (once per endpoint);
   - `Admission.reserve`, with `paid` for priced models;
   - one `ProviderClient.complete` call.
4. On success it calls `recordSuccess(cred, snapshot)`, `limits.settle` with the actual tokens, and `health.recordOutcome`. It checks the served model (same rule as the old paid path) and reconciles.
5. On a key-level failure (`rate_limited`, `auth_invalid`, `out_of_credits`) it calls `recordFailure`, releases the limit reservation when nothing was consumed, records the outcome as key-level, and moves to the next key. Other failures in `FALLBACK_KINDS` go to the next endpoint; anything else throws.
6. When no key can be selected, it records the skip as `skipped: no <provider> key available (<ref>: <reason> until <iso>)` and returns `resumeAt`.

`asProviderError` maps any thrown error (an injected client's `GatewayError`, a plain `Error`) to a `ProviderError`. `probeClient` is the Gate-backed probe client.

### Gate (`src/gateway/gate.ts`)

- `ProviderHealth(client, now, direct?)` reads key-derived statuses synchronously:
  - cached for 1 s, and invalidated by every `recordOutcome` and `refresh`;
  - merged into `lookup`, `snapshot`, and breaker cooling; a direct status wins unless it is `unknown`;
  - a direct cooldown on every key feeds `capacity.observeCooldown`.
- `recordOutcome(..., {keyLevel})`: a key-level failure releases the breaker and never counts toward it; a 429 still halves the slots once per generation.
- `round()`:
  - free direct endpoints count against `routing.max_endpoint_fallbacks`, paid ones against `paid.max_paid_attempts`;
  - a skip with a `resumeAt` sets `keyRetryAt`;
  - when nothing was dispatched, the round throws `rate_limited` with `retryAfterMs` ("no usable key for every remaining provider; next key in N s"), beside the existing open-circuit wait. The executor then defers the task.
- `Gate.probeClient()`.
- The slot staleness bound uses the larger of the gateway and provider timeouts.

### Provider runtime (`src/providers/runtime.ts`)

`ProviderRuntime` holds, per process:

- `providers()` and `credentials()`, rebuilt when a config reload replaces `cfg.providers` or `cfg.paid.providers`;
- `keys`, `limits`, `client`, `fetch`, and `now`;
- `discoverable()`: registry and `providers:` entries that are enabled and have a usable key. It excludes providers that exist only under `paid.providers`.
- `statuses()`: `providerStatuses`, plus a `paid:<name>` alias for each paid provider, because configured paid endpoints have `providerId` `paid:<name>`.

`routingProviders` merges the registry with `paid.providers`. A paid entry named like a registry provider uses the registry definition when the base URL matches, and its own otherwise.

### Catalog (`src/models/catalog.ts`)

- `supportsTools` and `supportsStructuredOutput` are `z.boolean().nullable()`.
- New optional `pricing.freeBasis: "model" | "key"`.
- `saveProviderDiscovery(records, listed)`:
  - upserts the records;
  - for providers in `listed` only, marks their unlisted discovered direct rows `available:false, enabled:false`;
  - never touches other providers or failed listings;
  - skips (and returns) ids held by a FreeLLMAPI chain row.
- The old `saveDiscovered` (FreeLLMAPI) no longer disables direct rows.
- New helpers: `storedEndpoints()`, `manualEndpoints()`, `mergedOverrides()`.
- The status reason for a removed direct row is "no longer listed by <provider>".

### Routing (`src/routing/select.ts`)

- `isPaid` is now price-based on every route: a direct endpoint is free when it is `freeVerified` at $0.
- New `freeKeyOnly(ep)`.
- The paid exclusions (paid disabled, tier policy `never`, price unknown) apply to direct endpoints only when they are paid.
- An unknown capability gives "tool calling unknown (required for repository work; set it in an override)" or "structured output unknown".

### Service (`src/core/service.ts`)

- New options `providerFetch` and `providerClient`. `directClient` is kept: it is wrapped so that only `paid.providers` use it.
- Builds `ProviderRuntime`, wires health and the gate, and creates one daily probe budget per service.
- Scheduled discovery runs every `discovery.interval_minutes`, at start only when a provider is discoverable and the last run, kept in `meta` as `provider_discovery_last`, is older than the interval.
- `discover({only?})` runs one at a time, records a `provider_discovery` event, and passes `gate.probeClient()`.
- `scan()` runs direct discovery when a provider is discoverable and merges it into `ScanSummary`. It still runs the FreeLLMAPI scanner when an admin token is set, or when nothing else is configured, so the "needs admin token" message stays.
- `close()` waits for an in-flight discovery.

## Decisions

1. **Health route: `ProviderHealth` reads key state directly.**
   - It reads through a synchronous `() => ProviderStatus[]` source (`ProviderRuntime.statuses()`), not through `InferenceClient.providers()`.
   - Why: key state is local store reads and changes on every attempt (a 429 cools a key immediately). Routing should see it without waiting out the 30 s FreeLLMAPI refresh cache, and the direct path has no `InferenceClient`.
   - The 1 s cache is invalidated on every outcome.
   - FreeLLMAPI's `/v1/providers` still feeds the same lookup for chain platforms until p2-remove.
2. **Out of credits versus `pool_exhausted`.** `ProviderError("out_of_credits")` maps to the gateway kind `pool_exhausted`. On the direct path it is a key-level failure:
   - the key is disabled (rechecked after 6 h, per p1-limits);
   - the next key is tried;
   - it never counts toward the provider's breaker (`recordOutcome` with `keyLevel` releases the breaker) and does not throttle slots.

   Before this, a 429 carrying `insufficient_quota` would have opened the breaker and halved the slots through `countsAsProviderFailure`; a key problem must not shut a provider for its other keys. When every key is out of credits, health is `invalid` and the endpoint is skipped with the recheck time as `resumeAt`. If nothing else can serve, the task defers until then. Auth failures disable the key with no resume time, so if nothing else can serve, the task fails with the skip reasons (it needs the user). An all-`auth` final error goes to `gateway_auth`.
3. **The `isPaid` rule.**
   - The endpoint is paid unless it is `freeVerified` at $0.
   - The gate keeps a free endpoint free by choosing keys:
     - `freeBasis: "key"` (free only because a `free_tier` key serves it, such as Groq): only `free_tier` keys may serve it. Any other key would bill an unrecorded price.
     - `freeBasis: "model"` (`:free` or listed $0): any key may serve it, because no money can move. This follows p1-discovery's "free when no money can move".
     - A row without `freeBasis` is treated as `key`, unless the model id ends in `:free`.
   - Priced endpoints never use `free_tier` keys. A free key on a priced model would 402 and be wrongly disabled.
   - Paid requests keep the existing paid policy, budgets, task caps, worst-case reservation, and spend settlement.
   - This differs slightly from the design's sentence "a paid billing class is paid": a paid key on a `:free` or $0 model is treated as free, not paid.
4. **Every key attempt is a reserved model request.** Each attempt (a 429 included) is one `model_requests` row and counts against the task's request budget, the same as endpoint fallbacks today. A provider with many cooling keys can therefore use several of a task's requests on one call. Revisit if that bites.
5. **The tool probe goes through Gate machinery, not admission.** `Gate.probeClient()` uses:
   - the provider's breaker, and a slot check;
   - only `free_tier` keys, through `ProviderKeys.select` with limits reserved (no usable free key refuses the probe, which then reports unknown);
   - key state and health recording.

   A probe is not written to `model_requests`, because it belongs to no task and has no execution row. An `out_of_credits` answer to a probe is not recorded on the key, because a priced model refusing a free key says nothing about that key. Probing stays off by default (`discovery.probe_tools`).
6. **Config keys on paid routes.** `paid_spend.key_id` is NOT NULL. A config key gets a stable negative id derived from its ref, and the new `key_ref` column records the ref. Config keys have no cap or prepaid balance, so only global and task budgets apply to them.
7. **The timeout for direct requests** is `providers.request_timeout_seconds` (default 300). The old paid path used `gateway.request_timeout_seconds`.
8. **Providers listed only under `paid.providers` are not discovered.** Their models come from `paid.models`. This also keeps the existing paid tests from making network calls.

## What p2-remove must know

FreeLLMAPI still appears in these files:

- **`src/gateway/freellmapi.ts`, `src/gateway/freellmapi-admin.ts`**: the clients. Delete them.
- **`src/gateway/gate.ts`**:
  - the chain branch of `round()`: `chains.ensureVerified` and `auto:<chainName>` dispatch through `this.client`;
  - `quarantined()`, which uses `chains.latest(ep.chainName)` to date the quarantine, so direct endpoints stay quarantined forever after a served-model violation (unchanged from the old paid path; p2-remove needs a release rule, for example a later discovery or a panel action);
  - `ProviderHealth`'s `client.providers()` cache and its `refresh()`;
  - the constructor's `client: InferenceClient` and `chains: ChainManager` parameters;
  - `cfg.gateway.request_timeout_seconds` in `request()` (the max wait) and in the slot staleness bound.
- **`src/gateway/types.ts`**: `InferenceClient` (still needed by the chain path, and by `ScriptedClient` in many tests).
- **`src/gateway/breaker.ts`, `capacity.ts`**: comments only ("cooldown FreeLLMAPI reported"). The behaviour is now shared with key health.
- **`src/models/chains.ts`**: delete it. **`src/models/scanner.ts`**: the FreeLLMAPI scan. `modelKey` and `Scanner.huggingFaceTotal` are reused, or re-implemented, in `providers/enrich.ts`, so move `modelKey` if `scanner.ts` goes.
- **`src/models/catalog.ts`**:
  - the `chain` route variant, `chainName` and `chainNameFor`, `flModelDbId`, and `saveDiscovered`;
  - `saveProviderDiscovery`'s skip of chain-held ids;
  - the "no longer offered by FreeLLMAPI" reason.
- **`src/routing/select.ts`**: the `route.kind === "chain"` exclusions, the `paidPlatforms` (`fl_key_billing`) exclusion, and the "FreeLLMAPI reports it unavailable" reason.
- **`src/routing/router.ts`**: `paidPlatforms` from `spend.paidFreeLlmApiPlatforms()`.
- **`src/paid/spend.ts`**: `paidFreeLlmApiPlatforms`, `setFreeLlmApiKeyBilling`, `freeLlmApiKeyBilling` (the `fl_key_billing` table).
- **`src/paid/direct.ts`**: `DirectClient`, `httpDirectClient`, and `directClientAsProviderClient` are only a test seam now. They are used by `tests/paid.test.ts` and `tests/session-faults.test.ts` (`directClient` option). Move those tests to `providerFetch` with `FakeProvider`, then delete the seam and `SwitchyardOptions.directClient`.
- **`src/core/service.ts`**:
  - `createGatewayClient`, `createAdminClient`, `this.client`, `this.admin`, `this.chains`, `this.scanner`, the FreeLLMAPI scan timer;
  - `scan()`'s scanner call and its `ScanSummary` shape (`chainsSynced`, `chainsDisabled`);
  - `SwitchyardOptions.client` and `admin`.
- **`src/core/watchdog.ts`**: `cfg.gateway.request_timeout_seconds`. Switch it to `providers`.
- **`src/config/schema.ts`**: the `gateway` section, `discovery.free_platforms`, `discovery.default_output_limit_tokens`, and `paid.providers`/`paid.models` (they still work, as direct providers).
- **`src/admin/insights.ts`, `src/cli.ts`, `src/cli/help.ts`**: FreeLLMAPI wording, gateway key and admin-token checks, and the `free_platforms` warning.
- **`src/index.ts`**: the `FreeLlmApiAdmin` and `FreeLlmApiClient` exports.
- **`src/storage/migrations.ts`**: a new migration to drop `fl_key_billing` and `pool_verifications`.
- **Tests:** `tests/helpers.ts` `baseConfig` still has a `gateway` block; `endpoint()` defaults to a chain route; `ScriptedClient`, `servedFor`, and `open(..., { admin: null })` are all chain-era. `FakeProvider`, `directEndpoint`, `providerChat`, `providerModels`, and `providerJson` are ready for the move.

## Commands run and observed results

- `npx tsc -p tsconfig.json --noEmit` (router) after the core wiring: no output, exit 0.
- `npx vitest run` (router) after wiring, before new tests: **36 files, 359 passed**.
- `pnpm -r typecheck` against the stale `dist`: Done for both. After `pnpm --filter switchyard-router build`, it failed in the panel: `app/models/detail/page.tsx(196,15)` and `(197,15)`, and `lib/models.ts(72,5)`, each `Type 'boolean | null' is not assignable to type 'boolean'`. After the panel type widening: router Done, panel Done.
- `npx vitest run tests/providers-routing.test.ts`:
  - First run: 9 passed, 1 failed. In the unknown-tools test, summarize was not eligible because of "parameter count 70B comes only from the model name/description: confirm it", a gap in the test setup.
  - After adding `confirmParams: true` to the override: **10 passed**.
- The 10 tests:
  - a free direct request: key, URL, a `direct:` request row, no `paid_spend`, key success recorded, health healthy;
  - rotation on a 429 within one request: outcomes `rate_limited` then `succeeded`, keys A then B, A cooling at least 29 s, breaker closed with 0 failures, provider healthy;
  - an invalid key disabled and skipped on the next task: outcomes `auth` then `succeeded`, then `succeeded` with B only;
  - `rpm: 1` blocks the second task: it defers with "no usable key", health is `rate_limited`, and after the clock moves 61 s the task completes;
  - priced models excluded when paid routing is off, and when the tier policy is `never`;
  - a paid request through a config key: $0.006 settled, `key_ref` `config:acme:literal:0`, negative `key_id`;
  - the weekly budget stops a paid request before dispatch;
  - a key-basis free model is never sent through a `paid_postpaid` key;
  - discovery saves per provider:
    - an unlisted model is removed with "no longer listed by one";
    - a failed listing (500) and a FreeLLMAPI chain row are untouched;
    - `only` lists one provider;
    - the FreeLLMAPI `saveDiscovered` leaves direct rows alone;
  - unknown tools are stored as null, excluded for `inspect` ("tool calling unknown ..."), and eligible for `summarize`; with `probe_tools`, the Gate-backed probe used the free key, recorded success, and stored `supportsTools: true` with `probe` provenance.
- Final runs:
  - `pnpm -r typecheck`: router Done, panel Done.
  - `pnpm --filter switchyard-router build`: passed (`tsc -p tsconfig.build.json`, no errors).
  - `npx vitest run` in `packages/router`: **37 files, 369 passed**.

## Not verified

- No live provider was called; all behaviour is checked against the fake provider fetch.
- `pnpm -r build`, which builds the panel, was not run, and neither was any panel page or screenshot. The panel edits are type and label changes only.
- Migration on an upgraded existing store: only fresh test databases were used.
- Concurrency of key rotation across processes; the `select` transaction comes from P1.
- Behaviour when FreeLLMAPI chains and direct providers both list the same `<provider>/<model>` id. Direct discovery skips ids a chain row holds, so a user running both keeps the chain row until p2-remove.
- The OpenRouter free daily quota probe (`probeFreeDailyQuota`) is not scheduled anywhere. The gate honours stored quota state, but nothing refreshes it yet.

## Open questions or contradictions found

1. **Edits outside the owned paths.** The brief requires nullable `supportsTools`/`supportsStructuredOutput` and a passing `pnpm -r typecheck`, but:
   - the panel types these fields as `boolean`, so the panel fails typecheck once the router `dist` is rebuilt;
   - `tests/providers-discovery.test.ts` (P1) asserted the interim `false`-for-unknown behaviour.

   I made the minimal changes: three panel files (`boolean | null` and "Unknown" labels, 7 lines) and two test expectations (`false` to `null`). The supervisor should accept or redo them; P3 owns the panel's real wording.
2. **The design text against the free rule.** The design says "a paid billing class is paid". I treat a paid key on a `:free` or $0 model as free (no money can move), and I restrict key-basis free models to `free_tier` keys (decision 3). Confirm with the user if needed.
3. **The task-budget cost of key retries** (decision 4).
4. **Provider content refusals.** A `ProviderError("policy")` maps to the gateway kind `policy_violation`, the same kind as a served-model violation. It is not a fallback kind, so the task fails with `gateway_policy_violation`. The old paid path behaved the same way, but the two causes now share one kind. Consider separating them in p2-remove or P3.
