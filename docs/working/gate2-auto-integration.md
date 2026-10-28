# Gate 2 integration acceptance
Status: Active
Status detail: Combined split mutex/startup/CLI repair independently119/119 PASS; final recursive checks and retained pilot recovery next.
Created: 2026-10-28
Last updated: 2026-10-28
Owner: Senior supervisor agent
Scope: Verify service-enforced integration and retry the Facebook MVP through MeritRouter without authoring application source.
Paired document: none
Related: [production readiness](production-readiness.md)

## Current State

Facebook/Commons MVP remains UNDELIVERED. User requested repeated router-driven builds with no manually authored application source. Root supervises/tests; only MeritRouter workers author the application. Main is held until actual product acceptance.

Active fresh job: t_0mvsr8qoi4c6b92cdff6b (commons-retry-357), supervisor session s_0mvsr8ziid56f0ef3550b. Worker17808 runs in exec28651; panel http://127.0.0.1:4477/p/facebook-mvp/jobs/t_0mvsr8qoi4c6b92cdff6b . At last read: running,12 requests/$0, no children/actions yet. Cap357 plus prior failed pilot43 =400-request trial envelope. maxPaidUsd0 and paid routing disabled. Never reset old usage or silently extend this envelope.

Prior pilot t_0mvsovety5bfa4069dc69 retained43 requests/$0, two completed workers, and source. Scaffold6359879/task t_0mvsoxf1g7939912adcbd rejected through CLI for one literal-backslash-n ignore line; operator reason requires real ignore behavior, ignored secrets/SQLite/build/dependencies, tracked lockfile and deterministic tests. Contracts task t_0mvsoxf1g5eb9fc1bb131 was accepted. Both failed integration because split role guard rejected queue mutex metadata. Initial integration unit6227470 was pushed to dev; its full suite2413pass/7fail/5skip (1947.87s), all five failed files then36/36 serial pass (263.52s). These are predecessor-tree results, not a full green run of current source.

Follow-up source is reviewed/frozen: strict bound merge mutex classification, exact refusal-snapshot preservation, managed split startup before fairness hints, scoped CLI Resume, and panel drain-before-exit. Root independently observed119/119 across11 split/recovery/queue/integration/identity/lease files (254.18s), plus24/24 shutdown/service/operations tests (13.69s). Latest recursive typecheck/build PASS. Earlier wider lock revision had6 real admission failures; repaired without weakening original tests. Root review also found2 shutdown/restart scheduler failures; reproduced and repaired. Full-suite rerun on the combined final tree remains outstanding.

Live restart proved expired attempt recovery/global grant reconciliation into run2 with usage retained, then old pilot failed before new model transport on a retained repository mutation marker. All16 worktrees passed publication/command guards; all tasks/sessions/actions terminal, worker16184/panel stopped. Marker PID18308 absent; SHA2566BA2928C8CB0454776915A1F31FBE0B56AA68BA2FCA0530700616CABBD03DD31, local fixed drive/single inode/nlink1/unchanged bytes verified. Root reversibly renamed ONLY this marker to app .git/meritrouter-mutation.lock.retained-21c51838-5dda-4bce-91e3-417b13dd9a7d. Bytes retained; HEAD/status unchanged; no DB/ref/index edits. Its timestamp correlates with an old stop request but does not prove old PID identity.

Panel stop race separately reproduced with actual handler and real tracked mutation fixture. Repaired API marks stop, awaits Router.close, then schedules one exit; failed drain preserves evidence/no forced exit. Root production verification on seeded OS-temp split demo C:/Users/mrjoh/AppData/Local/Temp/mr-panel-drain-zSzlJJ: first HTTP POSTstop success593ms, clean process exit, no repo/Brain lock, database quick_check ok; second cycle project HTTP200, cross-origin stop403, Chromium screenshot viewed, successful normal stop. Both temporary server cycles/browser stopped. Screenshot overview.png retained as validation evidence. No model/provider calls in demo.

