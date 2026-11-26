# Supervisor offload: free workers do the heavy lifting
Status: Planned
Status detail: Audit complete; week plan written and awaiting the user's go. No source changed yet.
Created: 2026-11-25
Last updated: 2026-11-25
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

Audit finished 2026-11-25 by four read-only workers; lead spot-checked each load-bearing claim.

**What the evidence says.** The one delivered trial (Instagram) used an external Codex
supervisor dispatching small, disjoint-file worker tasks directly; no MeritRouter supervisor job
or Lab was used (assessment lines 20-22, verified). The Facebook trial used MeritRouter's own
internal supervisor and never delivered after ~589/800 requests; its failures were overwhelmingly
framework machinery (slot recovery, budgets/deadlines, provenance, stalls), not model quality.
November's effort went mostly into that machinery. The proven loop was never hardened.

**What exists and is good.**
- Typed brief input (`submit_tasks` TaskArgumentSchema: goal, fileRefs, allowedPaths, checks,
  budget) and a typed worker result (findings with evidence refs, harness-run checks with exit
  codes and log refs, unresolved criteria, changed paths).
- Self-claimed "met" never yields acceptance; checks are harness-run and staleness-checked;
  deterministic defects cannot be overridden by a reviewer pass. Over-claiming is caught in code.
- Large payloads already sit behind artifact refs (`read_artifact`, capped), except `get_session`.
- The wait-without-spending mechanism exists (`request_supervisor_action` /
  `await_supervisor_action`, watchdog-exempt) but covers only exact command approval.

**What blocks the goal (ranked).**
1. Default supervisor guidance (`admin/client-supervision.ts` DEFAULT_CLIENT_SUPERVISION, ~1.7k
   tokens) tells Claude/Codex to "normally start a bounded delivery-supervisor job": the mode that
   failed. It gives no offload targets, no brief template, no probing protocol.
2. No two-way channel. A worker cannot ask its supervisor a question, request a tool, or say it
   is blocked; the supervisor cannot ask a worker a question or send work back with feedback
   (`reject_result` only records). Worker approval requests are not exposed over MCP at all.
3. Every coding worker gets the same ~1.2k-token preamble, including a dense 340-word
   harness-v2 paragraph and the full tool set, regardless of model or task.
4. Supervisor context tax: 50 MCP tools, ~40KB of tool JSON on every tool listing.
5. Operational breakage: local `.mcp.json` (untracked) points at deleted pre-rename paths, so the
   MCP server fails to connect in Claude Code today; `init --project` leaves the project store
   unprovisioned with no recovery path; `pnpm -r build` fails because the panel's Next.js 16.4.2
   is flagged by a security advisory.
6. No measure of offload (share of work done by workers, supervisor tokens saved, acceptance
   rate). Evals only qualify models.
7. Dead `ExternalCodingRunner` path implies `coding.runner: opencode` works; it always fails.

**Health.** `pnpm -r typecheck` passes; router build passes; MCP tests 30/30 pass; panel build
fails (item 5). Full suite not run this session (last full run 2026-11-05: 3,425 passed, one
timing failure since corrected).

**Decision (lead, user may override).** Standardize on external supervisor + direct bounded
tasks. Freeze the internal delivery supervisor, Facebook trial, Labs extensions, distributed work
and budget-request expansion for this week. Nothing is deleted; those paths stay opt-in.

**Next.** On the user's go: Phase 0 and the Phase 1 contracts today, lanes A-D dispatched in
parallel once contracts are committed.

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
1. Rewrite local `.mcp.json` to `node D:/MeritRouter/packages/router/dist/cli.js mcp --config
   <user's real config> --project <slug>`; confirm Claude Code connects. Machine-local, untracked.
2. Upgrade the panel's Next.js to a patched 16.x release; `pnpm -r build` green.
3. Fix `init --project` provisioning (store created, or `projects create` can adopt the stub).
4. Mark frozen efforts Paused in the index with one line each.

### Phase 1: contracts (today, lead fixes before any dispatch)
Stable interfaces, in `src/core/brief.ts`, `src/core/report.ts`, `src/core/channel.ts`, plus one
appended migration:
- **Brief v1**: `kind` (scout | summarize | edit | implement | run | review), `goal`,
  `context {files, notes}`, `scope {allowedPaths, writable}`, `tools` (profile name or explicit
  list), `checks` (exact commands), `doneWhen` (observable criteria), `report {maxWords}`,
  `budget`. A linter rejects vague briefs with actionable errors (edit/implement without
  allowedPaths, implement without checks, no doneWhen, goal too short). Maps onto the existing
  TaskArgumentSchema; old callers keep working.
- **Report v1**: compact text (target under 400 tokens) built from the existing worker result:
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

None dispatched yet. Lane briefs are written after Phase 1 contracts are committed.

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

## Open Questions
- Which config path and project slug the user's real install uses for `.mcp.json` (Phase 0.1).
- Budget for the live smoke and the Claude-usage cost of the offload eval (asked before Phase 3).
