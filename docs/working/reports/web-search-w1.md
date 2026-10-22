# Report: web-search-w1 (W1 and W2)

Worktree: `D:\SwitchYardRouter\.claude\worktrees\agent-afb961f3d921d7c1b`, branch `feat/web-search`
(renamed from the worktree branch). The branch now contains `dev` at `eac93fb` through the merge
commit `cb72917` "Merge dev into feat/web-search" (the only commit I made, as the follow-up
allowed). Everything else is uncommitted in the worktree.

The sections "What changed and why" through "Open questions" describe the first build. "Rework:
backend pool" at the end describes the supervisor's follow-up and supersedes the single-backend
parts above (`web.search.backend`, `web.fetch.backend`, one backend per call).

## Outcome

Done. All W1 and W2 deliverables are in, and every check the brief names passes (results below).
The live Ollama check was skipped because `SWITCHYARD_TEST_OLLAMA_KEY` is not set.

## What changed and why

Router: a new area, `packages/router/src/web/`:
- `services.ts`: backend and search-service names, with no imports, so the config schema and the
  credentials can use them without an import cycle.
- `backends.ts`: Ollama `web_search`/`web_fetch`, Tavily, Brave, Exa, and SearXNG. Each request
  and response shape was checked against the service's own docs on 2026-10-21; the facts are
  recorded in `docs/decisions.md`. Responses are validated with zod, snippets are capped,
  non-http result URLs are dropped, and keys are masked in every error.
- `address-guard.ts`: the SSRF guard. Only http(s) URLs are allowed. URLs with credentials, local
  or metadata host names, and blocked IPv4/IPv6 ranges are refused, and IPv4 addresses embedded
  in IPv6 (mapped or NAT64) are judged as IPv4. `checkHostResolves` checks every resolved address,
  and `guardedLookup` checks again at connection time, so DNS rebinding cannot get through.
- `page-fetch.ts`: the built-in fetch over node http/https with the guarded lookup. It re-checks
  every redirect (at most `max_redirects`), has a timeout, caps the decoded body (gzip, deflate,
  and br are decoded), and reads text content types only. The transport and the resolver can be
  injected for tests.
- `html-text.ts`: HTML to readable text with no new dependency.
- `ledger.ts`: the `web_requests` table. Each request is reserved inside one IMMEDIATE transaction
  that checks the per-task and per-UTC-day budgets, then settled with its outcome.
- `access.ts`: `WebAccess`. It resolves the backend (`auto` order: an ollama-cloud key, then
  Tavily, Brave, Exa, then SearXNG; config first, then the vault), reports `status()`, decides
  `enabledFor(role)`, and runs `search`/`fetch` with budgets, records, and a `web_request` event.
- `index.ts`: the barrel, also re-exported from `src/index.ts`.

Other router changes:
- `harness/web-tools.ts`: the `web_search` and `web_fetch` tools (side effect `read`, journaled
  by the loop). They are available only when `ctx.web.enabledFor(role)` is true. Output is wrapped
  in a `<web_content ... trust="untrusted">` data block, and a page cannot close that block early.
  Searches and pages are stored as artifacts and registered as citable evidence. A page longer
  than the limit is returned as an excerpt plus its artifact ref.
- The web tools are added to the tool lists in `runners/readonly.ts`, `runners/coding/native.ts`,
  `runners/supervisor.ts`, and `verification/review.ts`.
- Wiring: `RunContext.web`, `ExecutorDeps.web`, and `Switchyard.web`. New
  `SwitchyardOptions.webFetch` and `webPage` let tests inject fakes.
- `config/schema.ts`: a new `web` section (search backend, per-service keys and `base_url`,
  searxng, fetch backend, timeout, byte cap, redirects, roles, per-task and per-day budgets,
  max_results, page_excerpt_chars). `providers.tavily`, `providers.brave`, and `providers.exa`
  are refused with a pointer to `web.search.<service>`.
- `providers/credentials.ts`: vault keys of search services are filtered out of model
  credentials, so they are never routed for chat and never show up in doctor's provider checks.
  `paid/spend.ts` filters them out of the spend summary too.
- `storage/migrations.ts`: an appended migration adding `web_requests` (with a project-stamping
  trigger). `core/task.ts`: `Usage.webRequests`, which defaults to 0 so results stored earlier
  still parse. `storage/usage.ts` and `storage/tasks.ts` fill it.
- `admin/web-search.ts`, re-exported through `admin/insights.ts`: `webSearchView`, `searchKeys`,
  `addSearchKey`, `setSearchKeyEnabled`, `removeSearchKey`, `taskWebRequests`, `webStatusText`.
