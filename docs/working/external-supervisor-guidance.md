# External supervisor guidance
Status: Complete
Status detail: Corrected default-OFF final-supervisor dispatch accepted in734-test integrated unit, production UI/MCP and fresh outside-checkout package checks.
Created: 2026-10-22
Last updated: 2026-10-22
Owner: Senior supervisor agent
Scope: Configurable MCP client workflow guidance, distinct from SwitchYard's internal job supervisor and permission/budget enforcement.
Paired document: none
Related: [roadmap completion](roadmap-completion.md), [roles](../roles.md)

## Current State

The user clarified that the switch controls dispatch of SwitchYard's FINAL project supervisor,
not whether external workflow guidance is enabled. Authoritative default:
`client_supervision.dispatch_final_supervisor: false`. Claude/Codex retains final responsibility;
bounded SwitchYard sub-supervisors remain available. Turning it on permits an explicitly scoped
SwitchYard project supervisor over MCP. The earlier enabled/disabled-guidance implementation
and acceptance are superseded and must not be integrated as satisfying this request.

The corrected feature5b4725a is merged locally. Supervisor independently verified13 focused
tests, actual UI/MCP save/reload/default-OFF/once-change feedback and desktop/phone screenshots.
Final submission rechecks policy under the insertion lock after async validation; deterministic
revocation leaves no new tasks. Combined recursive typecheck/build and production UI/MCP,
model navigation, Labs and legacy-recipe checks have passed against6d61b8e. Supervisor viewed
desktop/phone screenshots. Fresh packed install outside checkout passed native SQLite, CLI,
42-tool MCP,8 panel/API routes, stylesheet and setup start/reuse/stop; owned processes closed.
Full integrated router suite passed734/734 tests in83 files (484.47s). This feature is accepted;
the broader roadmap remains active. Actual user panel4477/MCP were not restarted.

Workflow guidance does not technically enforce behavior inside another host application's agent.
Existing authorization, budgets, verification, containment and explicit user instructions retain
their authority. The switch changes final-project dispatch permission; guidance and bounded
sub-supervision remain available in both states.

## Corrected plan and acceptance

1. Replace unreleased `enabled` with `dispatch_final_supervisor`, default false. Keep optional
   bounded custom instructions. Effective MCP guidance always states who owns final completion:
   external client when off; internal project supervisor allowed when on. UI and setter/read
   tools use this exact role distinction, not an ambiguous supervision on/off toggle.
2. Persist optional `supervisionScope: subtask|project` in WorkerTaskSchema. A bounded externally
   delegated supervisor can be a persisted root (no internal parent); parentTaskId alone cannot
   classify final ownership. MCP start_job and submit_tasks accept this scope, default subtask;
   explicit project dispatch is refused while the setting is false, including raw task bypass.
   Classify supervisors by configured profile.mode, not just profile name. Children can never
   declare project scope; validate persisted parent/project and supervisor identity.
3. MCP start_job passes scope through service.startJob into its persisted task. The supervisor
   runner treats subtask scope as bounded delegation to the external owner, whose final review,
   integration/tests and project completion remain outstanding after finish_job. A completed
   bounded job is never represented as final project acceptance. Return scope/final owner in
   MCP dispatch responses, preserving existing fields. Prompt text describes role; validated
   dispatch guards enforce the structured project/subtask choice. Semantic goal breadth cannot
   be proven from prose and is not claimed as a security boundary.
4. Enforce current policy for MCP resume_task/resume_session too: explicit subtask and real
   internal children remain resumable; a legacy root supervisor without scope is project scope
   for this guard. Do not alter/cancel already running jobs or change CLI/panel standalone job
   defaults. Keep once-on-policy-change feedback for existing connections.
5. Test default project dispatch denial with no task/row mutation, bounded supervisor permitted,
   raw submit_tasks/custom supervisor-mode profile bypass rejected, bogus/cross-project parent
   refused, project dispatch enabled via UI and explicit setter, persisted scope and bounded
   runner instructions, resume guards. Repeat actual stdio/HTTP and multiline UI/browser checks.

## Superseded initial interpretation (history only)

1. Add validated install-wide `client_supervision` settings: `enabled` defaults true and
   `instructions` defaults empty (bounded human customization). Existing configs need no edit.
   Default text tells the external client to clarify the intended outcome, keep a concrete plan,
   delegate bounded independent work aggressively to SwitchYard, integrate/review actual changes,
   run appropriate final checks, iterate and report completion/remaining gaps truthfully.
2. Include effective guidance in MCP initialization. Add portable `get_supervision_policy` and
   `set_supervision_policy` tools; setter is for explicit user requests, validates only these
   settings, requires a reason, preserves other config/comments and returns effective guidance.
   Current MCP connections cannot rewrite already-delivered initialization instructions: expose
   updated guidance in the setter result and once after a changed policy on the next tool call.
   Do not pretend the external host is forced to obey or requires a reconnect to save settings.
3. Add a clearly named global Settings section for Claude/Codex supervision, toggle and custom
   instructions, using the existing validated settings API. Explain external vs internal roles.
