# Report: p4-coverage

Worker report for brief `p4-coverage` (direct-providers plan, phase P4). Worktree `D:/sy-wt/p4`,
branch `feat/providers-p4`. Nothing committed.

## Outcome

Partial. Everything in the brief is implemented. Typecheck and build pass. The router suite has
3 failures out of 415 tests (412 pass: the 395 baseline plus 20 new tests). All 3 fail because
test files I do not own assume things the new built-ins change. Each needs a one-line fix outside
my ownership (see Open questions). With those fixes applied to temporary copies, all 3 tests pass.

## What changed and why

| File | Change |
| --- | --- |
| `packages/router/src/providers/registry.ts` | Adds the 13 built-ins (ollama, lmstudio, llamacpp, ollama-cloud, deepseek, fireworks, deepinfra, nebius, scaleway, ovhcloud, zai, moonshot, vercel). Each has `sourceUrl` and `checkedAt: 2026-10-20`. New definition fields: `keyPolicy` (`required\|optional\|none`), `local`, `baseUrlEnv`, `keyInfoShape` (`openrouter_key\|ollama_balance`), `concurrency` (`{scope, note}`), and `freeModelIds`. `ModelListSpec` gains `fallbackUrl` and `details` (`ollama_show\|llamacpp_props`). New list shapes: `ollama_tags`, `lmstudio_native`, `deepinfra_list`, `ovh_catalog`. New `{root}` URL template (the base without `/v1`). `ollamaHostRoot()` parses `OLLAMA_HOST`. `resolveProviders(section, env = process.env)`. `ResolvedProvider` gains `defaultContextTokens` and `baseUrlSource`. `models_path` on a native-list provider switches it to the OpenAI list. `requestHeaders` sends no auth header for a keyless credential on an optional-key provider. `expandUrl` throws when the base URL is empty. |
| `packages/router/src/providers/local-servers.ts` (new) | Parsers for Ollama `/api/tags` and LM Studio `/api/v1/models`. Ollama details: `/api/show` per model (concurrency 4, process cache keyed by server + name + digest, at most 2000 entries) and `/api/ps` (local server only). `applyOllamaShow` handles the effective and maximum context, `num_predict`, the exact parameter count, tools, vision, quantization, and the embedding-only exclusion. llama.cpp `/props` details. `parseSizeLabel`. |
| `packages/router/src/providers/discovery.ts` | Hosted shapes `deepinfra_list` and `ovh_catalog`. The OpenAI item gains llama.cpp `meta`, Nebius `supported_features` and `quantization`, and DeepSeek `max_output_tokens`. `listProviderModels` adds an OpenAI-list fallback when the native list fails for a non-key reason, then runs the details step. `ProviderListing.warnings` feeds the discovery warnings. `freeStatus` honours `freeModelIds` (Z.ai). |
| `packages/router/src/providers/enrich.ts` | `ListedModel` gains optional `providerParams`, `maxContextTokens`, `contextDetail`/`outputDetail`, `quantization`, and `notes`. `EnrichedModel` gains `maxContextTokens` and `quantization`. Exact server parameter counts become exact and confirmed params (provenance `provider`). Context and output provenance details come from the server. New export: `blankListedModel`. |
| `packages/router/src/providers/credentials.ts` | A configured provider with policy `none`, or policy `optional` with no config or vault keys, gets one keyless `none:<id>` credential (`free_tier`). A provider with an empty base URL is unusable, with the reason "set providers.<id>.base_url". |
| `packages/router/src/providers/client.ts` | Refuses a request locally when the base URL is empty. Does not demand a key on optional-key providers. |
| `packages/router/src/providers/limits.ts` | `probeOllamaBalance` (shape `ollama_balance`) and the `OllamaBalance` type. `probeFreeDailyQuota` now requires shape `openrouter_key`. |
| `packages/router/src/providers/discovery-run.ts` | The free-quota refresh runs only for `openrouter_key`. |
| `packages/router/src/providers/runtime.ts` | `routingProviders(section, paid, env)`. The runtime passes its `env` so `OLLAMA_HOST` resolves. |
| `packages/router/src/providers/index.ts` | Exports for the above. |
| `packages/router/src/config/schema.ts` | In the `ProviderEntrySchema` block only: `default_context_tokens` is added, and the comments for `base_url` and `no_key` are updated. |
| `packages/router/tests/providers-coverage.test.ts` (new) | 20 tests. |
| `packages/router/tests/providers-client.test.ts` | The registry test now covers 26 ids with per-batch check dates. The keyless custom test uses `vllm`. A legacy `ollama` custom entry now configures the built-in. |
| `packages/router/examples/switchyard.config.example.yaml`, `examples/presets/*.yaml` | The provider list, local-server entries, and custom-provider examples (comments only). Presets regenerated with `node scripts/build-presets.mjs`. |
| `docs/setup.md` | New provider list. New "Local servers" section (table, effective-context rules, no `tool_choice` for Ollama, OVH anonymous). New "Custom providers" section with all 20 examples from the research. |
| `docs/decisions.md` | D1 and D2 updated. New section "Wider coverage (P4, 2026-10-20)" with D11-D17, the excluded providers with reasons, and what is still unverified. |
| `apps/panel/components/client/provider-keys.tsx` | The picker gains a "Local servers (no key)" group (Ollama, LM Studio, llama.cpp). Choosing one shows a base-URL field (required for llama.cpp) and either "No key needed" or an optional token. It writes `providers.<id>` through `/api/config` and stores the token in the vault through `/api/keys`. The custom-provider form now points local users to the built-ins. |

