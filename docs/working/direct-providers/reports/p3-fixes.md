# p3-fixes report

Worker: p3-fixes. Worktree `D:/sy-wt/dp`, branch `feat/direct-providers`. Nothing was committed.

## Outcome

**Partial.** Items 1 to 5 are done and tested. Item 6 is not done: its cause is in
`src/gateway/gate.ts` and `src/paid/catalog.ts`, and this brief does not own either file. The
diagnosis and a proposed fix are below.

Checks: `pnpm -r typecheck` passes, `pnpm -r build` passes, and `npx vitest run` passes with
394 tests (the baseline was 386; this work adds 8).

## What changed and why

### 1. Secrets are masked where provider errors are made

- **Cause.** `requestJson` put provider bodies and network-error text into `ProviderError`
  messages as they were. A provider that echoed the key, or a network error that quoted a
  `?key=` URL, therefore leaked the secret. `ProviderKeys.recordFailure` then stored it as
  `last_error`. Errors found inside HTTP 200 bodies (`errorInOkBody`) are built after the
  transport returns, so the transport could never mask them.
- **Fix.**
  - New file `src/providers/secret-masking.ts`:
    - `requestSecrets(headers, url)` collects the secrets in a request. It takes the values of
      credential headers (any header whose name matches auth, api-key, token, secret, signature
      or password), both the whole value and the part after a scheme such as `Bearer `. It also
      takes credential query parameters (`key`, `api_key`, `access_token`, `token`, and similar).
    - `maskSecrets(text, secrets)` masks each secret, raw and URL-encoded, longest first. A
      secret of 8 or more characters becomes `...WXYZ` (its last four). One of 4 to 7
      characters becomes `[redacted]`. Shorter values are ignored.
    - `maskProviderError` rebuilds the error with the masked message. It builds a new error
      rather than editing the old one, so `stack` does not keep the secret.
  - `requestJson` (`transport.ts`) now wraps its attempt and masks every `ProviderError` it
    throws, using the secrets of that request.
  - `ProviderClient.complete` (`client.ts`) masks `credential.apiKey` from every
    `ProviderError`. This covers the HTTP 200 error bodies.
  - The CLI's own `redact` and the admin's `redact` are removed (see item 3).
- **Tests** (`tests/providers-client.test.ts`, describe "secrets in provider errors"):
  - A 401 body that echoes the bearer key, sent straight through `requestJson`.
  - A transport error whose message quotes a `?key=` URL, both raw and URL-encoded.
  - A 401 through the client.
  - An HTTP 200 OpenRouter error body that echoes the key.
  - All four errors are then passed to `ProviderKeys.recordFailure`. Neither `lastError` nor
    the raw `provider_key_state.last_error` column contains a secret.
  - A unit test for `requestSecrets` and `maskSecrets`.
  - The existing CLI tests also confirm the new form: `...9999` in output and
    `Invalid API Key: ...0000` in stored state.

### 2. A key that fails during a discovery listing is recorded on the key

- **Cause.** `discoverModels` only added listing failures to its report. A revoked key stayed
  `available`.
- **Fix.**
  - `DiscoveryOptions.onKeyFailure(credential, err)` is called for failures that say the key
    itself is unusable. These are decided by a new `isKeyFailure(err)` in `errors.ts`:
    `auth_invalid` (401/403) and `out_of_credits` (402, or a spend-cap 429).
  - `runProviderDiscovery` wires the callback to `runtime.keys.recordFailure`.
  - Server errors, timeouts and rate limits during a listing are still not recorded on the key.
- **Tests.**
  - In `tests/providers-routing.test.ts`, a scan with a revoked key that echoes the secret:
    - leaves the key `auth_invalid`, with its `lastError` masked;
    - makes the provider's health `invalid`;
    - a later 500 leaves the other key alone;
    - a 402 marks that key `out_of_credits`.
  - `tests/providers-discovery.test.ts`: the callback receives the rejected credential.
  - `tests/cli-keys.test.ts`, doctor test: updated for the intended change. After `sy.scan()`,
    cerebras's only key is now recorded as invalid, so doctor reports the provider as
    **fail** (it was warn) with `1 invalid`.

### 3. One shared key-test function

- **Cause.** The panel and the CLI were written in parallel. Each had its own copy of the same
  steps: list models, record auth failures, clear an invalid mark, and redact secrets.
