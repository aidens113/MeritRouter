# Report: p1-limits

Worker report for brief `p1-limits` (direct-providers plan, phase P1). Worktree `D:/sy-wt/dp`,
branch `feat/direct-providers`. Nothing committed.

## Outcome

Done. Per-key state, round-robin key selection, sliding-window limits, the OpenRouter free
daily quota probe, and `ProviderStatus` health derivation exist under `src/providers/`, backed
by one new migration. `pnpm -r typecheck` passes. The full router suite passes: 359 tests in 36
files, which includes p1-discovery's file. With only my file added it was 335 in 35 files
(323 baseline plus my 12).

## What changed and why

| File | Change |
| --- | --- |
| `packages/router/src/storage/migrations.ts` | Appended one migration after the `paid_keys` columns migration. It adds two tables. `provider_key_state` is keyed on the credential ref: `provider, last4, cooldown_until, disabled_reason ('auth_invalid'\|'out_of_credits'), disabled_at, consecutive_failures, last_error, last_error_at, last_success_at, rate_limits_json, quota_json, selected_seq, updated_at`. `provider_usage` (`scope, at, tokens, reservation`) is indexed on `(scope, at)`, on `at`, and on `reservation`. No applied migration was edited. |
| `packages/router/src/providers/keys.ts` | New. `ProviderKeys`: per-key state, `recordSuccess`/`recordFailure`/`recordQuota`, availability, round-robin `select`. |
| `packages/router/src/providers/limits.ts` | New. `ProviderLimits`: store-backed sliding windows for `rpm/rpd/tpm/tpd` over provider, key, quota-group, and model scopes. Also the scope builder and the OpenRouter `/key` quota probe. |
| `packages/router/src/providers/health.ts` | New. `providerHealth` / `providerStatuses` derive a `ProviderStatus` (from `gateway/types.ts`) from key state. |
| `packages/router/src/providers/index.ts` | My three export lines only, after `export * from "./vault.js"`. p1-discovery's lines were added separately. |
| `packages/router/tests/providers-limits.test.ts` | New. 12 tests. |

## Exported API for P2 to wire

### keys.ts

- `new ProviderKeys(db: Db, now = Date.now)`. `now` is public and is the clock every cooldown and window is judged by.
- **Reading state:**
  - `get(ref): KeyState | null`
  - `states(refs): Map<ref, KeyState>`
  - `list(provider?): KeyState[]`
- **Recording outcomes:**
  - `recordSuccess(key: KeyRef, snapshot: RateLimitSnapshot | null = null)` clears failures, the cooldown, and any disable, and stores the snapshot.
  - `recordFailure(key: KeyRef, err: ProviderError)` acts on `err.reason`:
    - `rate_limited`: the cooldown is `retryAfterMs`, else `cooldownMs(err.rateLimits)`, else 30 s doubling per consecutive failure (capped at 15 min). It never shortens an existing cooldown.
    - `auth_invalid`: disables the key until `clear(ref)`, a success, or a changed secret.
    - `out_of_credits`: disables the key; it is retried after `OUT_OF_CREDITS_RECHECK_MS` (6 h).
    - `server`/`timeout`/`transport`: only increment `consecutiveFailures` and set `lastError`.
    - `bad_request`, `unknown_model`, `policy`, `aborted`: ignored, because they say nothing about the key.
  - `recordQuota(key, FreeDailyQuota)`
  - `clear(ref)`
  - `forget(ref)`
- `KeyRef = string | Pick<ProviderCredential, "ref"|"provider"|"last4">`. Pass the credential where you can: that records `provider` (needed by `list(provider)`) and `last4` (needed for changed-secret detection).
- `availability(provider, cred, state, opts & {siblings?}) → KeyAvailability & { scopes, check }`
- **`select(provider: ResolvedProvider, credentials: ProviderCredential[], opts: KeySelectOptions): KeySelection`**
  - Runs in one IMMEDIATE transaction.
  - Order: the least recently chosen key first (`selected_seq`), then declared order.
  - It skips a key that is any of: unusable, excluded, auth-invalid, out of credits (within the recheck), cooling, exhausted by its last snapshot, out of free quota (only when `freeQuota`), or over a configured limit (only when `limits` is given).
  - With `limits` and `reserve` (default true), the request is recorded on the chosen key's scopes atomically.
  - On success it returns `{ credential, scopes, reservation, blocked }`.
  - When no key is available it returns `{ credential: null, scopes: null, reservation: null, blocked, resumeAt }`. `resumeAt` is the earliest `until` among non-excluded keys, or null when none is known.