## Registry entries added (key facts)

- **ollama:**
  - Base `http://127.0.0.1:11434/v1`, the documented bind. `OLLAMA_HOST` overrides it, and config `base_url` wins over both.
  - Auth `none`, policy `none`. No `tool_choice`. Unsupported params: `logit_bias`, `user`, `logprobs`, `top_logprobs`.
  - Models from `{root}/api/tags` with details `ollama_show`, falling back to `{base}/models`.
- **ollama-cloud:** `https://ollama.com/v1`, bearer. Models from `{root}/api/tags` with `/api/show` tried. Balance at `{root}/api/balance`. Concurrency per account. No `tool_choice`.
- **lmstudio:** `http://localhost:1234/v1`, keys optional. Models from `{root}/api/v1/models` with fallback. `tool_choice` auto only.
- **llamacpp:** no base URL (the user must set one), keys optional. OpenAI list plus `meta`, with `/props` details. `tool_choice` auto only.
- **deepseek:** `frequency_penalty` and `presence_penalty` unsupported. Quota scope account. Concurrency per account.
- **fireworks:** `context_length_exceeded_behavior: "error"` body extra. `tool_choice` auto only. Quota scope account.
- **deepinfra:** public list `https://api.deepinfra.com/models/list` (auth none, shape `deepinfra_list`). Concurrency per model.
- **nebius:** `{base}/models?verbose=true`. `openai` headers, minute/minute. `tool_choice` auto only.
- **scaleway:** `user` unsupported. `tool_choice` auto only. Quota scope project.
- **ovhcloud:** keys optional (anonymous). Catalog `models_v2` (auth none, shape `ovh_catalog`). `tool_choice` auto only. Quota scope project.
- **zai:** `temperatureMax` 1. `tool_choice` auto only. `freeModelIds` glm-4.7-flash, glm-4.5-flash, glm-4.6v-flash.
- **moonshot:** `max_completion_tokens`.
- **vercel:** quota scope account.

## Decisions where the research was silent or UNVERIFIED

