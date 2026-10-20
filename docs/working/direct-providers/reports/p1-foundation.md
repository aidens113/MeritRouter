# Report: p1-foundation

Worker report for brief `p1-foundation` (direct-providers plan, phase P1). Worktree
`D:/sy-wt/dp`, branch `feat/direct-providers`. Nothing committed.

## Outcome

Done. `src/providers/` foundation exists: registry, the moved and extended vault, merged
config and vault credentials, a provider client with `openai_compatible` and `anthropic`
adapters, classified errors, and rate-limit header parsing. There is a `providers` config
section and a vault-columns migration. Shims at `src/paid/vault.ts` and `src/paid/direct.ts`
keep existing callers compiling and working. `pnpm -r typecheck` passes, and the full router
suite passes: 323 tests (305 baseline plus 18 new).

## What changed and why

| File | Change |
| --- | --- |
| `packages/router/src/providers/vault.ts` | Pure move of `src/paid/vault.ts`, then extended. `PaidKey` gains `accountId`, `quotaGroup`, `limits: KeyLimits {rpm,rpd,tpm,tpd}`. `NewKeySchema` and `KeyPatchSchema` accept `accountId`, `quotaGroup`, `rpm/rpd/tpm/tpd`. The vault class comment now says free and paid. |
| `packages/router/src/paid/vault.ts` | Re-export shim: `export * from "../providers/vault.js"`. |
| `packages/router/src/storage/migrations.ts` | Appended one migration: `ALTER TABLE paid_keys ADD COLUMN account_id, quota_group, rpm, rpd, tpm, tpd`. The table keeps its name; P2 may rename it. |
| `packages/router/src/providers/registry.ts` | 13 built-ins and custom providers from config (see API below). |
| `packages/router/src/providers/rate-limits.ts` | Header families `openai`, `openrouter`, `anthropic`, `none` produce a normalized snapshot. Also `retry-after`, reset-value parsing, `cooldownMs`, and audit headers. |
| `packages/router/src/providers/errors.ts` | `ProviderError` (extends `GatewayError`), the HTTP classifier, error-body extraction, and detection of error bodies on HTTP 200. |
| `packages/router/src/providers/transport.ts` | `requestJson`: one HTTP attempt over an injectable fetch. Handles timeout, caller abort, and transport classification. |
| `packages/router/src/providers/openai-compatible.ts` | Body builder that applies the registry rules, and the adapter. |
| `packages/router/src/providers/anthropic.ts` | `toAnthropic` and the Messages adapter, moved from `paid/direct.ts`. |
| `packages/router/src/providers/client.ts` | `ProviderClient` / `createProviderClient`. It refuses locally, before any HTTP, a missing key or a missing Cloudflare account id. |
| `packages/router/src/providers/credentials.ts` | `ProviderCredentials`: one lookup over config keys, vault keys, and keyless providers. |
| `packages/router/src/providers/index.ts` | Barrel. |
| `packages/router/src/paid/direct.ts` | Shim. It keeps `DirectRequest`, `DirectClient`, `httpDirectClient`, and the `toAnthropic` re-export, and delegates to the provider client. Behaviour is unchanged: generic OpenAI-compatible with `max_tokens`, `tool_choice` defaulting to `auto`, OpenRouter extras when the URL is `openrouter.ai`, Anthropic at `<base_url>/v1/messages`, `servedProvider: paid:<name>`, and the same `GatewayError` kinds. |
| `packages/router/src/config/schema.ts` | Adds `ProviderKeyConfigSchema`, `ProviderEntrySchema`, and `ProvidersSectionSchema`, plus a `providers` top-level section (`.prefault({})`). `gateway` is untouched. |
| `packages/router/tests/providers-client.test.ts` | 18 tests, all using a fake fetch (see Commands). |

## Public API (from `src/providers/index.ts`) for p1-discovery and p1-limits

### Registry (`registry.ts`)

