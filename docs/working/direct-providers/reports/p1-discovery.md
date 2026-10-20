# Report: p1-discovery

Worker report for brief `p1-discovery` (direct-providers plan, phase P1). Worktree
`D:/sy-wt/dp`, branch `feat/direct-providers`. Nothing committed.

## Outcome

Done. `src/providers/discovery.ts` lists models per provider, handles every registry list shape
and pagination, filters to models the key can use, marks free, maps to direct catalog endpoints,
and marks unlisted models unavailable. `src/providers/enrich.ts` enriches with per-field
provenance (provider -> OpenRouter -> Hugging Face -> opt-in budgeted probe -> overrides). The
`discovery` config gained `probe_tools` and `max_probe_requests_per_day`. 24 new tests; full
suite 359 passed (323 baseline + 24 mine + 12 from p1-limits); `pnpm -r typecheck` passes.
Nothing is wired into the service or catalog storage.

## What changed and why

| File | Change |
| --- | --- |
| `packages/router/src/providers/discovery.ts` (new, 465 lines) | Page parsing per shape (zod, lenient per item), `listProviderModels` (pagination, key auth per registry), `freeStatus`, endpoint mapping, `discoverModels`. |
| `packages/router/src/providers/enrich.ts` (new, 373 lines) | `ListedModel`, OpenRouter catalog load/index/match, Hugging Face lookup, probe budget and probe, `enrichModel` with provenance. |
| `packages/router/src/providers/index.ts` | Appended two export blocks (discovery, enrich). p1-limits' lines were already present and are untouched. |
| `packages/router/src/config/schema.ts` | The `discovery` section **already existed** (FreeLLMAPI era: `interval_minutes`, `free_platforms`, `default_output_limit_tokens`, `require_confirmation_for_heuristic_params`, `openrouter_models_url`, `huggingface_api_url`). I added `probe_tools: boolean = false` and `max_probe_requests_per_day: int >= 0 = 20`, and reworded the `interval_minutes` comment to be provider-neutral. 786 -> 790 lines. |
| `packages/router/tests/providers-discovery.test.ts` (new) | 24 tests, fake fetch only. |

The route type `{kind:"direct", provider, model}` already existed in `ModelEndpointSchema`; no
change was needed.

## Exported API (for P2)

From `src/providers/index.ts`:

- `discoverModels(opts: DiscoveryOptions): Promise<DiscoveryResult>`. Never throws for one provider's failure.
  - `DiscoveryOptions`: `providers: ReadonlyMap<string, ResolvedProvider>`, `credentials: Pick<ProviderCredentials,"usable"|"requestCredential">`, `config: Pick<RawConfig["discovery"], "openrouter_models_url"|"huggingface_api_url"|"probe_tools"|"max_probe_requests_per_day">`, optional `only?: string[]` (provider ids; for "after adding a key"), `fetch?`, `now?`, `timeoutMs?` (30 s), `known?: ModelEndpointInput[]` (stored discovered rows), `manual?: ModelEndpointInput[]` (models-file endpoints), `overrides?: Record<endpointId, EndpointOverride>` (caller merges YAML + panel), `openRouter?: OpenRouterCatalog` (preloaded), `huggingFaceTotal?`, `probeClient?: Pick<ProviderClient,"complete">`, `probeBudget?: ProbeBudget`, `signal?`.
  - `DiscoveryResult`: `endpoints: DiscoveredEndpoint[]` (`{ endpoint: ModelEndpointInput; enriched: EnrichedModel; free: {value, reason} }`), `unavailable: { endpoint, reason }[]`, `providers: ProviderDiscovery[]` (`status: listed|no_key|disabled|failed`, `credentialRef`, `pages`, `kept`, `excluded[]`, `errors[]{ref, kind, message}`), `warnings: string[]`.
  - P2 wiring: `catalog.saveDiscovered([...endpoints.map(e => e.endpoint), ...unavailable.map(u => u.endpoint)])` needs care: `saveDiscovered` marks every row not passed as unavailable+disabled, across all providers (including old FreeLLMAPI chain rows and providers excluded by `only`). P2 should either pass all still-valid known rows or add a per-provider save.
