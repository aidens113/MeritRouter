# Supervisor offload: free workers do the heavy lifting
Status: Active
Status detail: Resumed on November 27 for Windows check recovery, operating docs, and benchmark readiness.
Created: 2026-11-25
Last updated: 2026-11-27
Owner: Senior supervisor agent
Scope: Make an external Claude Code / Codex supervisor offload 60-80% of its work (reading,
searching, code writing, running commands) to free MeritRouter workers over MCP, with
standardized briefs, standardized reports, per-task tool sets and two-way supervisor/worker
communication.
Paired document: none
Related: [trial evidence](supervisor-offload/reports/trial-evidence.md),
[MCP surface audit](supervisor-offload/reports/mcp-surface-audit.md),
[worker path audit](supervisor-offload/reports/worker-path-audit.md),
[operational health](supervisor-offload/reports/operational-health.md)

## Current State

The user resumed on November 27 for a November 30 deadline and again after a computer crash.
The implementation checkpoint on `dev` predates the November 27 fixes below.

**Built and pushed to dev (all committed):**
- Contracts: Brief v1 (kind, goal, scope, tools, checks, doneWhen; vague briefs rejected), Report v1
  (no small cap; VERIFIED vs CLAIMED checks; required worker self-check), supervisor/worker channel
  (`channel_messages`, `task_rework`).
- MCP: default `tools: core` (~12 tools, ~10KB vs ~40KB) and offload playbook (direct tasks,
  delegate vs keep, brief template, probe freely, talk to workers, save context, rework once);
  delivery-job guidance only for `tools: full` / explicit delegated_delivery. probe returns answers;
  inbox/await split worker requests from probe answers.
- Channel backend: workers wait without model requests; probes on running and finished tasks;
  rework from the prior submitted commit with lineage.
- Worker side: supervisor-chosen tool sets (only granted tools offered per request; request_tools
  grants apply next turn), always-on ask_supervisor / request_tools / report_blocked /
  reply_supervisor, lite numbered prompt for T1, self-check required for brief tasks, dead external
  runner removed.
- `meritrouter connect claude|codex` (+ opt-in hooks), `meritrouter inbox`,
  `meritrouter exchanges export`, `offload_report`, 8-task two-arm eval (`evals/offload`,
  dry-run self-test 8/8).
- Fixes found on the way: Next.js 16.4.6 (advisory), init project provisioning, half-deleted
  Windows helper cache (all check commands were failing), explicit jobs kept on delivery engine.

**Validation:** last full suite (before the final regression fixes) 3,472 passed / 42 failed, 24
of them load timeouts; serial rerun of the 27 failing files left 4, all fixed and covered by a
13-file / 174-test serial run. A clean full-suite aggregate has NOT been rerun since.

**November 27 changes under lead verification:**
- A Windows kernel mutex replaces the persistent installer claim. The focused worker run observed
  11/11 Windows command environment cases, including actual abandoned mutex recovery.
- MCP check execution now refuses without an authorized command principal. The worker harness
  continues to run checks under its own policy. Core await and inbox now show pending approvals
  early, with sanitized metadata. The operator reviews actions in the existing panel task card.
- The generated presets leave the client workflow unset. Core guidance starts with direct workers
  and explicitly started jobs retain delivery semantics. Briefs carry a zero paid budget.
- Updated README and authored setup, roles and operations docs. Existing unrelated changes remain
  in the main checkout.
- The eval now creates isolated temporary fixture repositories, uses a separate installation
  with disabled paid routing and a cumulative request cap, and verifies which MCP servers each
  Claude arm used. It checks final work, counts Git-attributed worker lines and successful
  worker checks, and reads supervisor usage from the client. It journals completed arms to OS
  temp by default and can open a separate authenticated operator panel on an explicit local port.
- The computer crash left a malformed generated `dist/harness/repeat-policy.js`. Rebuilding
  restored the router import. An aggregate started before this diagnosis was stopped and has
  no result. The new aggregate uses three workers and logs to
  `%TEMP%/meritrouter-offload-suite-20261127-132953.log`.
- All eight fixture graders and all eight isolated MCP provisioning checks passed. The
  isolated production panel required login and returned HTTP 200 for the authenticated task
  list. The temporary panel was stopped after the check. A synthetic free key was imported
  into the temporary vault and used for authenticated loopback discovery. The key was absent
  from the supervisor environment and generated config.

**Remaining release gates:**
1. Complete the full router suite, recursive typecheck/build, and benchmark preflight.
2. Obtain approval for up to 120 free model requests for live smoke, up to 128 free model
   requests across the benchmark, and 16 Claude Code sessions at $0.50 API-equivalent each.
   The November 27 request is unanswered. Use isolated projects and paid routing disabled.