- **Fix.**
  - New file `src/providers/key-test.ts`. `testKeyListing(runtime, target, {timeoutMs})` takes
    either `{credential}` (a stored key) or `{provider, secret, accountId}` (a pasted key).
  - It returns `{provider, ref, ok, skipped, listing, error, cleared, durationMs}` and never
    throws for a provider failure.
  - For a stored key:
    - it skips the test when the key is unusable or its provider is not configured, and makes
      no request;
    - when the provider reports the key unusable (`isKeyFailure`), it calls `recordFailure`;
    - when the listing succeeds and the key was recorded `auth_invalid`, it clears that mark.
  - A pasted key changes no stored state.
  - `keyTestTimeoutMs(request_timeout_seconds)` gives the timeout: 30 s, or the configured
    request timeout if that is shorter.
  - In `src/admin/provider-keys.ts`, `testProviderKey` now uses it and keeps only the free and
    usable mapping of the models.
  - In `src/cli/keys.ts`, `testKeys` and `testSecret` now use it through a small `keyTest`
    mapper. `listWith`, `redact`, `failure` and `LIST_TIMEOUT_MS` are gone.
- **Small behaviour changes, for both surfaces:**
  - A 402 (out of credits) during a key test is now recorded on a stored key, the same as in
    discovery. Before, only 401/403 was recorded.
  - The CLI's timeout is now the smaller of 30 s and the configured request timeout. Before, it
    was a fixed 30 s.
  - The panel's message for a stored key whose provider is not configured now starts with
    `this key cannot be used: `.
  - Masked secrets now appear as `...last4` in the panel too. Before, the panel showed `••••`.
- **Tests.** The existing `tests/admin-keys.test.ts` and `tests/cli-keys.test.ts` key-test
  cases pass unchanged. That covers redaction, the invalid mark being recorded and then
  cleared, skipped keys making no call, and `--test` not storing a bad key.

### 4. `lastError` in health is reported only while it is still current

- **Cause.** `providerHealth` reported the newest recorded error even when a later success on
  the same key had resolved it. `recordSuccess` does not clear `last_error`.
- **Fix.**
  - `currentError(state)` in `src/providers/health.ts` returns the error only when there is no
    later success on that key (`lastSuccessAt >= lastErrorAt` counts as resolved).
  - `providerHealth` reports the newest current error.
  - In the admin view, `errorCurrent` is now `currentError(state) !== null` instead of its own
    copy of the comparison.
  - `lastError`, `lastErrorAt` and `lastSuccessAt` stay on the key view. The panel uses them for
    "Recovered since its last error" (`apps/panel/components/client/provider-keys.tsx:382-390`).
- **Tests.**
  - `tests/providers-limits.test.ts`: the error is reported, then cleared once the same key
    succeeds (the history stays in key state). A newer error on key A is still reported after
    key B succeeds.
  - `tests/admin-keys.test.ts`: `sy.providers.statuses()` shows the 429 while cooling, and
    `lastError: null` once healthy.
  - The panel typechecks and builds.

### 5. A `base_url` override also moves absolute registry URLs

- **Cause.** `applyEntry` replaced `baseUrl` but kept `models.url`. Google, Cohere and
  Cloudflare have absolute model-list URLs that are not under `{base}`. I checked every
  registry URL: `keyInfoUrl` exists only for OpenRouter and is `{base}/key`, so these three
  list URLs are the only absolute ones.
- **Fix.**
  - `rebaseUrl(template, defaultBase, override)` in `registry.ts` leaves `{base}` templates
    alone.
  - Otherwise, when the override ends in the default base's path, it treats the part before
    that path as the new root and appends the template's own path and query. This is the case
    for a proxy or gateway in front of the same API, such as a Cloudflare AI Gateway URL ending
    in `/v1beta/openai`.
  - When a template parameter in that path (`{account_id}`) is filled with a literal in the
    override, the same literal is used in the moved URL.
  - When the override does not end in the default path, the template's path goes on the
    override's origin.
  - `models_path` still sets the list path exactly.
  - `applyEntry` applies `rebaseUrl` to `models.url` and to `keyInfoUrl`, and only when
    `base_url` is set.
