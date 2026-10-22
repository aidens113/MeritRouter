# Prompt caching and conversation continuity

Status: Active
Status detail: C1 and C2 done and merged 2026-10-21; live checks against providers outstanding.
Created: 2026-10-20
Last updated: 2026-10-21
Owner: Senior supervisor agent
Scope: Use provider prompt caching, keep a conversation on one model while it is healthy, price cached tokens correctly, recover from truncated responses, and compact context without breaking the cached prefix.
Paired document: none
Related: [direct providers](./direct-providers.md), [projects](./projects.md), [decisions](../decisions.md)

---

## Current State

**Findings (code investigation 2026-10-20; file:line in the ledger entry):**
- No provider is asked to cache: no Anthropic `cache_control`, no OpenAI `prompt_cache_key`, no
  Gemini context caching. Only providers' automatic prefix caching can apply.
- The agent loop is mostly prefix-stable: tools and system/user prompts are built once, turns only
  append, no timestamps. Breaks: `compact()` rewrites old tool outputs in place to an elision stub
  before any request once over budget; the final turn switches `tool_choice` to `required`.
- `cachedInputTokens` is recorded per request, per session, per task, and summed in usage, and
  (2026-10-21) `uncachedInputTokens` (new input) beside it; the panel's token figures are new
  input plus output. Cost still uses only input and output prices; `cacheHit` is hard-coded
  `false`.
- Requests are non-streaming; a failed request is retried whole on the next key, then the next
  endpoint (up to `routing.max_endpoint_fallbacks` free plus `paid.max_paid_attempts` paid). There
  is no partial output to hand over.
- Every turn re-ranks from candidate 0: no stickiness, so cache reuse depends on the top candidate
  staying the same.
- `finish_reason: length` is ignored: the truncated message is kept and the loop continues.
- Context budget is the smallest limit among the first `max_endpoint_fallbacks` candidates, fixed
  at run start; too-small endpoints are skipped, never truncated; compaction elides tool outputs
  only.
- Deferred tasks resume from the session log on whatever model the new plan picks (works).

**Done (2026-10-21, merged as 61fc7ca):** C1 and C2 (see `reports/caching-c1-c2.md`): cache hints
per provider (`promptCache`; Anthropic `cache_control` on the last tool, system prompt, and
newest message; `prompt_cache_key` = task id for OpenAI and OpenRouter), endpoint stickiness
(`routing.sticky_endpoints`; never paid ahead of free), cached-input pricing with provenance,
truncation recovery, prefix-stable compaction (`harness/compaction.ts`), and the panel's cached
share and saving.

**Accounting update 2026-10-22:** roadmap checkpointec92e74 separately persists cache-creation
tokens, prices configured writes and reserves the maximum input rate. Unknown write pricing
and native server search disable paid Anthropic cache markers at the wire boundary. Unexpected
writes quarantine the endpoint and retain a finite uncertain reservation. Supervisor independently
passed27 focused tests; integrated full acceptance remains in roadmap-completion.md.

**Not verified:** live providers honouring the breakpoints and cache key; the saving figure with real
cached prices. Note: the input budget follows the serving model's context, so on a 1M-context
model compaction rarely runs and requests grow (cheap where the provider caches).

**Next steps:** a live check on a provider that reports cache use (Ollama Cloud does).

**Blockers:** none.

---

## Design

- **Provider caching.** Anthropic: `cache_control: {type: "ephemeral"}` breakpoints on the tools,
  the system prompt, and the most recent stable message (at most four, per Anthropic's docs; verify
  the current limit and minimum cacheable length before coding). OpenAI-compatible: send
  `prompt_cache_key` (a stable per-conversation id) only where the registry marks support. Gemini:
  rely on implicit caching through the OpenAI endpoint; explicit context caching stays out.
- **Stickiness.** A run remembers the endpoint that served its last turn and tries it first while
  it is healthy and still eligible (key usable, breaker closed, context fits); otherwise the normal
  order applies. Recorded per session so a resumed task prefers it too.
- **Pricing.** Catalog prices gain optional `cachedInputUsdPerMillion` (from discovery, e.g. the
  OpenRouter catalog, or user override); estimated and settled cost price cached tokens at it;
  `cacheHit` is set from `cachedInputTokens > 0`. The panel shows the cached share and the saving.
- **Truncation.** On `finish_reason: length` with no tool calls: one continuation request on the
  same endpoint ("continue exactly where you stopped"), then concatenate; for a truncated tool call
  (unparseable arguments): retry the turn once with a larger `max_tokens` where the endpoint
  allows, otherwise the next endpoint. Bounded and counted against the task budget.