3. Run the paired eval and verify the 60% floor for worker-attributed work and the 40% floor
   for supervisor output-token reduction within one passing task of the baseline. Publish
   only the verified coherent change. Promote after release acceptance.

Not done / deferred: fixed-count stall nudge; Stop hook "unreviewed report" gating (no reviewed
flag exists); per-tool examples in the lite prompt still describe the default tool set, not the
granted subset. User's panel on 4477 still runs the pre-upgrade Next.js until restarted.

## Plan

### Target loop

```text
supervisor (Claude Code / Codex)                     free worker (MeritRouter)
  delegate(brief: kind, goal, scope, tools, checks) ->  runs with ONLY the granted tools
  await -> report v1 (+ pending worker messages)     <- ask_supervisor / request_tools / blocked
  reply / grant_tools / deny                          -> resumes, no requests spent while waiting
  probe(question) on a running or finished task       -> answers with evidence refs
  rework(feedback)  -> same worktree, lineage kept    -> fixes, re-reports
  accept / reject  (only after harness-verified checks and a probe when warranted)
```

Every exchange (brief, tool grant, messages, report, verdict, check outcomes) is stored as one
structured record, which becomes the fine-tuning corpus later.

### Phase 0: unblock (today, lead)
1. Local `.mcp.json` (untracked) is stale. Deferred to Phase 3: the real config
   (`%LOCALAPPDATA%/MeritRouter/meritrouter.config.yaml`) has only the paused Facebook project, and
   this repository may not hold a `.MeritRouter` directory (2026-10-26 user rule). Phase 3 uses the
   lane D `connect` command to create a dogfood project whose store lives under
   `D:/MeritRouterProjects/` with this repository as its repository.
2. Upgrade the panel's Next.js to a patched 16.x release; `pnpm -r build` green.
3. Fix `init --project` provisioning (store created, or `projects create` can adopt the stub).
4. Mark frozen efforts Paused in the index with one line each.

### Phase 1: contracts (today, lead fixes before any dispatch)
Stable interfaces, in `src/core/brief.ts`, `src/core/report.ts`, `src/core/channel.ts`, plus one
appended migration:
- **Brief v1**: `kind` (scout | summarize | edit | implement | run | review), `goal`,
  `context {files, notes}`, `scope {allowedPaths, writable}`, `tools` (profile name or explicit
  list), `checks` (exact commands), `doneWhen` (observable criteria), `report {detail}`,
  `budget`. A linter rejects vague briefs with actionable errors (edit/implement without
  allowedPaths, implement without checks, no doneWhen, goal too short). Maps onto the existing
  TaskArgumentSchema; old callers keep working.
- **Report v1**: structured text built from the existing worker result. No small fixed cap
  (user direction 2026-11-25): every section is required, length scales with the work, and the
  brief's `report.detail` (brief | standard | full, default standard) sets verbosity. Only bulky
  raw output (full logs, full diffs, transcripts) stays behind drill-down refs. Sections:
  Outcome; Summary; Changed (diffstat); Checks (command, exit code, last lines), marked VERIFIED
  only when harness-run; Criteria (met / unmet / not verified, with evidence); Claims not
  verified by the harness; Self-check (fixed questions the worker must answer: what was not
  tested, assumptions made, riskiest change, what to check next); Open messages; drill-down refs.
- **Channel v1**: one table of messages `{task, direction, kind: question | tool_request | help
  | blocked | answer | grant | deny | probe | rework, body, status, times}`. Workers wait without
  model requests (generalize the supervisor-action wait); watchdog-exempt; a timeout returns
  control to the worker with "no answer, proceed or stop".

### Phase 2: lanes in parallel (Thu-Fri), partitioned by file