- **Tests** (`tests/providers-discovery.test.ts`, describe "base_url overrides"):
  - The defaults are unchanged without an override.
  - Google moves through a gateway, moves to the origin when the override's path differs, and
    `models_path` still wins. A discovery run through the gateway never calls
    `generativelanguage.googleapis.com`.
  - Cohere moves, even though its default list is on a different host from its chat URL.
  - Cloudflare moves with `{account_id}` kept as a template, and with a literal account id. A
    discovery run of both reaches neither `api.cohere.com` nor `api.cloudflare.com`.
  - OpenRouter's `{base}` URLs are untouched.
  - An absolute key-info URL moves the same way.

### 6. A provider under `paid.providers` appears twice in health: NOT FIXED

- **Cause** (traced, not changed):
  - `ProviderRuntime.statuses()` (`src/providers/runtime.ts:115-126`) deliberately emits a copy
    of each paid provider's status under `paid:<name>`.
  - The copy exists because configured paid endpoints get `providerId: "paid:<provider>"` in
    `src/paid/catalog.ts:56`.
  - `ProviderHealth` (`src/gateway/gate.ts:51-135`) keys four things on that platform string:
    its status map, `lookup()` (used by routing in `routing/router.ts:59,98` and
    `admin/insights.ts:192,334`), `observeCooldown`, and `snapshot()`.
  - `snapshot()` is the list the panel overview and health page show (`admin/insights.ts:81,117`).
  - So the duplicate is how paid endpoints get key-derived health.
  - If the copy is removed only in `runtime.ts` or `service.ts`, `lookup("paid:x")` returns
    nothing. Paid endpoints would then lose invalid or cooling ordering, and their slots would
    stop halving on cooldowns.
  - Any correct fix touches `src/gateway/gate.ts` (or `src/paid/catalog.ts`), and this brief
    does not own either.
- **Proposed fix** (needs `src/gateway/gate.ts` added to the owned paths):
  - Give `ProviderHealth` an optional `statusPlatform(platform) => string` resolver. Use it in
    `status()`, and when observing cooldowns, also for the aliases.
  - Add `ProviderRuntime.statusPlatform(p)`, mapping `paid:<name>` to `<name>` when `<name>` is
    under `paid.providers`.
  - Drop the `flatMap` copy in `statuses()`.
  - In `service.ts`, pass `(p) => this.providers.statusPlatform(p)`.
  - Breakers and slots stay per platform.
- **Alternative.** Make paid endpoints use the provider name as `providerId` in
  `src/paid/catalog.ts`. This is wider: it changes breaker and slot records keyed `paid:x`,
  `modelCounts` in `provider-keys.ts`, the models-page filter value, and the paid tests that
  read `providerId`.

## Commands run and observed results

- `npx tsc --noEmit -p .` in `packages/router`: no output (pass).
- `npx vitest run` on the six owned test files: one failure first, the doctor cerebras level.
  This was the intended item-2 change; I updated the test. After that, all owned files passed:
  client 19, discovery 28, limits, routing, admin and cli-keys.
- `pnpm -r typecheck`: `packages/router typecheck: Done`, `apps/panel typecheck: Done`.
- `pnpm -r build`: the router and the panel built (`apps/panel build: Done`).
- `cd packages/router && npx vitest run`: **39 files, 394 tests passed**, with no flaky timing
  failure in this run.
- Line endings: `file` reports `providers-limits.test.ts` and `health.ts` as CRLF throughout
  and every other edited file as LF. The edits were written in each file's existing ending.

## Not verified

- Live providers. Real error texts and real proxy or gateway URL layouts (for example a
  Cloudflare AI Gateway in front of Google) are assumptions checked only against fakes.
- The panel was not started or screenshotted. It typechecks and builds, and its key view still
  carries `errorCurrent`, `lastError`, `lastErrorAt` and `lastSuccessAt`.
- Item 6: no code changed.
- Secrets in non-credential custom headers whose names match none of auth, api-key, token,
  secret, signature or password are not masked.

## Open questions or contradictions found

1. Item 6 needs `src/gateway/gate.ts` (or `src/paid/catalog.ts`) in a brief; see the proposed
   fix above.
2. `recordSuccess` still never clears `last_error`. It is kept on purpose as history, which the
   panel shows as "Recovered since". `currentError` is now the single rule for whether that
   error is current.
3. A successful key test clears only `auth_invalid` and does not call `recordSuccess`. A listing
   can work on a key that has no credits or is rate-limited, so recording success there would
   be wrong. As a result, after a key test that clears the mark, the panel still shows the old
   error as current until a real request succeeds.

