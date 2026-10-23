# MeritRouter rename: supervisor acceptance

Date: 2026-10-23. Baseline 3c06c69; frozen rename checkpoint 9fa547a. This report records
observed checks, not worker completion claims. No live provider or paid-routing execution.

## Delivered scope

- Canonical product MeritRouter; package/library/CLI `meritrouter`, panel `meritrouter-panel`,
  service/error/options `MeritRouter`, `MeritRouterError`, `MeritRouterOptions`.
- `MERITROUTER_*` built-in environment variables, `meritrouter.config.yaml`, `.meritrouter`,
  `meritrouter.db`, application directories and new Git namespaces. Four presets regenerated
  from renamed example. Workspace lockfile regenerated and frozen offline install passes.
- Public metadata, MCP server identity, panel/imports/cookies/preferences/icon and scripts renamed.
- Root README starts with a copyable agent prompt, then source build, project/key/security,
  MCP registration and a bounded first task. Package README included in installed tarball.
  Docs index, setup, roles, operations and sourced decisions updated for readability.
- Existing-install upgrade instructions preserve explicit configuration/data paths, vault/master
  key and old Git refs; environment/path preservation precedes doctor. User-selected provider
  env names remain valid. Installed/source CLI distinction and local doc links/anchors reviewed.

## Observed validation

- `pnpm install --lockfile-only --offline` and `pnpm install --offline --frozen-lockfile` pass.
- Recursive router/panel production build passes. First parallel typecheck saw stale pre-rename
  declarations; repeat after router build passes, including final packaging-discovery source.
- Worker focused rename/operations/brain evidence: 44 distinct cases; packaging discovery 18/18.
  Full supervisor suite: 117 files passed, 1193 tests passed, 2 Linux-only skips, 1138.85s.
  Final integrated recursive build/typecheck pass; affected suites pass 49/49.
- Installed tarball outside checkout (SHA1 6c3a45cfdb1e744393544809696c60a017f30c36):
  fresh 156 dependencies; CLI help/init/status and README-style setup with explicit config pass;
  stdio MCP reports `meritrouter`,42 tools, usage query; bundled all/security/project/icon200,
  canonical branding and no stale warning; own panel stopped with200.
- Production demo4495:19 routes requested,4 desktop/mobile screenshots inspected,0browser
  exceptions. Actual existing checkout path is displayed as such; no physical folder move.
  Own panel stopped. Chrome9337 is retained temporarily for final validation.

## Defects found during acceptance

1. Generated package staging collided with an old user panel auto-started by the existing MCP.
   Prepack cleanup failed EBUSY on packages/router/panel. Supervisor restored 1812 previous
   generated files from its own archived accepted install and SHA256-verified every file.
   No user configuration/process was changed or restarted. Fixed staging to bundled-panel;
   checkout discovery prefers apps/panel, so prepack never mutates legacy staging. Installed
   package selection and explicit override are covered by meaningful path-discovery tests.
2. Demo nested integration assertion failed (2integrations/0rebase). Raw readonly evidence:
   await_tasks created action stores without injected clock, cancelling a valid historical
   pending check. Proper clock fix/regression is integrated.
   Demo phases now reject unfinished tasks and settle shutdown before advancing historical time;
   measured escalation phase has an explicit 120s allowance without weakening assertions.

## Intentional compatibility and operational boundaries

Old name remains only for explicit legacy DB fallback, exact Lab ownership/process/branch
proof, stable cross-version brain/repository-prepare locks, matching tests, migration prose,
gitignore privacy rules and historical working reports/real deployment paths. New callers do
not get old CLI/env/package aliases. No applied storage migration was edited.

No automatic movement/deletion of user installation data, no npm publication, no user-service
or MCP registration change and no live provider work. Existing client registrations must be
reconnected/re-registered using the upgrade guide. Hosted GitHub repository renamed to aidens113/MeritRouter after local acceptance; origin
updated and fetched successfully. Accepted merge dac9429 pushed to dev and main, with main fast-forwarded.

## Final integrated checks

- Final tarball reinstalled outside checkout; CLI/setup/MCP (42 tools) and bundled routes pass,
  with panel stopped cleanly. Final build/typecheck and 49 affected tests pass.

- Hardened offline demo exits 0 with no fixture warnings/failures: nested team completed/met,
  3 integrations including 1 rebase, comparison, historical escalation/review, queued questions
  and two real fixture Lab health checks. Fixture services are stopped.
- Final browser interaction run passes: native keyboard disclosure, draft preservation,
  direct #new and client/repeated-hash navigation, Overview/legacy usage/Activity, role filter,
  approximate reported tokens, mobile overflow. Eight desktop/mobile screenshots inspected;
  no browser exceptions. An initial Enter-only CDP probe did not activate the native summary;
  the supported Space keyboard interaction passed directly.
- Visual review moved attention/budget cards into Activity, keeping Overview focused on usage.
  Final bundle/browser repetition passes after this refinement; no router semantics changed.
  Large token-axis labels no longer clip and the token chart uses explicit token units.

- Final accepted tarball SHA1: 924b1f3fa33088c47fa3adbd58d399962324c7de, 2677 files.
  Final outside-checkout install/CLI/MCP/bundled panel rerun exits 0. Final ordered typecheck
  exits 0. Final production browser rerun: 19 routes, 4 general screenshots plus 8 UI-specific
  screenshots, all reviewed, 0 exceptions. Own panel4495 and Chrome9337 stopped.