| Lane | Owns | Tier | Delivers |
| --- | --- | --- | --- |
| A: MCP surface | `src/mcp/**`, `src/admin/client-supervision.ts`, `src/config/client-supervision.ts` | worker (Sonnet) | Core tool set (~12, default): `delegate`, `await`, `inbox`, `reply`, `probe`, `rework`, `accept`, `reject`, `diff`/`read_artifact`, `run_check`, `status`, `offload_report`. Full set behind `mcp.tools: full`. Capped `get_session`. Rewritten instructions ("offload playbook", ~600 words) defaulting to direct tasks. MCP prompts `offload_playbook`, `write_brief`, `probe_report`. |
| B: channel backend | `src/core/` (service methods, task lineage), `src/sessions/`, the new migration | worker-heavy (Opus) | Durable channel, worker wait/resume, `probe` on running tasks (delivered at next turn) and finished tasks (read-only resume of the session), `rework` continuing in the same worktree with lineage. Concurrency and restart safety tested. |
| C: worker side | `src/harness/` tool registry + new worker channel tools, `src/runners/prompts.ts`, `charters/` | worker (Sonnet) | Tool profiles (scout, summarize, edit, implement, run, review); worker sees only granted tools plus always-on `ask_supervisor`, `request_tools`, `report_blocked`, `submit_result`. Lite numbered prompt with one worked example per tool for free tiers; harness-v2 guidance only for implement on capable tiers. Earlier fixed-count stall nudge. Safe read tools auto-grantable by policy. |
| D: integrations | `src/cli*` connect command, new `integrations/claude-code/`, `integrations/codex/`, `docs/setup.md` | worker (Sonnet) | `meritrouter connect claude\|codex --project <slug>` writes MCP config plus a CLAUDE.md / AGENTS.md offload snippet. Opt-in Claude Code hooks: advisory nudge before large direct writes or long test/build runs; Stop hook refuses to end with unanswered worker messages or unreviewed reports; SessionStart injects the inbox. Remove the dead external-runner option. |
| E: measurement | new `src/admin/offload-metrics.ts`, `evals/offload/`, export CLI | worker (Sonnet), starts Fri | Per-session offload share (accepted lines attributed to free models, commands run by workers, bytes read vs digest returned, probes, reworks, acceptance rate); `export exchanges --jsonl` with secret redaction; an 8-task fixture suite (scout, log summary, mechanical edit, small feature with tests, bug fix, test writing, refactor, review). |

Lanes A and C build against the Phase 1 contracts and B's service method signatures, which the
lead fixes in Phase 1 and names as stable in every brief.

### Phase 3: integrate and go live (Fri-Sat, lead)
1. Integrate lanes; recursive typecheck, full router suite, build, MCP stdio smoke.
2. Live smoke on free providers only (announced with a request budget before running): one task
   per kind, plus a forced worker question and a forced rework, end to end from Claude Code.
3. Offload eval: the same fixture tasks run by headless Claude Code with and without
   MeritRouter. Spends Claude usage and free quota; cost stated and approved before running.

### Phase 4: dogfood and promote (Sat-Sun)
Use the new loop to fix the eval findings on this repository, recording the offload share.
Update `docs/roles.md`, `docs/setup.md`, `docs/operations.md`, README. Promote to `main`.

### Acceptance for the week
1. A fresh Claude Code session connects with one `connect` command and sees at most ~15 tools.
2. Worker question -> supervisor answer -> worker resumes, and probe and rework, all work end to
   end over MCP (tests plus one live run).
3. On the fixture suite: at least 60% of accepted changed lines and commands come from free
   workers; supervisor output tokens drop at least 40% versus the baseline; pass rate within one
   task of the baseline.
4. Full checks green, documentation current, promoted to `main`.

### Schedule (parallel lanes; each date's real constraint named)
- Wed 11/25: Phase 0 + Phase 1. Constraint: contracts must be fixed before lanes dispatch.
- Thu 11/26: lanes A-D. Constraint: B's channel backend (Opus, concurrency) is the long pole.
- Fri 11/27: lane E; integrate; full suite (~25 min per run); live smoke.
- Sat 11/28: offload eval and fixes. Constraint: free provider quota and the user's run approval.
- Sun 11/29: dogfood, docs, promote.

### Risks
- Free provider quota (Ollama Cloud quota refusals seen in trials). Mitigation: rotation already
  exists; eval sized to fit, quota errors surfaced not retried blindly.
- MCP prompt support differs by client; the playbook also ships in tool descriptions and the
  CLAUDE.md / AGENTS.md snippet, so no client depends on prompts alone.
- The 3,400-test suite must stay green while internal-supervisor code stays opt-in, not removed.
- 61 pre-existing uncommitted files (licensing, archived reports) are not this unit's; never
  staged by it.

### Later (not this week)
Fine-tune a worker model on the exchange corpus (brief -> tool use -> questions -> report ->
verdict). Revisit the internal supervisor only after the external loop meets acceptance.

## Worker Briefs

### Brief: windows_helper_recovery
- Repository: D:/MeritRouter
- Role: standard worker, gpt-6.1-sol, medium. Main checkout only.
- Task: Fix permanent Windows command/service helper cache blockage after an installer dies.
- Required reads: Current State above, windows-job-executable.ts, existing matching tests found by ripgrep.
- Owns: packages/router/src/harness/windows-job-executable.ts and matching helper-cache test(s).
- Must not touch: all other files except the report, including dist and shared working docs.
- Definition of done: deterministic Windows coverage of stale lock recovery and safe concurrent installation. Preserve tamper detection, symlink/hardlink defenses and pruning repair. Run focused new tests only; lead owns the aggregate build/test slot. No live providers.
- Report to: docs/working/supervisor-offload/reports/windows_helper_recovery.md

