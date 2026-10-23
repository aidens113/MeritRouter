# Correctness, containment and panel flows
Status: Complete
Status detail: F1-F6, worker containment/security settings and panel flows implemented with offline integration, browser and installed-package acceptance.
Created: 2026-10-23
Last updated: 2026-10-23
Owner: Senior supervisor agent
Scope: Worker repository boundaries and supervisor escalation, repeat-loop/evidence fixes, honest cache metrics and connected job/task/request UX.
Paired document: none
Related: [audit](post-change-fix-audit.md), [handoff](handoff.md)

## Current State

Delivered offline corrective unit. Supervisor acceptance is recorded in
[the acceptance report](correctness-and-panel-flows/reports/supervisor-acceptance.md).
All15 original full-suite failures are corrected and rechecked; final affected162/162 plus
native/resume/evidence61/61 and package/operations16/16 pass. Final recursive typecheck/build
and installed tarball CLI/MCP/bundled panel/live approval pass. No live deployment occurred.
Earlier validation snapshots below explain integration history; final evidence above wins.

User authorized implementation of F1-F6 and expanded containment: all worker functions/commands
must stay within their assigned repository sandbox. Outside actions require a supervisor request;
supervisors are exempt from worker containment, retain existing project/user policy and must not
silently grant blanket worker host access. Shell cwd/allowlist is not containment. Fail closed
where an OS sandbox cannot be established; provide a usable persisted supervisor request path.
Panel work includes job children/requests visibility, scoped links and back navigation across
jobs/tasks/requests/sessions; audit beyond the two concrete examples and fix material gaps.

Baseline dev8074a28 with pre-existing uncommitted live-run fixes. Feature branch
feat/post-change-corrections carries those changes forward; do not discard them.
Three workers own disjoint files. Supervisor owns integration, metrics core/CLI, docs and acceptance.
No broad validation until workers freeze; focused tests may run during non-overlapping work.
No paid/provider work, user config/stores, actual4477 or downstream projects. Use temp/demo.
Migration ownership: security worker only, append at actual current end if needed.
New user requirement: security.outside_repository has disabled, human_only (default), supervisor.
The setting governs model-controlled host actions including direct supervisor command paths;
current policy is reloaded on filing/approval and while approved processes run. Human-only cannot
be self-approved. Disabled forbids host/network operations; scoped repo/brain/artifact reads remain.
Security settings and decision cards are implemented; cross-origin mutating panel calls refused.

Implemented source: repeat fresh observations/duplicate-effect handling; command broker/one-shot
approvals; supervisor command policy; worker network/Lab mediation; linked job children/all-descendant
requests and filter-before-pagination; task unknown cache totals and explicit summary bounds.
Root observed usage/provider tests19/19 (13.96s), outside-operation5/5 (3.86s). These are focused
checks, not acceptance of the moving tree. Worker reports require supervisor recheck.
Fixture migration uses explicit temp-only trusted operator; default production approvals unchanged.
Source is frozen for integrated validation. Supervisor observed recursive typecheck and recursive
router/panel production build pass. Latest focused security/repeat/artifact/read-only set:34/34.
Broad runs were interrupted to migrate legacy unrestricted-shell fixtures and fix a real
Windows newline compatibility failure; exact integration acceptance now passes. Demo seed
passes its assertions after its explicit operator was changed to use the simulated clock.
Browser acceptance passes all touched routes and scoped operator API cases,13 screenshots
inspected (desktop/mobile/dark), zero browser exceptions. Live DOM task/request/brain updates
pass without reload. Runtime panels remain isolated to demo4489; no push or live restart.
Final source review fixed stale supervisor command approval identity and a known-not-applied
resume duplicate guard bug (including durable proof across another interruption).
Supervisor fixed native explicit context to use its isolated base and observed regression pass.
Full frozen suite completed:1150passed,15failed,2skipped /1167tests in116files (1168.56s).
Failures grouped into missing guarded Git verbs, legacy approval/context/display fixtures,
channel durable-replay metadata, custom supervisor mode compatibility and nested brain mounts.
Root fixes and reruns: task-prune11, plan-recovery1, Git16, policy14, session CLI6, upstream/team
graph11 passed; new scoped approval live watcher20passed separately after fixing a test table name.
Workers report channel/nesting/integration/calibration31passed, web33/Lab1/queued authority9 and
outside authority10passed. Supervisor subsequently rechecked the final affected source162/162.
Nested commit:true brain mount compatibility is restored with scoped commits that preserve
outside staged work; no generic Git-root guard exemption. New core supervisor authority uses
actual persisted task/lease and current trusted configured mode; custom profiles remain supported.
Supervisor final affected run162/162 in15files (186.90s) passes, including all worker corrections,
fresh-dist client stdio/HTTP, nested mounts and approval watcher. Final recursive typecheck/build
pass. Outside-checkout tarball install/CLI/MCP42tools/bundled panel and live approval pass:
Final1220ms insertion-to-DOM, exact command exit0, settled history without reload,0browser exceptions.
Screenshot inspected. Additional native/resume/evidence61/61 pass; packaged build-age false
warning fixed with validated content fingerprints and warning-free reinstalled acceptance.
All owned temporary panels/Chrome stopped, ports4489/4491/9335 closed. Accepted source commit1092881;
merged as4e0138b and published to dev/main on2026-10-23 after unchanged-dev merge verification.
Local feature branch removed. No live panel/MCP restart or npm publication.
No deployment acceptance claimed. See reports/supervisor-acceptance.md for exact evidence/limits.
Network Git verbs remain denied (automatic brain push unavailable under guarded Git; trusted
operator backup uses its separate fixed path). No user config, user stores or actual4477 touched.

