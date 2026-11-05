# Routing models with unpublished parameter counts
Status: Complete
Status detail: Implemented, validated, refreshed live metadata and verified successful live Gemini coding requests. Project delivery continues separately.
Created: 2026-11-05
Last updated: 2026-11-05
Owner: Senior supervisor agent
Scope: Preserve truthful metadata while routing verified hosted models with unpublished sizes.
Paired document: none
Related: [operations](../operations.md), [decisions](../decisions.md)

## Current State

Discovery now exempts verified official native Google Gemini entries with unpublished parameter
counts using the existing ignoreSizeFloor policy, retaining null counts and independent
capability/quality checks. Known numeric counts, including later operator overrides, retain their
ordinary floors; explicit null overrides retain the exemption. Custom hosts, missing generation
methods and unknown open-weight models do not gain this exception. Existing Anthropic behavior
is preserved. No paid policy, request budget or deadline was changed.

Read official Google model-list schema: it supplies model identity, generation methods and
input/output limits, but no parameter count. Tools/structured-output support need their own
existing metadata evidence; identity alone cannot manufacture those capabilities. Preserve
unresearched unknown open-weight models and custom-host lookalikes as pending.

Focused discovery tests (31), Anthropic protocol tests (11), recursive typecheck and recursive
build passed. Independent source review found one null-override regression, corrected and covered
before final validation. A supported Google-only catalog refresh made five metadata GET requests,
zero inference calls, saved 46 endpoints and returned no warnings. The configured coding route
now includes 18 Google candidates. Subsequent live coding requests through Gate succeeded on
Gemini after automatic fallback past three older models that returned account-specific 404s.
This verifies the repaired routing path, not downstream application acceptance.

## Worker Briefs

### Brief: unpublished-hosted-discovery
- Role/model/effort: worker, gpt-6.1-sol/max (connections_backend).
- Goal: Trace official hosted model metadata exclusion and implement the narrow verified Google exception after reporting concrete design to lead.
- Reads: this Current State, providers/discovery.ts, enrichment/listed-model contracts, catalog status and existing discovery tests, primary Google docs.
- Owns: providers/discovery.ts and a specifically named provider metadata module if concern/size warrants; existing provider discovery tests; own unpublished-model-sizes/reports/backend.md.
- Approved extension: models/catalog.ts narrow clearing of automatic Google size exemption when a later numeric override supplies a known count; regression required.
- Must not touch: config/runtime/state/keys, other source/tests, panel, shared docs, Git or live controllers.
- Preserve known-size floors, unverified/custom-host exclusions, free/paid policy, capabilities, qualification, Gate budgets and provenance.
- Native verified Gemini identity may be size-exempt only with count genuinely null; do not infer model quality or parameter counts from names.
- Reuse existing Google capability enrichment where independently sourced; do not accidentally erase it by applying Anthropic-only metadata rules.
- Tests: official Google unknown-size model becomes routable with separately proven required capabilities; known-small and unknown open-weight/custom-host models remain excluded; existing Anthropic behavior preserved.
- Use fake metadata/temp stores, no provider calls; coordinate focused tests/typecheck/build with lead. No broad regression.
- Report exact files/API/design before edits; source freeze after relevant checks. No agents/commits.

## Work Ledger

### Brief: unpublished-size-review
- Role/model/effort: independent worker, gpt-6.1-sol/max (connections_review).
- Goal: Read-only review of the discovery and catalog diff plus focused tests for official Google unknown-size treatment.
- Owns: only unpublished-model-sizes/reports/review.md; must not edit source/shared docs/runtime/Git.
- Check official origin/native identity/method evidence, preservation of enrichment, known numeric override behavior, spoofed/custom/open-weight rejection, unchanged Anthropic and other manual exemptions.
- Read this Current State and three changed source/test files; no broad exploration unless concrete issue requires it.
- Report actionable findings or no findings with exact scope; do not run builds/provider calls. No agents.

### 2026-11-05 — Diagnosis
- Agent: Lead.
- Changed: Created bounded implementation brief after user correction.
- Validation: Source inspection of catalog status, route exclusions and existing Anthropic discovery exception; official Google Models API schema checked.
- Outcome: Partial; implementation and actual configured-route verification remain.
- Follow-up: Implement provenance-backed handling, then refresh affected metadata through supported scanning and resume under unchanged approved limits.

### 2026-11-05 — Implementation and validation
- Agent: Lead, backend worker and independent reviewer.
- Changed: providers/discovery.ts, models/catalog.ts, providers-discovery.test.ts; operations and decision documentation.
- Validation: `npx vitest run tests/providers-discovery.test.ts` — 31 passed, 4.28s; `npx vitest run tests/provider-anthropic-protocol.test.ts` — 11 passed, 4.19s; `pnpm --filter meritrouter typecheck`, `pnpm -r typecheck`, `pnpm --filter meritrouter build`, `pnpm -r build` — exit 0. Lead inspected logs and source diff.
- Outcome: Metadata fix verified in tests and configured live catalog; production panel restored and Models page HTTP 200. No complete aggregate-suite result or inference availability claimed.
- Follow-up: Separately resume the existing live project through supported repair under its unchanged approved limits.

### 2026-11-05 — Live inference verification
- Agent: Lead.
- Validation: Read-only inspection of durable model-request receipts after supported project continuation: Google Gemini coding requests succeeded with HTTP 200; three older listed models returned 404 and automatic fallback selected a working model. No extra inference smoke calls were made.
- Outcome: Unknown-size routing repair verified end to end; project worker remains active under existing limits. Code and documentation published to dev/main.
- Follow-up: Project delivery and its required reviews continue independently; no application acceptance claimed.