### Brief: offload_operating_docs
- Repository: D:/MeritRouter
- Role: writing worker, gpt-6.1-terra, medium. Main checkout only.
- Task: Document the supported Claude Code and Codex supervisor offload loop and connection workflow in authored docs.
- Required reads: Current State above; docs/setup.md connection section; docs/operations.md MCP section; docs/roles.md external supervisor section; current packages/router/src/mcp instructions/tools and integration command sources as needed.
- Owns: docs/setup.md, docs/operations.md, docs/roles.md.
- Must not touch: all other files except the report, including README.md with unrelated edits.
- Definition of done: current core/full tools, direct vs delivery flow, verified checks, probes/rework, scope, hooks, and metrics documented with precise verified semantics. No claims about measured savings or live results. No providers, builds or tests.
- Report to: docs/working/supervisor-offload/reports/offload_operating_docs.md

### Brief: mcp_check_containment
- Repository: D:/MeritRouter
- Role: heavy worker, gpt-6.1-sol, max. Main checkout only.
- Task: Ensure MCP run_check uses the existing command-containment boundary or fails closed. It currently shells out directly given a previously declared command, bypassing the harness. Preserve valid runs and report shape when feasible.
- Required reads: Current State above, packages/router/src/mcp/tools.ts run_check, existing command runner/policies and MCP tests as relevant.
- Owns: packages/router/src/mcp/tools.ts, earliest MCP tests covering the behavior, and a narrowly scoped containment adapter only if required outside the current helper-cache files. Coordinate if another file is needed.
- Must not touch: helper-cache files, eval files, authored/working docs except your report, dist.
- Definition of done: regression proves declared check cannot escape the harness security boundary, retains valid checks when capability exists. No live calls. Use focused tests that run on source only because lead owns dist.
- Report to: docs/working/supervisor-offload/reports/mcp_check_containment.md

### Brief: mcp_check_visibility
- Repository: D:/MeritRouter
- Role: standard worker, gpt-6.1-sol, medium. Main checkout only.
- Task: Show pending worker command approvals to external supervisors using core MCP await/inbox, scoped to the selected project and requested tasks. The worker currently waits for an operator while the core client cannot see why. Return promptly when already pending and, if feasible narrowly, when pending starts during an await. Expose sanitized status metadata only.
- Required reads: Current State above, core await/inbox and related tests, admin/worker-actions.ts, existing await implementation as needed.
- Owns: packages/router/src/mcp/tools.ts and matching MCP test(s). Lead owns dist and aggregates; coordinate before editing other source files.
- Must not touch: security policies, grant paths, worker-action execution, authored/working docs except report, dist, eval.
- Definition of done: tests demonstrate pending check status is visible, project/task filters hold, no decision capability is added, existing channel/await behavior remains intact. No live providers.
- Report to: docs/working/supervisor-offload/reports/mcp_check_visibility.md

Completed: phase1-contracts (worker-heavy), init-provisioning-fix (worker); reports under
`supervisor-offload/reports/`. Dispatched 2026-11-25: lane-a (worker), lane-b (worker-heavy),
lane-c (worker), lane-d (worker), lane-e (worker; owns `src/admin/offload-metrics.ts`,
`src/admin/exchange-export.ts`, `src/cli/exchanges.ts`, `evals/offload/**`; lead registers its CLI
command and facade exports). Lead added wiring before dispatch (d6e2ec8): `MeritRouter.channel`,
`RunContext.channel`, watchdog exemptions for ask_supervisor/request_tools/report_blocked.

**Stable interfaces for every lane** (committed in Phase 1, change only through the lead):
`src/core/brief.ts` (BriefV1Schema, lintBrief, briefToTaskArgument, TOOL_PROFILES,
ALWAYS_ON_WORKER_TOOLS incl. reply_supervisor), `src/core/report.ts` (SelfCheckSchema,
renderReportV1), `src/core/channel.ts` (ChannelMessageSchema, ChannelMessageError, ChannelAwaitOutcome,
SupervisorChannelService), `src/storage/supervisor-channel.ts` (SupervisorChannelStore).
Rework lineage is the `task_rework` table (task rows stay unchanged: StoredTaskDTOSchema is strict).
Any new table must be classified in both `src/storage/store-role.ts` and
`src/projects/store-export.ts`. Wiring: `MeritRouter.channel: SupervisorChannelService`;
`RunContext.channel?: SupervisorChannelService`.

