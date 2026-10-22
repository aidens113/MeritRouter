# Report: web-search-w3 (native web search in model calls)

Worktree: `D:\SwitchYardRouter\.claude\worktrees\agent-a86fd0c3edf86f727`, branch `feat/native-search`
(fast-forwarded to dev 7602b00 first). Nothing committed.

## Outcome

Done. Phase W3 as decision D9 describes, with three providers skipped for documented reasons
(Gemini grounding, Perplexity Sonar as a direct provider, Groq compound). All W3 acceptance
tests pass, along with the full router suite, typecheck, and build. The demo panel shows the
model badge, filter, and detail.

## What changed and why

- **Provider facts verified 2026-10-21** (URLs in `docs/decisions.md`, new section "Native web
  search in model calls (W3)"):
  - OpenRouter: the web plugin, `:online`, `supported_parameters` with `web_search_options`,
    `pricing.web_search` and `pricing.request`, `url_citation` annotations, and the server tool's
    `usage.server_tool_use.web_search_requests`.
  - OpenAI: Chat Completions search models always search, citations are `url_citation`, and web
    search costs $10 or $25 per 1k calls.
  - Anthropic: the `web_search_20250305` server tool, `server_tool_use.web_search_requests`,
    `web_search_result_location` citations, $10 per 1,000 searches, and the models API's
    `capabilities.server_tools.web_search.supported`.
- **Skipped, with reasons:**
  - Gemini: the OpenAI-compatible endpoint documents `google_search` only for an image model.
  - Perplexity Sonar as a direct provider: its docs now point to the Agent API, and Perplexity
    is not a built-in provider.
  - Groq compound: deprecated on 2026-09-21.
- `src/models/catalog.ts`: added `nativeWebSearch` on endpoints (via, engine, usdPerSearch,
  priceDetail, source, detail, sourceUrl, checkedAt). Overrides can set it or remove it (`null`).
- `src/providers/native-search.ts` (new):
  - Detection: OpenRouter models from `supported_parameters` (`openrouter_plugin`, engine
    native); Anthropic models from their capabilities; OpenAI search models and OpenRouter's
    `perplexity/*` marked `always_on` from documented facts.
  - Request switches for each provider.
  - Response parsing of counts and citations (http(s) only, shortened, at most 50).
- Wiring:
  - `enrich.ts` reads the extra OpenRouter price fields.
  - `discovery.ts` reads the Anthropic `capabilities` field and sets `nativeWebSearch`.
  - `openai-compatible.ts` sends `plugins` or `web_search_options`.
  - `anthropic.ts` puts the server tool first, so the cache mark stays on the last client tool.
  - `client.ts` adds `ProviderRequest.webSearch`.
  - `gateway/types.ts` adds `ChatResponse.webSearch` and `WebCitation`.
- `src/routing/native-search.ts` (new) plus `select.ts`:
  - `nativeSearchUse`, `planSearch`, and `requestPaid`.
  - `hints.web: false` excludes `always_on` endpoints.
  - An `always_on` model with a priced search is treated as paid: it is excluded while paid
    routing is off, and excluded when its price is unknown.
  - A web task ranks endpoints with search turned on first (after the free-versus-paid order).
    Other tasks rank `always_on` endpoints last.
  - `RoutePlan` now carries `web` and `paidPolicy`. `router.ts` passes `spec.hints.web` into the
    plan.
- Paid handling and recording:
  - `direct.ts`: a priced search makes the request paid, and the worst case adds the maximum
    number of searches (one for the plugin). The route note names the search.
  - `direct.ts`: when a client reports nothing about a search that was on, one search is
    assumed.
  - `gate.ts` counts paid attempts with `requestPaid`.
  - `spend.ts`: added `perSearch` and `searchUsd`; `worstCaseUsd` and `actualUsd` now take a
    search count.
  - `admission.ts` stores `native_web_search`, `web_search_requests`, and `web_citations_json`.
    Computed spend includes searches.
  - A new migration (appended) adds those three columns.
  - `usage.ts`: added `nativeWebSearches` to task usage (`UsageSchema` in `core/task.ts`), and
    the estimated cost includes searches.
- Config and task inputs:
  - Config gains `web.native` (`enabled`, `max_searches_per_request` 5, `max_results` 5).
  - Tasks gain `hints.web` (task schema, MCP `submit_tasks` schema and description).
  - The supervisor's `delegate` and `plan_work` briefs take a `web` field.
  - Exports added to `src/index.ts`.
  - `admin/insights.ts`: `requestLog` returns `nativeWebSearch`, `webSearchRequests`, and
    `webCitations`.
- Panel:
  - "Web search" and "Searches always" badges (`model-badges.tsx`).
  - A "Web search" filter on the Models table (also settable as `?web=any|optional|always_on|none`).
  - A "Web search in the call" fact on the model page, with price, source, and doc link.
  - The searches and up to 3 cited sources shown in the requests table.
  - Two demo endpoints added to the seed.
- Docs: `docs/setup.md` (`web.native`, `hints.web`, overrides) and `docs/operations.md` (new
  subsection "Web search inside model calls (native)").
- Tests: `tests/native-search.test.ts` (11 tests, listed below).

## Commands run and observed results

- `pnpm install --frozen-lockfile` -> done (bin warnings about a missing `dist/cli.js` before the first build).
- Baseline before changes: `npx vitest run` -> `Tests 559 passed (559)`.
- `npx vitest run tests/native-search.test.ts` -> `Tests 11 passed (11)`. The tests cover:
  - discovery marking from OpenRouter `supported_parameters`, from Anthropic capabilities, and
    for always-on models, with provenance;
  - the request switch for each kind (plugin, `web_search_options`, Anthropic server tool);
  - citations and counts recorded;
  - searches priced into spend: $0.006 of tokens plus 2 searches at $0.004 gives $0.014 settled;
  - a priced native search skipped while paid routing is off;
  - `always_on` excluded for `hints.web: false`;
  - an unknown price blocking an `always_on` model until an override sets it;
  - `web.native.enabled: false` keeping the search off.
- `pnpm -r typecheck` -> router Done, panel Done (the router tsconfig includes the tests).
- Full suite: `cd packages/router && npx vitest run` -> `Test Files 57 passed (57)`, `Tests 570 passed (570)`.
- `pnpm -r build` -> router Done, panel compiled and Done.
- `pnpm --filter switchyard-panel seed:demo` -> "Demo ready".
- Ran `next start` on port 4593 with `.demo/switchyard.config.yaml`, then requested pages:
  - `/all/models`, `/all/models?web=any`, the model pages for perplexity/sonar, claude-haiku-4.5,
    and groq llama-3.1-8b, and `/all/requests` all returned 200 (`/requests` returned 307, a
    redirect).
- Screenshots in the scratchpad, inspected visually:
  - `w3-models-filter.png`: the filter set to "searches the web" shows 2 of 12 models, with a
    "Web search" badge and a "Searches always" badge.
  - `w3-models-all.png`: the full table with the badges.
  - `w3-model-detail.png`: the Sonar page with the header badge and the "Web search in the call"
    fact (price, source, checked date, doc link).
- Panel stopped; port 4593 confirmed free.

## Not verified

- No live provider calls (as the brief required).
- Unconfirmed provider behaviour:
  - Whether OpenRouter's `usage.cost` includes web plugin charges. When `usage.cost` is present,
    spend settles to it.
  - Whether the plugin reports `server_tool_use`. When it reports nothing, one search is assumed.
  - Which OpenAI price row applies to Chat Completions search models. The higher one, $25 per
    1k, is recorded.
  - The `web_search_options` field shape: the OpenAI docs page did not render it. SwitchYard
    sends `{}`, and only for endpoints an override marks with that via.
- An Anthropic `pause_turn` stop is still read as a normal stop (the paused turn is not
  continued).
- The requests table's citation line was not seen on screen: no seeded request ran a native
  search, because the demo's OpenRouter key is free_tier. It is covered by
  `insights.requestLog` in the tests.
- `stickyOrder` still uses the model's own paid status, not `requestPaid`.

## Open questions or contradictions found

- The brief lists "Perplexity Sonar and Groq compound (always on)". The Groq compound ids are
  deprecated, and Perplexity's docs no longer describe the Sonar chat API. Only OpenRouter's
  `perplexity/*` models are marked always-on. The marking rests on two statements: OpenRouter
  says native search is the default for them, and Perplexity documents a `disable_search`
  option (so search is on unless disabled).
- An always-on model is excluded only for `hints.web: false`. A task with no hint can still be
  served by one (it ranks last). Its answer is then web-derived, and that is recorded on the
  request.