## Execution phases

1. Security worker: inspect all runtime tool/runner entry points, implement worker boundaries and
   supervisor request/decision execution. Send architecture/contract early for review.
2. Harness worker: fix mutable reads/repeat suppression and safe transient recovery; preserve
   side-effect/journal guarantees and final-request-only terminal behavior.
3. Panel worker: inspect/fix scoped UX and unknown cache display; expose safe request/approval
   entry points after backend contract lands, serial follow-up if needed.
4. Supervisor: F5 usage/CLI semantics; integrate F3 evidence/F4 fixture with security worker,
   review all worker changes, check untrusted runtime schemas and bypasses.
5. Frozen acceptance: affected tests, recursive typecheck/build, full router suite (bounded
   concurrency), isolated production-demo routes/API/desktop+phone screenshots and package check.
6. Update authored docs/handoff, commit coherent changes with worker trailers; merge dev only
   after acceptance. Push/main promotion follow repository policy; no live restart inferred.

## Worker Briefs

### Brief: post-suite corrections (wait for supervisor thaw)
- Final package follow-up: panel worker owns operations/panel.ts, scripts/package-build.mjs, package manifest files allowlist and relevant tests. Replace unreliable packaged-file mtime freshness with validated deterministic router-content fingerprint, preserve workspace mtime fallback. No blind warning suppression; root repackages/reinstalls and validates. Worker reports in own nested-brain-mounts report; no shared docs/builds/commits.
- No source edits until running full suite finishes and supervisor explicitly dispatches.
- Panel worker owns admin/brain-entities.ts, brain/brain.ts only if needed for scoped blame, and admin-brain-entities.test.ts: verified actual Git root with original mount prefix/common-dir preserved; filter rename/history/whole-commit paths before subject/content disclosure. No generic containment exemption. Send inventory/focused evidence.
- Panel extension approved for previously supported commit:true nested mounts: new brain/mount-git.ts owns verified mount/root/history normalization; Brain delegates. Also attribution/index.ts and attribution.test.ts to make existing commitAs opts.paths actually select only those paths for staged diff and commit (--only), preserving unrelated staged/unstaged content. Reuse attribution architecture rather than duplicate actor/env/trailer logic. Mounted adoption must exclude its lock. Test new/deleted documents, adoption, outside cached diff unchanged, history privacy, redirect refusal and managed worktrees. No broad Git guard exemption.
- Repeat worker owns harness/channel-tools.ts and tests/{team-channel,team-nesting}.test.ts: post_channel uses its durable dedupe through observe metadata; preserve lost-outcome/no-duplicate assertion. Reproduce nested-job timeout with pending/last-turn diagnostics, fix exact fixture/runtime cause rather than guessing or increasing waits. Ask before unrelated product edits.
- Repeat worker serial follow-up also owns tests/team-integration.test.ts (same nested timeout) and verification-calibration.test.ts (direct supervisor fixture needs real lease/policy/approval authority). Preserve original integration, undo and calibration assertions; no synthetic authority bypass.
- Security worker owns config/schema.ts; host-authority checks in harness/{worker-actions,outside-operation}.ts and labs/control-authority.ts; tests/{client-supervision,web,worker-containment,outside-operation}.test.ts and labs-scripted.test.ts. Permit user-configured custom supervisor profiles; actual persisted cfg profile mode plus original live lease establishes supervisor authority (model role text never does). Keep supervise binding correct; preserve external root/client dispatch policy. Update literal-name host checks consistently if needed; add custom-supervisor positive/forged role negative test. Native workers remain mediated even supervisor outside mode. Migrate Lab fixture exact operator + explicit supervisor policy; retain telemetry coverage through authoritative supervisor/fixed WebAccess, plus pending/no-network worker case.
- Security extension approved: harness/worker-action-tools.ts, harness/tools.ts, runners/coding/task-lab.ts and a new leaf core/supervisor-authority.ts for consistent current persisted mode+lease checks. Repeat worker now owns channel-tools only, so no overlap. Avoid runtime TaskStore/core/task cycles through Lab schemas; use leaf lease schema/direct authoritative validated rows. Report all changes and test current mode revocation.
- Supervisor owns guarded Git verb inventory (switch/diff-tree only), CLI cache-display assertion, scoped upstream fixture ownership, admin/live.ts + admin-live.test.ts, all integration/docs/package/browser checks.
- Supervisor also owns policy.test.ts unknown-artifact message assertion if confirmed; unknown and foreign artifacts must remain indistinguishable to callers.
- Workers only focused checks/temp fakes, no shared docs except own report, no commits/full suite. Return exact inventory and limitations then freeze. Narrow reruns of changed code/failures follow F6 release gate; do not repeat unrelated passing suites.

