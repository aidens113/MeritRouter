# Supervisor acceptance — corrective unit

Date: 2026-10-23. Scope: preserved live-run fixes plus F1-F6, worker containment/security
settings, connected panel flows and compatibility corrections. No live providers or paid routes.

## Integrated evidence

- Frozen full router run: 1150 passed, 15 failed, 2 skipped /1167 tests, 116 files,
  1168.56s, `vitest run --maxWorkers=2 --minWorkers=2 --reporter=verbose`.
  Both skips are Linux-helper fixtures on Windows. The failures exposed missing guarded Git
  verbs, old unrestricted-worker fixtures, cache display/project ownership assertions, channel
  crash replay, custom supervisor configuration and nested brain mount compatibility.
- All 15 failures were corrected. Supervisor final affected run: **162/162**, 15 files,
  186.90s: client-supervision, worker-containment, outside-operation, worker-lab-authority,
  web, labs-scripted, team-channel, team-nesting, team-integration,
  verification-calibration, admin-brain-entities, brain, projects-brain, attribution, admin-live.
- Other corrected original failures independently pass: task-prune11, plan-recovery1,
  Git containment16, policy14, session-surface6, team-graph11. The first new live-watcher test
  had an incorrect table name; corrected admin-live20/20 passed and is included above.
- Final recursive typecheck and recursive router/panel build passed. Package build passed.
  Diff whitespace check passes (Git emits existing Windows newline-normalization advisories).
- Additional supervisor regression run: **61/61**, 8 files,55.59s: native,
  harness-repeat-policy, session-faults, session-resume, readonly-checks, artifact-scope,
  admin-job-navigation and usage-cache-certainty. No unrelated passing full-suite files repeated.

## UI and installed package

- Demo seed passed assertions including nested team3 integrations/1 rebase. It uses an explicit
  temp operator and simulated clock, then restores default human-only policy. Early real-clock
  supervisor observation disturbed one historical sample check; no user data was involved.
- Production demo4489: all touched pages/tabs/APIs requested; job requests include descendants
  (9 vs7 supervisor-only), child links/backlinks checked. Operator API: foreign404, forged
  actor400, cross-origin403, invalid security400, disabled409, exact approval200, repeat409.
- 13 demo desktop/mobile/dark screenshots inspected; zero browser exceptions. Existing live
  validation passed task1493ms/request1242ms/brain738ms, document preserved; quiet2500ms0refresh.
- Tarball installed with fresh dependencies outside checkout. Installed CLI init/status,
  stdio MCP42 tools/usage, bundled panel4491 overview/Security/project and operator API pass.
  Approval inserted after task page was already live appeared in1324ms; exact `node --version`
  completed exit0; decision history refreshed without reload, zero browser exceptions.
  Packaged screenshot inspected. Harness mistakes (GET on write-only config API, initial
  null DOM body and invalid fixture lease incarnation) were corrected in temporary probes.
- Package build-age false warning fixed with validated runtime path/content fingerprints bound
  to BUILD_ID. Supervisor operations-panel/packaging16/16 pass (6.80s); final recursive typecheck
  passes; npm prepack builds router/panel and includes the fingerprint. Final tarball SHA1
  e68e387c4b76b0fcc4ce69315077ce4b267e89e5, installed outside checkout with fresh dependencies.
  Reinstalled final CLI/MCP42tools/bundled pages and live approval pass with **no stale warning**,
  1220ms insertion-to-DOM, exit0, no reload, zero browser exceptions; final screenshot inspected.

## Limits and operational state

Default `human_only` requires an actual human operator; `disabled` refuses outside actions;
`supervisor` permits exact decisions by currently authoritative configured supervisors.
Worker shell commands are brokered because cwd/allowlists do not provide OS containment.
External autonomous coding runners and automatic worker Task Lab execution fail closed until
their sandbox/durable execution proof exists. Native scoped editing and approved ordinary checks
are supported. Network Git is denied, so automatic brain push is unavailable; trusted operator
backup remains separate. Nested mounts and scoped commits preserve unrelated staged work.

No real configuration/store, downstream project, actual4477 or live MCP deployment was touched.
No Compose engine, browser hydration, PostgreSQL/multi-host or provider acceptance is claimed.
Older deployment/process snapshots in working documents are historical. Temporary owned panels
were stopped after checks, including final installed panel and owned Chrome. Ports4489/4491/9335
are closed. Failed temp fixtures were recycled after exact path/identity checks. Source is ready
for coherent commit, dev merge and dev/main publication; publication receipt follows in handoff.

Source commit:1092881. Final unchanged-dev premerge outside-operation10/10 passed6.80s;
final `pnpm -r build` also passed after the fingerprint correction. Acceptance temp repositories,
package install and Chrome profile were recycled after owned processes stopped; measured results
are retained here. No unrelated worktrees or runtime state were removed.

Publication: merge4e0138b pushed to dev and main on2026-10-23. The local feature branch was
deleted after merge; no remote branch deletion, history rewrite, npm publish or live deployment.
