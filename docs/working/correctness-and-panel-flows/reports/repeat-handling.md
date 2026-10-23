# Repeat handling implementation report
Outcome: Done
Date: 2026-10-23
Owner: repeat-handling worker

## Changes
- `harness/loop.ts`: fresh actual executions for reads, with three identical outcomes per canonical signature as the no-progress bound. Changed outcomes reset that signature; successful mutation/progress clears observation windows.
- `harness/repeat-policy.ts`: isolated outcome comparison, including bounded identical read failures. Explicit execute tools retain service/task limits, with three identical failure outcomes stopping retries.
- Side effects keep conservative duplicate suppression, including failure outcomes that may follow actual mutation. A different successful edit changes the workspace revision and allows A -> B -> A. Immediate identical edits remain blocked. Other successful actions do not erase external effect protection.
- Resume reconstructs effect protection from resumed tool transcript; fresh observations restart their bounded window. Existing applyResume reconciliation remains authoritative for pending effects.
- Final request both offers and physically permits only the terminal tool; unsolicited tool calls do not execute. Aborted tool failures propagate cancellation.
- `tests/harness-repeat-policy.test.ts`: seven deterministic loop tests cover mutable task/channel/approval refresh, transient recovery, unchanged-result bound, changed-output reset, GET/check recovery, stable GET bound, immediate edit duplication/A-B-A, uncertain external error, final-only execution, resume and cancellation.
- `tests/native.test.ts`: updated read assertions for fresh observations and explicit terminal-only final request budget. External worker fixture now verifies fail-closed sandbox refusal, no worktree and unchanged source, matching security worker's deliberate behavior change.

## Validation
- New harness suite: 7/7 pass (latest run 2026-10-23 11:31:32 host time, 773ms).
- Native full file: 10 passing plus external-worker expectation failure during security integration. Fixed old success expectation, then fixed no-worktree assertion after observing refusal occurs before workspace allocation.
- Native external-worker targeted rerun: 1 pass / 10 filtered skips, 3.52s. Other 10 native cases passed in preceding full run.
- Prior targeted native repeat/nudge cases: 3 pass / 8 filtered skips.
- No broad typecheck/build, full router suite, real providers, Lab engines, user configuration or live panel operated. Supervisor owns frozen-tree acceptance.

## Integration notes
- Security worker owns HarnessTool.repeatBehavior widening and declared checks execute metadata.
- Supervisor owns Lab tool gating and metadata: GET/HEAD => observe; declared bounded checks => execute. No Lab source edits by this worker.
- Fresh observation guard does not infer semantic progress from differing log timestamps; task/model/service budgets remain the ultimate bound.
- No commits or shared working-document edits made. Existing uncommitted changes preserved.

## Follow-up fixture review requested by supervisor
- Approval helper consumers: native, budget-control, readonly-checks, verification-review/calibration/resume, task-lab-caller, projects-router-fixes; gate-request-capture needs confirmation. Synthetic verification records need no auto approval.
- External coding/task-tools successful host process fixtures cannot use approval helper to bypass sandbox refusal; migrate scenarios to native or test disabled behavior explicitly.
- Recommended helper is opt-in, temp-fixture-only, verifies realpath cwd inside test root and exact persisted task declaration, uses broker decision service with task/project/generation authority, and stops its own bounded polling with service close. Supervisor owns helpers.ts.