- `KeySelectOptions = { estimatedTokens?, exclude?: Iterable<ref>, model?, modelLimits?: Partial<KeyLimits>|null, freeQuota?, limits?: ProviderLimits, reserve? }`
- **Retry loop for P2:** call `select`; on a 429, call `recordFailure(cred, err)`, then `limits.release(reservation)` (or keep it), then `select` again with `exclude` grown. Leave the selection to fall through to the next endpoint when `credential === null`.
- `snapshotBlockedUntil(snapshot, tokens, now)` is exported, along with the constants `DEFAULT_COOLDOWN_MS`, `MAX_DEFAULT_COOLDOWN_MS`, and `OUT_OF_CREDITS_RECHECK_MS`.

### limits.ts

- `new ProviderLimits(db, now = Date.now)`:
  - `check(scopes, tokens = 0): LimitCheck`
  - `reserve(scopes, tokens = 0): ReserveResult` is an atomic check plus insert. It prunes rows older than a day.
  - `settle(reservation|id, actualTokens)`
  - `release(reservation|id)`
  - `usage(scopeId): {requestsMinute, requestsDay, tokensMinute, tokensDay}`
- `limitScopes(provider, cred, {siblings?, model?, modelLimits?}): LimitScope[]` builds three kinds of scope:
  - `provider:<id>`, carrying `provider.limits`.
  - Either `group:<provider>:<group>`, carrying the tightest limits declared by any member (it needs `siblings`), or `key:<ref>`, carrying `cred.limits`.
  - `model:<unit>:<model>` when `model` is given. It carries the model's stored `rateLimits`, and `<unit>` is the group or key scope id.
- `quotaUnit`, `quotaGroupOf`, `tightestLimits`, `hasLimits`, `MINUTE_MS`, `DAY_MS`.
- `LimitCheck = { ok, blocked: LimitBlock[], resumeAt }`. `LimitBlock = { scope, metric, limit, used, resumeAt|null }`, where null means the request never fits (it is larger than the limit).
- `probeFreeDailyQuota({ provider, credential: RequestCredential, fetch?, now?, timeoutMs?, signal? }): Promise<FreeDailyQuota | null>`
  - It sends `GET` to the provider's `keyInfoUrl` through `requestJson`.
  - The response is parsed with zod: `data.free_model_daily_requests {used, limit, remaining}`.
  - It returns null when the quota is not reported.
  - It throws a classified `ProviderError` on HTTP failure, and an `Error` when the provider has no `keyInfoUrl`.
  - `FreeDailyQuota = { used, limit, remaining, resetAt: next 00:00 UTC, checkedAt }`. The helper `nextUtcMidnight` is exported.

### health.ts

- `providerHealth(provider, credentials, keys: ProviderKeys, { limits? }): { status: ProviderStatus, keys: KeyAvailability[] }`
- `providerStatuses(providers, credentials, keys, { limits? }): ProviderStatus[]` covers every provider that has a credential.
- How the status is decided:
  - `healthy`: any key is available.
  - `invalid`: every usable key is `auth_invalid` or `out_of_credits`.
  - `rate_limited`: anything else that blocks every key. `resumeAt` is the earliest return among the non-disabled keys, or null if any is unknown.
  - `unknown`: there is no usable credential, or the provider is disabled.
- `keys` is the number of usable credentials.
- `requestsRemainingPct` is the sum of remaining over the sum of limits, across keys, taking each key's tightest current `requests` window.
- `lastError` is the most recent `lastError` among the keys.

## Decisions made where research.md and the plan were silent