- `listProviderModels(fetch, provider, {apiKey, accountId}, {timeoutMs, now, signal?}): Promise<ProviderListing>`; `parseModelListPage(shape, body): ListPage`.
- `freeStatus(provider, {id, price}, creds): {value, usable, reason}`.
- `enrichModel(providerId, listed: ListedModel, override, ctx: EnrichContext): Promise<EnrichedModel>`. `EnrichedModel.provenance: Record<EnrichedField, {source: FieldSource, detail}>` for `displayName, contextLimitTokens, outputLimitTokens, supportsTools, supportsStructuredOutput, inputModalities, parameters, pricing`. `FieldSource = provider|openrouter|huggingface|name|description|probe|override|unknown`. Unknown values are `null` in `EnrichedModel`.
- `loadOpenRouterCatalog(fetch, url, now?, timeoutMs?) -> {catalog, error}`, `openRouterCatalog(models)`, `matchOpenRouter(catalog, providerId, modelId) -> {model, match: "exact"|"name"} | null`, `OpenRouterModelSchema`, `listedFromOpenRouter`.
- `huggingFaceParamLookup(fetch, apiUrl, now?, timeoutMs?) -> (repo) => Promise<number|null>` (cached per lookup instance).
- `ProbeBudget { take(): boolean; remaining(): number }`, `dailyProbeBudget(maxPerDay, now?)` (in memory, UTC day), `toolProbe(client, provider, credential, timeoutMs?) -> ToolProbe`.
- Helpers used by both files: `priceNumber`, `knownModalities`, `ENRICHED_FIELDS`.

## Decisions where research.md was silent

1. **Unknown tool/structured support in the catalog.** `ModelEndpointSchema.supportsTools` and `supportsStructuredOutput` are non-nullable booleans, so the endpoint gets `false` (excluded from tool work) while `enriched` keeps `null` and provenance says `unknown`. To store true unknowns, P2 must make those fields nullable in `src/models/catalog.ts` (not mine).
2. **No output-limit default.** `discovery.default_output_limit_tokens` is not applied: unknown output stays `null` (routing already excludes it: `select.ts` "output limit unknown"). `outputLimitSource` is `"default"` when the value is null (the enum has no `unknown`), `"provider"` for provider or OpenRouter values, `"override"` for overrides.
3. **OpenRouter match levels.** `exact` = the OpenRouter provider itself, or an OpenRouter id equal to `<provider>/<model>` (e.g. `openai/gpt-4o` for provider `openai`). `name` = `modelKey` equality (vendor prefix and `:free` stripped; reused from `models/scanner.ts`). Context, output limit, and input modalities come from OpenRouter only on an exact match (hosts serve different limits); tools, structured output, description, display name, and Hugging Face id also come from a name match. For the OpenRouter provider, its own list is provider metadata.
4. **Free marking.** Free when the id ends `:free`, or the list states price 0 (any unit), or any usable key is `free_tier` (a free key cannot be charged). Exception for per-model-free providers (shape `openrouter`): a positive-priced model is not free, and is excluded as unusable when every usable key is `free_tier` ("priced model; only free_tier keys"). `trial`, `paid_credits`, `paid_postpaid` keys are not free unless the model is `:free`/$0. A free endpoint gets prices 0/0.
5. **Non-OpenRouter price units are unverified** (SambaNova, Together `pricing`): only zero vs positive is used; USD per million is set only from OpenRouter-shaped lists (per-token strings x 1e6). A negative OpenRouter price (variable routers) counts as unknown.
6. **Filtering "models the key can use"** per shape: Groq `active:false`, Mistral `archived:true` or `capabilities.completion_chat:false`, Together `type` in a non-chat set (embedding, image, audio, moderation, rerank, ...), ids-only lists by a non-chat id pattern (embed, whisper, tts, dall-e, moderation, rerank, transcribe); Google without `generateContent`; Cloudflare `task.name` other than `Text Generation`; OpenRouter `output_modalities` without `text`. These only exclude, never include.
7. **Pagination** follows any continuation the envelope carries, regardless of the registry's `paginated` flag: Google `nextPageToken` -> `pageToken`; Anthropic `has_more`+`last_id` -> `after_id`; Cohere `next_page_token` -> `page_token`; Cloudflare `result_info` (`page*per_page < total_count`) -> `page`. Capped at 50 pages; a repeated token stops.
8. **Shape details not in research** (implemented defensively, all UNVERIFIED): Cloudflare search items take the model id from `name` when it starts with `@`, `context_window` and `function_calling` from `properties[]`; Cohere `features` containing `tools` / `json_mode|json_schema` / `vision` count as support, absence stays unknown; Anthropic `capabilities` is not interpreted; Google ids drop the `models/` prefix; Mistral `capabilities.vision` sets modalities.
9. **Listing credential.** The first usable credential that lists successfully is used for the whole provider (auth failures and other errors fall through to the next key, all recorded). Keys in different Cloudflare accounts or Google projects could see different lists; only one is listed.
10. **Previously known models.** Only `origin:"discovered"` + `route.kind:"direct"` rows of a provider are considered (old FreeLLMAPI chain rows are untouched). Successful listing: unlisted -> `available:false, enabled:false` (matches `saveDiscovered`). Provider has no usable key or is disabled -> `available:false` only. Failed listing -> nothing changes (warning). Manual ids are never produced or marked.
11. **Overrides are baked into the returned endpoint** (context, output, modalities, tools, structured, parameter counts, `confirmParams`, `freeVerified`) so provenance and the probe decision reflect them. The catalog still applies overrides at read time. If an override is later removed, the stored row keeps the old value until the next discovery.
12. **Probe.** One request: one `ping` tool, `tool_choice: "required"` (the client maps or omits it per provider), `max_tokens: 64`. Tool call -> true; `bad_request` whose message mentions tool/function -> false; anything else -> null (inconclusive, noted). It runs only when `probe_tools` is on, a `probeClient` is given, tool support is still unknown, and no override sets it; each attempt takes one unit from the budget. Default budget is in memory per process (P2 may back it with the store). `max_probe_requests_per_day` default 20 is my choice.
13. **Hugging Face repo.** For provider `huggingface` the model id itself (minus `:policy`/`:provider`) is the repo; otherwise the list's `hugging_face_id` or OpenRouter's. `Scanner.huggingFaceTotal` is a method bound to the FreeLLMAPI scanner, so `huggingFaceParamLookup` re-implements the same request and parse (safetensors.total / 1e9) as a standalone function; `parseParamsFromName`, `parseParamsFromDescription`, `resolveParams`, and `modelKey` are reused. When P2 retires `Scanner`, `modelKey` should move with it (e.g. into `models/params.ts` or `enrich.ts`).
14. **quotaScopeIds** = `<provider>:<quotaScope>` from the registry (`groq:key`, `google:project`, `cloudflare:account`).
15. **sourceUrls** = the registry `sourceUrl` when it is an http URL, plus the OpenRouter and Hugging Face pages used.