## Trusted resume absence repair (2026-10-23)
- Fixed the real crash regression: an edit intent logged before the edit ran was being restored into duplicate-effect protection even after reconciliation proved no edit applied.
- `harness/resume.ts` now returns trusted occurrence indexes for effects proven absent. Successful Git reconciliation must show no dirty/since edits and the recorded HEAD unchanged; the planner additionally verifies no recorded workspace head advanced since before the original intent. Missing/failed/changed workspaces remain unknown and protected.
- `sessions/resume.ts` creates structured absence proofs for calls with no intent and verifies persisted proofs for later resumes. Each proof binds the entire transcript prefix, tool index and call ID; model prose, reused call IDs and compaction cannot grant retry authority to a later applied occurrence.
- `sessions/events.ts` and recorder.ts add optional backward-compatible resumed metadata. The reconciled transcript is synced before proof persistence, so an immediate second interruption can recover the same trusted proof. Existing action[] shapes remain unchanged.
- `harness/loop.ts` skips only those proven absent occurrences when rebuilding duplicate-effect protection. Applied/unknown calls retain existing protection.
- `harness/tools.ts` passes trusted env.toolInvocationId to both supervisor generic/declared command helpers, as coordinated with the security worker.
- Test coverage now includes absent/applied/unknown recovery, actual reconciliation plus a second interruption, reused call-ID protection, transcript mismatch and structured never-started-call proof. Existing real session crash assertions retained unchanged.
- Initial focused observed checks: session-faults10/10 + repeat14/14 pass (43.73s), session-resume12/12 pass (4.78s). Final combined frozen3-file recheck pending below. git diff --check for six changed source files + test passes with line-ending advisories.
- Source inventory: harness/{loop,resume,tools}.ts; sessions/{events,resume,recorder}.ts; tests/harness-repeat-policy.test.ts. No other product/tests changed in this repair; no broad suite/commit/provider/live operations.
- Legacy logs without structured absence proof remain conservative. A changed/compacted transcript invalidates that occurrence's old proof rather than transferring it to another effect.
- Final FROZEN combined recheck: npx vitest run tests/session-faults.test.ts tests/session-resume.test.ts tests/harness-repeat-policy.test.ts --maxWorkers=1 --minWorkers=1 ->36/36 pass across3 files,48.36s (session-faults10,session-resume12,repeat14). Source/tests frozen for supervisor acceptance; no remaining focused failures.

## Post-suite channel/nested-team corrections (2026-10-23)
- `harness/channel-tools.ts`: post_channel now uses observe repeat semantics. Its durable ChannelStore dedupe must execute on a replay of an outcome-unknown post; unchanged results remain bounded. Original lost-outcome test is unchanged and verifies one persisted post.
- Reproduced nested timeouts in team-nesting/team-integration using bounded20s diagnostic probes, before choosing the fix. Both showed all host actions approved/completed and child/worker completed. Parent was waiting_for_capacity because the scripted provider advanced past early-return await_tasks, integrated twice while sub-job still running, then finish was rejected; next nonexistent script step threw script[turns(...)] is not a function, misclassified by fake transport as capacity.
- Fixed fixture orchestration only: before returning each scripted integrate response, the fake provider waits for the actual persisted target child result. Those two fixture configs disable unrelated provider AIMD slots so waiting parent/child fake responses cannot occupy the two slots required for the worker. Original model turn counts, carve amounts, integration/attribution/check/undo expectations remain unchanged. Restored original170s test ceiling; retained concise pending/state/action/last-turn diagnostics rather than increasing waits.
- `verification-calibration.test.ts`: the real persisted/claimed supervisor task and lease already existed; its trusted fixture config lacked a configured supervisor profile. Added explicit supervise mode=supervisor and complete leaseOwner/now context. No synthetic authority bypass or production host-policy change.
- Source/test inventory: harness/channel-tools.ts; tests/{team-nesting,team-integration,verification-calibration}.test.ts. team-channel.test.ts original crash assertions retained unchanged.
- Focused observed checks so far: channel11/11, team-integration5/5, team-nesting7/7; calibration final suite result pending below. No broad suite/commit/provider/live effects.
- Final focused frozen4-file run: npx vitest run tests/team-nesting.test.ts tests/team-integration.test.ts tests/team-channel.test.ts tests/verification-calibration.test.ts --maxWorkers=1 --minWorkers=1 ->31/31 pass,110.27s. Calibration8/8 retains confirmations and seeded undo. git diff --check on changed4 files passes with line-ending advisories. Frozen for supervisor acceptance.