### Brief: acceptance-regressions
- Repository: shared feature checkout, source thawed after interrupted full run.
- Panel worker owns workspaces/git-process-policy.ts and git-process-containment.test.ts only: preserve trusted global newline settings without executable config/includes/env injection; test mixed raw/protected Git CRLF integration. Report git-process-containment.md.
- Repeat worker owns tests/coding.test.ts and external-task-tools.test.ts only: migrate obsolete unrestricted external-worker expectations to explicit sandbox-unavailable/no-side-effect coverage; retain direct process/policy bridge tests where meaningful. Report fixture-approval-migration.md.
- Security worker owns tests/task-lab-caller.test.ts only: adapt automatic worker Lab expectations to fail-closed request semantics, retain immutable lease/source/pin coverage through direct supported APIs. Report queued-lab-authority.md.
- Workers read this Current State and owned files; no shared docs/product edits beyond named files. Focused checks only, no full runs, no commits. Preserve meaningful coverage; report unsupported cases rather than weakening production boundaries.
- Supervisor owns integration, source scope fixtures and final acceptance. All test effects stay temp/demo; any external path needs supervisor authorization.
- Serial repeat-worker follow-up also owns tests/qualification.test.ts and team-surface.test.ts: replace obsolete external execution with native scripted equivalents to preserve qualification/charter behavior coverage. Supervisor owns session-recording.test.ts migration. No broader ownership.
- Final fixture pass: repeat worker owns tests/supervisor.test.ts; security worker owns tests/session-faults.test.ts; panel worker owns tests/resilience.test.ts. Read owned cases and explicit helper; retain crash/restart semantics, add narrowly scoped fixture operator approvals for declared checks (cross-process resilience needs a live fixture operator). No product changes/shared docs. Focused tests, reports, source freeze; full suite paused before these edits.
- Resume regression repair: repeat worker owns harness/{loop,resume,tools}.ts and harness-repeat-policy.test.ts; known-not-applied edit reconciliation must allow a fresh retry, while actual/unknown effects stay protected. Use trusted reconciliation metadata, not parsing model output/prose. Coordinate security session-faults reproduction, preserve crash tests. Supervisor owns native pinned context bug discovered by roadmap-team regression. Focused checks before refreeze.
- Resume repair extension: repeat worker also owns sessions/{events,resume}.ts to persist trusted known-not-applied metadata across another interruption and avoid treating calls without intent as effects. Backward compatible optional schema fields; never infer proof from model text. Supervisor approves this bounded extension.
- Optional resumed-event proof persistence also grants repeat worker sessions/recorder.ts and directly necessary bounded same-subsystem typed glue/tests; report full inventory before freeze.
- Final security review correction: security worker owns harness/{worker-actions,supervisor-tools,integration-tools}.ts and runners/supervisor.ts plus worker-containment.test.ts for trusted supervisor command invocation IDs. Fresh check invocations require new approvals/evidence even at unchanged source; exact logical replay stays one-shot. Coordinate no ownership overlap (repeat owns resume/loop/tools only), focused tests/report then freeze.

