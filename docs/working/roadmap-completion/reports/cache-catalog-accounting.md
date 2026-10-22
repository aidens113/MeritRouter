# Cache/catalog accounting worker report

Status: complete in isolated worktree; ready for supervisor integration and independent verification. No commits or pushes.

## Policy and sources

Supervisor approved narrow ownership of providers/anthropic.ts, providers/enrich.ts, providers/discovery.ts conversion, and gateway/direct.ts in addition to written brief.

No guessed cache-write multiplier. Configured paid.models.cache_write_input_usd_per_million becomes catalog write price/provenance. Paid Anthropic requests with unknown write price disable prompt caching at the emitted-wire boundary. Paid native-server-search requests also disable caching even with a write price: internal growing prompts do not have a defensible original-input-only reservation bound. Configured normal prompt writes reserve the maximum ordinary/read/write input rate with existing input-estimation safety margin. Provider-reported cost remains authoritative.

Official contract: https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-use-with-prompt-caching lines 125–130 says automatic server-tool caching only occurs when at least one cache_control marker is present; no-marker requests receive no automatic breakpoint. https://platform.claude.com/docs/en/build-with-claude/prompt-caching documents separate ordinary/cache creation/cache read counters. Prices are configuration, never copied from changing documentation.

## Changes

- Catalog preserves provider parameter evidence/source, reported quantization, trained maximum context and effective-context detail. Rounded provider labels retain heuristic confidence; exact weight counts retain exact provider provenance.
- Anthropic normalization retains nullable cache-creation counter separately while total input includes ordinary/read/creation. Invalid counters remain unknown; explicit zero remains zero.
- Session response usage supports optional-null creation counter, preserving older logs. Admission persists nullable creation tokens into existing supplied migration.
- Paid computed settlement prices ordinary/read/creation subsets separately. Unknown positive creation price is a nonfinite internal pricing signal; admission never persists that signal. It retains the finite reservation as uncertain, records an accounting incident, and the Gate discards and quarantines responses reporting creation after caching was disabled.
- Existing config schema and migrations untouched; no core, harness, runner, CLI, panel, public export or shared-document changes.

## Verification

- Frozen offline pnpm install passed (4m35s, 219 cached packages). Expected missing dist CLI shim warnings before router build.
- Router typecheck passed.
- Five focused suites initially passed 79 tests: cache-creation, caching, paid, providers-discovery, providers-coverage. Added explicit provider-reported-cost authority test afterward; intermediate cache-creation suite passed 6/6. Added catalog-schema JSON roundtrip assertion afterward; final providers-coverage suite passed 20/20. Those checks observed 80 distinct focused tests passing before the unexpected-write incident regression below.
- New tests inspect actual Gate-to-fake-fetch Anthropic request bodies with tools, system, and messages present. Unknown write price emits no cache_control; configured price emits markers; configured-price server search emits its server tool and no cache_control. Creation/read/ordinary counters persist separately and configured settlement/reservation are checked numerically. Legacy missing creation persists NULL and legacy log usage parses without inventing a value.
- Explicit corrected authoritative provider-cost reconciliation overrides computed creation/read/ordinary arithmetic.
- Local Ollama and llama.cpp tests confirm exact provider provenance, trained max versus effective context, quantization and catalog JSON/schema roundtrip retention.
- git diff --check passed (line-ending normalization warnings only).
- Initial attempted typecheck and vitest preceded completed install and failed due missing node/vitest dependencies; final checks above passed after installation.

## Limits

No live calls, quota, full build, publication, user configuration or data. Reservation input tokenization remains the established estimate plus safety margin, not an exact tokenizer proof. Paid caching with native server search is conservatively disabled. Creation usage on other API shapes is not invented.

## Integration inventory

Source: admission/admission.ts; gateway/direct.ts and types.ts; models/catalog.ts and params.ts; paid/catalog.ts and spend.ts; providers/anthropic.ts, discovery.ts conversion and enrich.ts; sessions/events.ts. Tests: new cache-creation.test.ts and updated providers-coverage.test.ts. Own report only under docs. No config schema, migration, CLI, core, panel or shared document changes.

Supervisor requested an end-to-end nonfinite-settlement audit before freeze. Actual native SQLite stores REAL Infinity; JSON.stringify renders it null; Zod number rejects it. Prevented that escape: unexpected creation after the disabled-cache wire becomes an existing policy_violation, response discarded and endpoint quarantined. Nonfinite computed settlement retains only the finite reservation with uncertain cost_basis, preserving charge evidence without claiming to know the premium. Finite authoritative provider cost still wins. Existing quarantine acknowledgement/latest-incident implementation is unchanged. New regression verifies finite retained spend, uncertain basis, persisted creation count, discarded endpoint attribution, and persistent quarantine reason. This is safety retention, not a full computed unknown premium; the real charge remains unknown pending reconciliation.

Final post-incident verification: cache-creation (7), paid (10), execution (15) all passed together (32 tests); router typecheck passed again. Execution covers model policy violation task completion/failure and quarantine acknowledgement followed by a later new incident. Across six focused suites, 96 distinct tests were observed passing. No full build or whole-suite claim.