Live config C:/Users/mrjoh/AppData/Local/MeritRouter/meritrouter.config.yaml hash9BBEC711E4B3501ECE3206776A57CFB582B3CAD5F61E7500847D74C5C64F4BA6 unchanged. Project D:/MeritRouterProjects/facebook-mvp; canonical HEAD a63e3be664d0b7fa94d7480723f119271e272284 at latest startup. Runtime data stays under owning project .MeritRouter; no D:/MeritRouter/.MeritRouter. Unrelated retained-api/ui review files remain untracked/untouched.

Next: monitor fresh job, verify real accepted commits reach job branch, handle exact routine command approvals/budget within cap, inspect candidate. Final acceptance requires clean isolated install/seed/test/build; signup/wrong-password/login/logout/session isolation; posts/newest-first/like/unlike/comments; own bio and ownership refusal; people search/friend send/accept/decline; notifications/unread count; viewed desktop/mobile pages/overflow; persistence after restart; exact validated source materialized canonically with reproducible startup and independent FINAL decision. Never accept from compilation or worker report alone. Scope limits and policy-rejected temp cleanup are under Open Questions.

## Worker Briefs

### Brief: integration-review
- Repository: D:/MeritRouter, existing checkout only.
- Task: Read-only review of the retained service-enforced integration fix for pilot safety.
- Required reads: this Current State; git diff for src/harness/delivery-tools.ts, integration-tools.ts, supervisor-tools.ts, src/runners/supervisor.ts, src/storage/tasks.ts; src/storage/integration-obligations.ts; tests/job-auto-integration.test.ts.
- Owns (may edit): docs/working/gate2-auto-integration/reports/integration-review.md only.
- Must not touch: source, tests, configuration, runtime state, application projects, commits or providers. Do not run tests while supervisor validation runs.
- Definition of done: report concrete blockers in acceptance/integration ordering, dependent source selection, failure handling and finish gating, with file references; distinguish unverified claims.
- Report to: docs/working/gate2-auto-integration/reports/integration-review.md.

### Brief: integration-failure-repair
- Repository: D:/MeritRouter, existing checkout; preserve retained edits.
- Task: Reproduce and repair the two blockers in reports/integration-review.md; framework only.
- Required reads: Current State, review report, integration-review named files; relevant merge-queue/context source only as needed.
- Owns (may edit): packages/router/src/storage/integration-obligations.ts, packages/router/src/storage/tasks.ts, packages/router/src/runners/supervisor.ts, packages/router/src/harness/integration-tools.ts, packages/router/tests/job-auto-integration.test.ts, docs/operations.md; report below. Context/upstream.ts and tests/dependent-review-source.test.ts are permitted only if essential to a minimal source-binding repair.
- Must not touch: application projects, config/runtime, other files, shared docs, commits/pushes/providers. No alternate checkouts.
- Definition of done: failing regression first for integration failure/timeout and conflict-created child at finish; enforce accepted upstream integration before dependent release; keep redelegated obligation until replacement is integrated or original explicitly rejected; recompute active children after drain. Preserve recovery, strict acceptance and existing successful integration. Run focused tests serially after supervisor typecheck completes (ask supervisor for clear if needed).
- Report to: docs/working/gate2-auto-integration/reports/integration-failure-repair.md with exact commands/results and limits.

### Brief: split-integration-lock
- Repository: D:/MeritRouter, existing checkout, no alternate checkout.
- Task: Reproduce/fix live split integration refusal `Project store contains unclassified or shared metadata`; likely merge-queue lock meta vs store role guard.
- Required reads: this Current State; src/storage/store-role.ts; src/workspaces/merge-queue.ts; src/projects/runtime-registry.ts; tests/project-store-identity.test.ts, project-service-activation.test.ts and job-auto-integration.test.ts as fixture references. Read further bounded dependencies only if essential.
- Owns (may edit): src/storage/store-role.ts, src/workspaces/merge-queue.ts, new tests/split-job-auto-integration.test.ts (all under packages/router/); docs/operations.md; report below. Propose ownership expansion before editing other files.
- Must not touch: application source, live runtime/config/data, existing other tests, shared working docs, commits/pushes/providers.
- Definition of done: isolated actual split runtime regression demonstrates accept_task integrates and dependent receives integrated head; regression fails before fix and passes after. Keep strict meta/schema ownership: exact validated project-local lock ownership only, reject foreign/malformed/shared metadata; no blanket prefix allowlist or disabling role checks. Preserve queue mutual exclusion and lock cleanup. Run focused serial checks, freeze for root validation.
- Follow-up acceptance: preserve exact queue snapshot on pending publication, foreign source or unowned-pick refusal; original project-metadata-merge-queue tests unchanged, plus split refusal coverage. No unconditional rollback of actual queue effects or unknown source changes.
- Report to: docs/working/gate2-auto-integration/reports/split-integration-lock.md with red/green commands, root cause, boundaries and limits.