1. **Provider-level limits are one shared window over all of the provider's keys.** They are not a default applied to each key; per-key limits do that job. The plan says "per provider or key", and I read "per provider" literally.
2. **Quota groups.** A key's group is its own `quota_group`, else the provider's. The group's limits are the per-metric minimum declared by any member. The group window counts every member's requests. The key scope is replaced by the group scope, so a grouped key has no separate per-key window.
3. **Per-model limits are per quota unit (key or group) and model,** not global per model. Free-tier limits are per key or project.
4. **Usage is recorded on every scope of a reservation, limited or not,** so a limit added later sees recent history. It costs up to 3 rows per request, and rows are pruned after 24 h.
5. **Windows are sliding, not calendar-aligned.** `rpd` is the last 24 h. This includes OpenRouter, whose free quota resets at 00:00 UTC; that reset is modelled only through the probe's `resetAt`.
6. **A token check with an unknown estimate (0) still needs 1 token of headroom.**
7. **The 429 cooldown when the provider names no wait** is 30 s, doubling with consecutive failures, capped at 15 min.
8. **Out of credits** is a disable that is rechecked after 6 h, because credits can be topped up and Anthropic's spend cap is monthly. Auth failures stay disabled until `clear`, a success, or a changed secret. A changed secret under the same ref (an env var edited) is detected by comparing `last4`.
9. **Snapshot windows without a reset time** are assumed to last one period from when they were observed. A period of `unknown` counts as a minute.
10. **The free daily quota applies only when the caller passes `freeQuota: true`** (an OpenRouter `:free` model). Paid models on the same key are not blocked by it.
11. **Round-robin uses a per-key `selected_seq` stored in the database,** so rotation is shared across processes and restarts. A newly added key goes first.

## Commands run and observed results

- `npx tsc -p tsconfig.json --noEmit` (router): no output (pass).
- `npx vitest run tests/providers-limits.test.ts`: the first run had 11 passed and 1 failed. The failure was a test bug: it read `blocked[0]` where the order is the rotation order. After the fix, **12 passed**.
- `pnpm -r typecheck` at the repo root: router Done, panel Done.
- `npx vitest run` in `packages/router` (full suite):
  - First run: 35 files, **335 passed**. p1-discovery's test file was not yet in that run.
  - Re-run after p1-discovery's files appeared: 36 files, **359 passed**, and typecheck still Done.
- The tests cover:
  - **Rotation:** round-robin order; a 429 cools the key and the next key is chosen; `exclude`; cooldown expiry with the injected clock.
  - **Cooldown length:** taken from the snapshot reset, else the doubling default; all keys cooling gives `resumeAt`.
  - **Headroom and disables:** exhausted-snapshot headroom against the token estimate; auth-invalid disable, the changed-secret re-enable, and `clear`; the out-of-credits recheck; ignored failure kinds.
  - **Configured limits:** per-key rpm sliding window; provider rpd across keys; a quota group sharing the tightest member limit; tpm with settle, release, and too-large requests; per-model rpm scope.
  - **Persistence:** key state, windows, and rotation survive a closed and reopened store.
  - **OpenRouter probe:** URL and auth header, remaining computed, record, the `freeQuota` block and its reset; not reported gives null; 401 gives `auth_invalid`; a provider with no endpoint throws.
  - **Health derivation:** healthy, `requestsRemainingPct`, `rate_limited` with `resumeAt` and `lastError`, invalid, unknown, a configured-limit block, and `providerStatuses`.

## Not verified

- No live provider was called. The OpenRouter `/api/v1/key` response shape comes only from research.md (`free_model_daily_requests {used, limit, remaining}`), and the fake fetch is built from that, not from a real response.
- Concurrency across multiple processes was not exercised. `select`/`reserve` use BEGIN IMMEDIATE, but no two-process test was run.
- `pnpm -r build` and the panel build were not run. dist/ was not rebuilt; I added no CLI or MCP surface.
- The migration was applied only to fresh test databases, not to an upgraded existing store.
- Nothing is wired into Gate, breakers, or `ProviderCapacity` yet; that is P2.

## Open questions or contradictions found

- **Provider-level limit semantics** (decision 1) and **quota-group limits** (decision 2) are my choice. The config schema has no group-level limit fields. If the user means "provider limits are a per-key default", only `limitScopes` changes.
- **`ProviderHealth` in `gateway/gate.ts` consumes `InferenceClient.providers()`.** P2 must decide whether the direct client's `providers()` calls `providerStatuses`, or whether `ProviderHealth.lookup` reads key state directly. Cooldowns now live per key, so a provider-wide "cooling" means every key is cooling.
- **Out-of-credits keys count as "invalid" in `ProviderStatus`.** `gate.ts` `countsAsProviderFailure` treats `pool_exhausted` specially; P2 should check that the mapping still makes sense.
- **`providers/index.ts` is shared.** p1-discovery's export block was appended after mine; there are no conflicts.
