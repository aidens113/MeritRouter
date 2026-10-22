# Client supervision worker report

Status: Corrected feature implemented and FROZEN for independent supervisor review.13 focused tests, both typechecks/builds and corrected multiline production browser acceptance passed. Prior enabled/disabled-guidance interpretation is fully replaced.

## Corrected behavior

client_supervision.dispatch_final_supervisor defaults false; instructions defaults empty, trimmed max8000. Claude/Codex remains final project supervisor by default, can aggressively delegate bounded SwitchYard sub-supervisors. Setting true permits explicit project-scoped internal final supervisors. Guidance remains present in both cases, with user/repository instructions and existing permission/budget boundaries authoritative. Setter requires explicit-user bounded reason and edits only these YAML paths using snapshot-checked patchConfig.

WorkerTaskSchema gains optional supervisionScope subtask|project. MCP start_job and supervisor-mode submit_tasks default subtask, persist it, return scope/finalOwner while preserving existing response fields. Project scope refused unless policy permits. Batch preflight validates every task before any submission mutates rows. Mode classification resolves actual target projectContext.profiles mode supervisor (not profile name). Any parent must be persisted real same-project supervisor; child project-scope claims refused. Non-supervisor tasks cannot claim supervisionScope. Resume_task/session enforce current policy for existing task: explicit bounded root/real child allowed; unscoped legacy root supervisor is project scope. Already-running tasks unchanged; no CLI/panel default change.

Bounded runner system text explicitly retains outer-client/parent final review/integration/tests/completion and says finish_job is only bounded completion, never final project acceptance. This is structured scope enforcement, not semantic proof of arbitrary goal prose breadth.

New policy read validates owned authored YAML section directly rather than relying only on mtime, because real stdio tests reproduced same-millisecond external writes sharing mtime. Per-connection fingerprint appends exactly one changed-guidance content block after a persisted UI/file change, retaining existing first JSON/error block; setter returns current guidance without duplicate. Invalid policy does not break unrelated tool calls. Optional custom instructions use six-row multiline textarea, scoped Field.multiline flag; existing other form behavior preserved.

Actual schema finding: profiles are global; authored project profile overrides are forbidden by ProjectConfigSchema, so tests assert rejection rather than claim that currently supported bypass. Guard still resolves effective projectContext for correct ownership.

## Files

config/schema.ts owned setting; core/task.ts optional scope; core/service.ts startJob scope hunk only; runners/supervisor.ts bounded role text only; new admin/client-supervision.ts and mcp/client-supervision.ts; mcp/tools.ts/schemas.ts; admin/insights.ts export; panel lib/settings-schema.ts and authorized components/client/settings-form.tsx multiline flag; new tests/client-supervision.test.ts; MCP stdio/HTTP inventory assertions40->42; new panel/scripts/validate-client-supervision.mjs; this own report. No ledger close/accounting/Labs hunks or shared docs changed by worker.

## Observed checks

- Router build/typecheck pass. Panel production build/typecheck pass (corrected final build exit0).
- pnpm --dir packages/router exec vitest run tests/client-supervision.test.ts tests/mcp.test.ts tests/mcp-http.test.ts:12/12 pass. New6 tests cover defaults/narrow validation/YAML preservation; no-mutation default project rejection; named inspect-mode supervisor bypass; bounded persisted scope; invalid/non-supervisor/crossproject parents; child project rejection; forbidden authored project profiles; legacy resume guards; actual scripted bounded runner role text; real stdio+HTTP default init/bounded and project dispatch refusal; explicit setter permits project dispatch; same live connection observes external changes once;42tool portable schemas and HTTP auth/access unchanged.
- Corrected production browser harness passed exit0 with temp isolated .demo config, empty providers, paid disabled, workerfalse. Asserts default final-dispatch OFF, UI permission ON + actual multiline customization save/reload, current MCP connection sees UI change once, explicit setter resets OFF reflected in UI, invalid8001char API400, unrelated config/comments preserved, model_requests0,4desktop/phone light/dark screenshots/no overflow. Prior semantics' successful runs do not count as corrected acceptance.

No commits/push/provider calls/userconfig/4477 operations. Full suite/integrated package/docs remain supervisor responsibility. Local log artifacts supervision-browser.log/supervision-panel-build.log are evidence, not source.


Final corrected acceptance: Next7128/Chrome25480,4499/CDP9371; temp config .demo/client-supervision-eIm9wW, owned MCP stdio child closed, both processes confirmed absent and fixture removed finally. Only ignored screenshots directory remains. Visually inspected final corrected phone/dark screenshot showing explicit OFF final-project-dispatch switch and bounded sub-supervisor explanation; desktop/phone contained. Current production evidence supervision-browser.log. git diff --check passes (line ending normalization warnings only). No source changes after freeze.


## Final insertion-race fix

Independent supervisor review found a real TOCTOU gap: MCP preflight could permit project scope, then awaited task validation allowed a concurrent human revocation before insertion. Added final explicit-scope checks inside existing service.submitTasks immediate transaction, immediately before tasks.submit: current persisted policy read, effective supervisor mode, real same-project supervisor parent and child/project prohibition. Same DB lock serializes the existing config writer. No change to default absent-scope CLI/panel jobs or service.close/reserves.

Shared strict authored policy disk reader now lives in config/client-supervision.ts; admin reuses it, core has no admin dependency. Deterministic regression holds after actual validateTask finishes, revokes through actual snapshot-checked writer, then releases submission and verifies rejection with zero task insertion. Also confirms direct core explicit project obeys policy and unscoped legacy/bounded scope remain available. New focused test count7, total with existing MCP tests13. Final router typecheck/build and targeted13-test rerun all passed exit0; no full suite claimed or needed by worker.

Final race-fix source frozen after passing13/13, router typecheck/build and diffcheck. No further browser rerun for backend-only insertion guard; prior corrected UI production acceptance remains recorded and supervisor independently confirmed it.
