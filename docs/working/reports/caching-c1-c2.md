# Report: caching-c1-c2

Worker report for `### Brief: caching-c1-c2` (docs/working/caching-and-continuity.md).
Worktree: `D:\SwitchYardRouter\.claude\worktrees\agent-a3a41aaec9f108b6d`, branch `feat/caching`
(renamed from the worktree's branch; based on `d735298`, two commits behind `dev`: `a6ccc06` and
`6afc11e` touch only `cli.ts`, `mcp.ts`, `operations/panel.ts`, its test, and working docs, none of
which this work touches). Nothing committed.

## Outcome

Done. C1 and C2 are implemented with the Phases acceptance tests (`tests/caching.test.ts`, 16
tests), all passing. Typecheck and `pnpm -r build` pass. The full router suite passed 511 of 512;
the one failure is an `ENOTEMPTY` temp-dir cleanup race in `tests/operations.test.ts` (daemon),
an area this work does not touch, which passes 23/23 when run alone (a different daemon test hit
the same race in an earlier full run).

## What changed and why

**C1: provider cache hints**
- `providers/registry.ts`: new `PromptCacheStyle` and `ProviderDefinition.promptCache`:
  `cache_control` for `anthropic`, `prompt_cache_key` for `openai` and `openrouter`, `none` for
  every other provider (custom providers included). `providers.<id>.prompt_cache` overrides it
  (`config/schema.ts`). Exported from `providers/index.ts`.
- `providers/anthropic.ts`: with `cache_control`, the body carries three `{type:"ephemeral"}`
  breakpoints: the last tool, the system prompt (now a one-block array), and the last block of
  the newest message. `MAX_CACHE_BREAKPOINTS = 4` is respected. `cacheHit` = cache reads > 0.
- `providers/openai-compatible.ts`: sends `prompt_cache_key` (from the new
  `ProviderRequest.cacheKey`) only where `promptCache` is `prompt_cache_key`. `cacheHit` =
  `cached_tokens > 0`, null when the provider reports no cached count.