### Brief: lane-b-channel-backend (worker-heavy, Opus, high)
Goal: implement SupervisorChannelService and wire it. Owned: `src/core/service.ts` (channel
member + delegate/probe/rework methods only), new `src/core/channel-service.ts`,
`src/runners/types.ts` (RunContext.channel), `src/sessions/**` as needed for read-only resume,
tests `tests/offload-channel.test.ts`. Must not touch: `src/mcp/**`, `src/harness/**`,
`src/runners/prompts.ts`, charters, contracts files, migrations. Deliver: postFromWorker;
awaitReply waits without model requests, honours abort and timeout (returns "no answer"), survives
restart (pending rows reload); replyFromSupervisor atomic; probe on running task queues a
supervisor_to_worker message, on finished task runs a read-only resume of the worker session with
the question and returns the answer with evidence refs; rework creates a task with rework_of,
same writable scope, starting from the prior candidate commit, feedback appended; grantedTools;
pendingForWorker; listPendingForSupervisor. Checks: package typecheck; new test file; existing
session/resume and task tests. Report: `supervisor-offload/reports/lane-b.md`.

### Brief: lane-c-worker-side (worker, Sonnet, medium)
Goal: workers see only granted tools and can talk to their supervisor. Owned: `src/harness/**`
(tool registry, loop injection, new `src/harness/supervisor-channel-tools.ts`),
`src/runners/prompts.ts`, `src/runners/coding/**`, `src/runners/readonly.ts`, `charters/**`,
tests `tests/worker-tool-profiles.test.ts`, `tests/worker-channel-tools.test.ts`. Must not touch:
`src/mcp/**`, `src/core/**`, contracts, migrations. Deliver: tool set per turn = TOOL_PROFILES[profile]
or explicit list, plus grantedTools(taskId), plus ALWAYS_ON (ask_supervisor, request_tools,
report_blocked, reply_supervisor, submit_result); worker tools call ctx.channel and wait without
model requests (add them to watchdog exemption via the existing set's owner only if needed: ask
the lead); loop injects pendingForWorker messages at the next turn and marks delivered; lite
numbered prompt with one worked example per granted tool for free tiers; HARNESS_V2_GUIDANCE only
for implement on capable tiers; fixed-count early stall nudge; submit_result requires selfCheck;
remove the always-failing external coding runner option (config value refused with a clear
error). Checks: typecheck; new tests; existing harness/runner tests. Report: `lane-c.md`.

### Brief: lane-a-mcp-surface (worker, Sonnet, medium)
Goal: default core MCP tool set and offload playbook. Owned: `src/mcp/**`,
`src/admin/client-supervision.ts`, `src/config/client-supervision.ts`, tests `tests/mcp*.test.ts`
(new cases). Must not touch: `src/core/**`, `src/harness/**`, `src/runners/**`, contracts.
Deliver: core tools (default) `delegate` (BriefV1 + lint errors returned + route preview),
`await` (renderReportV1 + pending worker messages), `inbox`, `reply` (answer/grant/deny),
`probe`, `rework`, `accept`, `reject`, `diff`/`read_artifact`, `run_check`, `status`,
`offload_report` (stub until lane E); full set behind config `mcp.tools: full`; capped
`get_session`; rewritten default supervision text (~600 words): direct tasks by default, what to
delegate vs keep, brief template, probing protocol, answer worker messages on every await,
rework once then escalate; MCP prompts `offload_playbook`, `write_brief`, `probe_report`.
Report: `lane-a.md`.

### Brief: lane-d-integrations (worker, Sonnet, medium)
Goal: one-command connection and structural hooks. Owned: new `src/cli/connect.ts`, `src/cli/inbox.ts`,
command registration lines in `src/cli.ts`, new `integrations/claude-code/**`, `integrations/codex/**`,
`docs/setup.md`, tests `tests/cli-connect.test.ts`. Must not touch: `src/core/**`, `src/mcp/**`,
`src/harness/**`. Deliver: `meritrouter connect claude|codex --project <slug> [--repo <dir>]
[--project-dir <dir>]` writes `.mcp.json` / Codex MCP config and a CLAUDE.md / AGENTS.md offload
snippet (idempotent, never overwrites unrelated content); `meritrouter inbox --json`; opt-in Claude
Code hooks (advisory PreToolUse nudge for large direct writes or long test/build commands; Stop
hook blocking while worker messages are unanswered or reports unreviewed; SessionStart inbox
summary) installed only with `--hooks`. Report: `lane-d.md`.

## Work Ledger

### 2026-11-25 — Audit and plan
- Four read-only audit workers (Sonnet): trial evidence, MCP surface, worker path, operational
  health. Reports under `supervisor-offload/reports/`.
