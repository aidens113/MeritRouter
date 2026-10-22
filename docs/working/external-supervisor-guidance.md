# External supervisor guidance
Status: Active
Status detail: User requested default Claude/Codex supervision guidance with UI and explicit model-request changes; implementation queued alongside roadmap acceptance.
Created: 2026-10-22
Last updated: 2026-10-22
Owner: Senior supervisor agent
Scope: Configurable MCP client workflow guidance, distinct from SwitchYard's internal job supervisor and permission/budget enforcement.
Paired document: none
Related: [roadmap completion](roadmap-completion.md), [roles](../roles.md)

## Current State

The user explicitly requests that Claude/Codex connecting to SwitchYard act as the supervising
agent by default: own intended project completion, delegate as much practical work as possible,
review the integrated results, test them and iterate on defects. The default must be changeable
from the panel and by asking the connected model. Current MCP instructions describe the panel
but do not establish this end-to-end responsibility. This feature is not implemented yet.

This adds workflow guidance, not technical enforcement over another host application's agent.
Existing authorization, budgets, verification, containment and explicit user instructions retain
their authority. Disabling the guidance does not alter internal supervisor charters or limits.

## Plan and acceptance

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

### 2026-10-22 - User requirement inspected and implementation scoped
- Agent: supervisor
- Changed: recorded default outer-supervisor responsibilities, install-wide setting/tool contract and active-connection update behavior.
- Validation: inspected MCP initialization/registration, config parsing/writer and global Settings schema/page; no implementation or provider calls yet.
- Outcome: Partial
- Follow-up: dispatch isolated implementation after L4 worker freezes its current unit; independently verify and integrate with ongoing roadmap work.

## Open Questions

- None needed to begin. Default supervision is enabled; human customization and disabling are supported. Host compliance is guidance, not a security boundary.
