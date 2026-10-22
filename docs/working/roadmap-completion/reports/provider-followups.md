# Provider follow-ups: supervisor acceptance

## Outcome
Accepted for this bounded unit: availability before paid-policy preference; registry-shaped free
quota selection and local-server UI metadata; explicit, audited quarantine retry; live views.
Remaining provider/catalog/cache-accounting work stays in the master backlog.

## Changes and boundaries
- Cooling/circuit-open preferred paid providers rank behind healthy alternatives. Explicit
  forced/preferred endpoint overrides retain their existing meaning; paid eligibility is unchanged.
- Free daily quota selection requires keyInfoShape=openrouter_key, not merely any key-info URL.
- Provider keys view passes local/keyPolicy/defaultBaseUrl/baseUrlEnv from registry resolution.
  Browser local forms no longer keep a hard-coded provider ID/address table.
- New gateway quarantine module validates persisted acknowledgements. A human reason permits
  retry for the latest violation request only, without clearing original request evidence.
  Same-timestamp later requests use rowid as a deterministic tie-breaker and quarantine again.
- Model Controls exposes the reasoned action via validated API; empty reason400, unknown model404,
  already-acknowledged state409. Model/key pages subscribe to relevant live topics; models watch
  quarantine and acknowledgement changes. Acknowledgement payloads are hashed, not streamed.
- Audit correction: refreshPaidPrices already takes an injected fetch; no new implementation.

## Validation observed by supervisor
- Targeted `pnpm exec vitest run tests/paid.test.ts tests/execution.test.ts tests/admin-keys.test.ts tests/providers-routing.test.ts tests/resilience.test.ts --maxWorkers=2`:60/60 passed.
- `pnpm exec vitest run tests/admin-live.test.ts --maxWorkers=1`:18/18 passed.
- Final frozen `pnpm exec vitest run --maxWorkers=2`:624/624,63 files,328.83s.
- Recursive typecheck passed after rebuilding public router declarations. Recursive production
  build passed; final panel rebuild after live subscriptions passed (compile7.3s, typecheck3.7s).
- Production demo on4489 only: both changed pages200; reason400, unknown404, stale409; actual UI
  acknowledgement saved actor/reason and retained original violation; reversing only the demo
  acknowledgement refreshed the browser in682ms with its document marker intact.
- Four desktop/phone light/dark quarantine screenshots inspected; no document overflow or
  browser exceptions. Local-provider option groups are generated from registry metadata.
- Temporary acknowledgement removed and temporary panel/Chrome stopped. User install4477,
  paid routing, real provider requests and credentials were not used.

## Failed/discarded probes
An initial test fixture omitted required route-plan time; corrected before passing targeted run.
An initial recursive typecheck used stale dist declarations; rebuilt router then passed.
One full suite overlapped a watcher source edit:623/624 with the watcher assertion failing;
discarded that run and reran the frozen tree to624/624. Initial browser launch raced server
readiness; reran after ready. Live reversal now waits for the watcher to observe the prior
acknowledgement, so returning a fixture immediately to its original state cannot hide the change.

Artifacts: TEMP/switchyard-roadmap-provider-*.log and
TEMP/switchyard-panel-v2-validation/provider-acceptance.json plus quarantine-*.png.