- Lead spot-checks: Instagram external-supervisor claim (assessment lines 20-22); dead
  `ExternalCodingRunner` (`runners/coding/index.ts:102-113`); `HARNESS_V2_GUIDANCE`
  (`harness/operation-dispatch.ts:38`); default guidance recommends delivery jobs
  (`admin/client-supervision.ts:7-14`); no worker question tool, worker action tools not on MCP.
- Validation: `pnpm --filter meritrouter-panel build` -> exit 1, Next.js SecurityFatalError
  (16.4.2 advisory). Worker-reported: `pnpm -r typecheck` pass; router build pass; MCP tests
  30/30 pass; stdio probe 50 tools, 39,888 bytes.

### 2026-11-25 — Phase 0 started
- Next.js 16.4.2 -> 16.4.6 (GHSA-mfr8-8qww-v76h, patched >=16.4.5) in panel and router; lockfile
  changes Next-only. Validation: `pnpm --filter meritrouter-panel build` -> success (route table
  printed); `pnpm --filter meritrouter-panel typecheck` -> exit 0. Commit 1df42d2.
- Paused five efforts (header + committed index row); trial-failure-audit and gate2 rows paused in
  the working copy only (their rows and the audit file are not yet committed by their owners).
- Dispatched: phase1-contracts (worker-heavy), init-provisioning-fix (worker).

### 2026-11-25 — Phase 1 contracts and init provisioning fix
- Outcome: Accepted. Worker: phase1-contracts (worker-heavy), init-provisioning-fix (worker).
- Lead changes: registered `channel_messages`/`task_rework` in `projects/store-export.ts`; moved
  SupervisorChannelStore from core/channel.ts to `storage/supervisor-channel.ts` (placement rule);
  narrowed the new init test's doctor assertion to project checks (fresh temp install has no keys).
- Validation: `pnpm typecheck` -> exit 0; `pnpm build` (router) -> exit 0;
  `npx vitest run` offload-contracts, project-store-migration, project-store-provision,
  zero-project-installation, project-cli-operations, install-layout -> 6 files, 92 passed, 1 skipped;
  mcp, mcp-http, mcp-lifecycle-v2, task-queue, task-recovery-retention, task-startup-recovery,
  verification, verification-flow, verification-surface -> all passed.
- Known failing, not caused here: `project-task-lab-deletion` 3/3 fail with
  `environment_failure`; same result with the init fix stashed and (per worker) without the
  contracts. Lab area is paused; revisit at the full-suite run.

### 2026-11-25 — Lane D: connect command, inbox, Claude Code hooks
- Outcome: Accepted. Worker: lane-d.
- Lead changes: Stop hook blocks at most once per stop (`stop_hook_active`) and only on worker
  messages awaiting the supervisor (not undelivered replies); PreToolUse nudge emits
  `hookSpecificOutput.additionalContext` JSON (plain stdout never reaches the model; verified
  against code.claude.com/docs/en/hooks.md), no permissionDecision; `integrations` added to the
  published `files`; README wording fix.
- Validation: `npx vitest run tests/cli-connect.test.ts` -> 9 passed; `npx vitest run
  tests/packaging.test.ts` -> 4 passed; manual hook runs: Stop with one pending request -> block
  JSON, with stop_hook_active -> no output, reply-only -> no output; nudge on `pnpm -r test` and a
  9,000-char Write -> additionalContext JSON, on Read -> no output; all exit 0.
- Not verified: hooks inside a live Claude Code session; `inbox` against the real channel (lane B);
  Codex config against an installed Codex CLI.

