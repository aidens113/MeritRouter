# Cost-first routing defaults and positioning
Status: Complete
Status detail: Implemented and verified; publication receipt recorded in repository history.
Created: 2026-10-23
Last updated: 2026-10-23
Owner: Senior supervisor agent
Scope: Paid policy defaults, presets, onboarding, product wording and visible Overview usage graphs with time horizons.
Paired document: none
Related: [handoff](handoff.md)

## Current State

Cost-first defaults and documentation are implemented: paid enabled, $5 rolling weekly cap,
T1-T3 and standalone supervisor on_free_exhaustion, T4 escalation. Explicit existing settings
and the named free-only preset remain authoritative. No ranking algorithm change.
README opens with the cost-saving/model-selection and testing-framework pitch, then agent prompt.
Global and project Overview share visible usage charts and 1h/24h/7d/30d URL-backed ranges.
Chart timelines crop empty outer buckets, retain interior gaps and keep full axes for empty ranges.
The selector now sits above sticky table headers; refreshed projects are validated without
replacing a good list on malformed responses. Physical pointer interception was reproduced
and corrected; keyboard, mobile, scopes, links and range changes were verified in production.
Full router snapshot: 1200 passed, five old-default fixture assertions failed, two skips.
All five assumptions corrected without weakening production guards; affected eight suites
passed 75/75. Recursive build/typecheck, hardened offline demo, CLI defaults, installed package
and browser acceptance passed. Final crop rebuild, recursive typecheck and installed/live browser verification pass.
The user authorized restarting the real panel. Its configuration, explicit paid-disabled policy,
data and key paths are preserved; no real provider requests were submitted. Publication follows the accepted merge into dev and fast-forward of main; remote heads are checked after push.

## Worker Briefs