- **Prefix-stable compaction.** Elide in large batches at most once per N turns (not every turn),
  replacing a contiguous run of old tool outputs with one summary message, so the prefix changes
  rarely; the budget is recomputed for the serving endpoint.

---

## Phases

| Phase | Deliverable | Acceptance |
| --- | --- | --- |
| C1 | Provider caching hints, stickiness, cached pricing and `cacheHit` | Fake-provider tests: Anthropic body carries breakpoints; a healthy previous endpoint is reused, an unhealthy one is not; cached tokens priced at the cached rate |
| C2 | Truncation recovery, prefix-stable compaction, panel cache display | Tests for continuation and truncated tool calls; compaction changes the prefix at most once per N turns |

---

## Worker Briefs

### Brief: caching-c1-c2
- Repository: this repository. Work in your own git worktree on branch `feat/caching`; run
  `pnpm install --frozen-lockfile` there first. Two other workers edit other files at the same time.
- Task: implement C1 then C2 exactly as `## Design` and `## Phases` describe: provider cache
  hints (Anthropic `cache_control` breakpoints; verify Anthropic's current breakpoint limit and
  minimum cacheable length from its docs and record them in `docs/decisions.md`;
  OpenAI-compatible `prompt_cache_key` only where the registry marks support), endpoint
  stickiness per session, cached-input pricing (`cachedInputUsdPerMillion` from discovery or an
  override; cost and paid spend use it; `cacheHit` from `cachedInputTokens > 0`), truncation
  recovery, prefix-stable compaction, and the panel's cache display (cached share and saving).
  Usage already carries `cachedInputTokens` and `uncachedInputTokens` (2026-10-21); build on them.
- Facts: Ollama Cloud reports `prompt_tokens_details.cached_tokens` (90% cached on a live
  supervisor job). Never hard-code prices; keep provenance as elsewhere in the catalog.
- Required reads: this document; `AGENTS.md` Code Structure; the files named in the 2026-10-20 ledger.
- Owns: `packages/router/src/{providers,harness,gateway,models,admission,paid,sessions,routing,core,config}/**`,
  `packages/router/src/storage/{usage,migrations}.ts` (append migrations only),
  `packages/router/tests/**` (new files, or tests of the areas above),
  `apps/panel/components/{requests-table,requests-view,task-detail,session-timeline}.tsx`,
  `apps/panel/app/all/models/**`, `docs/decisions.md`, `docs/working/reports/caching-c1-c2.md`.
- Must not touch: `packages/router/src/{mcp.ts,cli.ts,cli/**,operations/**,admin/projects.ts,projects/**}`,
  `apps/panel/next.config.ts`, the panel shell, projects and settings pages, `docs/setup.md`,
  `docs/operations.md` (put text for them in your report), this document's Current State and ledger.
- Definition of done: the Phases acceptance tests exist and pass; `pnpm -r typecheck`; full
  `npx vitest run` in packages/router; `pnpm -r build`. Never use the user's config, brain, or
  port 4477; for a panel check use the demo (`seed:demo`) on a spare port and stop it afterwards.
- Report to: docs/working/reports/caching-c1-c2.md

---

## Work Ledger

### 2026-10-20 — Plan written
- Agent: supervisor (investigation by an Explore agent)
- Changed: this document; `docs/working/README.md`.
- Why: user asked how caching and mid-output model switching work.
- Validation: not validated (design only). Evidence: `providers/anthropic.ts:49-65,83-98`,
  `providers/openai-compatible.ts:31-49,73-74`, `harness/loop.ts:47-52,65-67,89-99,117-118`,
  `gateway/gate.ts:276-320`, `gateway/direct.ts:30,134-151,206-221`, `routing/select.ts:286-294`,
  `storage/usage.ts:84`, `core/disposition.ts:41-79`, `sessions/resume.ts:145-311`.
- Outcome: Accepted
- Follow-up: user go-ahead; C1.

### 2026-10-21 — C1 and C2 implemented
- Agent: worker caching-c1-c2; supervisor review and merge
- Changed: see the report and the merge commit 61fc7ca; supervisor added setup and operations text,
  `routing.sticky_endpoints` in the example config, and regenerated the presets.
- Why: user asked to implement every unfinished plan.
- Validation: worker: 16 caching tests, `pnpm -r build`, demo panel on 4593. Supervisor: reviewed
  gate stickiness and loop recovery; merged dev `npx vitest run` `Tests 524 passed (524)`, both
  packages typecheck.
- Outcome: Accepted

---

## Open Questions

- None blocking.