### Brief: split-lock-boundary-review
- Repository: D:/MeritRouter, frozen current checkout.
- Task: Read-only independent review of split-store mutex classification repair.
- Required reads: this Current State; reports/split-integration-lock.md; packages/router/src/storage/merge-branch-lock.ts, storage/store-role.ts; git diff workspaces/merge-queue.ts; tests/split-job-auto-integration.test.ts.
- Owns (may edit): docs/working/gate2-auto-integration/reports/split-lock-boundary-review.md only.
- Must not touch: source/tests/shared docs, live runtime/config/projects, providers, commits/pushes. Do not run tests; root validates frozen tree.
- Definition of done: identify concrete flaws in exact key/item/project/store-generation binding, lock acquisition/heartbeat/release, stale-owner recovery and immutable detail retention. Consider bypasses and regressions; report CLEAR or blockers with file references and limits.
- Follow-up review: root found6 unchanged admission snapshot failures. Inspect provisional-binding restoration: only on RepositoryMutationError, exact whole-row snapshot and still-owned nonce; never erase actual queue progress or independent changes. Source frozen during final focused run.
- Report to: docs/working/gate2-auto-integration/reports/split-lock-boundary-review.md.

### Brief: split-recovery-controls
- Repository: D:/MeritRouter existing checkout; all other source frozen, no tests currently running.
- Task: Reproduce/repair split restart and CLI Resume gaps exposed by retained pilot2; framework only.
- Required reads: Current State; src/cli.ts resume dispatch; src/core/service.ts resumeSession/resumeTask/recover; src/core/project-runtime-host.ts and scheduler.ts; relevant project-service-activation.test.ts/session resume fixtures. Bounded further queue/lease runtime reads if needed; report ownership before extra source edits.
- Owns (may edit): packages/router/src/cli.ts, src/core/service.ts, src/core/project-runtime-host.ts, src/core/project-scheduler.ts; new packages/router/tests/split-recovery-controls.test.ts; docs/operations.md; report below. Scheduler.ts edits require proposal first.
- Must not touch: lock repair source/tests, shared docs, live config/runtime/projects/providers, application source, commits/pushes; no alternate checkout.
- Reproduction: stopped owner8420, supervisor session interrupted lease lost at28requests while task remains running with expired lease (1793226928781); completed children2, scaffold externally rejected. New worker7732 did not recover it without queued work; CLI `resume s_0mvsovmzo8ebfbc0be76a --project facebook-mvp` throws `Private evidence requires an explicit project store` because CLI reads sy.sessions before selecting scoped store.7732 stopped quiescent. No state surgery permitted.
- Definition of done: isolated actual split fixture with only expired running task/interrupted session: startup recovers through queue/lease ports OR supported explicit resume reconciles exact expired lease safely; no duplicate transport/budget reset or foreign-project side effect. CLI session/task resume resolves owning store and never queries private installation stores; existing live-owner/generation checks remain. Regression red before fix, green after; test real CLI using rebuilt dist where appropriate. Preserve role guard and immutable source/session history. Report auto-recovery limitation separately if blocked; do not silently fake successful recovery.
- Additional acceptance from root review: stop during awaited first-project startup must not initialize later projects; stop/start on the same ProjectScheduler must rerun startup recovery. Worker reproduced both red (2fail/5skip,5.61s) after first44/44 green; fix these without weakening existing lifecycle tests.
- Report to: docs/working/gate2-auto-integration/reports/split-recovery-controls.md; freeze after focused serial checks for root verification.