- `BUILTIN_PROVIDERS: readonly ProviderDefinition[]`, `BUILTIN_PROVIDER_IDS: readonly string[]`
  - The ids are groq, google, nvidia, openrouter, mistral, cerebras, cohere, cloudflare, sambanova, together, huggingface, anthropic, and openai.
- `builtinProvider(id): ProviderDefinition | null`
- `resolveProviders(section?: Pick<ProvidersConfig,"byId">): Map<string, ResolvedProvider>` returns every built-in, with config overrides applied, plus every custom provider.
- `customProvider(id, entry: ProviderEntryConfig): ResolvedProvider`
- `defaultProvider(id): ResolvedProvider | null`
- `emptyKeyLimits(): KeyLimits`
- `expandUrl(template, provider, accountId|null): string`. It expands `{base}` and `{account_id}`, and throws when an account id is needed but missing.
- `chatUrl(provider, accountId|null): string`
- `requestHeaders(provider, apiKey|null, auth = provider.auth): Record<string,string>` returns the auth header plus `extraHeaders`. For discovery, pass `p.models.auth ?? p.auth`.

`ProviderDefinition` fields:

- **Identity and URLs:** `id`, `displayName`, `api` (`"openai_compatible"|"anthropic"`), `baseUrl` (no trailing slash; may contain `{account_id}`), `urlParams` (`["account_id"]` for Cloudflare), `chatPath`.
- **Auth and headers:** `auth` (`"bearer"|"x-api-key"|"x-goog-api-key"|"none"`), `extraHeaders`, `optionalHeaders`.
- **Model list:** `models: { url, shape, auth|null, paginated }`.
  - `url` is a template.
  - `shape` is one of `openai|openrouter|google_native|cohere|cloudflare_search|anthropic`.
- **Quota probe:** `keyInfoUrl` (OpenRouter `{base}/key`, otherwise null).
- **Request rules:** `tokenLimitParam`, `unsupportedParams`, `renameParams`, `stripMessageName`, `toolChoice: {auto,none,required}` (null means omit), `structuredOutputWithTools`, `imagesBase64Only`, `temperatureMax`, `bodyExtras`.
- **Limits and notes:** `rateLimitHeaders: {family, requestsPeriod, tokensPeriod}`, `quotaScope` (`"key"|"project"|"account"`), `quirks`.
- **Provenance:** `sourceUrl`, `checkedAt`.

`ResolvedProvider` adds `builtIn`, `enabled`, `noKey`, `accountId`, `quotaGroup`, and `limits: KeyLimits`. These provider-level limits come from `providers.<id>.rpm/rpd/tpm/tpd`.

### Client (`client.ts`)

- `createProviderClient({ fetch?: FetchLike, now?: () => number }): ProviderClient`
- `ProviderClient.complete(req: ProviderRequest): Promise<ProviderResponse>` makes one attempt with no retries.
- `ProviderRequest = { provider: ResolvedProvider; credential: RequestCredential; model; chat: Omit<ChatRequest,"model">; params?: Record<string,unknown>; timeoutMs; signal? }`
  - `RequestCredential` is `{ apiKey: string|null; accountId?: string|null }`.
  - `params` passes only `seed, top_p, stop, presence_penalty, frequency_penalty, parallel_tool_calls, logprobs, top_logprobs, logit_bias, user`, minus the provider's unsupported parameters and with its renames applied. `n` is never sent.
- `ProviderResponse = ChatResponse & { rateLimits: RateLimitSnapshot }`.
  - `telemetry.servedProvider` is the provider id, and `servedModel` is the response's `model`.
  - `telemetry.headers` holds only rate-limit and request-id headers.
- `FetchLike = (url, { method, headers, body?, signal? }) => Promise<Response>`
- `requestJson(fetchFn, HttpCall, now): Promise<HttpResult>` is a GET (no body) or POST helper that applies the same classification. Discovery can use it for model lists.
- `buildOpenAiBody(p, req)`, `buildAnthropicBody(req)`, `toAnthropic(messages)`, and `PASS_THROUGH_PARAMS`.