### Runtime defaults
- Own packages/router/src/config/schema.ts, packages/router/scripts/build-presets.mjs,
  packages/router/examples/** and relevant tests under packages/router/tests/** only.
- Set schema/example defaults true, $5/week, T1-T3 on_free_exhaustion, T4 never; preserve
  all budget/price/key checks and explicit false/zero/never values. Check schema refinements.
- Default claude-code preset permits bounded paid routing; standalone-free explicitly false,
  zero budget and never tiers. Other named policies stay explicit, accurate header wording.
- Regenerate presets with script. Add meaningful default/explicit override/generated init
  regressions. No routing ranking changes, panel/docs edits or commits.
- All commands repository scoped, focused tests only; no build/full suite/provider/user config.
- Write docs/working/cost-first-routing/reports/runtime.md with results and limitations.

### Documentation
- Own README.md, CLAUDE.md, packages/router/README.md and authored docs/*.md only.
- Reframe around reducing cost for capable results, supporting both paid and free routes.
  Paid is enabled by default, $5 weekly cap, T1-T3 free-exhaustion policy, T4 supervisor.
- Remove blanket free-only/paid-optional positioning and README prompt's paid-off instruction.
  Retain explicit free-only instructions and accurate policy mechanics; avoid claims of
  globally optimal price routing or automatic billed-key authorization. Existing explicit config
  is preserved; keys/prices/budgets still required. No current provider price claims.
- No source/panel/working shared doc edits, commits or live/network checks.
- Write docs/working/cost-first-routing/reports/docs.md with inventory/verification.

### Isolated Overview graphs and horizons
- Own ONLY apps/panel/app/all/page.tsx, app/p/[slug]/page.tsx, components/client/charts.tsx
  if required, NEW components/usage-overview.tsx and NEW lib/usage-range.ts if useful, plus
  own docs/working/cost-first-routing/reports/overview.md IN isolated worktree
  .claude/worktrees/overview-horizons (feat/overview-horizons). No primary edits.
- User cannot see graphs in main Overview: /all currently defaults Projects and has a separate
  Usage table tab with no actual time charts. Make default Overview usage-first with actual
  token/request/tier SVG charts, no separate Usage tab. Keep Projects/Activity/Health navigation,
  attention and budget actions accessible outside usage overview; old tab=usage -> Overview.
- Both /all and /p/<slug> need visible accessible URL-backed horizons: 1h,24h,7d,30d minimum.
  Selected range must drive queries, chart buckets, titles and token/request totals consistently.
  Preserve scope and query state; invalid range falls back predictably. Include partial first/
  current buckets; bounded sensible bucket counts and nonambiguous labels across days.
- Reuse insights.timeseries(hours,bucketMinutes,project?) and tierDistribution(since,project?);
  stable library API, no backend edits. Use shared focused usage component/helper if useful,
  remove duplicate project chart-building code. Respect chart tokens unit and large axis labels.
- Verify ResizeObserver/table/graph toggle lifecycle; fix only if implicated, preserve mobile.
  Add appropriate pure helper tests only if necessary; explain unverified behavior in report.
- Offline frozen install/build/typecheck permitted only IN worktree, no full suite/demo/provider
  work or user config/processes. Root owns integrated final build, demo browser/screenshots
  and publication. All commands confined to repository; no commits.

### Isolated project selector followup
- Extend overview_horizons worker ownership in the SAME child worktree to ONLY
  apps/panel/components/client/project-switcher.tsx and shell.tsx if causally needed, plus
  own overview report. Root owns integrated runtime/browser testing and live panel restart.
- User reports dropdown doesn't work; reproduce or trace before fixing. Check fixed-menu
  clipping/stacking, physical pointer hit tests, focus/outside dismissal, navigation/global
  fallback, API refresh validation and mobile/desktop behavior. Keep scope and saved data.
- Coordinate with supervisor's actual Chrome reproduction. No primary edits, commits,
  real user config, providers or user-process management. Build/typecheck only in child.
- User explicitly authorized full restart of the real panel after implementation. Supervisor
  will preserve actual config/port/env and restart only the identified panel after acceptance;
  no worker restart/kill/service or config migration authority.

## Work Ledger

### 2026-10-23 - Inspection
- Agent: supervisor
- Evidence: schema, preset generator, example, routing sort and onboarding inspected.
- Decision: align enabled switch, tier policy and nonzero cap; preserve routing mechanics.
- Validation: not yet run.
- Outcome: implementation underway.

### 2026-10-23 - Integration
- Agent: supervisor
- Changed: schema/example/presets; default/init/fake-dispatch regressions; authored docs/prompt;
  panel settings and glossary; handoff/index.
- Validation: pnpm -r build and pnpm -r typecheck exit 0; compiled CLI init and schema assertions
  verify true/$5/T1-T3/supervisor defaults. Full suite and offline demo in progress.
- Outcome: Partial; await complete regression/demo/browser acceptance, then push dev/main.

## Open Questions

None. Supervisor owns panel wording and integrated acceptance/publication.

### Supervisor follow-up: timeline cropping

- User requested fitting chart axes to recorded data within the selected range. Both usage
  charts now derive shared bounds from scoped request points; interior empty buckets remain.
- Direct helper assertions pass: 7-day empty axes, cropped outer buckets, interior gap,
  single bucket and selected-window clamping. Production/package browser checks pass.
- Full-suite fixture corrections and 75/75 affected tests are supervisor-verified; no runtime
  containment, routing budget or paid-disable guard was relaxed.

### 2026-10-23 - Final supervisor acceptance
- Agent: Codex (supervisor)
- Validation: recursive production build/typecheck pass; offline demo exits 0. Full router
  run: 119 files, 1200 passed, five obsolete-default assertions failed, two platform skips.
  Corrected fixtures explicitly disable paid or set zero budgets; affected eight suites pass
  75/75, including fake dispatch, price/budget guards, init/preset preservation and packaging.
- Installed final tarball: 2680 files, SHA1 e0d557be82ab6eee33a695ec1dc5287cc4fe72d9.
  Bundled production panel starts without stale-build warning. Browser acceptance covers both
  scopes, four horizons, totals, URL fallback/persistence, chart resize, operational tabs,
  keyboard/pointer/mobile project selection and invalid-refresh preservation. Zero exceptions.
- Cropped 7-day charts show six actual demo-data buckets instead of 29 full-window buckets.
  Desktop/mobile screenshots inspected. Direct helper assertions cover single bucket, empty
  axes, interior gaps and range clamping. Cost settings: three routes, four inspected images.
- Real panel fully stopped and restarted after final build; readonly live browser acceptance
  confirms graphs, horizons and physical project switching. Existing configuration, stored
  data and paid-disabled setting preserved. No real provider calls or npm publication.
- Outcome: Complete. Detailed evidence in reports/supervisor.md; publish dev/main together.