- Facts verified 2026-10-21 and recorded in `docs/decisions.md` (new section "Prompt caching and
  conversation continuity"): Anthropic allows at most 4 breakpoints; the minimum cacheable prefix
  is 512 to 4096 tokens depending on the model, and a shorter prefix is not cached and raises no
  error; reads cost about 0.1x and 5-minute writes 1.25x. OpenAI Chat Completions accepts
  `prompt_cache_key` (from openai-node's `ChatCompletionCreateParamsBase`). OpenRouter accepts
  `prompt_cache_key` and prices `input_cache_read` in USD per token. Anthropic facts come from
  the claude-api skill's prompt-caching reference; OpenAI and OpenRouter facts come from their
  docs pages fetched with WebFetch.

**C1: stickiness**
- `routing/select.ts`: `stickyOrder(candidates, preferId, healthy)` moves the endpoint that
  served the last turn to the front. It does not when that endpoint is not a candidate or is
  unhealthy, or when it is paid and a free candidate ranks ahead of it.
- `gateway/gate.ts`: `GateRequest` gains `preferEndpointId`, `avoidEndpointIds`, and `cacheKey`.
  `stickyHealthy` requires a closed breaker, no cooldown, and no exclusion. Key availability and
  context fit are still checked when the endpoint is tried, and a skip there falls through to
  the normal order. New `routing.sticky_endpoints` (default true). `gateway/direct.ts` passes
  `cacheKey` to the provider client.
- `sessions/resume.ts`: `ResumePlan.lastEndpointId` (the endpoint of the last recorded
  response). The loop starts sticky to it, so a resumed task prefers the same endpoint.
- `harness/loop.ts`: every request carries `preferEndpointId` (the last serving endpoint) and
  `cacheKey` (the task id). `runners/types.ts` `ask()` already spreads extra request fields into
  the gate, so no runner changed.

**C1: cached pricing**
- `models/catalog.ts`: `pricing.cachedInputUsdPerMillion` (optional, nullable) and
  `cachedInputSource` record where a cached price came from. A catalog override
  `cachedInputUsdPerMillion` sets the source to "override".
- Where the price comes from:
  - discovery: `providers/enrich.ts` parses OpenRouter `input_cache_read` and
    `providers/discovery.ts` stores it.
  - paid models: `paid/catalog.ts` takes `paid.models[].cached_input_usd_per_million` (new in
    `config/schema.ts`) or `input_cache_read` from the `pricing_url`.
- `paid/spend.ts`: `TokenPrice`, `endpointPrice()`, `actualUsd(..., cachedInputTokens)` (cached
  tokens at the cached rate when known), `cacheSavingUsd()`. The worst-case reservation is
  unchanged (full input price).
- `admission/admission.ts` settles paid spend with cached tokens. `storage/usage.ts` task
  `estimatedCostUsd` uses them too (batch shares are priced as ordinary input).

**C2: truncation recovery (`harness/loop.ts`)**
- A reply with `finish_reason: length`, no tool calls, and some text gets one continuation
  request (`CONTINUE_TEXT`) that goes to the sticky endpoint first. The partial reply and the
  continuation are then joined into one assistant message, and the continue prompt is removed
  from the transcript.
- A truncated tool call (unparseable arguments), or an empty reply cut off at the limit, retries
  the turn once without keeping the broken reply. The retry first asks for twice `max_tokens`
  on the same endpoint, when its output limit and context allow (`turnRetry`). Otherwise it
  uses the same allowance on another candidate (`avoidEndpointIds`). When no endpoint can take
  it (an `AdmissionDenied`), the truncated reply is kept as before. Both are ordinary requests
  counted against the task budget.

**C2: prefix-stable compaction (new `harness/compaction.ts`)**
- `compact()` runs only when the conversation is over budget. It then cuts the conversation to
  `COMPACT_TARGET` (0.5) of the budget by replacing the oldest whole turns (an assistant message
  plus its tool results and nudges) with one summary user message that lists their tool calls.
  A repeated compaction folds the earlier summary into the new one. The newest turn always
  stays, tool calls stay paired with their results, and tool outputs are stubbed only when the
  newest turn alone is too large. `loop.ts` re-exports `compact`.
- The budget follows the serving endpoint: `max(inputBudget, its context - maxTokens - tools
  - 500)`. If the gate then answers `context_does_not_fit`, the loop compacts to the fallback
  `inputBudget` and retries.

**Panel (cached share and saving)**
- `requests-view.tsx`: a new "Prompt cache" stat shows the cached share of input and the saving
  at cached prices. It shows "saving unknown (no cached price)" when no model has a cached
  price.
- `requests-table.tsx`: the Cached column shows each request's share. It also exports
  `cacheSaving()`.
- `task-detail.tsx` and `session-timeline.tsx` show the cached share.
- `app/all/models/detail/page.tsx` shows the cached-input price and its source. For a priced
  model without one it says "cached input priced as input".

**Tests:** `tests/caching.test.ts` (new). `tests/providers-client.test.ts`: the Anthropic body
expectation now reads `system` as the block array.

## Commands run and observed results

- `pnpm install --frozen-lockfile` -> exit 0.
- `pnpm -r typecheck` -> router Done, panel Done.
- `npx vitest run tests/caching.test.ts` -> 16 passed.
- `pnpm -r build` -> exit 0 (router and panel; the panel route list printed).
- `npx vitest run` (packages/router, full) -> 52 files passed, 1 failed; 511 tests passed, 1
  failed: `operations.test.ts > daemon > stop() during a backoff wait ...` with `ENOTEMPTY ...
  rmdir switchyard-ops-*` in `afterEach` cleanup. `npx vitest run tests/operations.test.ts`
  alone -> 23 passed. An earlier full run (before the new tests existed) failed a sibling daemon
  test the same way, plus the Anthropic expectation that has since been updated.
- Panel check:
  - Ran `pnpm --filter switchyard-panel seed:demo`, then `next start` on port 4593 with
    `SWITCHYARD_CONFIG=.demo/switchyard.config.yaml`.
  - These pages returned 200: `/`, `/all/models`, `/all/requests`, `/p/demo/requests`,
    `/p/demo/tasks`, `/p/demo/sessions`, a task detail, a session detail, and two model detail
    pages.
  - The HTML showed:
    - "Prompt cache 20% ... saving unknown (no cached price)" on the requests page.
    - "cached (20%)" on task details.
    - "cached, 20%" on the session timeline.
    - "cached input priced as input (no cached price)" on the paid model detail.
  - Looked at headless Chrome screenshots of the requests page and the paid model page; both
    render correctly.
  - The panel was stopped afterwards (nothing listens on 4593).

## Not verified

- No live provider call. Not confirmed against live APIs:
  - real Anthropic acceptance of the breakpoints;
  - OpenAI and OpenRouter honouring `prompt_cache_key`;
  - real cache-hit rates.
- The 1.25x premium Anthropic charges for cache writes is not modelled. Cache-write tokens are
  counted as ordinary input, so settled Anthropic cost is slightly low on writes.
- OpenRouter also accepts `cache_control` for Anthropic models through its OpenAI-compatible
  API; that is not sent (only `prompt_cache_key`).
- The demo data has no cached prices, so the panel's saving figure (as opposed to "unknown") was
  checked only through `cacheSavingUsd` unit tests, not on a page.
- Not run: the eval suite or the MCP surface beyond the full test run.

## Open questions or contradictions found

- Budget growth: the Design says "the budget is recomputed for the serving endpoint". As
  implemented, a sticky conversation can grow past the smallest-fallback budget, up to the
  serving endpoint's context. That uses more tokens per request, which matters for TPM-limited
  free providers. If the sticky endpoint becomes unavailable, the loop falls back to compacting
  to the original budget. The supervisor may prefer to cap growth.
- Stickiness never promotes a paid endpoint over a free one. This is a choice made here, not
  stated in the Design.
- Proposed text for `docs/setup.md` / `docs/operations.md` (this worker may not edit them):
  - setup.md, provider entries: "`prompt_cache: cache_control | prompt_cache_key | none`: how to
    ask the provider to cache the prompt prefix. Anthropic uses `cache_control`, OpenAI and
    OpenRouter use `prompt_cache_key`, and every other provider (custom ones included) uses
    `none` unless set here."
  - setup.md, routing: "`sticky_endpoints` (default true): keep a conversation on the model that
    served its last turn while it is healthy, so the provider's prompt cache keeps working. It
    never moves a paid model ahead of a free one."
  - setup.md, paid.models: "`cached_input_usd_per_million`: the price of input served from the
    provider's cache. Without it, the price is fetched from `pricing_url` (`input_cache_read`)
    or cached input is priced as ordinary input."
  - operations.md: "A reply cut off at the output limit gets one continuation request, or for a
    cut-short tool call one retry with a larger output allowance or on another model. Both count
    against the task's request budget. Compaction replaces the oldest whole turns with a summary
    of their tool calls only when the conversation exceeds its budget, and cuts it to half the
    budget."
- `examples/switchyard.config.example.yaml` and the generated presets do not mention
  `routing.sticky_endpoints`. The default is on, so presets work unchanged. Add it to the
  example and regenerate the presets if wanted (outside this brief's paths).