- `cli/keys.ts`: `keys add tavily|brave|exa` takes no billing class and runs no scan.
  `keys list` includes search keys and keeps its JSON array shape. `cli/help.ts` is updated.
- `cli/doctor.ts`: a "web search" check. It is `ok` when web search is on or off, and `fail` only
  when a named backend cannot serve. Literal `web.search.*.api_key` values are added to the
  secrets-in-config warning.
- `tests/web.test.ts`: 21 tests (below).

Panel (`apps/panel`):
- Settings: a "Web search" section (`lib/settings-schema.ts` `WEB_SECTION`) with a nav entry and a
  status callout saying which backend serves, or how to turn search on.
- Provider keys: a "Web search services" card. Each service shows its keys (last four characters
  only) with Enable/Disable and Remove, and there is an add form
  (`components/client/search-keys.tsx`).
- New API routes: `app/api/web-search/route.ts` (GET the view, POST a key) and
  `app/api/web-search/keys/[id]/route.ts` (PATCH enabled, DELETE). Both refuse vault keys that do
  not belong to a search service.
- Task page: a "Web requests" usage row and a Web requests table.
- Session timeline: web tools get a globe icon and a "web" badge.
- `scripts/seed-demo.mjs`: the demo config now points web search at a SearXNG instance on the
  closed local port. In-process fake web transports answer it, and one new inspection
  ("web research") searches and then fetches a page.

Docs: `docs/setup.md` (configure and run), `docs/operations.md` (a new "Web search and fetch"
section covering backends, hard budgets, records, untrusted content, SSRF, and keys), and
`docs/decisions.md` (backend facts with URLs and dates, decisions, and departures).

## Commands run and observed results

- `pnpm install --frozen-lockfile` -> done in 1m 22s. It warned twice that it could not create
  the panel's `switchyard` bin because `dist/` did not exist yet.
- `npx vitest run tests/web.test.ts` -> 21 passed. The first run had 1 failure: a test
  expectation about the paragraph break in `htmlToText`. I fixed the test.
- First full run, before the panel work: `pnpm --filter switchyard-router build` -> exit 0;
  `npx vitest run` -> 56 files, 545 tests passed.
- Final run, after all edits: `pnpm -r typecheck` -> exit 0 (router and panel both "Done");
  `pnpm --filter switchyard-router build` -> exit 0; `cd packages/router && npx vitest run` ->
  exit 0, 56 test files and 545 tests passed (web.test.ts included); `pnpm -r build` -> exit 0,
  and the panel reported "Compiled successfully".
- `node scripts/build-presets.mjs` -> rewrote the 3 presets with no diff (they are not in
  `git status`).
- `pnpm --filter switchyard-panel seed:demo` -> every phase completed as before, plus
  "web research (search, then fetch) completed". The demo DB holds 2 `web_requests` rows
  (searxng search: 2 results; builtin fetch: 441 bytes).
- `pnpm --filter switchyard-panel build` -> ok. I started it with `next start` on 127.0.0.1:4591
  against `.demo` and got HTTP 200 for `/`, `/all/keys`, `/all/settings`,
  `/p/demo/tasks/<web task>`, `/p/demo/sessions/<its session>`, and `/api/web-search`.
- Search-key API on the demo: POST added an exa key, PATCH disabled it, and DELETE removed it.
  DELETE of vault key 1 (a model provider key) was refused with "unknown search key 1".
  `/api/config` with a patch to `web.max_requests_per_task` and a null `searxng.base_url` saved
  successfully; I then restored both values.
- Headless Chrome screenshots (in my scratchpad, not committed) of the keys, settings, task, and
  session pages. I looked at each one: the Web search services card, the settings section and
  callout, the task's Web requests row, table, and events, and the session's `web_search` and
  `web_fetch` calls with their untrusted blocks all render.
- I stopped the panel on 4591 and confirmed nothing listens there any more. The user's panel on
  4477 was not touched and was still listening. I never used `D:\SwitchYard` or its config.

## Not verified

- The live check against Ollama: `SWITCHYARD_TEST_OLLAMA_KEY` is not set, so it was skipped.
  None of the five backends has been called for real; each was tested only against fake HTTP
  built from its docs.
- The SearXNG result field names (`title`, `url`, `content`) are not listed on the documentation
  page I checked; they come from common usage and are parsed defensively.
- The built-in fetch against a real public site: no network access was used in tests. The node
  transport was exercised against a local server (gzip, byte cap, redirect pass-through), and
  `fetchPage` refused that local server.
- The OpenCode and command coding runners get no web tools. This is by design and is recorded in
  `decisions.md`.

## Open questions or contradictions found