### Brief: panel-stop-drain
- Repository: D:/MeritRouter existing checkout; prior source frozen, no root tests running.
- Task: Reproduce/fix panel stop exiting while Router repository work can remain in flight, without weakening stale-lock preservation.
- Required reads: Current State/latest live result; src/operations/panel.ts turnPanelOff; apps/panel/app/api/panel/stop/route.ts; apps/panel/lib/api.ts handle/router lifecycle; core/service.ts close/drain as needed; existing operations-panel/service-close tests.
- Owns (may edit): packages/router/src/operations/panel.ts, src/index.ts; apps/panel/app/api/panel/stop/route.ts; new packages/router/tests/panel-shutdown-drain.test.ts; docs/operations.md; report below. Service.close change requires proposal first.
- Must not touch: application source, live runtime/config/Git locks/data/providers, other source/tests/shared docs, commits/pushes. No alternate checkout.
- Evidence: new worker16184 recovered pilot root into run2 with43requests retained, then failed before model call `internal_error: Repository mutation lock is busy; foreign or stale locks are preserved`. App .git/meritrouter-mutation.lock PID18308 absent, created1793227868795 (~165ms after earlier API stop at1793227868630). Root read-only checked all16 worktrees: no unresolved publications/active command guards. No manual state edits/lock removal.
- Definition of done: prove actual stop API cannot schedule process exit before asynchronous Router/repository drain; failures preserve evidence and do not force exit. Preserve existing sync turnPanelOff API if possible, add narrow async wrapper/public export for route. Tests exercise deferred real/fake drain, error and stop marker ordering; no code-text mirror assertions. Explain exact causal limit: timestamp correlation alone is not proof old PID identity. Run focused tests, freeze/report. Root handles existing lock only via separately verified reversible operator action if safe; never auto-steal/delete stale/foreign locks in this repair.
- Report to: docs/working/gate2-auto-integration/reports/panel-stop-drain.md.

## Work Ledger

### 2026-10-28 — Resume pilot acceptance
- Agent: supervisor
- Changed: created this record and read-only review brief.
- Why: latest handoff records failed pilot and unfinished integration fix.
- Validation: initial process inventory found no live panel/worker; focused test run started, outcome pending.
- Outcome: Partial
- Follow-up: observe tests and review before activating retained build.

### 2026-10-28 — Failure-path regressions reproduced
- Agent: supervisor; worker integration_review
- Changed: assigned framework-only repair after independent static review.
- Why: timeouts/failures released dependencies; finish could miss conflict-created child.
- Validation: supervisor observed initial `pnpm exec vitest run tests/job-auto-integration.test.ts --maxWorkers=1` -> 3 passed, 46.26 s; `pnpm -r typecheck` -> router and panel Done. Worker reports new regressions red (6 failed/2 passed); supervisor independent rerun pending.
- Outcome: Partial
- Follow-up: verify repaired failure paths. Additional root source review found replacement receipt alone cannot retarget original dependency's context; original dependent must stay blocked unless explicitly rebound through supported re-delegation or a validated source-binding change.

### 2026-10-28 — Integrated build and full-suite observation
- Agent: supervisor
- Changed: independently reviewed repaired source, built router/panel and started authorized panel4477.
- Why: validate retained integration change before spending a fresh pilot budget.
- Validation: `pnpm -r typecheck` PASS; `pnpm -r build` PASS; `pnpm exec vitest run --maxWorkers=4 --reporter=default --reporter=json --outputFile=<OS temp>/meritrouter-gate2-full-tests.json` -> 2413 passed / 7 failed / 5 skipped, 219 passed files / 5 failed / 1 skipped, 1947.87s. New job-auto-integration 8/8, team-nesting 7/7, dependent-review-source 22/22 PASS. Failed files: admin-promotions, task-lab-caller, verification-calibration, resilience, roadmap-team. Serial rerun of all five started, pending.
- Outcome: Partial
- Follow-up: observe serial reruns; preserve full-run failure evidence. Config hash unchanged; overview/list/old-job HTTP200; no new model job yet.