1. **Unverified `tool_choice` gets auto only.** Where the values are unverified (LM Studio, llama.cpp, Fireworks, Scaleway) or only auto and named are documented (Nebius, OVHcloud, Z.ai), only `auto` is sent. Omitting is the safe failure mode. The research table said "pass-through" for Fireworks and Scaleway, but also marked them UNVERIFIED; the brief's conservative rule won.
2. **Local enforcement of a required tool call already exists.** The `harness/loop.ts` loop re-prompts a reply without a tool call ("Plain text answers are not accepted"). This is the same path Cohere and Cloudflare use, so no new code was needed.
3. **Default context for Ollama.** Budgets use the effective context: `num_ctx`, then `/api/ps`, then `default_context_tokens`, then 4096 (the smallest documented default), always capped at the trained maximum. For Ollama Cloud, LM Studio, and llama.cpp no default is assumed: the context stays unknown unless configured.
4. **Output on local servers is bounded by the context.** The research gives no output cap for local servers. Ollama uses `num_predict` when it is set; otherwise the effective context is the output limit. Without this rule every local model would be unroutable ("output limit unknown"). This is a structural assumption, recorded in provenance.
5. **Ollama Cloud `/api/show` is tried.** It is UNVERIFIED there. A failure keeps the `/api/tags` details and adds a warning. Reading an answer that does come back is not a guess.
6. **Ollama `supportsStructuredOutput` is true for completion models.** The research documents `response_format` server-wide. `structuredOutputWithTools` is false on all three local servers and Ollama Cloud, because the combination is undocumented.
7. **LM Studio `supportsTools` follows `trained_for_tool_use`.** False means the model is excluded from tool work, even though it accepts tools through a default format. The model id is `key` (UNVERIFIED that `/v1/chat/completions` takes it).
8. **OVHcloud model id = catalog `id`.** This is UNVERIFIED and recorded as a quirk. Exclusions: `available:false`, output without text, and categories that match embedding, image, or audio.
9. **DeepInfra `max_tokens` = context** (per the research). A truthy `deprecated` excludes the model. Price is zero vs positive only. The 16,384 output cap is not applied ("most models"), so output stays unknown, consistent with P1.
10. **Concurrency.** The registry records the kind and scope only. The number goes in the existing `team.provider_concurrency_limits.<id>`, which the gate's cross-process provider slots already enforce. No new enforcement code and no config field were needed, because the existing design fits. A later phase could fold a per-provider `max_concurrent` into `ceilingFor`, but that is in `gateway/capacity.ts` and `team` config, not mine.
11. **Z.ai free models are listed by id with a check date.** Without this, a `free_tier` key would mark every Z.ai model free, and a priced call could charge the account or disable the key.
12. **Local servers are opt-in by config entry,** so a user without Ollama never has `127.0.0.1:11434` contacted. `no_key` is not needed (or allowed without `base_url`) on the built-in local servers. A provider with policy `none` ignores configured keys; a reverse proxy takes `headers`.
13. **Exact server parameter counts are stored as `description` evidence with confidence `exact`.** The catalog's `ParamSourceSchema` has no "provider" value; `src/models/catalog.ts` is not mine. The provenance source is `provider`.
14. **Quantization and the trained maximum context are on `EnrichedModel` only.** `ModelEndpointSchema` is strict and has no fields for them.
15. **`OLLAMA_HOST` forms.** Supported: `host`, `host:port`, `:port`, `[v6]:port`, and `http(s)://...` (scheme default port, path kept). `0.0.0.0`, `[::]`, and an empty host become `127.0.0.1`. Malformed values are ignored and the default applies. Forms beyond the FAQ's wording are UNVERIFIED.

## Commands run and observed results

- `npx tsc -p tsconfig.json --noEmit` (router): no output.
- `pnpm -r typecheck`: router Done, panel Done.
- `pnpm --filter switchyard-router build`: pass. `pnpm -r build`: router and panel Done (route list printed, `/keys` included).
- `npx vitest run tests/providers-coverage.test.ts`: 20 passed.
- `npx vitest run` (full router, two runs): 40 files, **412 passed, 3 failed** (415). Failures:
  1. `admin-keys.test.ts` "adds a custom provider ...": `expected ... /paid provider/ but got 'deepinfra is a built-in provider: add…'`. The fixture uses `deepinfra` as a paid-provider name, and deepinfra is now a built-in.
  2. `paid.test.ts` "uses paid only after free capacity fails ...": times out; the task stays `waiting_for_capacity`, "acme HTTP 402".
  3. `session-faults.test.ts` "dies after submit_result was accepted ...": `expected 1 to be 2`.

  Failures 2 and 3 share one cause: `tests/helpers.ts` `providerOfUrl` matches built-ins with `url.startsWith(p.baseUrl)`. llamacpp's empty base URL matches every URL, so requests to `acme` are scripted as the free provider.
