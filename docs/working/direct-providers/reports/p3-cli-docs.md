# Report: p3-cli-docs

Worker report for brief `p3-cli-docs` (direct-providers plan, phase P3). Worktree `D:/sy-wt/dp`,
branch `feat/direct-providers`. Nothing committed. p3-panel ran in parallel; I did not touch
`apps/panel/**`, `src/admin/**`, or `tests/admin-keys.test.ts`.

## Outcome

Done. The CLI has `keys add|list|test|enable|disable|remove|spend` on the vault and config keys
for every registry, custom, and paid provider. `doctor` checks each provider. `models scan`
prints a text summary. The help text is updated. The example config and presets were reworded
and regenerated. `setup.md`, `operations.md`, `decisions.md`, and `README.md` describe no external
gateway; FreeLLMAPI appears only in clearly marked history and upgrade notes. New test file
`tests/cli-keys.test.ts` has 10 tests. Full suite: 386 tests passed (367 baseline + 10 mine + 9 from
p3-panel's `admin-keys.test.ts`).

## What changed and why

### Files

| File | Change |
| --- | --- |
| `packages/router/src/cli/keys.ts` (new) | `keys` command and its testable functions: `keyRows`, `keyAvailability`, `keyProvider`, `newKeyInput`, `addKey`, `testKeys`, `testSecret`, `testTargets`, `keyTestText`, `keysCommand`. |
| `packages/router/src/cli/doctor.ts` (new) | `doctorChecks`, `providerChecks`, `literalSecretChecks`, `lastListings`, `doctorText`. Reads stored state only and never calls a provider. |
| `packages/router/src/cli/secret-input.ts` (new) | `readHiddenLine`: a raw-mode prompt with no echo, written to stderr. Ctrl+C or Ctrl+D aborts. |
| `packages/router/src/cli.ts` | New flags (`--rpm --rpd --tpm --tpd --quota-group --account-id --test`). `doctor` and `keys` delegate to the new files. `models scan` prints text unless `--json`. |
| `packages/router/src/cli/help.ts` | Tagline. Lines for `doctor` and `models scan`. A new "Provider keys" section replaces "Paid keys". |
| `packages/router/src/cli/operations.ts` | Backup message: "provider keys in the vault need SWITCHYARD_MASTER_KEY" (was "paid keys"). |
| `packages/router/examples/switchyard.config.example.yaml` | Covers how to add keys (panel, `keys add`, config), the built-in list, required billing class, `api_key_env` over literal, google `quota_group` and cloudflare `account_id` examples, and an accurate paid/free comment. |
| `packages/router/examples/presets/*.yaml` | Regenerated with `node scripts/build-presets.mjs`; not hand-edited. |
| `docs/setup.md`, `docs/operations.md`, `docs/decisions.md`, `README.md` | Rewritten; see Docs below. |
| `packages/router/tests/cli-keys.test.ts` (new) | 10 tests. |

`src/mcp.ts` and `scripts/build-presets.mjs` are unchanged. `mcp.ts` has no FreeLLMAPI wording, and
no MCP tool exposes `ScanSummary`. The script needed nothing. `docs/roles.md` does not mention
FreeLLMAPI and is unchanged. No existing test was edited.

### CLI contracts

**`keys add <provider> --billing <class> [--label x] [--rpm n] [--rpd n] [--tpm n] [--tpd n] [--quota-group g] [--account-id id] [--balance usd] [--cap usd] [--test] [--json]`**

- **The secret.** It comes from `SWITCHYARD_NEW_KEY`, or from a hidden prompt when stdin is a TTY, and never from argv. With neither, it is a usage error (exit 1): "set SWITCHYARD_NEW_KEY ... never taken from the command line".
- **The provider.** `<provider>` is any id in `sy.providers.providers()`: a built-in, a custom provider under `providers:`, or a `paid.providers` entry.
  - An unknown id is a usage error that lists the known ids.
  - A `no_key` provider is refused.
- **`--billing`** is **required**. A missing or invalid value is a usage error naming the four classes; the billing class is never guessed.
- **Cloudflare** (`urlParams` includes `account_id`) needs `--account-id` unless `providers.cloudflare.account_id` is set.
- **Validation.**
  - Limits use `countFlag` with a minimum of 1.
  - `--balance` must be >= 0 and `--cap` > 0.
  - Everything is then checked by `NewKeySchema`; its errors are mapped back to flag names.
- **Text output:** `added key vault:<id> for <provider> (...last4), <billing>`, followed by a next-steps line.
- **JSON output:** `{added: PaidKey & {ref}, test: KeyTest | null}`.
- **`--test`.** Lists the models with the new secret first and stores the key only if the listing works. On failure it prints `{added: null, test}` and exits 1.
- **No automatic scan.** `keys add` does not run discovery; it tells you to run `keys test` and then `models scan`. I chose this so a fake key never triggers network calls.

**`keys [list] [provider] [--json]`**

- Lists every credential, config keys first and then vault keys, in declared order.
- JSON output is `KeyRow[]`: `{ref, provider, label, source: vault|config|none, billingClass, enabled, last4, status, until: ISO|null, detail, vaultKeyId, apiKeyEnv}`.
- `status` is one of `available | unusable | invalid | out_of_credits | cooling | exhausted | free_quota | limit`. It comes from `providerHealth(...).keys` with configured limits.
- Text columns: `ref provider label billing key(...last4) status detail`.
- No secret is printed, only `last4`.

**`keys test [provider|<vault id>|<ref>] [--json]`**

- With no argument it tests every key; with a provider id, that provider's keys; with a vault id or ref, that one key.
- Each key's models are listed with `listProviderModels` (timeout 30 s, the same bound as discovery) through `sy.providers.fetch`.
- JSON output is `KeyTest[]`: `{ref, provider, label, last4, ok, models: string[], excluded, pages, skipped, error: {kind, message} | null, cleared}`.
- A 401/403 is recorded with `keys.recordFailure` (the key becomes invalid). A key that was recorded `auth_invalid` and now lists is cleared with `keys.clear`.
- Secrets that a provider echoes in an error message are redacted to `...last4`, both in the output and in the stored `lastError`.
- Nothing is written to the catalog.
- Exits 1 if any key errored. A skipped key (disabled, env var unset) does not fail the command.

**`keys enable|disable|remove <id|vault:id> [--json]`**

- These act on vault keys only. `config:` and `none:` refs are refused with "declared in <config>: change it there".
- `enable` also clears the key's state (`keys.clear`).
- `remove` calls `vault.remove`, which keeps a key that has recorded spend but drops its secret, then `keys.forget`.
- JSON output: `{ref, removed}` or `{ref, enabled}`.

**`keys spend`**: unchanged.

**`models scan [--json]`**

- `--json` prints `ScanSummary` exactly as before.
- Without it, the output is text: `listed N provider(s): a, b; M model(s), K new, U now unavailable`, a line about pending confirmations, and one `error: ...` line per error.
- **Exit-code change:** it exits 1 when nothing was listed and there were errors (no key, for example), and 0 otherwise. Before, it always exited 0.
- It needs no admin token (it never did after P2).

**`doctor [--json]`**

- JSON output is `DoctorCheck[]`: `{check, ok, level: ok|warn|fail, detail}`. `level` is new; `ok` is false only for `fail`. The exit code is 1 if any check is `fail`.
- Checks, in order:
  1. `config`.
  2. `provider keys` (aggregate).
  3. One `provider <id>` check for each provider that has a credential, is under `providers:`, or is under `paid.providers`.
  4. `secrets in config`: a warning listing each `providers.<id>.keys[n]` that holds a literal `api_key`. Only paths are named, never values.
  5. `models`.
  6. `repo <alias>`.
- Each provider check reports:
  - key count and availability by reason, with the earliest "until";
  - invalid, out-of-credits, and unusable keys, named by ref and last four;
  - the last listing result, from the newest `provider_discovery` event that covers the provider (status, models kept), with error messages from the scan that ran it;
  - "N of M stored models active".
- Provider check levels:

  | Level | When |
  | --- | --- |
  | `fail` | No usable key; health `unknown` or `invalid`; or a key for an unconfigured provider. |
  | `warn` | Rate limited; some keys invalid, out of credits, or unusable; never listed; or the last listing failed. A `paid.providers`-only provider with no key is also only a warning. |
  | `ok` | Anything else. A disabled provider is `ok` with the detail "disabled in the config". |

- A `paid.providers`-only provider shows "models from paid.models (not listed)". It counts as paid-only when it is not under `providers:` and either has no built-in definition or its base URL differs from the built-in's; this mirrors `routingProviders`.

### Docs sections rewritten

- **`docs/setup.md`**
  - §2 "Start the panel": init and start the panel, with bash and PowerShell examples and the preset table.
  - §3 "Add provider keys" (new): the panel, the CLI (env var or hidden prompt; a PowerShell one-liner that clears the variable afterwards), and config (`api_key_env`, a `no_key` local server). It also covers the required billing class, the free rules, quota groups and limits, and the master key.
  - §3b "Configure and run": `models scan`, then `doctor`, then `models`.
  - §6 Panel: summary updated.
  - The FreeLLMAPI section, its credentials, `free_platforms`, and the env exports are removed.
- **`docs/operations.md`**
  - Limits table rows updated: no chain verification; key retries are exact, admitted attempts; a new row for configured limits; provider limits are "external, tracked".
  - New "Provider keys" section: rotation, cooldowns, invalid keys, out of credits, limits, health, discovery, replacing a key, secrets and the master key, and upgrading from FreeLLMAPI (marked history).
  - The capacity note "(FreeLLMAPI v0.2.1 reports none)" is removed.
  - The Recovery quarantine line is fixed: `models scan` no longer lifts the quarantine; nothing does.
  - Known limitations rewritten: providers not yet verified live, the list of things to confirm live, and the quarantine that never lifts.
- **`docs/decisions.md`**
  - New section "Direct providers" with D1-D10. These cover the P2 decisions in Current State (health from key state, out of credits disables one key, the free/paid basis, a 429 cools every model of the provider, paid spend keyed by credential ref, chain endpoints deleted) and the CLI.
  - "Provider facts" table from research.md, with sources, plus the list of facts still unconfirmed.
  - "Upgrade notes": `gateway`, `free_platforms`, and `default_output_limit_tokens` fail with a message; chain endpoints are deleted; a models-file entry without a route goes direct; `ScanSummary` fields changed; text and exit code of `models scan`; `doctor` `level`; `--billing` required; per-key cooldown.
  - Departures 1, 3, and 5 now carry 2026-10-20 notes; new item 20.
  - The FreeLLMAPI table moved to the end as "History: verified FreeLLMAPI behaviour". Its consequences are rewritten in the past tense, and it gains a catalog row from Current State.
- **`README.md`**
  - New "Your keys, no other service" bullet.
  - Bullets on paid credits, scanning, and fallback reworded.
  - Layout table descriptions updated.
  - Quick start adds `keys add` and `models scan`.

## Commands run and observed results

- `npx tsc -p tsconfig.json --noEmit` (router, src and tests): no output, exit 0.
- `pnpm -r typecheck`:
  - first run: the panel failed only in p3-panel files (`app/api/keys/*`, `app/paid/page.tsx`: missing `providerKeysView`, `@/lib/paid`, and similar). Their work was in progress against a stale `dist`;
  - final run: `packages/router typecheck: Done` and `apps/panel typecheck: Done`.
- `pnpm build` (router): ok.
- `pnpm -r build`, final run: both packages Done. The panel build listed every route and ended with "Done".
- `npx vitest run tests/cli-keys.test.ts`: 10 passed. One assertion failed on the first run because heuristic-param models are `pending_confirmation`, so 0 were active; I fixed the wording and the assertion.
- `npx vitest run` (full router suite), final run: **39 files passed, 386 tests passed**. The same count was seen on two full runs.
- `grep -rin freellmapi packages/router/src/cli* packages/router/src/mcp.ts packages/router/examples docs/*.md README.md` matches only:
  - `docs/decisions.md`: the intro, D5, upgrade notes, departures 1 and 3, item 20, and the History section;
  - `docs/operations.md` lines 88-91: "Upgrading from a FreeLLMAPI setup (history: ...)".

  All are marked history or upgrade notes.
- **Built CLI by hand.** Temp dir `<scratchpad>/p3cli-run`, deleted afterwards. `brain.path` was changed to `./brain` before anything else ran, so the user's brain was never touched.
  - `init . --preset standalone-free`: wrote `switchyard.config.yaml` and `models.yaml`; the config has no `gateway`.
  - `SWITCHYARD_NEW_KEY=gsk_fake_demo_key_ABCD keys add groq --billing free_tier --label demo --rpm 30`:

    ```
    added key vault:1 for groq (...ABCD), free_tier
    next: switchyard keys test vault:1 (lists the models it can use), then switchyard models scan
    ```

    Exit 0.
  - `keys add groq` without `--billing`: `switchyard: --billing is required: free_tier, paid_credits, paid_postpaid, trial (...)`, exit 1.
  - `keys add groq --billing free_tier` with no env var and stdin `</dev/null`: `switchyard: set SWITCHYARD_NEW_KEY to the secret, or run keys add in an interactive terminal ...`, exit 1.
  - `keys list`:

    ```
    ref      provider  label  billing    key      status  detail
    vault:1  groq      demo   free_tier  ...ABCD  ok
    ```

    `--json` gave one `KeyRow` with `status: "available"`.
  - `doctor`:

    ```
    ok    config         <path>\switchyard.config.yaml
    ok    provider keys  1 usable key: groq
    WARN  provider groq  1 key, 1 available; never listed: run switchyard models scan; 0 of 0 stored models active
    FAIL  models         0 active of 0: run switchyard models scan once a key is added
    FAIL  repo app       <scratchpad>\my-app
    ```

    Exit 1. The preset's example repo path does not exist, and no scan was run.
  - **A local custom provider** at `http://127.0.0.1:9/v1` (offline) with a literal key:
    - `keys test offline` printed `offline key 1 (config:offline:literal:0, ...WXYZ): FAILED transport: cannot reach offline: fetch failed`, exit 1;
    - `doctor` then added `WARN secrets in config ... holds a literal api_key at providers.offline.keys[0]: use api_key_env, or move the key to the encrypted vault (switchyard keys add)`.
  - `keys remove 1` removed the vault key. `keys remove config:offline:literal:0` was refused ("declared in ...: change it there"), exit 1.
  - `--help` shows the new Provider keys section.
  - `grep -rl gsk_fake_demo_key_ABCD` over the temp dir found nothing: the secret is not stored in plaintext.

## Not verified

- **No live provider.** I made no network calls. `keys test` and `keys add --test` against real Groq or OpenRouter were not run. `models scan` was not run by hand, because a scan fetches the public OpenRouter catalog and Hugging Face from the real network.
- **The hidden prompt** (`readHiddenLine`) was not exercised: there is no TTY in this environment, and Git Bash/mintty stdin is not a TTY. Only the non-TTY refusal is tested.
- **The setup text describes the panel's Provider keys page** (pick provider, paste, Test, billing class, limits). That page is p3-panel's work; I did not check the doc against the final panel.
- **The doc claim that a running worker and panel must restart to see a changed env var** comes from reading the code: `ProviderCredentials` reads `process.env` of the running process. It was not tested.
- **The `models scan` exit code of 1** when nothing is listed is covered by no automated test. It was read from the code only.

## Open questions or contradictions found

1. **Two key-test implementations.** p3-panel added `src/admin/provider-keys.ts` (`testProviderKey` and others), and I added `src/cli/keys.ts` `testKeys` and `testSecret`. Both call `listProviderModels`, record auth failures, clear an invalid mark on success, and redact echoed secrets. They were written in parallel without a shared API. The supervisor may want the CLI to call the admin functions, or both to call one function in `src/providers/`, so their behaviour cannot drift.
2. **`ProviderKeys.recordFailure` stores `err.message` as `lastError` unredacted.** A provider that echoes the key would put it in `provider_key_state`. The CLI redacts before recording. The gate's direct path and discovery do not; I did not check what p3-panel does on its side. A redaction inside `recordFailure`, or in the client's error construction, would cover every caller. It is outside my paths.
3. **Discovery records no auth failures on keys.** `discoverModels` only reports listing errors. So a key that 401s during a scan stays `available`, and doctor shows the failure only as "last listing FAILED". It does not mark the key invalid. Recording it there would make the key INVALID in `keys list` too.
4. **The `provider_discovery` event stores only error counts**, not messages. Doctor takes the messages from the scan that wrapped the run. A discovery run outside a scan (`sy.discover()` from the panel after adding a key) shows the count only.
