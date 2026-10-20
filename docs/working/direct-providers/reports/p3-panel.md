# Report: p3-panel (direct providers, phase P3)

Worker: p3-panel. Worktree `D:/sy-wt/dp` (branch `feat/direct-providers`). Nothing committed.

## Outcome

Done. The Provider keys page now works on SwitchYard's own vault and config keys. It covers:

- adding keys for every registry provider, plus custom providers;
- testing a key;
- billing class and limits;
- per-key status;
- models found per provider.

The Paid routes page is folded into Provider keys, and `/paid` redirects there. The FreeLLMAPI leftovers on the panel side are gone. The demo seed is fully offline: I pressed Scan and saw no outbound connection. The health-badge mismatch was traced to its cause and fixed in the view layer.

Checks:
- typecheck: clean.
- builds: clean.
- tests: 386 pass (baseline 367, plus 9 in `admin-keys.test.ts` and 10 in the parallel worker's `cli-keys.test.ts`).

## What changed and why

### Router (`packages/router/src/admin/**`, one new test)

- **`src/admin/provider-keys.ts`** (new): the page's data access, re-exported from `insights.ts`.
  - `providerKeysView(sy)`: covers every registry provider, every custom provider from config, every `paid.providers` entry, and any provider that still has keys but is no longer configured (`kind: "missing"`). Each provider entry carries:
    - its keys, with status, origin, and spend;
    - health from key state;
    - model counts from the catalog.
  - `providerKeyView(sy, ref)`.
  - `addProviderKey(sy, NewKey)`: replaces `addPaidKey`. It accepts any registry, custom, or paid provider, and refuses:
    - unknown providers;
    - `no_key` providers;
    - Cloudflare without an account id (on the key or the provider).
  - `updateProviderKey(sy, id, KeyPatch)`: replaces `updatePaidKey`. It refuses removed keys. A new secret, or `enabled: true`, clears the recorded disable or cooldown (`keys.clear`).
  - `removeProviderKey(sy, id)`: replaces `removePaidKey`. It also calls `keys.forget` for the key.
  - `testProviderKey(sy, {ref} | {provider, secret, accountId, billingClass})`:
    - calls `listProviderModels` through `sy.providers.fetch` (never from the browser);
    - marks each model free or not with `freeStatus`, and excludes models the key cannot use;
    - redacts the secret from provider messages;
    - records `auth_invalid` on a stored key, and clears an `auth_invalid` state when the key lists successfully;
    - never sends a chat request;
    - makes no call at all for an unusable credential (for example, an env var that is not set).
  - `scanProviderModels(sy, id)`: runs `sy.discover({only:[id]})`. It refuses providers that are paid-only (`paid.providers` only), disabled, or keyless.
  - `addCustomProvider` / `removeCustomProvider`: write or delete `providers.<id>` through `patchConfig`, which validates and keeps a `.bak`. Removal needs no live keys. Ids that clash with built-in or paid providers are refused. Only http(s) base URLs are accepted.
  - `paidSummary` moved here and no longer returns the vault key list.
- **`src/admin/config-edit.ts`** (new): `readConfigText`, `validateConfigText`, `writeConfigText`, and `patchConfig` moved here verbatim from `insights.ts` and are re-exported, so `insights.*` is unchanged. This avoids an import cycle: `provider-keys.ts` needs `patchConfig`, and `insights.ts` re-exports `provider-keys.ts`.
- **`src/admin/insights.ts`**:
  - `Overview` lost `gatewayConfigured` and `adminConfigured` and gained `usableKeys: number`.
  - The attention text now points at the Provider keys page.
  - There is a new attention item: "N provider key(s) are invalid or out of credits".
  - The paid key functions are removed (replaced above).
  - The file shrank from 660 to 605 lines.
- **`tests/admin-keys.test.ts`** (new, 9 tests, fake fetch). It covers:
  - the view, including config-key origin, no secret in the JSON, and ordering;
  - cooling versus resolved errors;
  - adding keys for registry, custom, and paid providers, plus the refusals;
  - edit, enable, and secret replacement clearing a disable, and removal;
  - a pasted-key test, including excluding non-chat models and checking which key was sent;
  - redaction, invalid recording, and clearing;
  - no network call for an unusable key;
  - custom provider add, scan, and remove;
  - overview `usableKeys` and the invalid-key attention item.

  No existing test needed editing.

### Panel (`apps/panel/**`)

- **`app/keys/page.tsx`** (rewritten), with **`components/client/provider-keys.tsx`** (new) and **`lib/key-schemas.ts`** (new zod bodies):
  - **Add a key.** The provider picker groups built-in, custom, and paid providers, with "Add a custom provider…" at the end. You enter:
    - the API key (password field, cleared after submit);
    - the billing class (required);
    - an optional label;
    - the account id, shown only when the provider needs one;
    - optionally, rpm/rpd/tpm/tpd and a quota group;
    - for keys that are not free tier, a monthly cap and prepaid balance;
    - an optional expiry.

    "Test key" lists the models a pasted key can use before you save it.
  - **Custom provider form**: id, name, base URL, API style, "takes no key", and an optional models path.
  - **One card per provider** that has keys or is configured. It shows:
    - kind and health badges;
    - a one-line summary of what the keys can do now;
    - the base URL;
    - "N models found · M routable · F free", linked to `/models?platform=<id>`;
    - "Find models" (scan this provider);
    - "Remove provider" for an empty custom provider.
  - **Each key row** shows:
    - label, last four characters, and source. Config keys show their origin, such as `providers.groq.keys[0]` plus env var or literal, and are marked "read-only (config)";
    - billing class and limits;
    - for keys that are not free tier: spend over 30 days, cap left, and balance left;
    - the status badge: Healthy, Cooling down · back in X, At a limit, Invalid key, Out of credits · recheck, Disabled, Removed, or Not usable plus the reason;
    - a Test button.

    Vault keys also have an enable switch, edit (including secret replacement), and remove.
  - **Paid spend card**: master switch, tier policies, the 24h/7d/30d spend against budgets, and spend by model, with a link to Settings for policy and budgets.
- **`app/paid/page.tsx`**: now just `permanentRedirect("/keys#paid")`. The "Paid routes" nav entry is removed (`shell.tsx`).
- **Deleted**:
  - `components/client/keys.tsx`
  - `components/client/paid.tsx`
  - `lib/keys.ts`
  - `lib/paid.ts`
  - `app/api/keys/[id]/billing/route.ts`
  - `app/api/paid/keys/route.ts`
  - `app/api/paid/keys/[id]/route.ts`
- **FreeLLMAPI and dead features removed**:
  - `app/page.tsx`: the provider-health description, the empty state (now uses `usableKeys`), and "The gateway is configured".
  - `app/models/detail/page.tsx`: "Available in FreeLLMAPI" and the Chain row are replaced by "Reachable" (help term `available`) and "Sent to".
  - `components/client/models-table.tsx`: the Chain column became "Reachable"; the empty state is new; it takes an `initialPlatform` prop from `?platform=`.
  - `lib/models.ts`:
    - `chain`, `chainDetail`, and `chainState` are gone;
    - added `available`, `routeProvider`, `keyedProviders`, and `reachable`;
    - "Reachable" means available *and* the route provider has a usable key, because manual entries are `available: true` even when no key exists.
  - `lib/glossary.ts`:
    - `chain` is replaced by `available`;
    - `quarantine`, `freeVerified` (it cited `free_platforms`), `quotaScope`, `billingClass`, and `outputDefault` (it cited the removed `default_output_limit_tokens`) are reworded.
  - `app/qualification/page.tsx`: "through FreeLLMAPI" is gone.
  - `lib/settings-schema.ts`: the `respect_provider_cooldowns` help, the allocation description, the paid section description, and the providers description.
  - `app/settings/page.tsx`: "Paid routes page" now reads "Provider keys page".
  - The output-limit "default" tooltip (table and detail) no longer mentions a configured default.
- **`scripts/seed-demo.mjs`**:
  - New header comment.
  - Every built-in demo provider has `base_url: http://127.0.0.1:9/<id>/v1`.
  - google also gets `models_path: /models`; see Open questions 1.
  - A custom keyless `lab` provider was added.
  - `paid.providers.anthropic.base_url` is now `http://127.0.0.1:9/anthropic`.
  - `discovery.openrouter_models_url` and `huggingface_api_url` point at `127.0.0.1:9`.
  - The scripted 429 messages no longer claim "all keys cooling down".
  - The retired `github/openai/gpt-4.1` endpoint is now `openai/gpt-4.1`, and the pricing source `free_platforms` is now `demo`.
  - At the end, it adds a fake revoked groq vault key recorded as `auth_invalid`, and puts the cerebras key in a 45-minute cooldown, so the page shows those states.
  - The seed finishes with no warnings.
- **`apps/panel/README.md`**: the FreeLLMAPI and Paid routes text is replaced.

## API routes and their shapes

All routes return `{ ok: true, ... }` or `{ ok: false, error, errors? }`, with 400 for validation, 404 for unknown, and 503 when not configured. No response contains a secret, only `last4`.

| Route | Body (zod, `lib/key-schemas.ts`) | Response |
| --- | --- | --- |
| `GET /api/keys` | none | `{ view: ProviderKeysView }`: `{ generatedAt, configPath, billingClasses, providers: ProviderKeysEntry[], usableKeys, lastDiscoveryAt }` |
| `POST /api/keys` | `AddKeyBody` (below) | `{ key: ProviderKeyView }` |
| `PATCH /api/keys/[id]` (vault id) | `KeyPatchBody` (below); empty is refused | `{ key: ProviderKeyView }` |
| `DELETE /api/keys/[id]` | none | `{ removed, keptForHistory }` |
| `POST /api/keys/test` | `{ ref }` or `{ provider, secret, accountId?, billingClass? }` | `{ result: KeyTestResult }` (below) |
| `POST /api/keys/scan` | `{ provider }` | `{ scan: { provider, status, kept, added, errors, warnings } }` |
| `POST /api/keys/providers` | `{ id, displayName?, baseUrl, api?, noKey?, modelsPath? }` | `{ provider: { id } }` |
| `DELETE /api/keys/providers/[id]` | none | `{ removed }` |

Field lists for the longer shapes:

- **`AddKeyBody`**:
  - required: `provider`, `secret`, `billingClass`;
  - optional: `label`, `accountId`, `quotaGroup`, `rpm`, `rpd`, `tpm`, `tpd`, `monthlyCapUsd`, `prepaidBalanceUsd`, `expiresAt`.
- **`KeyPatchBody`**: the same fields, all optional, minus `provider`, plus `enabled`.
- **`KeyTestResult`**: `{ ok, provider, ref, models: [{ id, displayName, contextLimitTokens, free, freeReason }], excluded, pages, error: { kind, message } | null, durationMs }`.

`ProviderKeyView` fields:

- identity: `ref`, `provider`, `source`, `origin`, `secretSource`, `editable`, `vaultKeyId`, `label`;
- key settings: `billingClass`, `enabled`, `last4`, `accountId`, `quotaGroup`, `limits`;
- state: `status`, `statusDetail`, `until`;
- errors: `lastError`, `lastErrorAt`, `lastSuccessAt`, `errorCurrent`;
- vault details: `createdAt`, `expiresAt`;
- money: `monthlyCapUsd`, `prepaidBalanceUsd`, `spent30dUsd`, `remainingCapUsd`, `remainingBalanceUsd`.

`/api/scan` is unchanged.

## Health-badge cause

Reproduced on the P2 demo store. Every cooldown had long expired, so "healthy" was correct:

- cerebras and groq: last error 152 minutes ago, last success 72 to 78 minutes ago;
- nvidia: last error 1022 minutes ago, last success 92 minutes ago.

The text beside the badge was the problem:

- `ProviderKeys.recordSuccess` does not clear `last_error`.
- `providerHealth` in `src/providers/health.ts` reports the newest recorded `lastError` whether or not a later success resolved it.
- The P2 keys page rendered `ProviderStatus.lastError` as the card description, with no time.
- The demo's scripted error text itself said "all keys cooling down".

Fix, in my area:

- The admin view gives each key `errorCurrent` (last error newer than last success).
- The provider summary is computed from current per-key availability and never uses a stale error.
- The panel shows a past error only as "Recovered since its last error X ago", with details on hover. It never shows a stale error beside "Healthy".
- The seed's scripted messages no longer claim "all keys cooling down".
- The overview already shows `lastError` only as the tooltip of non-healthy badges.

Not changed, outside my paths: `ProviderStatus.lastError` in `src/providers/health.ts` is still sticky. A one-line filter would make it mean "unresolved": keep only states whose `lastErrorAt > (lastSuccessAt ?? -1)`. That would protect CLI and MCP readers too. See Open questions 2.

## Commands run and observed results

- `pnpm -r typecheck`: router and panel `Done`, no errors (final run after all edits).
- `pnpm -r build`: router `tsc` clean; panel `next build` "Compiled successfully". The route list includes `/api/keys/providers`, `/api/keys/providers/[id]`, `/api/keys/scan`, `/api/keys/test`, `/keys`, and `/paid`.
- `cd packages/router && npx vitest run` (final): **39 files, 386 tests passed**. `tests/admin-keys.test.ts` alone: 9 passed.
- `pnpm seed:demo`: exit 0; `grep -ci warn` on the log returned 0. Final reseed after the API checks: exit 0, 0 warnings. The demo is left freshly seeded.
- **Scan offline check.** I started the panel (`next start -p 4595`, demo config) with a `NODE_OPTIONS --require` preload that logs every `fetch` URL and every `net.Socket.connect` target, then ran `POST /api/scan`:
  - **First run (before the google fix): it caught a real leak.** The demo google key's model list went to `https://generativelanguage.googleapis.com/v1beta/models`, logged as `connect generativelanguage.googleapis.com:443`; Google answered HTTP 400 "API key not valid". The registry's Google model-list URL is absolute and ignores a `base_url` override. I fixed it in the seed with `models_path: /models` and reseeded.
  - **Second run (after the fix):** every fetch went to `http://127.0.0.1:9/...`: openrouter-catalog, groq ×2, google, nvidia, openrouter, cerebras, lab, and openrouter `/key`. `grep -v 127.0.0.1` printed "NO NON-LOCAL CONNECTIONS". Port 9 refused the connection, which I checked beforehand with `net.connect` (ECONNREFUSED).
  - The API checks below also made only local calls: groq and cerebras test, openrouter-catalog, probe.
- **Pages, all 200**: `/`, `/keys`, `/models`, `/models?platform=groq`, `/models/detail?id=groq/openai/gpt-oss-120b`, `/models/detail?id=openai/gpt-4.1`, `/settings`, `/qualification`. `/paid` returns 308 to `/keys#paid`.
- **API checks against the demo** (all observed as described):
  - `GET /api/keys`: 200, and the secret strings appear 0 times (`grep -c 'NOT-A-REAL|REVOKED-NOT|PREPAID-FAKE'`). Statuses: anthropic healthy/healthy, cerebras rate_limited/cooling, groq healthy/(healthy, invalid), and the rest healthy.
  - `POST /api/keys/test` with a pasted groq key: `ok:false`, `transport: cannot reach groq` (offline, as intended). With `ref config:cerebras:literal:0`: same. With `{provider}` only: 400.
  - `POST /api/keys` for mistral, trial: returned the key with `last4 "QQQQ"` and `rpm 5`. Without a billing class: 400 "choose a billing class". Unknown provider: 400 listing the built-ins.
  - `PATCH` disable plus `tpd`: 200. Empty `{}`: 400 "nothing to change". `/api/keys/abc`: 400.
  - `DELETE`: 200 `{removed:4, keptForHistory:false}`; again: 404.
  - `POST /api/keys/providers` with probe (no key): 200. `POST /api/keys/scan` with probe: 200, `status failed` (offline). `DELETE /api/keys/providers/probe`: 200.
  - `POST /api/keys/scan` with cohere: 400 "Cohere has no usable key".
  - The rendered `/keys` HTML lists all 13 registry providers plus "Add a custom provider…".
- **Screenshots** (headless Chrome), all looked at. Directory: `C:/Users/mrjoh/AppData/Local/Temp/claude/d--SwitchYardRouter/f513290c-d4c1-4d44-81c0-be35d4674ab1/scratchpad/`.
  - `p3panel-keys.png`: /keys with keys, after the status-text fix. The Cerebras card and key both show "Cooling down · back in 43 minutes". The revoked groq key shows "Invalid key", and the groq summary reads "1 of 2 keys ready; 1 invalid".
  - `p3panel-keys-empty.png`: /keys against a throwaway config with no keys, showing the "Add your first provider key" callout, the add form, and the paid card. The temp config was deleted afterwards.
  - `p3panel-overview.png`: provider health shows cerebras "Rate limited · resumes in 45 minutes", the rest Healthy, and the new attention item "1 provider key(s) are invalid or out of credits".
  - `p3panel-models.png`: "Reachable" column; no Chain column.
  - `p3panel-model-detail.png`: "Reachable" and "Sent to" rows; no FreeLLMAPI text.
  - `p3panel-keys-600.png`: a 600 px viewport lays out cleanly.

  The first keys screenshot also showed a bug, which I fixed: an invalid or cooling key whose error equals its status detail was labelled "Recovered since its last error". It now shows nothing extra when the error is current.
- The panel was stopped after each session; no listener on 4595 remains (`Get-NetTCPConnection` count 0).

## Not verified

- **Client-side interactions in a real browser.** I verified the API routes behind them, the server-rendered HTML, and the screenshots, but did not click through:
  - picking Cloudflare to reveal the account id field;
  - the custom provider form;
  - Test result rendering with models (only the failure path was reachable offline);
  - the edit form;
  - the enable switch;
  - two-step remove.
- A successful key test or Find models against a real provider (no real keys; never attempted).
- Headless Chrome will not render below roughly 500 px (the existing `/settings` clips the same way), so phone width was checked only at 600 px.
- `/api/keys` GET was checked for secrets on the demo only. The no-secret JSON test covers a literal config key and vault keys.
- The parallel `cli-keys.test.ts` passed in my runs. I did not review the other worker's files.

## Open questions or contradictions found

1. **A built-in provider's `base_url` override does not move its model list when the registry list URL is absolute.** This affects Google (`https://generativelanguage.googleapis.com/v1beta/models`), Cohere, and Cloudflare. A user who points google at a proxy or region still has discovery and key tests call Google directly. The demo works around it with `models_path`. A registry or `applyEntry` change in `src/providers` would fix it; that is not in my paths.
2. **`ProviderStatus.lastError` is sticky** (`src/providers/health.ts`; see Health-badge cause). The panel no longer shows it beside a healthy badge. CLI and MCP output that prints `lastError` next to status would show the same mismatch. Suggested fix: filter it to errors newer than the key's last success.
3. **`ProviderRuntime.statuses()` reports a `paid.providers` provider twice** (`anthropic` and `paid:anthropic`, as seen on the overview). This is pre-existing and harmless, but the overview list duplicates it.
4. **A pasted-key Test, or a key added for a provider with no demo `base_url`, still calls the real provider.** This applies to providers the demo does not configure (cohere, mistral, and so on). That is the intended behaviour for a key the user pastes; the demo's own providers, Scan, and enrichment stay offline.
5. **Upgrade note for the supervisor: the panel API changed.**
   - `/api/paid/keys*` and `/api/keys/[id]/billing` are gone.
   - Use `/api/keys*`. `Overview` lost `gatewayConfigured` and `adminConfigured` and gained `usableKeys`.
   - `insights.addPaidKey`, `updatePaidKey`, and `removePaidKey` are replaced by `addProviderKey`, `updateProviderKey`, and `removeProviderKey`.
   - `paidSummary` no longer returns `keys`.