- **Verification of the fixes, on temporary copies that were deleted afterwards:**
  - `admin-keys.test.ts` with `deepinfra` renamed to `acmepaid`: 9 passed.
  - `paid.test.ts` and `session-faults.test.ts` against a copy of `helpers.ts` with `p.baseUrl !== "" &&` added to `providerOfUrl`: 19 passed.
- `node scripts/build-presets.mjs`: wrote 4 presets. The diffs are comment-only; the example-config and preset parse test is in the suite and passes.
- **Panel:**
  - Setup: seeded the demo and started `next start` on port 4593 with `SWITCHYARD_CONFIG=.demo/...`.
  - `/keys` returned 200 and contains "Local servers (no key)", "Ollama (local)", "LM Studio (local)", "llama.cpp server", DeepSeek, Z.ai, and Vercel.
  - POST `/api/config` with the form's patch for ollama, and for llamacpp with `http://127.0.0.1:9/v1`: both `{"ok":true,"saved":true}`. The YAML gained `ollama: {enabled: true}` and the llamacpp entry. `/keys` then showed both cards with a "no key" credential and Find models.
  - POST `/api/keys/scan` for llamacpp: `status: failed`, "cannot reach llamacpp" (expected, port 9).
  - Headless Chrome screenshot of `/keys`: the layout is intact and the new cards render.
  - Cleanup: the panel is stopped and the demo re-seeded; the config no longer has the test entries.

## Not verified

- No live provider or local server was called. Every shape is a fake body built from research-coverage.md.
- Unverified items remain: `/api/show` on ollama.com, OVHcloud's id field, Z.ai and Moonshot `/models`, DeepInfra `type` values and pricing units, LM Studio `key` as the chat id, and llama.cpp `/props` in router mode.
- The panel's local-server form was not clicked in a real browser. Static screenshots cannot open the select, so I exercised the same API calls with curl.
- The token path (POST `/api/keys` after setup) was not exercised.
- With no `providers:` section in the YAML, the `/api/config` route's `expand()` would write the transformed `{request_timeout_seconds, byId}` and fail validation. Not tested (route not mine; see below).
- The "Find models" scan on Ollama in the panel was not run, deliberately: it could reach a real local Ollama on this machine.
- `probeOllamaBalance` is not wired to anything: no storage, no display.

## Open questions or contradictions found

1. **Two one-line fixes needed in files I do not own** (all three failing tests):
   - In `tests/helpers.ts` `providerOfUrl`, use `BUILTIN_PROVIDERS.find((p) => p.baseUrl !== "" && !p.baseUrl.includes("{") && url.startsWith(p.baseUrl))`.
   - In `tests/admin-keys.test.ts`, rename the paid fixture `deepinfra` (lines 41, 55, 57, 104, 178, 186) to a non-built-in id such as `acmepaid`.
2. **`ProvidersSectionSchema` (J1's region)** still says "no_key needs base_url" for `ollama: {no_key: true}`. That is harmless, since the built-in needs no flag, but the message is confusing. It could also check that `llamacpp` has a `base_url` at config time; today that check happens at runtime.
3. **The panel's `/api/config` `expand()`** builds a missing `providers` ancestor from `sy.cfg.providers`, which is the transformed `{request_timeout_seconds, byId}` shape. A local-server setup on a config without a `providers:` section would fail validation. The example and presets have the section.
4. **Admin and page wiring are not mine.**
   - The panel hard-codes the three local ids (`LOCAL_SERVERS`). `ProviderKeysEntry` should carry `local`, `keyPolicy`, and the default base URL from the registry so the panel map can go.
   - The admin labels a keyless credential's origin `providers.<id>.no_key` even when no `no_key` is set (visible in the screenshot).
   - The CLI `keys add` / `addProviderKey` reject keys for `noKey` providers, which now includes ollama. That is intended.
5. **Catalog schema gaps (`src/models/catalog.ts`):** `ParamSourceSchema` needs a `provider` value, and the catalog has no fields for quantization or the trained maximum context.
6. `gateway/direct.ts` sets `freeQuota` from `keyInfoUrl !== null`. It should test `keyInfoShape === "openrouter_key"`. It is harmless today, because ollama-cloud ids never end in `:free`.
