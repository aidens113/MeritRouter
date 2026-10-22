# Panel v2 supervisor validation — 2026-10-22

## Outcome
Core U1-U3 behavior was independently verified by the checks below; full requirement completion was not established. The 2026-10-22 completion audit reopened gaps listed in the working document Current State. No live provider calls; all checks used temp
router fixtures or apps/panel/.demo with fake provider/web transports. The user's install and
port 4477 were not used for testing or restarted.

## Changes confirmed
- Live SSE topics, bounded resume cursors, reconnect, pause and invalidation after watcher recovery.
- Scoped fingerprints detect same-timestamp and older-row changes; all configured brain roots are watched.
- Shared headers, query tabs, legacy anchor mappings, disclosures, grouped navigation and phone summaries.
- Agent, repository, commit and model-request pages, including qualification and unassigned requests.
- Related task/job/session/model/request/commit links; validated citations and bounded-history notices.
- Repository aliases reject inherited object names; encoded agent route identities are decoded.
- Integration review corrected dashboard tab scope, agent 404s, encoding damage and missing sibling navigation.

## Commands and observed results
- `pnpm -r typecheck`: passed on the final tree.
- `pnpm -r build`: passed on the final tree, including router and production Next.js panel.
- `cd packages/router; npx vitest run`: initial loaded run had 598 passed, 5 failed and a worker-reporting timeout. Failures were admin-promotions timeout, operations cleanup ENOTEMPTY, projects-operations cleanup EBUSY, resilience hook timeout, and supervisor question timing. Concurrent build/seed load was removed.
- `cd packages/router; npx vitest run --maxWorkers=2`: 59 files and 603 tests passed, 284.06 s. No source/test timeout changes were made to obtain this result.
- `pnpm --filter switchyard-panel seed:demo`: exited 0 with Demo ready. Fixture warnings: add-multiply failed on a brain index.lock collision, nested team had no rebased integration, and no pending demo promotions remained. These are recorded limitations of this seed run; they are not evidence that live teams work.
- Production panel: `node node_modules/next/dist/bin/next start -H 127.0.0.1 -p 4489`, with SWITCHYARD_CONFIG pointing only to the demo config.
- `%TEMP%/switchyard-panel-v2-validation/crawl.mjs after.json`: 492 route/tab/entity and scope checks, zero unexpected failures. Archived legacy-billing routes intentionally returned 404. Invalid aliases, unknown requests, cross-project task/session URLs and unknown SSE scope returned 404.
- `browser.mjs live live-options.json`: final store mutation appeared in 865 ms; zero idle RSC refreshes in 2.5 s after prefetch settled. Scroll 120, an open disclosure and a JavaScript marker survived refresh. Pause held a second update; resume caught up. Restarting only the temporary server reconnected and retained state.
- `sse-check.mjs`: text/event-stream; malformed cursor emitted reset; valid resume emitted missed changes. A delegated divide task had direct links to job, agents, sessions, models, requests and commits.
- `browser.mjs anchors after.json`: job #plan, keys #add, settings #brain, task #web-requests and model #controls all selected their expected query tab and active navigation.
- Screenshots: 44 baseline captures; 120 resulting page/theme/viewport artifacts, with affected captures refreshed after mobile/navigation fixes. Desktop 1440x1000 and phone 390x844, light/dark. Supervisor inspected contact sheets and full-size job, agent, commit and qualification-request images. No browser exceptions or document-width overflow in captured pages.
- `git diff --check`: no whitespace errors after EOF cleanup.

## Evidence and limits
Logs, route JSON, browser scripts, screenshots and contact sheets are retained outside git at
`%TEMP%/switchyard-panel-v2-validation/`. No runtime DB, fake key vault, generated demo, or
screenshot binaries are committed. The baseline was a separate checkout of dev e00dfd5.

Large-store watcher performance is unbenchmarked: after writes, mutable scoped rows are
fingerprinted; quiet ticks retain cheap version/heartbeat checks. Some inactive tab queries
remain eager. Request attribution reads 60 recent session logs; commit lists are bounded.
Archived project history requires unarchiving. Shared-brain diffs are not exposed as code-repo
commit pages because their project containment differs.

The baseline server was stopped and its worktree unregistered. Removing its leftover
`D:/SwitchYardPanelBaseline` directory was rejected by automatic approval review with only
"blocked by policy" supplied; it remains as an unregistered temporary directory.
The temporary demo server and headless Chrome were stopped. Automatic approval review also rejected deletion of the generated apps/panel/.demo fixture directory with only "blocked by policy" supplied; it remains gitignored. Final merge is recorded in the working ledger.

## Completion follow-up, 2026-10-22 (integration in progress)

- Root independently seeded the repaired demo: exit 0, no fixture warnings; nested team met,
  three integrations including one rebase, four channel posts, verified survey twins; promotion
  count assertions passed. Scripted providers only, no real quota or user install access.
- D5/D6 baseline inventory: all literal section titles and IDs retained across nine dense pages;
  dynamic settings schemas/renderers unchanged from e00dfd5. See remaining-audit.md for the map.
  Fixed the discovered third-click transcript wrapper and structured repository/job/model links.
- Expanded headless browser anchor check: 40 old hashes/query combinations selected their
  expected tab, including generated profile/provider IDs and every project policy section.
- Durable `pnpm --filter switchyard-panel validate:live` passed after adding Brain's missing live
  subscription: task 905 ms, independent new request 735 ms, brain commit 1222 ms; document marker
  preserved, open disclosure retained, zero idle refreshes over 2500 ms, zero browser exceptions.
- B2 browser actions: required reason; partial approval of one request; denial; wrong-project 404,
  malformed reason 400, over-pool 409 and repeated decision 409. Five screenshots captured.
  A harness selector initially looked for settled history under the pending card; corrected to
  budget-history and verified stored decisions and task extras on a separate pass.
- Initial default-parallel suite: 611/612, one Windows EBUSY deleting a brain directory after
  close. Traced unowned deferred promotion writes; close now cancels queued callbacks and drains
  active settlement. Four deterministic lifecycle regressions cover direct/deferred work,
  cancelled callbacks and retries remaining queued after scheduler stop.
- A route crawl found copied README ancestry incorrectly listed private sibling hashes (dead
  links). Copy statuses now advance the tracked path and stop at scope boundaries; native Git
  tests cover private copies and visible own-project copies. Final rebuilt crawl is pending.
- Intermediate integrated suite: 616/616 before the shutdown/copy follow-ups. Final full suite,
  production screenshots and route crawl are in progress; completion is not yet asserted here.

Artifacts remain under `%TEMP%/switchyard-panel-v2-validation/`: build-accepted.log,
tests-accepted.log, live-accepted.log, anchors-completion.json, crawl-accepted.json and
completion-shots/. Earlier evidence above remains historical and retains its limitations.