### Brief: worker-containment
- Repository: D:/SwitchYardRouter, shared feature checkout; no independent Git changes.
- Task: Implement user-required worker repo containment, supervisor out-of-sandbox requests and audit F2-F4 evidence fixes. Send concrete design/file inventory early before major edits.
- Required reads: this Current State; audit F2-F4; tools, readonly/native/external runner/finish/verification command call paths and existing question/budget request architecture.
- Owns: src/harness/tools.ts (body AND interface), supervisor-tools.ts, resume.ts; runners/coding/** and readonly.ts; context/repo-reader.ts; core/validate.ts; new specifically named containment/escalation files under owning areas; ONE appended storage migration if needed; new tests/worker-containment*, readonly-checks.test.ts and proportionate existing tests for these boundaries.
- Owns: new admin/worker-actions.ts if needed, new CLI/MCP files if requested first; supervisor owns index.ts integration. Do not modify other source without coordination.
- Must not touch: harness/loop.ts or repeat-policy files; any panel files; storage/usage.ts; shared docs; existing native/budget/session test files until assigned for serial integration.
- Enforce on actual service/tool paths, including post-submission/reviewer checks and external command/OpenCode runners; do not claim cwd, prompts, allowlists or Git worktrees as OS containment.
- No direct unsandboxed worker shell fallback. If no accepted OS sandbox use persisted bounded supervisor action requests; supervisor executes with explicit scope, not a blanket worker bypass. Keep supervisor exemption within existing host/project policy.
- Scope file APIs to authorized repos/paths (symlink/junction/.git escape); inspect worker network/Lab/brain/artifact access and communicate intended scoped capability semantics, no arbitrary host access.
- Persist requests/decisions with Zod validation, task/project/generation authority, cancellation, bounded output, duplicate/replay handling and original command cwd/source identity. Support jobs and standalone tasks with explicit supervisor/operator path.
- Preserve check records/evidence across resume, >1000 mixed events and failed/budget outcomes; fix five-turn fixture caps under final repeat policy. Do not widen production budgets.
- Definition of done: outside sentinels unchanged on Windows, deterministic tests for denial/pending/approval/rejection/foreign task/lease loss/duplicate, pinned source and evidence resume; no user/provider operations. Focused checks only; supervisor runs broad validation after freeze.
- Report to: docs/working/correctness-and-panel-flows/reports/worker-containment.md

### Brief: repeat-handling
- Repository: D:/SwitchYardRouter, shared feature checkout; no Git changes.
- Task: Implement F1 with mutable-state reads actually fresh, bounded no-progress/transient handling and conservative duplicate effects.
- Required reads: this Current State; audit F1 and reports/harness; harness/loop.ts/journal.ts and tool metadata read-only.
- Owns: harness/loop.ts, new harness/repeat-policy.ts if useful; tests/native.test.ts and new tests/harness-repeat-policy.test.ts or harness-progress.test.ts.
- Must not touch: tools.ts/supervisor-tools.ts/resume.ts, other existing tests, any panel, shared docs, storage/config/runners. Coordinate metadata additions with security worker.
- Keep existing repeatBehavior execute contract; live reads need actual rerun and state-aware stall rather than forever cached output. Bounded commands respect their own limits; preserve side-effect duplication protection and unknown-effect reconciliation.
- Tests: task_result->await->same result sees completion; channel/approval status refresh; transient read error recovers; stable repeated errors/reads terminate boundedly; GET/check service recovery; duplicate edit not applied twice; final-request-only terminal offered; cancellation/resume invariants.
- Definition of done: focused deterministic tests pass; no providers/Labs real engines/live config. Report exact limits. Run only focused files; broad tree checks wait for freeze.
- Report to: docs/working/correctness-and-panel-flows/reports/repeat-handling.md

### Brief: panel-flows
- Repository: D:/SwitchYardRouter, shared feature checkout; no Git changes.
- Task: Audit and fix logical job/task/request/session UX, including job children and all job requests with correctly scoped links and counts. Fix F5 unknown-cache presentation in panel.
- Required reads: this Current State; actual job/task/request routes/components and admin facade. Audit beyond examples; identify missing, hidden or misleading navigation.
- Owns: apps/panel/**; src/admin/{jobs,job-plans,job-team,entities,insights}.ts and new named admin/job-requests.ts if needed; new tests/admin-job-navigation.test.ts and proportionate existing admin tests. Supervisor owns public index.ts export changes; coordinate needed DTO exports.
- Must not touch: harness/runners/core/config/storage, usage.ts, shared docs, other existing tests unless assigned. Do not duplicate service/data access in panel.
- Show immediate children and nested job structure with links even without plan rows; expose job-wide requests including descendants with unambiguous task/job labels. Preserve authoritative project scope; do not infer scope from query params alone.
- Ensure job->task->request->session and back links, useful empty states and scoped filtering/pagination; inspect global/legacy redirects and mobile flows. No pointless tabs or blanket unrelated redesign.
- Cache null means unknown, never0; preserve measured zero. Supervisor handles storage/CLI semantic fixes; request DTO coordination early.
- If worker-action backend lands, follow up for discoverable requests/decisions using its validated admin API; do not invent raw DB writes/UI-only enforcement.
- Definition of done: source-backed UX findings and implemented fixes, appropriate backend tests, no live4477/user config. Broad builds/demo/browser waits until supervisor freeze; provide route matrix and screenshot plan. No real provider calls.
- Report to: docs/working/correctness-and-panel-flows/reports/panel-flows.md

### Brief: fixture-approval-migration
- Repository: shared D:/SwitchYardRouter feature checkout, no Git changes.
- Task: Add explicit trusted test-operator fixtures and migrate legacy shell/check test scenarios after new human-only default; preserve fail-closed external-worker expectations.
- Required reads: Current State; harness/worker-actions.ts broker; tests/helpers.ts and named test scenarios.
- Owns: tests/helpers.ts; tests/{native,budget-control,verification-review,verification-calibration,verification-resume,projects-router-fixes,team-integration,team-nesting}.test.ts; new tests/fixtures/supervisor-actions.ts if needed.
- Must not touch: any product source, readonly-checks.test.ts/worker-containment tests (security owns), panel, other shared docs.
- Implement opt-in openWithTestSupervisor, bounded exact operator approval in temporary fixture roots only, checking command declared by fixture task or configured fixture allowlist; stop/drain poller on sy.close. Never production auto approval or arbitrary host path commands.
- Import alias in legacy files only as needed; do not weaken budget/tool assertions for unrelated semantics. Preserve explicit pending/denial tests (no helper there). Coordinate readonly helper import with security worker.
- Definition of done: focused changed tests pass or exact remaining failures reported. No external models/engines/user data. Do not run broad tree checks until freeze.
- Report to: docs/working/correctness-and-panel-flows/reports/fixture-approval-migration.md

### Brief: git-process-containment
- Repository: shared feature checkout, no Git state changes.
- Task: Harden fixed internal Git operations so repository/model-controlled config cannot execute host hooks/fsmonitor/filters/merge/textconv/trailer/GPG commands; no shell cwd claim.
- Required reads: Current State; workspaces/git.ts, attribution/index.ts and configured Git invocations; existing worktree/attribution tests as needed.
- Owns: src/workspaces/git.ts; new src/workspaces/git-process-policy.ts if needed; tests/git-process-containment.test.ts; report only.
- Must not touch: runners/coding/task-lab.ts (security owns), other source/test/shared docs. Expose safe sync policy helper for its raw execFileSync if needed, coordinate security.
- Use fixed -c core.fsmonitor=false/core.hooksPath null-device/commit.gpgsign=false, sanitized config injection env, no external diff/textconv. Handle Git clean/smudge/process/merge/trailer config without invoking arbitrary repo programs. Conservative fail-closed diagnostics acceptable where cannot preserve conversion safely, but no silent executable path.
- Preserve normal Git metadata/attribution and Windows/Linux behavior. Test malicious repo-defined hook/filter/fsmonitor/trailer/merge script with outside sentinel untouched plus ordinary stage/commit/worktree behavior. No provider/user repos; temp only.
- Definition of done: focused regressions pass, report limitations/compatibility, source frozen. No broad checks. No commits or --no-verify tool commands.
- Report to: docs/working/correctness-and-panel-flows/reports/git-process-containment.md

### Brief: security-integration-review
- Repository: shared feature checkout, read-only review; no Git changes.
- Task: Independently review user-required disabled/human_only/supervisor enforcement, request authority and remaining model-to-host bypasses after implementation. Prioritize exploitable current paths and practical fixes.
- Required reads: Current State; changed broker/tool/runner/context/artifact/security config paths. Read source, not worker claims.
- Owns: reports/security-integration-review.md only under this effort.
- Must not touch: all product/tests/shared docs; no broad tests/providers/live state.
- Check lifecycle authority after awaits, direct supervisor paths, worker Lab/taskLab internal process starts, HTTP operator API identity, config edits, artifact grants and resume; distinguish fixed service capabilities from arbitrary host effects.
- Definition of done: concrete source anchors, trigger/consequence and fix suggestions, false positives ruled out. Send critical bypasses immediately. Source frozen after integration follow-ups.
- Report to: docs/working/correctness-and-panel-flows/reports/security-integration-review.md

### Brief: queued-lab-authority
- Repository: shared feature checkout, no Git changes.
- Task: Close queued model Lab command bypass/revocation: capture original supervisor task lease when queuing; enforce current outside policy and lease before every physical process/network effect and after awaits. Human/operator Lab controls remain explicit operator actions.
- Required reads: Current State; labs/{control,lab,services,checks}.ts and tests/labs-team.test.ts as needed.
- Owns: labs/{control,lab,services,checks}.ts; new named labs/control-authority.ts if useful; append ONE new migration for durable authority after worker-actions migration if needed; new tests/worker-lab-authority.test.ts. Existing broader tests only request assigned fixes.
- Must not touch: labs/tools.ts, harness/outside-operation.ts or other harness/root files; shared docs; other workers' files. Coordinate options API/root call sites immediately.
- Capture typed LeaseRef in trusted control options, persist with operation, validate requested task/project/profile supervisor mode AND security.outside_repository=supervisor at execution; reject task:-prefixed legacy/unproved ops. API callers cannot spoof actor JSON.
- Recheck authority before spawning later services/checks after health waits; abort operation-owned running effects on policy/lease loss; do not kill unrelated human services. Queued after_integrate cannot bypass human-only/disabled.
- Definition of done: deterministic temp/fake tests show queue then disabled/cancel/reincarnation => zero new effects; midawait revocation blocks subsequent starts; original supervisor mode positive; operator route distinction. No real providers/engines/live config. Source freeze, focused checks and report.
- Report to: docs/working/correctness-and-panel-flows/reports/queued-lab-authority.md

### Brief: demo-security-fixtures
- Repository: shared feature checkout, no Git changes.
- Task: Adapt demo seed to explicit trusted temporary operator approvals and supervisor policy so native scripted checks/jobs still seed under new production human-only default. Keep all effects under apps/panel/.demo.
- Required reads: Current State; apps/panel/scripts/seed-demo.mjs; tests/helpers.ts explicit approval fixture pattern.
- Owns: apps/panel/scripts/seed-demo.mjs; report only. Do not modify live acceptance script or other source/tests/shared docs.
- Set supervisor policy explicitly in demo config only; worker host commands still require exact fixture operator decisions. Approve only task-declared fixture checks or specifically named deterministic fixture probes, cwd canonical within verified .demo. Deny all generic operations; no providers/engines.
- Stop/drain owned approval poller before seed sy.close. Preserve warning-free fixture assertions, scope provenance, and seed-generated config security current default/reset behavior. No test against live install.
- Definition of done: source frozen and seed command evidence after current router build available; no broad source checks. Confirm .demo resolved path before any seed deletion; cleanup no user data.
- Report to: docs/working/correctness-and-panel-flows/reports/demo-security-fixtures.md

## Work Ledger

### 2026-10-23 - Execution authorized and partitioned
- Agent: supervisor
- Changed: execution working document and feature branch; existing dirty work preserved.
- Why: user approved fixes and expanded worker containment plus UI audit.
- Validation: baseline status/worktrees and audit reviewed; not yet validated.
- Outcome: Partial
- Follow-up: integrate worker contracts, implement supervisor-owned usage fixes and run frozen acceptance.

### 2026-10-23 - Integration corrections and isolated browser acceptance
- Agent: supervisor; workers panel-flows, repeat-handling, worker-containment
- Changed: exact action broker and policy, Lab queued authority, fixed internal Git process policy;
  linked job children/requests, unknown-cache displays, strict operator API and Security settings.
  Migrated obsolete external-runner fixtures to explicit refusal or native supported behavior.
- Findings fixed: global Git newline conversion compatibility, seed operator simulated-clock
  mismatch, loopback same-origin false rejection, native context reading source instead of
  isolated base, garbled dashboard punctuation and vertical tab overflow. Added grep to guarded
  fixed Git command inventory after source call-site review.
- Supervisor evidence: recursive typecheck passed on final source; recursive production build
  running. Focused Git/context21/21, sessions10/10, usage/providers19/19 and earlier security34/34.
  Worker freshness12/12 and final resume claims still need frozen full-suite confirmation.
- Demo: seed assertions passed, including nested team3integrations/1rebase; exact fixture
  operator uses simulated clock. Early supervisor inspection against real time affected one
  sample multiply task; no user data was used. Seeded failures remain genuine demo history.
- Browser: production demo4489, headless Chrome9335 temporary profile. Route/API matrix passes,
  scoped job9requests vs7supervisor-only; foreign404, forged actor400, cross-origin403,
  invalid config400, disabled409, exact node --version200, repeat409.13screenshots inspected;
  zero browser exceptions. Task/request/brain DOM updates738-1493ms, document preserved;
  quiet page2500ms had0refreshes. Demo panel stopped; owned Chrome retained for package check.
- Outcome: Partial; final full suite/package acceptance pending. No commit/push/deployment yet.

### 2026-10-23 - Final supervisor acceptance
- Agent: senior supervisor
- Changed: reconciled Current State in handoff, roadmap/distributed/live validation; recorded
  exact acceptance and limits in reports/supervisor-acceptance.md. Package freshness uses
  bounded validated runtime fingerprints, preserving workspace mtime warnings.
- Validation: final recursive typecheck/build pass; full1150pass/15fail/2Linuxskips followed by
  all15 corrected, supervisor affected162/162 + regressions61/61 + package operations16/16.
  Final outside-checkout installed CLI/MCP42tools/bundled panel/live approval1220ms pass,
  no stale warning/reload/browser errors; final screenshot inspected. Owned services stopped.
- Outcome: Complete for this corrective unit; no user data/providers/actual4477 deployment.
- Follow-up: only separate roadmap phases and deployment/live-provider acceptance remain.

## Open Questions

None blocking offline implementation. Generic OS containment must fail closed until supported;
supervisor-mediated requests provide the required escalation path. No deployment/provider budget implied.
