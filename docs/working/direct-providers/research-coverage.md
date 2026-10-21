# Provider coverage research: local servers and more hosted providers (fetched 2026-10-20)

Follow-up to [research.md](research.md) (the 13 current built-ins). Every fact is from official
documentation (or the project's own repository for open-source servers) fetched 2026-10-20
unless marked UNVERIFIED. Free-tier numbers are "documented as of 2026-10-20, changes often":
never hard-code them as truth; discovery, headers and user configuration supply live values.

Field names below match `ProviderDefinition` in `packages/router/src/providers/registry.ts`.
Where a provider needs something the interface cannot express today, it is flagged
**NEEDS: ...** so the implementer sees the schema change.

## 1. Local and self-hosted servers

### Ollama (local)
- Default bind `127.0.0.1:11434`; change with `OLLAMA_HOST` (https://docs.ollama.com/faq.md).
  CORS allows `127.0.0.1` and `0.0.0.0` origins by default; more via `OLLAMA_ORIGINS`.
- Auth: "The local API at `http://localhost:11434` does not require authentication"
  (https://docs.ollama.com/api/authentication.md). The OpenAI client needs an `api_key` value but
  "Ollama ignores it" (https://docs.ollama.com/api/openai-compatibility.md).
- OpenAI-compatible base `http://localhost:11434/v1`: `/v1/chat/completions`, `/v1/completions`,
  `/v1/models`, `/v1/models/{model}`, `/v1/embeddings`, `/v1/responses`.
  - Supported chat fields: `model, messages, frequency_penalty, presence_penalty, response_format,
    seed, stop, stream, stream_options, temperature, top_p, max_tokens, tools, reasoning_effort,
    reasoning`.
  - **Unsupported: `tool_choice`, `logit_bias`, `user`, `n`, `logprobs`.**
  - `/v1/models`: `created` = model modification time, `owned_by` = Ollama user (default
    `library`). No context, size, or capability fields.
  - Context size cannot be set through the OpenAI path; docs say create a Modelfile with
    `PARAMETER num_ctx` and `ollama create`.
- Native endpoints that carry metadata (https://docs.ollama.com/api/tags.md,
  https://docs.ollama.com/api-reference/show-model-details.md, https://docs.ollama.com/api/ps.md):
  - `GET /api/tags` -> `{models:[{name, model, remote_model?, remote_host?, modified_at, size
    (bytes), digest, details:{format, family, families[], parameter_size ("8.0B"),
    quantization_level ("Q4_K_M")}}]}`.
  - `POST /api/show` body `{model, verbose?}` -> `{parameters ("temperature 0.7\nnum_ctx 2048"),
    license, modified_at, details:{parent_model, format, family, families, parameter_size,
    quantization_level}, template, renderer, parser, template_source, capabilities[],
    model_info:{"general.architecture", "general.file_type", "general.quantization_version",
    "<arch>.context_length", "<arch>.block_count", ...}, thinking?:{values, default}}`.
    The older repo doc example (https://github.com/ollama/ollama/blob/main/docs/api.md, which now
    says the docs moved to docs.ollama.com) shows `"general.parameter_count": 8030261248` and
    `"llama.context_length": 8192`. `general.parameter_count` is not in the current docs page
    example: treat it as optional.
  - `capabilities` values (from source, https://raw.githubusercontent.com/ollama/ollama/main/types/model/capability.go):
    `completion, tools, insert, vision, embedding, thinking, image, audio, decision`. The docs page
    shows only `completion, thinking, vision` in its example.
  - `GET /api/ps` (loaded models) -> `{models:[{name, model, size, digest, details, expires_at,
    size_vram, context_length}]}`: `context_length` here is the **allocated** context.
- Runtime context: default context depends on VRAM: "< 24 GiB VRAM: 4k context; 24-48 GiB: 32k;
  >= 48 GiB: 256k" (https://docs.ollama.com/context-length.md); `OLLAMA_CONTEXT_LENGTH` overrides
  (the FAQ still says "default is 4096"; the context-length page is newer). So
  `<arch>.context_length` is the model's trained maximum, not what the server will use.
- Tools: native `/api/chat` and OpenAI path accept `tools`; parallel tool calls supported;
  streaming with tools supported (https://docs.ollama.com/capabilities/tool-calling.md).
  No forced tool choice anywhere.
- Limits/errors: `OLLAMA_NUM_PARALLEL` (default 1 per model); `OLLAMA_MAX_QUEUE` default 512, then
  **503** "server is overloaded". Errors `{"error": "..."}`; 404 = model not pulled; streaming
  errors arrive as an NDJSON object with `error` (https://docs.ollama.com/api/errors.md).
  No rate-limit headers.
- Model names: `name[:tag]`, e.g. `llama3.1:8b`, `qwen3`, `gemma4:31b`; no tag means `:latest`;
  user models are `user/name:tag`. `/api/tags` returns both `name` and `model` (same string).
  Hosted models run through a local server carry `remote_model`/`remote_host` and a `-cloud` /
  `:cloud` tag form (https://docs.ollama.com/cloud.md).

### Ollama Cloud (hosted)
- Current. Base `https://ollama.com/v1` (OpenAI) and `https://ollama.com/api` (native);
  Anthropic-compatible at `https://ollama.com` (https://docs.ollama.com/api/introduction.md).
- Auth: `Authorization: Bearer <OLLAMA_API_KEY>`; keys from https://ollama.com/settings/keys, do
  not expire; "`x-api-key` alone is not supported" (https://docs.ollama.com/api/authentication.md).
- Models: `GET https://ollama.com/api/tags` (same shape as local). Use the exact name it returns
  (e.g. `gemma4:31b`) for direct API calls; `-cloud` suffix is only for the local app/CLI.
  Whether `/api/tags` or `/api/show` on ollama.com needs a key: UNVERIFIED (docs curl it without
  one); whether `/api/show` works on ollama.com at all: UNVERIFIED.
- Quota endpoints (both Bearer): `GET https://ollama.com/api/balance` ->
  `{included:{balance_usd, allowance_usd, period:{from,until}}, purchased:{balance_usd}}` (legacy
  plans: `included.session/weekly.{remaining_percent, resets_at}`)
  (https://docs.ollama.com/api/balance.md); `GET https://ollama.com/api/usage?range=24h|7d|30d`
  -> totals and buckets of `request_count, usage_usd, input_tokens, output_tokens`
  (https://docs.ollama.com/api/cloud-usage.md).
- Free tier: yes. Free plan: "Starter usage credits included", "access to starter models",
  **1 concurrent request**, resets monthly from signup; buying credits unlocks all models
  (https://ollama.com/pricing). 429 = rate limit; 502 = unreachable cloud model. No rate-limit
  headers documented. "We do not use them to train models" (cloud.md).

### LM Studio
- Default port **1234**; OpenAI base `http://localhost:1234/v1`
  (https://lmstudio.ai/docs/developer/openai-compat). Endpoints: `GET /v1/models`,
  `POST /v1/chat/completions`, `/v1/responses`, `/v1/embeddings`, `/v1/completions`,
  `/v1/decisions`.
- Auth: off by default; when enabled in Developer > Server Settings, every request needs
  `Authorization: Bearer $LM_API_TOKEN` (https://lmstudio.ai/docs/developer/core/authentication).
- `/v1/models` "Returns the models visible to the server" and "may include all downloaded models
  when Just-In-Time loading is enabled"; fields beyond id UNVERIFIED.
- **Native REST v1** `GET /api/v1/models` (https://lmstudio.ai/docs/developer/rest/list) ->
  `{models:[{type ("llm"|"embedding"|"decision"), publisher, key, display_name, architecture,
  quantization:{name, bits_per_weight}, size_bytes, params_string, loaded_instances:[{id,
  config:{context_length, eval_batch_size, parallel, flash_attention, num_experts,
  offload_kv_cache_to_gpu}}], max_context_length, format ("gguf"|"mlx"), capabilities:{vision,
  trained_for_tool_use, reasoning:{allowed_options, default}}, description, variants,
  selected_variant}]}`. Also `POST /api/v1/models/load|unload`, `POST /api/v1/chat`.
  The older `/api/v0/*` API is superseded (https://lmstudio.ai/docs/developer/rest).
- Chat params documented: `model, top_p, top_k, messages, temperature, max_tokens, stream, stop,
  presence_penalty, frequency_penalty, logit_bias, repeat_penalty, seed`
  (https://lmstudio.ai/docs/developer/openai-compat/chat-completions).
- Tools: `tools` accepted; models with native tool templates (Qwen2.5, Llama 3.1/3.2,
  Ministral) are "natively" supported, all others get "a custom system prompt and a default tool
  call format"; tool calls stream in chunks (https://lmstudio.ai/docs/developer/openai-compat/tools).
  **`tool_choice` values: UNVERIFIED** (not on the current pages).

### llama.cpp server (`llama-server`)
Source: https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md
- `--host` default `127.0.0.1`; **`--port` "default: 9931"** in the current README (older
  releases and most guides use 8080: users must set the port; do not assume either).
- Auth: `--api-key KEY` (comma list allowed, default none), sent as `Authorization: Bearer`.
- OpenAI `GET /v1/models` -> `{object:"list", data:[{id, object, owned_by:"ggml-org",
  architecture:{input_modalities, output_modalities}, multimodal, meta:{vocab_type, n_vocab,
  n_ctx_train, n_embd, n_params, size}}]}` (`meta` fields per README; parameter count and trained
  context come straight from it).
- `GET /props` -> `default_generation_settings.n_ctx` (runtime context), `model_path`,
  `chat_template`, `modalities`. `GET /health` readiness. `GET /slots` per-slot state.
- Router mode (multiple models, `--models-dir`, `--models-preset`, `--models-max` default 4,
  autoload default on): `GET /models` or `/v1/models` adds `status` `loaded|unloaded|loading`.
- Tools: need the Jinja template engine (`--jinja`, now default enabled); native formats for
  Llama 3.x, Qwen, Mistral etc., generic fallback otherwise; parallel tool calls "disabled by
  default", enable with `"parallel_tool_calls": true`
  (https://github.com/ggml-org/llama.cpp/blob/master/docs/function-calling.md). `tool_choice`
  values: UNVERIFIED. `response_format` with JSON schema supported.

### vLLM
- Default `http://localhost:8000`; `--api-key` or `VLLM_API_KEY` (multiple keys allowed) checked
  in the header (https://docs.vllm.ai/en/latest/getting_started/quickstart/).
- `GET /v1/models` lists served models; a `max_model_len` field: UNVERIFIED (not shown in docs
  fetched). `--max-model-len` sets context, else derived from model config.
- Tools (https://docs.vllm.ai/en/latest/features/tool_calling.html): `auto` needs
  `--enable-auto-tool-choice` and `--tool-call-parser`; `required` and named work by default via
  structured outputs; `none` supported. Without auto tool choice the server still puts tools in
  the prompt but the model will not call them automatically.

### LocalAI
- Default port 8080, base `http://localhost:8080/v1/`; `LOCALAI_API_KEY=...` enables keys
  ("API keys grant full admin access with no role separation"); `LOCALAI_AUTH=true` for per-user
  keys (https://localai.io/docs/basics/getting_started/).
- Tools: OpenAI `tools` and `tool_choice` (e.g. `"auto"`); llama.cpp backend uses grammars;
  vLLM backend needs `tool_parser`; parallel calls via model config `function.parallel_calls`
  (https://localai.io/docs/features/openai-functions/). `/v1/models` fields: UNVERIFIED.

### Jan
- Base `http://127.0.0.1:1337/v1` (prefix configurable); API key optional (empty disables it;
  when set, sent in the authorization header); CORS on by default
  (https://docs.jan.ai/desktop/api-server). Tool-call pass-through details: UNVERIFIED.

### KoboldCpp
- Default `localhost:5001`; OpenAI-compatible API at `http://localhost:5001/v1`; also emulates the
  Ollama and KoboldAI APIs; `--password` makes clients send an API key
  (https://github.com/LostRuins/koboldcpp, https://github.com/LostRuins/koboldcpp/wiki).
- Tools: README lists "tool calling"; `--jinjatools` uses the model's template instead of
  "KoboldCpp's universal tool calling". Native metadata: `/api/extra/true_max_context_length`,
  `/api/v1/model`, `/api/extra/version` (wiki; response shapes UNVERIFIED).

### text-generation-webui (oobabooga)
- `--api`, default `http://127.0.0.1:5000/v1`, `--api-port`, `--api-key`
  (https://github.com/oobabooga/text-generation-webui/wiki/12-%E2%80%90-OpenAI-API).
  `/v1/chat/completions` supports tool calls (Qwen, Mistral, GPT-OSS examples); `/v1/models`;
  `/v1/internal/model/list|load`. Field details UNVERIFIED.

### Others
- **SGLang**: OpenAI server, examples on `http://127.0.0.1:30000/v1`, examples use
  `api_key="EMPTY"` (https://docs.sglang.io/basic_usage/openai_api_completions.html); tool parser
  and `/v1/models` fields UNVERIFIED.
- **Hugging Face TGI**: "now in maintenance mode"; HF recommends vLLM, SGLang, llama.cpp, MLX
  (https://huggingface.co/docs/text-generation-inference/index).

## 2. Hosted providers not yet covered

| Provider | Status | Free tier | OpenAI base URL | Model list | Notes |
|---|---|---|---|---|---|
| DeepSeek | current | none documented | `https://api.deepseek.com` | `GET /models`: `context_window, max_output_tokens, input/output_modalities, effort, api_capabilities` | see below |
| xAI | current, **Chat Completions deprecated** | none documented | `https://api.x.ai/v1` | `/v1/models` minimal; `/v1/language-models` adds prices, `context_length`, modalities, aliases | Responses API is primary |
| Fireworks | current | 10 RPM with no payment method/credits | `https://api.fireworks.ai/inference/v1` | management `GET /v1/accounts/{id}/models`: `contextLength, supportsTools, supportsImageInput`; OpenAI list fields UNVERIFIED | |
| DeepInfra | current | none documented | `https://api.deepinfra.com/v1/openai` | `GET https://api.deepinfra.com/models/list` (no auth): `model_name, type, pricing, max_tokens (context), quantization, deprecated, replaced_by` | |
| Nebius Token Factory | current | $1 trial credit, 30 days | `https://api.tokenfactory.nebius.com/v1` | `GET /v1/models?verbose=true`: `context_length, architecture, quantization, pricing, supported_features, status` | full x-ratelimit headers |
| Scaleway | current | first 1,000,000 tokens free | `https://api.scaleway.ai/v1` | `GET /v1/models` (fields UNVERIFIED) | EU; IAM secret key |
| OVHcloud AI Endpoints | current | **anonymous: 2 RPM per IP per model, no key** | `https://oai.endpoints.kepler.ai.cloud.ovh.net/v1` | public catalog `GET https://catalog.endpoints.ai.ovh.net/rest/v1/models_v2` with `function_calling`, pricing, rate limits | 400 RPM with key |
| Z.ai (GLM) | current | free models: GLM-4.7-Flash, GLM-4.5-Flash, GLM-4.6V-Flash | `https://api.z.ai/api/paas/v4` | endpoint UNVERIFIED | `tool_choice` only `auto` |
| Moonshot / Kimi | current | UNVERIFIED | `https://api.moonshot.ai/v1` | UNVERIFIED | `max_completion_tokens` |
| Alibaba Model Studio (Qwen) | current | ~1M tokens per model, 90 days, Singapore/International only | `https://{WorkspaceId}.{region}.maas.aliyuncs.com/compatible-mode/v1` | UNVERIFIED | keys region-bound |
| MiniMax | current | UNVERIFIED | `https://api.minimax.io/v1` | UNVERIFIED | temperature/top_p ignored |
| Vercel AI Gateway | current | monthly free credit, free-tier model subset, lower per-model limits | `https://ai-gateway.vercel.sh/v1` | `GET /models` (`id, object, created, owned_by`) | 402 budget; `retry-after` sometimes |
| Venice | current | UNVERIFIED | `https://api.venice.ai/api/v1` | `GET /models?type=text`: `model_spec.availableContextTokens`, `capabilities.supportsFunctionCalling`, pricing | Venice system prompt added by default |
| Novita | current | UNVERIFIED | `https://api.novita.ai/openai` | `data[]: context_size, input/output_token_price_per_m` | `tool_choice` undocumented |
| Hyperbolic | current (inference) | UNVERIFIED | `https://api.hyperbolic.ai/inference/v1` | `GET /v1/models` (path relative to base UNVERIFIED) | `sk_live_` keys |
| Chutes | current | **"We do not offer a free tier"** | `https://llm.chutes.ai/v1` | `GET /v1/models` (no auth) | `cpk_` keys; quota at `api.chutes.ai/users/me/quotas` |
| Featherless | current | none (plans from $25/mo) | `https://api.featherless.ai/v1` | `/v1/models` (fields UNVERIFIED) | concurrency units |
| Baseten Model APIs | current | UNVERIFIED | `https://inference.baseten.co/v1` | `/v1/models` | 402, 529 overloaded |
| AI21 | current | UNVERIFIED | `https://api.ai21.com/studio/v1` (`/chat/completions`) | UNVERIFIED | tools only without streaming; max 4096 output |
| SiliconFlow | current | free models UNVERIFIED | `https://api.siliconflow.com/v1` | `GET /models?type=text&sub_type=chat` (`id` only) | |
| Perplexity | Sonar Chat Completions **superseded by Agent API** (changelog July 2026) | no | `https://api.perplexity.ai` | n/a | search-grounded |
| Inference.net | pivoted to tracing/gateway product | n/a | UNVERIFIED | n/a | no serverless catalog in current docs |
| Lambda Inference API | **winding down** | n/a | n/a | n/a | "As the Inference API winds down..." (https://lambda.ai/inference) |
| Kluster.ai | **inference end-of-life 2025-07-24** (kluster.ai blog per search; site no longer resolves) | n/a | n/a | n/a | |
| Azure OpenAI / Foundry | current | no | `https://{resource}.openai.azure.com/openai/v1` | per-deployment | model = deployment name |
| Amazon Bedrock | current | no | `https://bedrock-runtime.{region}.amazonaws.com/openai/v1`; list only on `https://bedrock-mantle.{region}.api.aws/v1` | mantle `GET /models` | key types below |
| Google Vertex AI | current | no | `https://{location}-aiplatform.googleapis.com/v1/projects/{p}/locations/{l}/endpoints/openapi` | n/a | OAuth tokens (1 h) |

Details worth keeping:

- **DeepSeek** (https://api-docs.deepseek.com/, /api/create-chat-completion,
  /quick_start/rate_limit, /quick_start/pricing, /api/list-models): current ids `deepseek-flash`,
  `deepseek-v4-pro` (legacy names still accepted and remapped); Anthropic format at
  `https://api.deepseek.com/anthropic`. `max_tokens` (1 to 393,216; defaults 8K non-thinking,
  64K thinking). `tool_choice` none/auto/required/named, but **required and named return 400 in
  thinking mode**. `response_format` text/json_object (must also ask for JSON in the prompt).
  `frequency_penalty`, `presence_penalty` no longer supported; no `n`. Temperature has no effect
  in thinking mode. Limits are **concurrency** (account-level), 429 when exceeded; no rate-limit
  headers; requests may wait up to 10 minutes with keep-alive blank lines / `: keep-alive` SSE
  comments (clients must tolerate them). Off-peak prices are half.
- **xAI** (https://docs.x.ai/developers/rest-api-reference/inference/chat-completions,
  .../inference/models, https://docs.x.ai/docs/key-information/consumption-and-rate-limits):
  Chat Completions is the "stateless, OpenAI-compatible predecessor" of Responses and is
  deprecated (removal date UNVERIFIED). `max_tokens` deprecated for `max_completion_tokens`.
  Reasoning models reject `frequency_penalty`, `presence_penalty`, `stop`; `logprobs` ignored on
  grok-4.20+. Limits RPS (=RPM/48, min 2) and TPM by spend tier; 429; header names UNVERIFIED.
  Prices in `/v1/language-models` are "USD cents per 100M tokens".
- **Fireworks** (https://docs.fireworks.ai/tools-sdks/openai-compatibility,
  https://docs.fireworks.ai/guides/quotas_usage/rate-limits): `max_tokens` is silently reduced to
  fit context unless `context_length_exceeded_behavior: "error"`; usage in the final stream
  chunk. Up to 6,000 RPM with payment method and credits. Header names UNVERIFIED.
- **DeepInfra** (https://docs.deepinfra.com/chat/overview,
  https://docs.deepinfra.com/account/rate-limits.md,
  https://docs.deepinfra.com/api-reference/models/models-list.md): params include `tools,
  tool_choice, response_format, n, max_tokens`; "may not be 100% compatible"; output hard cap
  16,384 tokens for most models; 200 concurrent requests per model; occasional 429 during
  autoscaling.
- **Nebius** (https://docs.tokenfactory.nebius.com/ai-models-inference/rate-limits.md,
  .../api-reference/models/list-models.md, .../function-calling.md,
  .../other-capabilities/billing-new.md): headers `x-ratelimit-limit|remaining|reset-requests`,
  `-tokens` (per minute; reset in seconds), plus `x-ratelimit-dynamic-*`,
  `x-ratelimit-over-limit`, `Retry-After`. Limits scale in 15-minute windows. `tool_choice`
  documented: `auto` (default) and named function; `required`/`none` UNVERIFIED.
- **Scaleway** (https://www.scaleway.com/en/developers/api/generative-apis,
  https://www.scaleway.com/en/pricing/model-as-a-service/): Bearer `$SCW_SECRET_KEY`; chat
  supports tools and structured output; unsupported `audio, modalities, stream_options, user`;
  only `function` tools. Rate-limit numbers/headers: UNVERIFIED (page did not render).
- **OVHcloud** (https://docs.ovhcloud.com/en/guides/public-cloud/ai-machine-learning/ai-endpoints-getting-started,
  .../ai-endpoints-catalog-api): limits per model: anonymous 2 RPM per IP, keyed 400 RPM per
  project; 429 beyond. Catalog entries: `id, name, available, category, tags,
  metadata.model_specs.capabilities.{input_modality, output_modality, reasoning,
  function_calling, streaming}, metadata.usage_information.pricing`, rate limits. Function
  calling with `tool_choice="auto"` shown in OVH docs (search snippet; page not fetched).
- **Z.ai** (https://docs.z.ai/api-reference/llm/chat-completion,
  https://docs.z.ai/guides/overview/pricing): "Only `auto` is supported" for `tool_choice`;
  `max_tokens`; **temperature range [0.0, 1.0]**; `thinking:{type, clear_thinking}`.
- **Moonshot/Kimi** (https://platform.kimi.ai/docs/api/chat; platform.moonshot.ai redirects
  there): models `kimi-k3`, `kimi-k2.6`, `kimi-k2.7-code(-highspeed)`; `tool_choice`
  auto/none/required/named; `max_tokens` deprecated for `max_completion_tokens`.
- **Alibaba** (https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope,
  .../regions, .../new-free-quota): legacy `dashscope(-intl).aliyuncs.com/compatible-mode/v1`
  still works but "will no longer support new features after September 30, 2026"; keys only work
  in their region.
- **Venice** (https://docs.venice.ai/api-reference/api-spec, .../rate-limiting,
  .../endpoint/models/list): headers `x-ratelimit-limit|remaining|reset-requests`,
  `x-ratelimit-remaining-tokens`; **`x-ratelimit-reset-requests` is a Unix timestamp in
  milliseconds**, not a duration; `x-venice-balance-usd`; more than 50 failed requests in 30 s
  blocks the key; send `venice_parameters.include_venice_system_prompt: false`.
- **Azure** (https://learn.microsoft.com/en-us/azure/ai-foundry/openai/api-version-lifecycle):
  v1 API needs no `api-version`; key auth in REST examples uses the `api-key` header; Entra ID
  uses Bearer tokens. Chat Completions also serves DeepSeek/Grok deployments.
- **Bedrock** (https://docs.aws.amazon.com/bedrock/latest/userguide/inference-chat-completions.html,
  .../api-keys.html): `bedrock-runtime` takes SigV4 or a Bedrock API key as Bearer but has **no
  `GET /models`** (404); `bedrock-mantle` has `/models` and takes keys. Short-term keys last at
  most 12 hours; long-term keys are "for exploration only" and region-scoped.
- **Vertex** (https://docs.cloud.google.com/vertex-ai/generative-ai/docs/migrate/openai/auth-and-credentials):
  OAuth access tokens from Application Default Credentials, 1-hour lifetime.

## 3. Recommendation

### Built-in now

| id | Why |
|---|---|
| `ollama` | local, no key, rich native metadata |
| `ollama-cloud` | free plan, documented, has a balance endpoint |
| `lmstudio` | popular local server, native list with context, quantization, tool capability |
| `llamacpp` | reference local server; `/v1/models` `meta` gives n_params and n_ctx_train |
| `deepseek` | popular, cheap, documented model list with context |
| `fireworks` | popular open-model host |
| `deepinfra` | popular; public model list with pricing and context |
| `nebius` | documented headers, verbose list with pricing, trial credit |
| `scaleway` | 1M free tokens, documented |
| `ovhcloud` | anonymous free use, public catalog with tool capability |
| `zai` | free Flash models |
| `moonshot` | popular, full `tool_choice` |
| `vercel` | monthly free credit, many models |

### Custom-provider example only (documented in setup, not built in)
vLLM, LocalAI, Jan, KoboldCpp, text-generation-webui, SGLang (local servers: user gives the
URL; plain OpenAI list); xAI (deprecated Chat Completions; built-in once a Responses adapter
exists); Alibaba Model Studio (needs a `{WorkspaceId}` URL parameter; built-in later); MiniMax;
Venice; Novita; Hyperbolic; Chutes (no free tier); Featherless (subscription); Baseten; AI21;
SiliconFlow; Azure OpenAI/Foundry (per-resource URL, deployment names, `api-key` header); Amazon
Bedrock via `bedrock-mantle` with a long-term Bedrock API key (exploration only; short-term keys
expire within 12 h); HF TGI (maintenance mode).

### Excluded
- Google Vertex AI: OAuth access tokens (1 h), no static key.
- Amazon Bedrock with SigV4 credentials: request signing, not a key (the API-key path is above).
- Azure with Entra ID only: token auth.
- Perplexity: Sonar Chat Completions superseded by the Agent API; search-specialised.
- Lambda Inference API: winding down.
- Kluster.ai: inference end-of-life (2025-07-24).
- Inference.net: no documented serverless model API today (UNVERIFIED).

### Registry facts for each recommended built-in

Defaults are the `openAiCompatible()` defaults unless listed. `checkedAt: "2026-10-20"`.

**Schema needs (implement before or with these entries):**
1. NEEDS: user-overridable `baseUrl` for local servers (`providers.<id>.baseUrl`), and the
   option to have no key (`auth: "none"` exists; the vault must allow keyless providers).
2. NEEDS: new `ModelListShape` values `ollama_tags` (`{models:[...]}` + per-model `/api/show`),
   `lmstudio_native` (`{models:[...]}` from `/api/v1/models`), `deepinfra_list` (bare array,
   `model_name`), `ovh_catalog` (bare array, nested metadata). `nebius` and `llamacpp` keep the
   `openai` envelope with extra fields (`?verbose=true` for Nebius; `meta` for llama.cpp).
3. NEEDS: a "concurrency" limit kind (DeepSeek, DeepInfra, Ollama Cloud free plan, Featherless)
   distinct from RPM; and a rate-limit family variant for headers whose reset is a timestamp
   (Venice, custom only for now).
4. NEEDS (optional): `keyInfoUrl` shape for Ollama Cloud `/api/balance` (OpenRouter's `/key` shape
   differs).

| id | displayName | baseUrl | auth | models | tokenLimitParam | toolChoice | unsupportedParams | rateLimitHeaders | other | source |
|---|---|---|---|---|---|---|---|---|---|---|
| `ollama` | Ollama (local) | `http://localhost:11434/v1` (overridable) | `none` | `http://{host}/api/tags` shape `ollama_tags`, then `POST /api/show` per model | `max_tokens` | all `null` (unsupported) | `tool_choice, logit_bias, user, n, logprobs` | `none` | quotaScope n/a (local); 503 when queue full; 404 = not pulled | https://docs.ollama.com/api/openai-compatibility.md |
| `ollama-cloud` | Ollama Cloud | `https://ollama.com/v1` | `bearer` | `https://ollama.com/api/tags` shape `ollama_tags` | `max_tokens` | all `null` | same as `ollama` | `none` | keyInfoUrl `https://ollama.com/api/balance` (NEEDS 4); quotaScope `account`; free plan 1 concurrent request | https://docs.ollama.com/cloud.md |
| `lmstudio` | LM Studio (local) | `http://localhost:1234/v1` (overridable) | `none` (bearer when the user enables tokens) | `http://{host}/api/v1/models` shape `lmstudio_native`; fallback `{base}/models` | `max_tokens` | UNVERIFIED: start `{auto:"auto", none:null, required:null}` | none documented | `none` | `capabilities.trained_for_tool_use=false` still accepts tools via a default format | https://lmstudio.ai/docs/developer/rest/list |
| `llamacpp` | llama.cpp server | **user-supplied** (README default `http://127.0.0.1:9931/v1`; many installs 8080) | `none` (bearer if `--api-key`) | `{base}/models` shape `openai` + `meta` | `max_tokens` | UNVERIFIED: start `{auto:"auto", none:null, required:null}` | none documented | `none` | `parallel_tool_calls` off by default; runtime ctx at `/props` | https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md |
| `deepseek` | DeepSeek | `https://api.deepseek.com` | `bearer` | `{base}/models` shape `openai` (+`context_window, max_output_tokens`) | `max_tokens` | pass-through (required/named 400 in thinking mode) | `frequency_penalty, presence_penalty, n` | `none` | quotaScope `account`; concurrency limits; keep-alive blank lines/SSE comments | https://api-docs.deepseek.com/api/create-chat-completion |
| `fireworks` | Fireworks AI | `https://api.fireworks.ai/inference/v1` | `bearer` | `{base}/models` shape `openai` (fields UNVERIFIED) | `max_tokens` | pass-through (UNVERIFIED in detail) | none documented | `none` (UNVERIFIED) | quotaScope `account`; add `context_length_exceeded_behavior:"error"` to bodyExtras so truncation is visible | https://docs.fireworks.ai/tools-sdks/openai-compatibility |
| `deepinfra` | DeepInfra | `https://api.deepinfra.com/v1/openai` | `bearer` | `https://api.deepinfra.com/models/list` shape `deepinfra_list`, auth `none` | `max_tokens` | pass-through | none documented | `none` | quotaScope `account`; 200 concurrent per model; output cap 16,384 most models | https://docs.deepinfra.com/chat/overview |
| `nebius` | Nebius Token Factory | `https://api.tokenfactory.nebius.com/v1` | `bearer` | `{base}/models?verbose=true` shape `openai` (RichModel fields) | `max_tokens` (UNVERIFIED) | `{auto:"auto", none:null, required:null}` (only auto/named documented) | none documented | `openai`, requests `minute`, tokens `minute` | dynamic limits; `x-ratelimit-over-limit` | https://docs.tokenfactory.nebius.com/ai-models-inference/rate-limits.md |
| `scaleway` | Scaleway Generative APIs | `https://api.scaleway.ai/v1` | `bearer` (IAM secret key) | `{base}/models` shape `openai` | `max_tokens` (UNVERIFIED) | pass-through (values UNVERIFIED) | `stream_options, user, audio, modalities` | `none` (UNVERIFIED) | quotaScope `project` (UNVERIFIED); only `function` tools | https://www.scaleway.com/en/developers/api/generative-apis |
| `ovhcloud` | OVHcloud AI Endpoints | `https://oai.endpoints.kepler.ai.cloud.ovh.net/v1` | `bearer`; keyless allowed (anonymous 2 RPM) | `https://catalog.endpoints.ai.ovh.net/rest/v1/models_v2` shape `ovh_catalog`, auth `none` | `max_tokens` (UNVERIFIED) | `{auto:"auto", none:null, required:null}` | none documented | `none` | quotaScope `project`; 400 RPM per project per model with key | https://docs.ovhcloud.com/en/guides/public-cloud/ai-machine-learning/ai-endpoints-catalog-api |
| `zai` | Z.ai (GLM) | `https://api.z.ai/api/paas/v4` | `bearer` | `{base}/models` shape `openai` (UNVERIFIED that it exists) | `max_tokens` | `{auto:"auto", none:null, required:null}` | none documented | `none` | `temperatureMax: 1` | https://docs.z.ai/api-reference/llm/chat-completion |
| `moonshot` | Moonshot (Kimi) | `https://api.moonshot.ai/v1` | `bearer` | `{base}/models` shape `openai` (UNVERIFIED) | `max_completion_tokens` | pass-through | none documented | `none` (UNVERIFIED) | | https://platform.kimi.ai/docs/api/chat |
| `vercel` | Vercel AI Gateway | `https://ai-gateway.vercel.sh/v1` | `bearer` | `{base}/models` shape `openai` (`id, owned_by` only) | `max_tokens` | pass-through | none documented | `none` (honour `retry-after`) | quotaScope `account` (team); 402 `quota_for_entity_exceeded` = budget, not retryable; free tier model subset | https://vercel.com/docs/ai-gateway/openai-compat |

## 4. Ollama discovery design

Use the OpenAI path for chat and the native API for discovery.

1. **Host.** `providers.ollama.baseUrl` (default `http://localhost:11434/v1`). Derive the native
   root by stripping the trailing `/v1`. Also honour `OLLAMA_HOST` when no config value is set:
   it may be `host`, `host:port`, or a URL (accepted forms beyond the FAQ wording: UNVERIFIED);
   map `0.0.0.0` to `127.0.0.1` for client use. Remote hosts work the same way; no key
   is sent unless the user configures a header (a reverse proxy may need one).
2. **List.** `GET {root}/api/tags`. Catalog id = `name` exactly (`llama3.1:8b`,
   `user/model:tag`); never strip `:latest` or the tag, since `llama3.1` and `llama3.1:70b` are
   different models. Treat entries with `remote_host` as hosted (flag them; they may use cloud
   quota).
3. **Details.** For each model (bounded concurrency, cached by `digest` so unchanged models are
   not re-queried), `POST {root}/api/show {"model": name}` without `verbose`.
4. **Field mapping.**

   | Catalog field | Source (first that is present) |
   |---|---|
   | parameter count | `model_info["general.parameter_count"]` (exact integer); else parse `details.parameter_size` (`"8.0B"` -> 8.0e9, `"567M"` -> 5.67e8; parser must handle number or string) |
   | context length (max) | `model_info["<arch>.context_length"]`, `<arch>` = `model_info["general.architecture"]` |
   | context length (effective) | `num_ctx` in `/api/show` `parameters` text if present; else `/api/ps` `context_length` when loaded; else unknown, shown as "server default (4k/32k/256k by VRAM, or OLLAMA_CONTEXT_LENGTH)". Budgeting uses the effective value when known, otherwise the smaller of the max and a configured default. |
   | tool support | `capabilities` contains `"tools"` |
   | vision | `capabilities` contains `"vision"` |
   | reasoning | `capabilities` contains `"thinking"` |
   | embedding-only | `capabilities` contains `"embedding"` and not `"completion"`: exclude from chat routing |
   | quantization | `details.quantization_level` (`Q4_K_M`, `Q4_0`, `F16`...) |
   | family / format | `details.family`, `details.format` |
   | size on disk | `/api/tags` `size` |
   | price | 0 (local); free-tier flag true |
5. **Fallback.** If `/api/tags` fails (not Ollama, or a proxy that only forwards `/v1`), fall back
   to `{base}/models` (ids only) and mark metadata unknown.
6. **Requests.** Never send `tool_choice`; when SwitchYard needs `required`, enforce it locally
   (re-prompt or reject a reply with no tool call). Strip `n`, `logprobs`, `logit_bias`, `user`.
   Treat 404 "model not found" as "not pulled" (do not retry; suggest `ollama pull <name>`), 503 as
   overloaded (retry with backoff).
7. **Ollama Cloud.** Same mapping on `https://ollama.com/api/tags` with Bearer; `/api/show` there
   is UNVERIFIED, so fall back to `details` from `/api/tags`; poll `/api/balance` for remaining
   allowance.

## Still unverified (matters for implementation)

- `tool_choice` values on LM Studio, llama.cpp, Fireworks, Scaleway, Nebius `required`/`none`.
- `/v1/models` extra fields on vLLM (`max_model_len`), LM Studio OpenAI path, Fireworks, Scaleway,
  Z.ai and Moonshot (whether the endpoint exists).
- Whether `ollama.com/api/tags` and `/api/show` need a key; whether `/api/show` works on cloud.
- llama.cpp default port: current README says 9931; earlier releases 8080.
- Rate-limit header names for xAI, Fireworks, Scaleway, Moonshot, DeepInfra (none documented).
- Free tiers for Moonshot, MiniMax, Venice, Novita, Hyperbolic, Baseten, AI21, SiliconFlow.
- xAI Chat Completions removal date; Kluster.ai EOL page (site no longer resolves; date from a
  search snippet of kluster.ai's blog).