- The worktree base was one commit behind `dev` (it lacked the plan commit). This needs a merge
  of `dev` before merging back.
- `AGENTS.md`'s Code Structure area list and `CLAUDE.md`'s Layout do not list the new `web` area.
  Both are outside what I own; the supervisor should add `web` (`src/web`: web search backends,
  SSRF guard, web budgets).
- Departures from the plan's decisions (also recorded in `decisions.md`):
  - Every fetched page is stored as an artifact, not only long ones, so every page can be cited.
  - A named backend whose key is missing turns the tools off and fails doctor; it does not fall
    back to another backend.
  - Web calls are journaled as `read`, so a resume re-runs an interrupted call, and that call
    counts against the budget again.
- `web.search.searxng.base_url` is optional inside `searxng`. This is needed because the panel's
  config patch deletes a key that is set to null, which leaves `searxng: {}`.

## Rework: backend pool (supervisor follow-up, same day)

The user rejected the single-backend design: web search must use every configured backend, the
way SwitchYard treats model providers. What I did:

1. **Merged `dev` (`eac93fb`).** I set my uncommitted work aside with a tagged stash
   (`w1-websearch-pre-merge-7f3a`), ran `git merge --no-ff dev -m "Merge dev into feat/web-search"`
   (no conflicts), and re-applied the stash by SHA. One conflict came up on re-apply, in
   `runners/coding/native.ts`: dev now computes `maxTokens` after `limits` (bounded by the
   candidates' output limit), and I had added `webTools()` to the tool list. I kept dev's
   `maxTokens` line and my tool list. I then dropped the stash entry.
2. **Search backends are a pool.**
   - Config: `web.enabled` (default true), `web.search.backends` (default `[auto]`; `auto` expands
     to every backend not listed elsewhere, in the order ollama, tavily, brave, exa, searxng; a
     backend listed twice is refused), `web.search.strategy: spread | fallback` (default spread),
     and `web.search.limits.<backend>: { per_day?, per_month? }` with no built-in numbers.
   - `WebAccess.search`:
     - spread orders the healthy backends least recently used first (ties keep the list order);
       fallback keeps the list order;
     - within one tool call each backend is tried once, until one answers;
     - the tool output ends with "answered by X after Y (rate limited) failed".
3. **Health per key, persisted.** A new table `web_backend_state` is handled by
   `src/web/backend-state.ts`:
   - 429, 5xx, timeout, or transport failure: cooling, for the backend's `retry-after` or else
     30 s doubling to 15 min;
   - 401 or 403: invalid;
   - 402 or a spend message: out of credits, rechecked after 6 h;
   - a success clears the state.
   A secret fingerprint makes a new secret start clean. Re-enabling a key clears its state: panel
   PATCH, `keys enable`, and `updateProviderKey` for `ollama-cloud` keys. Removing a search key
   clears it too. Several keys of one backend rotate least recently used first: every vault key
   of a service plus its config key, and every usable `ollama-cloud` key. Backend errors are now
   classified: a `WebBackendError` carries the provider error kind and its retry-after.
4. **Caps.** These are counted from `web_requests` per backend: attempts per UTC day and month,
   and for ollama, fetches count too. A capped backend is skipped until the window resets, and
   the status shows when.
   - The ledger now has one row per attempt, with `call_id`, `key_ref`, and `error_kind`.
   - The per-task and per-day budgets count distinct calls and are reserved transactionally on a
     call's first attempt.
   - `Usage.webRequests` counts calls.
   - My own unreleased migration was rewritten in place. It is on no other branch and has never
     been applied outside this worktree's test and demo databases.
5. **Fetch chain.** `web.fetch.backends` defaults to `[builtin, ollama]`. When the built-in fetch
   fails or refuses the content, ollama is tried. A new `SsrfRefusal` error (from `checkWebUrl`,
   `checkHostResolves`, a redirect target, or the connection-time lookup's ESSRF) stops the chain,
   so a refused URL never reaches ollama.
6. **Tools stay on while any backend has a key.** A backend named in the list without a key is
   skipped and gets a doctor warning ("web search backend" checks). The tools are off only when
   `web.enabled` is false or no backend has a key. Doctor's `webChecks` shows each backend's
   state, today's and this month's requests, and caps. It warns when no backend can serve right
   now.
7. **Panel.**
   - Settings "Web search": the enable switch, the backends list, strategy, SearXNG URL, fetch
     chain, roles, and budgets, plus a new "Web search caps" rows editor
     (`web.search.limits` keyed by backend). A status callout shows the pool and any warnings.
   - Provider keys "Web search backends" card: a table of every backend (and the built-in fetch)
     with its state (healthy, cooling until, invalid, out of credits, at its cap until, no key),
     requests today and this month against caps, and each key's state and last error. Key
     management and the add form are unchanged.
   - Task page "Web requests": one row per attempt with the backend and key ref, the error kind
     on failures, and "answered" on the backend that served.
   - The demo seed now has a fake Tavily key and SearXNG: Tavily answers 429 (cooling for 2 h),
     so the call moves on to SearXNG.
8. **Tests.** `tests/web.test.ts` has 32 tests (13 new), which together cover all six points of
   the follow-up's test list:
   - spread rotation and fallback order;
   - 429 with retry-after, 402, 503, and 401 each moving on to the next backend within one call,
     marking the first, counting one budget unit for two attempts, and the next call skipping the
     marked backend;
   - a cooldown honoured by a second Switchyard on the same store, and ending once its wait has
     passed;
   - two vault keys rotating, an invalid key being skipped, and re-enabling it clearing the mark;
   - a per-day cap skipping a backend until UTC midnight;
   - every backend failing giving one clear error, with the next call naming each backend and when
     it is back;
   - the fetch chain going builtin -> ollama on 503 and on PDF content;
   - SSRF refusals (literal, DNS rebinding, redirect, and ollama-only chain) never reaching
     ollama.
   The end-to-end test now pins `web.fetch.backends: [ollama]`, because the default builtin-first
   chain would resolve its fake host for real.
9. **Docs.** `docs/setup.md` (configure and run), `docs/operations.md` ("Web search and fetch",
   rewritten for the pool, health, caps, the chain, and budgets counting calls), and
   `docs/decisions.md` (decisions revised by the user on 2026-10-21, plus departures).

### Commands run and observed results (rework)

- `git merge --no-ff dev -m "Merge dev into feat/web-search"` -> `cb72917`, 11 files changed, no
  conflicts. Stash re-apply -> 1 conflict in `native.ts`, which I resolved.
- `npx vitest run tests/web.test.ts` -> 32 passed. The first run had 3 failures: my wait assertion
  measured from a clock that moves a second per reading. I fixed the assertion to measure from the
  attempt's `finishedAt`; the code was not changed.
- `pnpm -r typecheck` -> exit 0 (router and panel both "Done").
- `pnpm --filter switchyard-router build` -> exit 0.
- `cd packages/router && npx vitest run` -> exit 0, 56 files, 559 tests passed.
- `pnpm -r build` -> exit 0 (the panel reported "Compiled successfully").
- `pnpm --filter switchyard-panel seed:demo` -> "web research (search, then fetch) completed". The
  DB has a tavily attempt (error, rate_limited), a searxng attempt (ok, 2 results) in the same
  call, and a builtin fetch (ok, 441 bytes). `web_backend_state` has tavily:config cooling.
- Demo panel (`next start` on 127.0.0.1:4591 against `.demo`) -> 200 for `/`, `/all/keys`,
  `/all/settings`, the web task page, its session page, and `/api/web-search`. The API reported
  `on: true, spread`, tavily cooling until 04:39Z, searxng healthy, and the other three backends
  unconfigured.
- `/api/config` patch of `web.search.limits` (tavily per_day 30), strategy fallback, and backends
  `[searxng, auto]` -> saved, and the status reflected the new order and cap. I then restored all
  three to their defaults (patched to null).
- Headless Chrome screenshots of the keys card, the settings Web search section and caps editor,
  and the task's Web requests table. I looked at each one; all render as intended.
- I stopped the panel on 4591 and confirmed nothing listens there. 4477 (the user's) was never
  touched and is still listening; `D:\SwitchYard` was never used.

### Not verified (rework)

- Still no live call to any backend (`SWITCHYARD_TEST_OLLAMA_KEY` is not set).
- Whether Tavily, Brave, and Exa send `retry-after` on 429 is not documented on the pages I read.
  Without it the doubling backoff applies.
- How each service phrases a spend or out-of-credits message on 429 is not verified. Detection
  uses the provider classifier's existing patterns.
- Two processes picking a backend at the same moment can both pick the same least recently used
  key, because `touch` is not transactional. Budgets are transactional; caps are checked before
  each attempt and can be passed by in-flight calls.

### Open questions (rework)

- Caps count every attempt, including failed ones (429s usually do not consume a provider
  allowance). This is conservative; the alternative is counting only successes.
- A search key's billing class is stored as `free_tier` and is not used. The plan's open question
  (whether paid search should count toward `paid.budgets`) is still open; the answer here is no.
- `AGENTS.md` and `CLAUDE.md` still need the `web` area added (outside my ownership).