4. Verify actual MCP stdio/HTTP default instructions, disable/customize/read/write persistence,
   invalid input and unrelated-setting preservation; browser test panel save/reload and live
   connection observing a UI-originated policy change. Production pages/API/screenshots and
   integrated typecheck/build/tests required. No real model/provider requests or user config.

## Worker Briefs

### Brief amendment: corrected dispatch ownership
- User correction above supersedes earlier enabled/disabled semantics, implementation and tests. Use corrected plan as authoritative; continue in the same isolated client-supervision WT.
- Ownership expands to core/task.ts (optional supervisionScope), core/service.ts (startJob scope only) and runners/supervisor.ts (bounded role text only). Supervisor coordinated service.ts ownership with ledger worker: its close patch is frozen; do not alter close/accounting. Root integrates ledger before this unit. Do not edit Labs check reuse predicate; root owns that separate hunk.
- Own MCP dispatch/resume guards, config/UI/schema/new tests/report; no broad runtime permission changes. Update current unit tests rather than claiming the obsolete toggle acceptance applies.
- No internal parent is required for an external client's bounded delegation. Explicit persisted scope plus MCP guards distinguish final authority; do not block every root supervisor and thereby disable all delegation. Parent fields must name a real same-project supervisor if present.
- `get_supervision_policy`/`set_supervision_policy` retain names; setter accepts dispatch_final_supervisor and optional instructions plus reason. Default scope for new MCP supervisor tasks is subtask; project scope requires policy on. Off/on guidance must accurately state final owner and allow sub-supervisors in both cases.
- Freeze after corrected focused tests/typecheck/build and actual MCP/UI browser acceptance. Root owns shared docs/public exports/integration. No commits/push, real install/provider calls.

### Brief: client-supervision
- Repository: `.claude/worktrees/roadmap-team`, new branch `feat/client-supervision` from current integrated core; supervisor prepares it before dispatch. Separate from frozen L4 acceptance tree.
- Task: implement all four steps above; user requested implementation now. Read this Current State and actual MCP/config/global Settings code; preserve existing repository boundaries.
- Owns: config/schema.ts for client_supervision only; new mcp/client-supervision.ts and admin/client-supervision.ts as needed; mcp/tools.ts and schemas.ts; admin/insights.ts export if needed; global Settings page and lib/settings-schema.ts; focused new tests and necessary MCP inventory assertions; own production harness/report `external-supervisor-guidance/reports/client-supervision.md`.
- Must not touch: Labs, core service/executor, admission/gateway, project Settings, package manifests/lock, public exports/shared docs or generated presets by hand. Ask for necessary expansion; no commits/push, providers, real install or actual4477 management.
- Contract: default enabled plus bounded custom instructions, aggressive practical delegation, outer-client ownership of review/integration/final tests/iteration. Plain workflow advice honors explicit user/repo instructions; no new authority to deploy/spend/message others or self-change policy without user request.
- Update behavior: initialize with current guidance; setter returns effective instructions. Existing connection notices persisted UI/file changes once on its next tool call; preserve existing first JSON content block/result shapes and error semantics. No repeated full guidance on every call; no unsupported MCP notification claims.
- Config edits use existing serialized snapshot-checked writer and touch only owned settings. Strictly validate runtime input; descriptive MCP schema uses portable typed nodes. Required reason is bounded and returned, not a credential or new provider config.
- Acceptance: real stdio/HTTP initialize/read/set + same-connection external edit observation; default/disabled/custom/schema/input/preservation regressions; demo production settings save/reload/screenshots desktop/phone light/dark. Preserve/stop owned fixtures and use no model requests. Narrow tests/typecheck/build, then freeze for supervisor review.
- Structure: keep guidance/settings functions by concern, do not bloat tools.ts further; report exact commands/results and what was not verified. Supervisor owns integration/docs/public exports/final acceptance.

## Work Ledger

### Acceptance ledger: 2026-10-22
- Agent: supervisor.
- Changed: corrected final-project dispatch permission and structured scope guards; retained bounded sub-supervisors and external completion guidance, UI/custom instructions and explicit-request tools.
- Validation: source6d61b8e,734/734 router tests in83files (484.47s), recursive typecheck/build; actual production UI save/reload, default-OFF, live MCP once-change feedback, invalid-input rejection, unrelated YAML/comments preserved, zero model calls; desktop/phone light/dark screenshots reviewed; packed outside-checkout install passed native/CLI/MCP42/panel/setup.
- Outcome: Accepted. No actual4477/MCP restart or provider calls. Broader roadmap work continues.

### 2026-10-22 - User requirement inspected and implementation scoped
- Agent: supervisor
- Changed: recorded default outer-supervisor responsibilities, install-wide setting/tool contract and active-connection update behavior.
- Validation: inspected MCP initialization/registration, config parsing/writer and global Settings schema/page; no implementation or provider calls yet.
- Outcome: Partial
- Follow-up: dispatch isolated implementation after L4 worker freezes its current unit; independently verify and integrate with ongoing roadmap work.

## Open Questions

- None needed to begin. Default supervision is enabled; human customization and disabling are supported. Host compliance is guidance, not a security boundary.