### Errors (`errors.ts`)

- `class ProviderError extends GatewayError` has these fields:
  - `reason: ProviderErrorKind`, `provider`, `retryable`, `providerCode|null`, `rateLimits: RateLimitSnapshot|null`.
  - Inherited from `GatewayError`: `kind`, `status`, `retryAfterMs`, `possiblyConsumed`.
- `ProviderErrorKind` values and their gateway kinds:

  | Reason | Gateway kind | Retryable |
  | --- | --- | --- |
  | `rate_limited` | `rate_limited` | yes |
  | `auth_invalid` | `auth` | no |
  | `out_of_credits` | `pool_exhausted` | no |
  | `policy` | `policy_violation` | no |
  | `server` | `server` | yes |
  | `timeout` | `timeout` | yes |
  | `transport` | `transport` | yes |
  | `bad_request` | `bad_request` | no |
  | `unknown_model` | `unknown_model` | no |
  | `aborted` | `aborted` | no |

- `classifyProviderError(provider, status, bodyText, rateLimits|null, {httpStatus?})`, `errorInOkBody(provider, json, httpStatus, rateLimits, resultKey)`, `extractErrorBody(json)`.
- `rate_limited.retryAfterMs` is `retry-after` when sent. Otherwise it is the latest reset among windows with `remaining === 0`, and otherwise `undefined`.

### Rate limits (`rate-limits.ts`)

- `RateLimitSnapshot = { family, observedAt, retryAfterMs|null, windows: RateLimitWindow[] }`
- `RateLimitWindow = { metric: "requests"|"tokens"|"input_tokens"|"output_tokens"; period: "minute"|"day"|"unknown"; limit|null; remaining|null; resetAt: epoch ms|null }`
- `parseRateLimitHeaders(headers, spec, now)`, `parseRetryAfter(value, now)`, `parseResetValue(value, now)`, `cooldownMs(snapshot)`, `auditHeaders(headers)`.
- The `openai` family also reads `-requests-day` and `-tokens-day` variants as `period: "day"` (SambaNova).

### Credentials (`credentials.ts`)

- `new ProviderCredentials(providers: ReadonlyMap<string,ResolvedProvider>, section: Pick<ProvidersConfig,"byId">, vault: KeyVault|null, env = process.env, now = Date.now)`
- Methods:
  - `list(providerId?)` returns config keys first, then vault keys. Each list is in declared order.
  - `usable(providerId)`, `get(ref)`
  - `requestCredential(ref): RequestCredential` throws for an unknown or unusable credential.
- `ProviderCredential` fields:
  - `{ ref, source: "vault"|"config"|"none", provider, label, billingClass, enabled, last4, accountId, quotaGroup, limits, vaultKeyId, apiKeyEnv, unusableReason|null }`
  - `limits` holds the key's own limits only.
- Refs, which are stable ids for p1-limits state: `vault:<id>`, `config:<provider>:env:<VAR>`, `config:<provider>:literal:<index>`, `none:<provider>`.
- Reasons a credential is unusable: disabled, removed, expired, env var unset, provider not configured or disabled, or a Cloudflare key with no account id. Cooldowns and limits are not applied here; they belong to p1-limits.

### Vault (`vault.ts`)

- Everything that was there before: `KeyVault`, `PaidKey`, `NewKeySchema`, `KeyPatchSchema`, `BillingClassSchema`, `loadMasterKey`, `MASTER_KEY_ENV`.
- New: `KeyLimits`, and on `PaidKey` the fields `accountId`, `quotaGroup`, `limits`.

### Config (`src/config/schema.ts`)

