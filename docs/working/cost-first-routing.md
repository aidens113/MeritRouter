# Cost-first routing defaults and positioning
Status: Active
Status detail: Implementing user-requested cost reduction positioning and enabled paid routing defaults.
Created: 2026-10-23
Last updated: 2026-10-23
Owner: Senior supervisor agent
Scope: Paid policy defaults, presets, onboarding, product wording and visible Overview usage graphs with time horizons.
Paired document: none
Related: [handoff](handoff.md)

## Current State

Baseline dev f19ff34; branch feat/cost-first-routing. User wants cost reduction across free and paid models as the
product's purpose, with paid routing enabled by default. Schema/example/presets and docs now agree on new defaults: enabled true, $5 weekly cap,
T1-T3 on_free_exhaustion, T4 never (retain supervisor escalation). Omitted supervisor paid
policy also becomes on_free_exhaustion, with explicit free-only supervisor policy preserved. Explicit old false/zero/
never values remain authoritative. Free-only named preset remains an explicit alternative.
Runtime and documentation workers are frozen. Supervisor reviewed their diffs, including
actual fake-provider dispatch/budget/disable coverage and generated init preservation. Panel
copy now emphasizes cost controls, enabled defaults and neutral paid policy descriptions.
Recursive production build and ordered typecheck pass. Compiled CLI init defaults verified.
Full router suite and hardened offline demo are running; browser acceptance follows seed
completion. User explicitly reiterated push after completion; publish dev/main after acceptance.
No real provider execution or changes to the user's installation configuration.

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
