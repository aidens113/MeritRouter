# Prompt caching and conversation continuity

Status: Active
Status detail: Plan written 2026-10-20 from a code investigation; not started.
Created: 2026-10-20
Last updated: 2026-10-20
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
- `cachedInputTokens` is recorded per request, per session, per task, and summed in usage, but
  cost uses only input and output prices; `cacheHit` is hard-coded `false`.
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

**Next steps:** after the user's go-ahead, C1 then C2 (C1 and the projects work J1 touch
different files except `src/harness/loop.ts`; schedule C1's loop changes after J1 merges).

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

---

## Open Questions

- None blocking.