- `cfg.providers` is `{ request_timeout_seconds: number (default 300); byId: Record<id, ProviderEntryConfig> }`.
- In YAML, provider ids sit beside `request_timeout_seconds` under `providers:`. The schema's transform splits them into `byId`, so the two never share a TypeScript type.
- `ProviderEntryConfig` fields:
  - `enabled`, `display_name?`, `base_url?`, `api?` (custom providers only), `no_key`, `account_id?`, `headers`, `models_path?`, `token_limit_param?`, `rate_limit_headers?`.
  - Provider-level limits: `rpm?/rpd?/tpm?/tpd?`, `quota_group?`.
  - `keys: ProviderKeyConfig[]`.
- `ProviderKeyConfig` fields: `label`, `api_key_env?` or `api_key?` (exactly one), `billing_class` (required), `enabled`, `account_id?`, `rpm?/rpd?/tpm?/tpd?`, `quota_group?`.
- Validation errors carry paths such as `providers.<id>.keys.<n>....`:
  - an unknown id without `base_url`;
  - `api` set on a built-in;
  - `no_key` without `base_url`, or `no_key` with keys;
  - a Cloudflare key without `account_id` (on the key or the provider);
  - a duplicate `api_key_env`.
- Exported names: `ProviderKeyConfigSchema`, `ProviderEntrySchema`, `ProvidersSectionSchema`, `ProviderKeyConfig`, `ProviderEntryConfig`, `ProvidersConfig`.

## Decisions made where research.md was silent

1. **`sourceUrl` without a research URL.** Research gives no URL for Cerebras, Cloudflare, SambaNova, Together, Hugging Face, Anthropic, or OpenAI. For these, `sourceUrl` points at the report section (`docs/working/direct-providers/research.md#<heading-anchor>`). I did not invent URLs. `checkedAt` is `2026-10-19` everywhere, the research fetch date.
2. **Gemini token parameter.** Gemini compat uses `max_tokens`, because `max_completion_tokens` is unverified there. `tool_choice` sends only `auto`; `required` and `none` are omitted (research rule 5: omit where undocumented).
3. **Cohere and Cloudflare `tool_choice`.** Both omit `tool_choice` entirely, because it is unverified. Tools are still sent.
4. **Rate-limit families for unverified headers.** NVIDIA, Cerebras, Together, Hugging Face, Cloudflare, Cohere, Google, and Mistral use family `none`, so only `retry-after` is read. Providers whose header names are unverified are not guessed. OpenAI, OpenRouter, and Anthropic header periods are `unknown`, because research does not state the windows. Only Groq (requests per day, tokens per minute) and SambaNova (minute, plus `-day`) have documented periods.
5. **Reset-value parsing is generic.** It accepts:
   - Go durations;
   - bare numbers, read by magnitude: at least 1e12 is epoch ms, at least 1e9 is epoch seconds, anything smaller is seconds from now;
   - ISO dates.

   Research does not give OpenRouter's reset format.
6. **`n` is never sent.** SwitchYard reads only choice 0, and Groq and Cerebras require n = 1.
7. **Structured output beside tools.** On Groq and Cerebras (`structuredOutputWithTools: false`), `response_format` is dropped when tools are present. JSON is validated locally anyway.
8. **NVIDIA temperature.** It is clamped to 1, following the research note "temperature <= 1".
9. **Policy classification.** A request is classified as `policy` when any of these holds:
   - the status is 451;
   - the status is 400 or 403 and the body matches content-policy, moderation, flagged, safety, content_filter, or responsible-ai;
   - HTTP 200 with `finish_reason: content_filter` and no content.
10. **Out-of-credits classification.** It is `out_of_credits` on 402, or on a 429 whose body matches `enforced_spend_limit`, `spend limit`, `insufficient_quota`, or `insufficient credits`. Research documents only Anthropic's spend cap. `insufficient_quota` (OpenAI) is my addition and needs confirming.
11. **Errors inside HTTP 200 bodies.** When the body has an `error` member and no result (`choices`, or `content` for Anthropic), it is classified by its numeric code when that looks like an HTTP status. A body that matches the policy patterns becomes `policy`; anything else is treated as a 502-like `server` error. `possiblyConsumed` is true only for server-class failures.
12. **Config `billing_class` is required.** There is no default, because a wrong default either spends money or hides a free key. The vault's own default (`paid_postpaid`) is unchanged.
13. **Config key refs use the env var name where there is one.** Reordering keys then does not move cooldown state to another key.
14. **Vault columns for panel-entered keys.** The vault needed new columns so that a key entered in the panel can carry a Cloudflare `account_id`, a `quota_group`, and limits, hence the migration. `paid_keys` keeps its name.
15. **Custom providers default to no rate-limit headers.** They use `rate_limit_headers: none` unless the config sets it. A custom `api: anthropic` provider expects its `base_url` to include `/v1`.

