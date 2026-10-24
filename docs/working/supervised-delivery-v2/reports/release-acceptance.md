# Supervised delivery v2 release acceptance

Status: Source release verified — physical/live acceptance remains open
Owner: Senior supervisor

## Scope and isolation

Framework changes only. Downstream clone files, real user configuration/Brain and live
panel4477 were untouched. All providers in automated tests are fakes. No real requests,
paid spending or inferred quality qualifications. Test datasets use temporary directories
and panel `.demo`; none are tracked. Feature commits preserve individual worker attribution.

## Independently observed checks

- Recursive typecheck and recursive router/panel production build passed on integrated
  d17890a. Full regression runs build router first for actual CLI/MCP subprocess tests.
- Snapshot61d572c:1,348 passed, one failed, three skipped,141 files/1,352 tests,
  949.61seconds. Remaining scoring test assumed two real-Git preflights would reach a50ms
  batching window together. Its deterministic admission barrier retains real queue/Gate/cache
  execution and verifies an actual two-item request plus cached completion. Production timing
  and queue unchanged. Focused6/6 passed.
- Full d17890a: **1,354 passed, two failed, three skipped** (143 files,1,359 tests,
  827.18seconds). Both failures were HTTP inventory assertions still expecting47 tools
  after adding project_delivery_report (actual48). Corrected both; final actual stdio/HTTP,
  product and rejected-repair selection **12/12 passed** in25.97seconds. No observed failure
  remains. This is full-run plus focused corrective coverage, not a claim that the original
  full d17890a invocation exited successfully.
- Final additional production change validates the stored repair eligibility row with zod
  instead of a cast. Independent delivery/repair6/6 passed, then final12/12 selection above;
  recursive typecheck/build passed after this guard. Remaining changes are HTTP expectations
  and authored release records. No additional full run was needed for those inventory constants.
- P9 integrated selection:31/32 initially, with sole obsolete MCP tool-count expectation;
  both actual MCP cases passed after updating the inventory to48. Selection included real
  two-project rejected-delivery repair, protected completion refusal, source-bound product
  state, actual transport reports, supervisor orchestration and review/session crash recovery.
- Panel demo seed passed every expectation, including nested integration/rebase. Production
  UI/API17/17 scenarios passed; no JS exceptions. Includes scoped search/catalog/paging,
  document CAS/concurrency/conflict draft preservation, history/blame/related, typed project
  memory and global preference CRUD/revocation, historical manifests, settings persistence
  and separate legacy task/product labels. See production-delivery-panel-acceptance report.
- Rebuilt mobile Brain table fixed:640px scrollable table,406px height,54–74px rows,
  page390px. Supervisor settings actual Add creates null request cap/8000 output tokens;
  corrected current quality/600-budget guidance rendered. Original demo profile restored.
- Latest P9 production project overview/job detail each returned200, rendered product
  attention/evidence-incomplete/FINAL-pending independently of green legacy acceptance,
  and had no page overflow at390px or browser exceptions. Screenshots independently inspected.
- Actual Request repair UI required confirmation and returned200/queued on synthetic
  demo-only rejection with retained seeded supervisor workspace. Nonrejected, foreign-project
  and duplicate requests returned409. Original task/delivery rows restored in finally;
  fixture audit events remain synthetic history. This proves the panel control, not usable
  downstream product quality. Initial QA script expected404 for project mismatch and missed
  the existing two-click confirmation; corrected script exercised actual service409 and UI.
- Actual compiled `delivery-report --project demo --limit1 --json` reported missing candidate,
  pending FINAL, effectiveAccepted:false and sourceRevalidated:false for the same fixture.
- Temporary servers4480/4481/4482 and all QA Chrome instances stopped; live4477 remains.

## Remaining acceptance and operating limits

The Docker adapter and bounded journey contracts exist, but installed Docker has no working
Linux engine/image. Real interactive hydration/input/upload/cookie/mobile/restart journeys,
network/file canaries, crash ownership and browser sandbox compatibility are unverified.
Windows static Chrome/process checks do not certify those or Linux physical containment.

No qualified live-provider delivery pilot has run, so no measured request/cost reduction or
new usable-clone claim. Starting supervisor allocation600 is configurable, not a promised
per-project consumption. Manual dated capability-evidence onboarding is required; model/vendor
names do not self-qualify. Automatic worker Task Labs and FINAL waiver UI remain unsupported.
FINAL observations/decisions operate through MCP with fresh candidate/CAS checks; no separate
panel product-acceptance endpoint was added.

Warm production short-document navigation30samples: p50/p95/max188/281/326ms.
Latest opt-in benchmark explicitly executed:1/1 passed,13.88seconds total, Windows/Node22.11.0,
10,000 corpus files/3,334 owned-project files. Initial indexing4,588.71ms, warm catalog30samples
p95 .392ms, scoped search30samples p95 4.304ms, five new Brain instances with existing index
p95 264.14ms. This ran alongside focused tests, not a controlled idle comparison. Initial
indexing still exceeds2s target; no controlled cold10k/50k browser acceptance. Full suite skips
this opt-in benchmark and two physical Linux namespace/helper tests; the benchmark was verified
separately and the two Linux platform checks remain unverified.

## Reproduction artifacts

Full JSON: `%TEMP%/meritrouter-final-61d572c-tests.json` and final
`%TEMP%/meritrouter-final-d17890a-tests.json`. Production QA scripts/results/screenshots:
`%TEMP%/meritrouter-release9c80b12-qa.cjs`, its `results.json` directory,
`%TEMP%/meritrouter-final-panel-check.cjs`, `%TEMP%/meritrouter-p9-panel-check.cjs`,
`%TEMP%/meritrouter-p9-repair-check.mjs`. These are local test artifacts, not tracked source.

## Publication

Source checks cleared for publication under repository standing authorization. Source acceptance
does not close the physical-platform, cold-performance or live-product acceptance work above.
