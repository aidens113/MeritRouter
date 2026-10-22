# Report: model-navigation-regression

## Outcome
Frozen for supervisor review. Reproduced and fixed a historical-model link failure. Current-model slash/dot/colon links, client navigation and tab query preservation worked in the isolated production browser; the exact user-reported current-model failure was not reproduced. Do not present the historical fix as proof of that user's browser state or stale deployment cause.

Owned changes: apps/panel/app/all/models/detail/page.tsx, new apps/panel/scripts/model-navigation-check.mjs, this report. No shared ModelLink/modelHref/list-page/router API edits; no commits, shared docs, providers or user data. Root's previously copied config-edit.ts/lab-config-guard.ts dependencies remain supervisor-owned.

## Actual reproduction
Production Next panel in this isolated worktree on 127.0.0.1:4493, official demo seed through scripted fake clients only. Fresh owned Chrome profile under this worktree's apps/panel/.demo, CDP port9343; no real browser profile or4477 access.

Baseline browser results:
- Actual mouse clicks on three list ModelLinks resolved their matching titles, and all five tabs kept the exact query ID and document marker: `nvidia/meta/llama-3.3-70b-instruct`, `openrouter/z-ai/glm-4.5-air:free`, `google/gemini-2.5-flash`. Direct GETs were200.
- Changing the demo catalog display name, then bumping its public catalog version, refreshed the title while preserving the usage query.
- A previously unknown slash/dot/colon fixture ID `lab/vendor.dot/minimax.fixture:free`, added to the demo catalog, opened correctly by actual list click. No stale404 reproduced. This is a synthetic fixture, not a factual claim about a real provider/model.
- Removing the manual catalog entry for an endpoint with existing recorded requests left its request-detail ModelLink pointing at Not Found. Actual browser click rendered Not Found; direct GET returned404. A completely unknown endpoint also returned404.

Source cause: the detail page only searched current `modelsView` and called notFound when metadata was absent, even if existing stored requests identified that endpoint. Encoded href construction and tabs were correct.

## Change
When current metadata is absent, a nonempty endpoint ID with recorded requests now gets a history-only detail page using existing public requestLog/modelUsage/requestDetail APIs. It clearly says the model is no longer in the current catalog, provides related tasks/agents/projects, linked recorded requests and actual latest recorded provider/model/token values, and retains Overview/Usage navigation. It does not invent size/context/prices/capabilities or offer current-catalog eligibility, qualification actions or mutation controls. Empty IDs and unknown IDs remain404.

Attribution regression deliberately includes a real demo mismatch: requested `nvidia/meta/llama-3.3-70b-instruct`, latest recorded provider `nvidia`, latest recorded served model `meta/llama-3.1-8b-instruct`. The new view preserves those different recorded values, rather than reconstructing them from the requested endpoint.

## Observed validation
- `pnpm --filter switchyard-router build`: passed before panel validation (prior work's final build; no router source changes for this brief).
- `pnpm --filter switchyard-panel build`: initial isolated build failed only because this old facade snapshot omitted writePreparedConfigText/patchPreparedConfig. Supervisor confirmed its current real source already exports both; used previously authorized generated dist/admin/insights.js and .d.ts export bridge only, ignored/uncommitted. Rebuilt successfully, then built again successfully after the historical page change, including TypeScript.
- `pnpm --filter switchyard-panel seed:demo`: passed; all seed fixture checks completed. No real provider calls.
- `node scripts/model-navigation-check.mjs`: final run passed actual browser clicks and15 current-model tab switches, mutable title/query preservation, historical request-link plus direct200, actual stored provider/model equality, history tab identity, no unavailable tabs, unknown and missing-ID direct404, previously unknown then added fixture client navigation, zero browser exceptions. Harness restores original catalog text and closes its own service/browser in finally; refuses to attach if the debug port is already occupied.
- Direct history DOM and client history DOM both showed the history page, not Not Found. Next's HTML/RSC payload can contain its generic not-found template even for a successful page; acceptance inspects rendered DOM and matching history content instead of treating a raw template substring as the result.
- Captured and inspected changed history page at1440x1000 desktop and390x844 phone, light/dark: correct historical notice, real attribution, readable wrapping and no horizontal page overflow. Also inspected active-model and baseline historical404 captures.
- `node --check apps/panel/scripts/model-navigation-check.mjs` and `git diff --check`: passed.
- Stopped verified owned Next process after validation;4493 and9343 listeners are absent. No4477 process was mutated or restarted.

## Artifacts and limits
Ignored local artifacts: apps/panel/.demo/model-navigation-results/results.json and historical-model-{light,dark}-{desktop,phone}.png, historical-model.png and active-model.png. Root can inspect them before cleanup. The final JSON records historicalClientNotFound:false, historicalDirectStatus:200, historicalDirectNotFound:false, unknownStatus:404, missingIdStatus:404, and no browser exceptions.

No assertion about the user's original current-model client session, real catalog changes or stale build state is made. No whole-repository suite, user browser inspection, remote providers or router metadata changes were needed. Supervisor owns integrated build/browser checks and authored docs for the new historical behavior.