## Commands run and observed results

- `npx tsc -p tsconfig.json --noEmit` in `packages/router`, after the shims and again after the tests: no output (pass).
- `npx vitest run` in `packages/router`, before the new test file: 33 files, **305 passed**. The shims did not regress anything.
- `npx vitest run tests/providers-client.test.ts`: **18 passed**. Coverage:
  - Registry: the built-in set has sources; a custom keyless provider; overrides apply.
  - Config: env and literal keys parse; the default section; 8 rejection paths.
  - Credentials: merge over config, vault, and keyless keys; env unset; vault limits, quota group, and account id; disable.
  - Groq rules and per-day headers.
  - Mistral: `any`, `random_seed`.
  - OpenRouter: extras, cost, X-RateLimit, and error bodies on HTTP 200 for 429, 402, and generic.
  - Cloudflare: account URL from the key or the provider, no `tool_choice`, local refusal, error envelope.
  - Google, Cohere, NVIDIA, Cerebras (base64 images), and the custom no-key provider.
  - Anthropic body, headers, tool use, usage, and `anthropic-ratelimit` headers; spend cap versus a plain 429; 529.
  - Every error class: 401, 403 auth, 403 and 400 policy, 402, 429 insufficient_quota, 404, 400, 408, 500, 503 with retry-after, 429 with seconds, a date, or an exhausted-window reset, and the Gemini array 429.
  - Timeout, caller abort, transport failure, non-JSON body, content_filter, and empty choices.
  - SambaNova `-day` headers, family `none`, and all reset forms.
  - The paid shim's URL, body, telemetry, and Anthropic URL.
- `pnpm --filter switchyard-router build`: pass (dist rebuilt).
- `pnpm -r typecheck` at the repo root: router Done, panel Done.
- `npx vitest run` in `packages/router` (full): **34 files, 323 passed**.

## Not verified

- No live provider was called (no credentials here). All behaviour is checked against fake fetch responses shaped from research.md, not against real responses.
- The real header formats are unverified: OpenRouter `X-RateLimit-Reset`, SambaNova `-day` reset values, and Anthropic periods.
- Whether Gemini compat accepts `max_tokens`, and whether Cloudflare and Cohere accept tools without `tool_choice`, are research UNVERIFIED items and remain so.
- I did not run the panel build. `pnpm -r build` was not run; only the router build was.
- The migration was exercised only on fresh test databases, not on an upgraded existing store.

## Open questions or contradictions found

- **Discovery config has no owner.** The plan's Design uses `discovery.interval_minutes` and `discovery.max_probe_requests_per_day`, but p1-discovery does not own `src/config/schema.ts`. I did not add them because they are outside this brief. The supervisor needs to assign them, either to p1-discovery (granting `schema.ts`) or to P2.
- **Public exports.** `src/index.ts` is not in my ownership, so nothing from `src/providers` is exported publicly yet. Exports go through `src/providers/index.ts`.
- **`schema.ts` is near the size threshold** at 786 lines, close to the 800-line rule. P2 removes `gateway` and the paid provider schemas, which should bring it back down.
- **p1-limits migration.** p1-limits will also append a migration. Mine is the last entry now, so p1-limits must append after it.
- **Panel compile check.** `ProviderError`'s `reason` field could shadow nothing today; `AdmissionDenied` also has a `reason`, but the two are unrelated classes. The panel compiles.