## Item 6 (follow-up dispatch, 2026-10-20)

The coordinator committed items 1 to 5 (fd407a3), then gave this worker `src/gateway/gate.ts`,
`src/providers/runtime.ts` and `src/core/service.ts` so it could implement the fix proposed
above. **Outcome: Done.**

### Cause

- `ProviderRuntime.statuses()` emitted a `paid:<name>` copy of every `paid.providers` status.
  Configured paid endpoints have `providerId: "paid:<provider>"` (`src/paid/catalog.ts`, which
  is unchanged).
- `ProviderHealth` looked up key-derived status, and observed cooldowns, under that exact
  platform name. The copy was the only way paid endpoints got their provider's health.
- The panel overview and health page show `ProviderHealth.snapshot()`, so each paid provider
  appeared twice.

### Fix

- **`src/gateway/gate.ts`.** `ProviderHealth` takes a third, optional constructor argument,
  `statusPlatform(platform) => string`.
  - `status(platform)` reads the status of `statusPlatform(platform)`, so `lookup()` and the
    cooling check in `recordOutcome()` both go through it.
  - Each platform name that reads another provider's status is remembered as an alias.
  - On every refresh, a cooling provider's cooldown is passed to `capacity.observeCooldown`
    under the provider id and under each alias. The first time an alias is seen, it catches up
    on a cooldown already in progress. `observeCooldown` is idempotent per `resumeAt`.
  - Breakers, slots, and `recordOutcome` throttling stay keyed on the platform name as given.
  - Without a resolver, behaviour is unchanged (`tests/team-capacity.test.ts` builds a
    `ProviderHealth` with no resolver).
- **`src/providers/runtime.ts`.**
  - `statuses()` returns `providerStatuses(...)` directly: one entry per provider, no copy.
  - New `statusPlatform(platform)`: `paid:<name>` maps to `<name>` when `<name>` is a
    `paid.providers` entry, and every other name maps to itself.
- **`src/core/service.ts`.** It passes `(platform) => this.providers.statusPlatform(platform)` to
  `ProviderHealth`.

### Test

New test in `tests/providers-routing.test.ts`, describe "health of a paid.providers provider". It
sets up two paid providers, `acme` and `beta`, each with one model and one vault key, and uses
policy `preferred`:

- **Healthy.** `sy.health.snapshot()` has exactly one acme entry, `platform: "acme"`, and
  `statuses()` has no `paid:` platforms. The paid order is `[paid:acme/acme-large,
  paid:beta/beta-large]`.
- **acme's only key cooling (429, 60 s).**
  - The snapshot still has one acme entry, now `rate_limited`.
  - `lookup("paid:acme")` is `rate_limited`.
  - The paid order becomes `[beta, acme]`, and acme's explanation has `coolingDownUntil` set.
  - `capacity.record("paid:acme").cooldownResumeAt` is set, so the paid platform's slots were
    halved.
- **acme's key invalid (401).** `lookup("paid:acme")` is `invalid`, and the snapshot has one acme
  entry, `invalid`.

A note on "pushes back": `planRoute` ranks paid against free by policy before it looks at
cooling. So a cooling paid endpoint moves behind other paid endpoints and is marked
`coolingDownUntil`, but it does not move behind free models under `preferred`. An `invalid`
status is not used in ordering at all. It reaches the gate, where key selection skips the
invalid key. Both of these were the same before this change.

### Commands run and observed results

- `npx vitest run tests/providers-routing.test.ts`: 13 passed.
  - A first version of the test expected a cooling paid endpoint to move behind the free model.
    It failed because paid rank is decided first (see above), so the test now compares two paid
    providers instead.
- `pnpm -r typecheck`: `packages/router typecheck: Done`, `apps/panel typecheck: Done`.
- `pnpm -r build`: `packages/router build: Done`, `apps/panel build: Done`.
- `cd packages/router && npx vitest run`: **39 files, 395 tests passed**, with no flaky timing
  failure in this run.

### Not verified

- The panel overview was not rendered. `snapshot()` now has one entry per provider, but no
  screenshot was taken.
- Breaker records for `paid:<name>` still exist and still show separately on the health page's
  breaker list. That is by design: breakers stay per platform name.
- I did not run the new test against the old code to watch it fail. By inspection, the old
  runtime's `paid:acme` copy would fail the first assertion (one acme entry).