## Commands run and observed results

- `npx tsc -p tsconfig.json --noEmit` (router): no output (pass).
- `npx vitest run tests/providers-discovery.test.ts`: **24 passed**. Coverage: openai shape (Groq filters, malformed entry, bearer auth, limits, name params), openai variants (Mistral capabilities/archived, Together bare array/type/price, SambaNova zero price, bad envelope throws), google_native pagination + `x-goog-api-key` + `generateContent` filter, anthropic `after_id` pagination + headers + unknown limits stay null, cohere URL query kept + features, cloudflare account URL + task filter + `result_info` paging, keyless custom provider at `models_path`, repeated token stops; free marking (OpenRouter free key / paid key, SambaNova free vs trial); enrichment (name match tools, exact match context/output/modalities, HF exact params, all-unknown model, catalog outage warning, overrides win with provenance); availability (unlisted -> unavailable, manual wins, already-gone and chain rows untouched, no key -> unavailable, failed listing changes nothing, 401 falls through to next key, disabled provider not called); probe (off by default, probes within budget with probe provenance, override skips probe, budget exhausted note, UTC-midnight reset); config defaults and validation.
- `pnpm -r typecheck` (repo root): router Done, panel Done.
- `npx vitest run` (full router, 1st run): 358 passed, 1 failed: `tests/operations.test.ts > daemon > stop() during a backoff wait ...` with `ENOTEMPTY: directory not empty, rmdir ...switchyard-ops-...` in `afterEach` cleanup (Windows temp-dir race under load). `npx vitest run tests/operations.test.ts` alone: 23 passed. Full suite re-run twice: **36 files, 359 passed**.

## Not verified

- No live provider, OpenRouter, or Hugging Face call: all list shapes are fake bodies built from research.md plus the unverified details in decision 8.
- Real pagination parameter names for Cohere and Cloudflare, Cloudflare search item fields, Anthropic `capabilities`, and NVIDIA/OpenAI list fields beyond `id`.
- The tool probe against a real model (whether `tool_choice: required` plus 64 tokens is enough for reasoning models).
- `pnpm -r build` and the panel build were not run (no panel change).
- Nothing persists discovery output yet (P2).

## Open questions or contradictions found

- **The brief said "a new `discovery` section"**, but one already exists (FreeLLMAPI scanning). I extended it. `free_platforms` and `default_output_limit_tokens` contradict the new design (billing class decides free; unknown output is never defaulted) and should be removed in P2 with the FreeLLMAPI scanner. `insights.ts` still warns about `free_platforms`.
- **Catalog schema**: `supportsTools`/`supportsStructuredOutput` should become nullable, and `outputLimitSource` could gain `unknown`/`openrouter`, to store provenance faithfully (decision 1-2). A provenance column/field is not in `ModelEndpointSchema` (strict), so `enriched.provenance` currently travels only in the result.
- **Gate rule**: AGENTS.md says every model request goes through `Gate`. `toolProbe` takes any `complete`-shaped client; P2 should pass a Gate-backed one (or record why the probe is exempt).
- **`saveDiscovered` semantics** (see API above): it disables every row not passed, which conflicts with `only` and with failed-listing providers.
- The OpenRouter provider list and the OpenRouter public catalog are the same URL; a run with an OpenRouter key fetches it twice. P2 can preload `openRouter` once per run.
