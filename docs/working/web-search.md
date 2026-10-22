# Web search and fetch for agents

Status: Active
Status detail: Plan written 2026-10-21 at the user's request; W1 dispatched.
Created: 2026-10-21
Last updated: 2026-10-21
Owner: Senior supervisor agent
Scope: Give SwitchYard's agents (supervisor and workers) web search and page fetching, with
pluggable backends, code-enforced budgets, SSRF protection, and results treated as untrusted data.
Paired document: none
Related: [live-validation](./live-validation.md), [direct-providers](./direct-providers.md), [decisions](../decisions.md)

---

## Current State

**Findings (2026-10-21):** no agent has any web access today: harness tools are repository reading
and editing, artifacts, brain, channel, delegation, and checks (see `src/harness/`). Facts checked
on 2026-10-21:
- Ollama: `POST https://ollama.com/api/web_search` `{query, max_results (default 5, max 10)}` returns
  `{results: [{title, url, content}]}`; `POST https://ollama.com/api/web_fetch` `{url}` returns
  `{title, content, links}`; both `Authorization: Bearer <Ollama key>`; a free account suffices;
  no documented rate limits (https://docs.ollama.com/capabilities/web-search). The user's install
  has an Ollama Cloud key, so this backend costs nothing extra there.
- Other backends with free allowances (third-party summary, verify each API before coding):
  Tavily (1,000 credits/month), Brave ($5 credit/month, attribution required), Exa (monthly free
  credit); SearXNG is self-hosted with no key.

**Next steps:** W1 (worker web-search-w1), then W2.

**Blockers:** none.

---

## Decisions (recommended defaults; the user may override)

- **D1. Backends are pluggable**, chosen by `web.search.backend: auto | ollama | tavily | brave |
  exa | searxng | none`. `auto` picks the first usable: an `ollama-cloud` key (vault or config),
  then a configured key for tavily, brave, or exa, then a `searxng` base URL. Keys for the
  search-only services are entered like provider keys (panel Provider keys page, `keys add`,
  or `api_key_env`), marked as search services, never routed for chat.
- **D2. Fetch** uses Ollama `web_fetch` when that backend is available, else a built-in fetch:
  http(s) only; every hostname resolved and refused when any address is loopback, private,
  link-local, unique-local, or cloud metadata (SSRF), re-checked on each redirect (at most 5);
  15 s timeout; 2 MB cap; HTML reduced to readable text without new heavy dependencies.
- **D3. Tools** `web_search(query, max_results <= 10)` and `web_fetch(url)` for the roles listed in
  `web.roles` (default: supervisor, analyst, reviewer, implementer, inspector). Summarize tasks
  have no tools. Large pages are stored as an artifact and returned as an excerpt plus the ref.
- **D4. Budgets in code:** `web.max_requests_per_task` (default 12) and `web.max_requests_per_day`
  (default 300, install-wide), checked before each call; refusals are tool errors the model sees.
  Each call is recorded (event and the session's tool journal) and counted in task usage
  (`webRequests`).
- **D5. Untrusted content:** results and pages are returned inside a clearly marked data block
  stating they are untrusted web content, not instructions; never placed in system prompts.
- **D6. Off unless a backend is usable:** with `backend: auto` and nothing usable, the tools are not
  offered (no failing tool in the list); `doctor` and the panel say how to enable web search.
- **D7. Not in the MCP server:** Claude Code, Codex, and ChatGPT have their own web search.

---

## Phases

| Phase | Deliverable | Acceptance |
| --- | --- | --- |
| W1 | Router: config `web` section, backends (ollama, tavily, brave, exa, searxng), built-in fetch with SSRF guard, tools for the configured roles, budgets, usage and events, doctor check | Fake-HTTP tests per backend; SSRF refusals (127.0.0.1, 10.x, 169.254.169.254, a redirect to a private address); budgets enforced; tools absent without a backend; a worker task using web_search end to end with a scripted model |
| W2 | Panel and docs: Settings "Web search" section, search-service keys on the keys page, web calls in the session timeline and task usage, setup/operations docs | Demo panel pages 200 and screenshots; docs describe backends, limits, and safety |

---

## Worker Briefs

### Brief: web-search-w1
- Repository: this repository; your own worktree on branch `feat/web-search`; run
  `pnpm install --frozen-lockfile` first.
- Task: Phase W1 and W2 as `## Decisions` and `## Phases` describe. Verify each search API's
  request and response from its official documentation before coding it, record what you
  verified (URL, date) in `docs/decisions.md`, and put backends in a new area file such as
  `src/web/` (per AGENTS.md Code Structure, a new area for a new concern). Tools go through the
  harness like other tools (journaled, budgets enforced by code). Never print or log keys.
- Required reads: this document; `AGENTS.md`; `src/harness/tools.ts`, `src/runners/*.ts`,
  `src/providers/credentials.ts`, `src/config/schema.ts`.
- Owns: `packages/router/src/**`, `packages/router/tests/**`, `packages/router/examples/**`
  (regenerate presets with the script), `apps/panel/**`, `docs/setup.md`, `docs/operations.md`,
  `docs/decisions.md`, `docs/working/reports/web-search-w1.md`.
- Must not touch: this document; other working documents.
- Live check: allowed once, read-only, with the user's install untouched: one `web_search` and one
  `web_fetch` against Ollama using a temp config that reads the key from the env var
  `SWITCHYARD_TEST_OLLAMA_KEY` if the supervisor sets it; otherwise skip and say so.
- Definition of done: the acceptance tests of W1 and W2; `pnpm -r typecheck`; full router suite;
  `pnpm -r build`; demo panel on a spare port (never 4477 or the user's config) with screenshots;
  panel stopped afterwards.
- Report to: docs/working/reports/web-search-w1.md

---

## Work Ledger

### 2026-10-21 — Plan written
- Agent: supervisor
- Changed: this document; `docs/working/README.md`.
- Why: user asked for web search as a feature.
- Validation: not validated (design only). Evidence: Ollama web search docs fetched 2026-10-21;
  harness tool list in `src/harness/tools.ts`, `src/harness/supervisor-tools.ts`.
- Outcome: Accepted
- Follow-up: W1/W2 by worker web-search-w1.

---

## Open Questions

- Should paid search backends (beyond their free allowance) count toward `paid.budgets`? Default
  here: no; they are capped only by `web.max_requests_per_day`.
