# Provider API research (fetched 2026-10-19)

Source of record for the built-in provider registry. Every fact is from official documentation
fetched 2026-10-19 unless marked UNVERIFIED. Free-tier numbers are "documented as of
2026-10-19, changes often": they are never hard-coded as truth in code; discovery, response
headers, and user configuration supply live values.

## Not included

- **GitHub Models: retired 2026-07-30** (https://github.blog/changelog/2026-07-30-github-models-is-now-retired/).

## Providers

### Groq
- Base `https://api.groq.com/openai/v1`, OpenAI-compatible `/chat/completions`
  (https://console.groq.com/docs/openai). Bearer auth.
- Models `GET /openai/v1/models`: `id, owned_by, active, context_window, max_completion_tokens`;
  no pricing or free flag (https://console.groq.com/docs/api-reference).
- Tools: `tool_choice` none/auto/required/named; `parallel_tool_calls`. Structured output
  json_schema/json_object; not with tools or streaming; `strict` only on some models
  (https://console.groq.com/docs/structured-outputs).
- Rate-limit headers (https://console.groq.com/docs/rate-limits): `x-ratelimit-*-requests` are
  **per day**, `x-ratelimit-*-tokens` per minute; `retry-after` on 429.
- Free tier: yes (Free plan, per-model RPM/RPD/TPM/TPD).
- Quirks: unsupported `logprobs`, `logit_bias`, `top_logprobs`, `messages[].name`; `n` must be 1;
  `max_tokens` deprecated for `max_completion_tokens`.

### Google AI Studio (Gemini)
- OpenAI-compatible base `https://generativelanguage.googleapis.com/v1beta/openai/` (beta,
  https://ai.google.dev/gemini-api/docs/openai). Bearer auth on compat; native uses
  `x-goog-api-key`.
- Models: native `GET /v1beta/models` returns `inputTokenLimit, outputTokenLimit,
  supportedGenerationMethods`, paginated (https://ai.google.dev/api/models); compat list fields
  beyond id UNVERIFIED.
- Tools work (docs show `tool_choice: "auto"` only; `required`/named UNVERIFIED); structured
  output via `response_format`.
- Rate limits per **project**, not per key (RPM, TPM, RPD reset at midnight Pacific); 429
  `RESOURCE_EXHAUSTED`; **no rate-limit headers documented**
  (https://ai.google.dev/gemini-api/docs/rate-limits).
- Free tier: yes, per project; many models "Free of charge"
  (https://ai.google.dev/gemini-api/docs/pricing); free content may be used to improve products.

### NVIDIA (build.nvidia.com)
- Base `https://integrate.api.nvidia.com/v1`, OpenAI-compatible
  (https://docs.api.nvidia.com/nim/reference/llm-apis). Bearer (`nvapi-` keys).
- Models: `GET /v1/models` exists (fields UNVERIFIED). Tools per model; structured output
  UNVERIFIED per model; per-model parameter ranges (temperature <= 1, `max_tokens` caps).
- Rate limits: not documented (third-party "40 RPM" UNVERIFIED). Free trial for prototyping.

### OpenRouter
- Base `https://openrouter.ai/api/v1`, OpenAI-compatible. Bearer; optional `HTTP-Referer`,
  `X-OpenRouter-Title`.
- Models `GET /api/v1/models`: context, pricing, modalities, `top_provider.max_completion_tokens`,
  `supported_parameters` (tools, response_format, reasoning)
  (https://openrouter.ai/docs/api/api-reference/models/get-models). Free = `:free` or $0.
- Unsupported parameters are silently ignored: gate on `supported_parameters`.
- Limits (https://openrouter.ai/docs/api-reference/limits): 429 with `X-RateLimit-*` and
  `Retry-After`; 402 with `limit_source`; `GET /api/v1/key` reports
  `free_model_daily_requests {used, limit, remaining}`. `:free` models 20 RPM; 50 RPD (<$10
  lifetime credits) or 1,000 RPD (>= $10), reset 00:00 UTC.
- Errors: HTTP 200 may carry an `error` body; `{error:{code,message,metadata}}`.

### Mistral
- `https://api.mistral.ai/v1/chat/completions` (https://docs.mistral.ai/api/). Bearer.
- Models `GET /v1/models`: `capabilities.{completion_chat, function_calling, vision}`,
  `max_context_length`, `aliases`, `archived`.
- Tools: forcing uses `tool_choice: "any"` (documented) as well as `required`;
  `parallel_tool_calls`. Structured output json_schema strict.
- 429 with `Retry-After`; no x-ratelimit headers; limits per model visible only in the console.
- Free mode is the default lowest tier (exact numbers UNVERIFIED). Quirks: `random_seed` not
  `seed`; strict tool-message ordering.

### Cerebras
- Base `https://api.cerebras.ai/v1`, OpenAI-compatible. Bearer.
- Models list: ids only. Tools and structured output supported (not combined unless documented).
- Limits documented as RPM/RPH/RPD/TPM; header names UNVERIFIED.
- **No permanent free tier**: $5 trial credits after adding a verified payment method.
- Quirks: `n` = 1; never send both `max_tokens` and `max_completion_tokens`; base64 images only.

### Cohere
- OpenAI-compatible `https://api.cohere.ai/compatibility/v1`
  (https://docs.cohere.com/docs/compatibility-api); native v2 `https://api.cohere.com/v2/chat`.
- Models `GET https://api.cohere.com/v1/models?endpoint=chat`: `context_length, features`.
- `tool_choice` not listed for compat (UNVERIFIED); unsupported `logit_bias`, `n`,
  `parallel_tool_calls`. Trial keys free: 20 RPM, 1,000 calls per month. No rate-limit headers.

### Cloudflare Workers AI
- `https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1` (`/chat/completions`).
  Bearer API token; account id in the URL.
- Models: `GET /accounts/{id}/ai/models/search` (supports `format=openrouter`). Model ids `@cf/...`.
- Tools only on some models (OpenAI path UNVERIFIED); JSON mode on a short list, no streaming.
- Free 10,000 Neurons/day (reset 00:00 UTC); no rate-limit headers.

### SambaNova Cloud
- Base `https://api.sambanova.ai/v1`, OpenAI-compatible. Bearer.
- Models `GET /v1/models`: `context_length, max_completion_tokens, pricing`.
- Headers: per-minute `x-ratelimit-*-requests` and per-day `x-ratelimit-*-requests-day`.
- Free (no payment method): 20 RPM, **20 RPD**, 200K TPD per model.
- Quirks: `logit_bias` errors; penalties ignored.

### Together AI
- Base `https://api.together.ai/v1`, OpenAI-compatible. Models list has `type, context_length,
  pricing`. No documented free tier. Header names UNVERIFIED.

### Hugging Face Inference Providers
- Base `https://router.huggingface.co/v1`, OpenAI-compatible chat only. Model ids
  `org/model[:policy|:provider]`. **Free users get no monthly credits.**

### Anthropic (paid)
- Native Messages `https://api.anthropic.com/v1/messages`; `x-api-key`, `anthropic-version:
  2023-06-01`. OpenAI compat exists but is not production-ready (ignores structured output).
- Models `GET /v1/models`: `max_input_tokens, max_tokens, capabilities`.
- Headers `anthropic-ratelimit-*`, `retry-after`; spend-cap 429 (`enforced_spend_limit_reached`)
  has no retry-after and must not be retried. No free tier.

### OpenAI (paid)
- Base `https://api.openai.com/v1`. Models list: ids only. Headers `x-ratelimit-*`,
  `Retry-After` on 429/503. Use `max_completion_tokens`.

## What one OpenAI-compatible client must handle

1. Per-provider base URL and model id format (Cloudflare account id and `@cf/`; HF `:provider`;
   OpenRouter `vendor/model[:free]`).
2. Bearer auth plus optional extra headers.
3. Token-limit parameter per provider: `max_completion_tokens` (OpenAI, Groq, Cerebras) vs
   `max_tokens` (Mistral, NVIDIA, Cohere compat, OpenRouter, others).
4. A parameter allowlist per provider: strip `n`>1, `logprobs`, `logit_bias`,
   `messages[].name`; map `seed` to Mistral `random_seed`.
5. `tool_choice` mapping: `required` -> Mistral `any`; omit where undocumented; detect support
   from catalogue metadata.
6. Structured output may be ignored or unsupported: always validate JSON locally (already done).
7. Message handling: Mistral tool-message ordering; base64 images only on Cerebras.
8. Rate-limit parsing: OpenAI-style `x-ratelimit-*` (Groq requests = per day; SambaNova `-day`
   variants), Anthropic `anthropic-ratelimit-*`, OpenRouter `X-RateLimit-*`; many providers send
   none, so honour `retry-after` and keep local counters from configuration.
9. Quota endpoints: only OpenRouter `/api/v1/key`. Gemini quotas are per project (keys in one
   project share them).
10. Errors: inspect bodies on HTTP 200 (OpenRouter); 402 = out of credits, not retryable;
    Anthropic spend-cap 429 not retryable.

## Adapters

- Native Anthropic Messages (exists). Everything else through one OpenAI-compatible client with
  per-provider rules; Gemini via its compat endpoint (beta); Cohere via compat; Cloudflare with an
  account-id URL template.

## Still unverified

Gemini per-model free numbers; NVIDIA limits and models fields; Cerebras/Together/HF/Cloudflare
headers; Mistral free numbers; Cohere compat `tool_choice`; Cloudflare tools on the OpenAI path;
Gemini compat `max_completion_tokens` and forced tool choice; SambaNova Developer daily cap.