### 2026-10-28 — Pilot 2 split integration refusal and independent scaffold rejection
- Agent: supervisor; worker integration_review
- Changed: supported CLI rejected invalid scaffold; stopped owned quiescent model worker8420; assigned isolated split-lock reproduction/repair.
- Why: accepted tasks could not integrate because role assertion rejects local merge mutex metadata; supervisor session interrupted lease lost. Invalid one-line ignore rules must be repaired by runtime worker, not root.
- Validation: inspected supervisor outcomes139/141/148, actual job branch still a63e3be, child sessions complete, no active actions/child processes; CLI reject records supervisor decision. Worker reports isolated split-service1fail/24.63s (root independent repair verification pending).
- Outcome: Partial
- Follow-up: validate narrow framework fix, rebuild/restart at quiescence, recover same pilot with usage preserved; no manual application edits.

### 2026-10-28 ? Follow-up split integration and recovery verified
- Agent: supervisor; workers integration_review, split_recovery, split_lock_review.
- Changed: strict bound mutex ownership, refusal snapshot preservation, child startup recovery before queued hints, scoped Resume and lifecycle guards.
- Why: live split metadata refusal, then expired-running-only startup/CLI failures; root caught6 intermediate admission and2 lifecycle regressions.
- Validation: root119/119 in11files254.18s; recursive typecheck/build PASS. Worker red/green details in owned reports. Full combined-tree suite still pending.
- Outcome: Accepted for focused source behavior; live product acceptance open.
- Follow-up: retain scope limits; monitor actual application delivery.

### 2026-10-28 ? Retained marker inspected; shutdown race repaired
- Agent: supervisor; worker split_recovery.
- Changed: exact-hash/absent-PID/single-inode reversible marker archive, no Git history/database edits; async panel close/drain before exit.
- Why: recovered pilot run2 stopped safely on retained marker; actual stop-handler tests independently reproduced a drain race.
- Validation: all16 project worktree guards clear; archive bytes and canonical HEAD/status unchanged. Root shutdown24/24, recursive typecheck/build PASS. Isolated production demo2cycles: first-stop593ms, database ok/no lock, project200, foreign Origin403, viewed screenshot, normal stop; temporary browser/server stopped.
- Outcome: Accepted focused repair; historical PID causation unproven.
- Follow-up: preserve archived evidence and failed43-request job; no automatic stale-lock stealing.

### 2026-10-28 ? Fresh retry under remaining trial budget
- Agent: supervisor.
- Changed: supported startJob created t_0mvsr8qoi4c6b92cdff6b with357 requests/maxPaidUsd0, explicit environment/ignore/CSS/deterministic-test requirements; worker17808 started.
- Why: prior failed internal-error job is not a supported resumable delivery; preserve it rather than editing its state or resetting charges.
- Validation: new job running12 requests/$0 at last read; total trial55/400; panel route200. No manually authored application source. Earlier43 requests retained.
- Outcome: Partial.
- Follow-up: complete actual application and FINAL acceptance; main remains held.

## Open Questions

- Supervisor follow-up: configured non-supervise profiles can use mode=supervisor (confirmed in config schema and worker-containment/client-supervision tests), but split mutex metadata admission currently supports literal supervise only. This is a retained split compatibility limit, not proof of general custom-supervisor integration. Add a dedicated custom-mode split integration fixture before extending support. Legacy unbound crash-retained mutex metadata also remains fail-closed; no silent migration/deletion.
- Cleanup: automatic approval review rejected forced recursive removal of OS-temp failed-test fixtures meritrouter-test-zbcRGx, meritrouter-test-Ld1zh0 and worker fixture meritrouter-test-hXi6rw. Leave them recorded; do not retry through alternate deletion tools. This does not block pilot recovery.
- None requiring user input before isolated validation.

### 2026-10-28 - Fresh scaffold dependency failure observed
- Agent: supervisor.
- Changed: approved exact source-bound install after manifest review; denied subsequent build after install failed, returning observed ETARGET and deterministic-test/SQLite-ignore feedback to runtime worker.
- Validation: action wa_0mvsrbi213e1a843343e3 completed exit1: unpublished @types/better-sqlite3@^12.0.0. Build action wa_0mvsre78faa636fcfc92c denied through supported panel API. Fresh job42 requests/$0 at latest read (trial85/400).
- Outcome: Partial; application still not accepted; no application source authored by supervisor.
- Follow-up: worker repairs dependencies; full follow-up framework suite started serially, evidence OS-temp meritrouter-gate2-followup-full.json, outcome pending.