### 2026-11-26 — Lane A: core MCP tools and offload playbook
- Outcome: Accepted. Worker: lane-a.
- Lead changes: playbook split by mode. Core (default) = direct-task playbook plus three new
  paragraphs (talk to workers / probe freely; save your own context with scout, summarize and run
  workers; free routes by default, spend and authority limits). Delivery-job paragraphs
  (supervisor strength, credit notices, delivery validation) move to DELIVERY_JOB_SUPERVISION,
  added only for `tools: full` or `workflow: delegated_delivery`. `client_supervision.workflow`
  default changed delegated_delivery -> direct_tasks (the old default injected "Use MeritRouter
  delivery supervisors for multi-step work" ahead of the playbook). Two tests that asserted the old
  default updated; core-mode test asserts the delivery text is absent.
- Validation: `pnpm typecheck` -> exit 0; `pnpm build` -> exit 0; `npx vitest run`
  client-supervision, mcp, mcp-http, mcp-lifecycle-v2, mcp-passive-startup, mcp-credit-usage,
  mcp-offload -> 7 files, 45 passed. Core tool list JSON 10,176 bytes (worker-measured; was
  39,888 for 50 tools).
- Not verified: `apps/panel/scripts/validate-client-supervision.mjs` (needs Chrome; only its
  expected phrase changed); `tests/delivery-runtime.test.ts` 2 failures (worker: fail inside
  harness execution, `node --version: terminated`; recheck after lane C lands).

### 2026-11-26 — Lanes B and E: channel backend, offload metrics, exchange export, eval suite
- Outcome: Accepted. Worker: lane-b (worker-heavy), lane-e.
- Behaviour: `MeritRouter.channel` (ChannelService) and per-run `RunContext.channel` (RunChannel).
  Worker waits poll the store without model requests, pause operation clocks, honour abort/lease
  loss, end answered/expired/timeout. Probe on a running task is delivered at the next turn; on a
  finished task one gated read-only summarize task answers from the task's record and transcript
  tail (sessions cannot be reopened without a lease). Rework = new task with feedback, same scope,
  worktree starting at the prior submitted commit, lineage in task_rework, idempotent.
- Lead changes: interface gains replyFromWorker, markDelivered, acknowledge, replyTo,
  messagesForTask (both classes implement; wrong-side calls throw). MCP `probe` returns the answer
  for finished tasks (else queued id); `inbox`/`await` split workerRequests from probeAnswers, show
  each answer with its question once, then acknowledge it. `offload_report` wired to
  offloadReport (since, taskIds). `meritrouter exchanges export` registered; facade exports in
  admin/insights.ts. mcp-offload test fake/expectations updated.
- Validation: `pnpm typecheck` -> clean except lane C's in-progress
  tests/worker-channel-tools.test.ts fake; `pnpm build` -> exit 0; `npx vitest run` mcp,
  mcp-http, mcp-lifecycle-v2, mcp-passive-startup, mcp-credit-usage, mcp-offload,
  client-supervision, offload-channel, offload-contracts, offload-metrics, exchange-export,
  cli-connect, task-queue, task-startup-recovery, project-cli-operations -> 15 files, 129 passed;
  `node evals/offload/run.mjs --dry-run` -> 8/8 tasks self-test cleanly; no flags -> usage only.
- Not verified: live two-arm eval (needs approval); restart through a resumed executor run; lane B
  reports 18 failures in session-faults, session-recording, verification-resume, coding,
  approval-execution-timeout that also occur without its changes (lane C runner removal in
  flight); recheck at the full-suite run.

### 2026-11-26 — Lane C: worker channel tools, tier-gated prompt, external runner removed
- Outcome: Partial. Worker: lane-c.
- Done: ask_supervisor, request_tools, report_blocked, reply_supervisor (uses replyFromWorker);
  loop injects pendingForWorker each turn, marks delivered, shows each probe once per run; T1 gets
  legacy edit tools plus a numbered lite prompt with one example per tool, T2/T3 keep harness v2;
  ExternalCodingRunner removed, non-native `coding.runner` refused at config parse.
- Not done: per-brief tool restriction (WorkerTaskSchema has no field to carry the brief's tool
  set); selfCheck asked for but not required; fixed-count stall nudge deferred.
- Validation: `pnpm typecheck` -> 0 errors; `pnpm build` -> 0 errors; `npx vitest run
  --no-file-parallelism` worker-tool-profiles, worker-channel-tools, offload-contracts,
  offload-channel, mcp-offload -> 5 files, 52 passed.
- Known failing, NOT caused by lane C: serial run of native, session-recording, task-lab-caller,
  external-task-tools -> 6 failed / 43 passed; with lane C stashed, 5 of the same fail at HEAD.
  Cause: declared check commands end `environment_failure` with exitCode null (verification
  reasons logged from native.test.ts), same symptom as project-task-lab-deletion and
  delivery-runtime (`node --version: terminated`). Assigned to command-execution diagnosis.

### 2026-11-26 — Supervisor-chosen worker tool sets and required self-check
- Outcome: Accepted. Worker: tool-restriction.
- WorkerTaskSchema gains optional `tools {profile?, allow}` set by briefToTaskArgument;
  workerToolPolicy recomputes allow + grantedTools + always-on each turn; the loop filters the
  tool definitions sent on every request (verified loop.ts requestDefs filter) and refuses calls
  outside the set; a policy notice tells the worker to use request_tools. selfCheck is required in
  submit_result for brief-originated tasks only. Legacy tasks unchanged.
- Validation: `pnpm typecheck` -> 0 errors; `npx vitest run --no-file-parallelism`
  worker-tool-restriction, worker-tool-profiles, worker-channel-tools, offload-contracts,
  mcp-offload, task-queue, supervisor-loop-role, offload-channel -> 8 files, 76 passed.
- Not verified: restriction through a full live executor run with a real grant reply.

### 2026-11-26 — Check commands environment_failure: half-deleted helper cache
- Outcome: Accepted. Worker: check-environment-failure (worker-heavy).
- Root cause: Windows Storage Sense / SilentCleanup removed manifest.json but kept job.exe in the
  %TEMP% command and service helper caches (~2026-11-25 23:34); windows-job-executable.ts refused
  an incomplete cache forever and command-process.ts dropped the error, so checks returned exitCode
  null -> environment_failure -> needs_supervisor (service path: "node --version: terminated").
  Not caused by source changes since de3d28d or the Next.js bump.
- Fix: an incomplete cache is rebuilt under the existing lock, remnants renamed unverified-* and
  never executed; a complete cache disagreeing with its manifest is still refused; long-running
  processes re-verify per call; the setup error is reported. Lead: delivery-runtime test now sets
  `workflow: delegated_delivery` explicitly (direct_tasks is the default since 4cd1ad2).
- Validation: `pnpm typecheck` -> 0 errors; `npx vitest run --no-file-parallelism`
  delivery-runtime, command-environment, native, session-recording, task-lab-caller,
  project-task-lab-deletion, external-task-tools -> 7 files, 49 passed (before: 11 failed).
  command-environment against the old helper file -> 5 of 6 fail.
- Open risk: a lock left by a crashed process reports "busy" forever (not changed).

### 2026-11-26 — Full suite after integration; job-engine regression fixed
- Full run: `pnpm build` -> exit 0; `npx vitest run` -> 282 files, 3,472 passed, 42 failed, 5
  skipped, 1 vitest RPC timeout (24 of the 42 "Test timed out" under parallel load). Serial rerun of
  the 27 failing files -> 274 passed, 4 failed.
- Real defects found and fixed: (1) the 4cd1ad2 workflow default silently made explicitly started
  jobs (start_job, team connections, MCP job dispatch) non-delivery jobs. `workflow` is now optional:
  guidance treats unset as direct_tasks, jobs treat unset as delegated_delivery; only explicit
  direct_tasks changes jobs (config/client-supervision.ts guidanceWorkflow/deliveryJobs).
  (2) coding and gate-request-capture tests still configured the removed external runner: now assert
  config-parse refusal / native only. (3) projects-surfaces init test used a shared `%TEMP%/web`
  repository that init now provisions; given a private parent and asserts the store exists.
- Validation: `pnpm typecheck` -> 0 errors; `npx vitest run --no-file-parallelism`
  supervisor-lifecycle, delivery-runtime, client-supervision, mcp-lifecycle-v2, mcp, mcp-offload,
  projects-surfaces, coding, gate-request-capture, client-connection-routing, client-connections,
  connection-listener-access, connection-modes -> 13 files, 174 passed. projects-surfaces init test
  passed on two consecutive runs.
- Not rerun: a complete full-suite aggregate after these fixes.

### 2026-11-27 — Offline release fixes and crash recovery
- Agent: supervisor, with windows_helper_recovery, offload_operating_docs, mcp_check_containment, mcp_check_visibility.
- Changed: Windows command helper cache; MCP check containment and approval visibility; brief budget defaults; CLI snippets and generated presets; authored docs; paired eval and evidence tests.
- Why: Preserve free-only offload, keep exact operator command authority, and collect comparable evidence from isolated working repositories.
- Validation: `npx vitest run --no-file-parallelism tests/offload-eval.test.ts tests/command-environment.test.ts tests/offload-contracts.test.ts tests/client-supervision.test.ts` -> 44 passed. `node packages/router/evals/offload/run.mjs --dry-run` -> 8 of 8 graders passed.
- Validation: `node packages/router/evals/offload/run.mjs --preflight` -> eight isolated fixtures each saw 12 core tools, exit 0. Isolated panel smoke with `startOperatorPanel` -> anonymous 307, login 303, authenticated Tasks page 200.
- Validation: offline `prepareInstallation` smoke with a synthetic OpenAI-compatible loopback listing -> free vault key authenticated; no model calls; supervisor environment and YAML contained no key.
- Validation: `pnpm -r typecheck` -> router and panel passed after correcting a fixture tuple type. `pnpm -r build` -> router and panel passed after rebuilding the crash-damaged dist, before the final MCP approval visibility integration.
- Outcome: Partial
- Follow-up: Observe fresh aggregate and preflight. Approval for paid supervisor usage is still pending.

## Open Questions
- Budget for the live smoke and the Claude-usage cost of the offload eval (asked before Phase 3).
