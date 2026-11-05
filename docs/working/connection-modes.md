# Direct and agent connection modes
Status: Complete
Status detail: Compact global Connections is live; acceptance checks passed and the full regression's sole startup timing failure passed unchanged and corrected reruns.
Created: 2026-11-05
Last updated: 2026-11-05
Owner: Senior supervisor agent
Scope: Client routing parity, explicit agent/team submission, and global panel configuration.
Paired document: none
Related: [client connections](client-connections.md), [operations](../operations.md)

## Current State

The revised implementation provides a compact Connections page with persistent enablement,
editable host/IP and port, and copyable Ollama/Chat Completions settings. Direct requests need
no selected project or configured completion profile. Agent scope/limits and examples live in
secondary sections. The listener remains off by default; saved enablement survives restart.

Virtual models are meritrouter-direct, meritrouter-agent and meritrouter-team. The meritrouter
alias follows the saved default (initially direct); discovery lists enabled modes only. Direct
calls preserve caller text/images/tools and route through the installation Gate with normal
model/key fallback, intrinsic T1 policy and shared quotas/provider capacity/paid admission.
They create an empty-member installation execution, never a hidden project or worker task.
Process-issued authority is checked at acquisition/reservation/dispatch. Known policy denials
release proven-unsent capacity; genuinely unknown persistence/transport outcomes retain holds.
Positively identified direct usage counts globally and per key, not against each project's own
request share or paid cap. Ambiguous historical accounting remains conservative.

Host accepts IPv4/IPv6 literals or localhost, including intentional wildcard binding. A non-local
bind requires a separate generated Connections bearer key. Only its hash is stored; the panel
returns the key once and ordinary views expose configured/required flags. Host checks pin the
actual listener address/port; CORS and token checks precede dispatch. Existing saved profile
fields are discarded by the central configuration parser so old settings remain editable.

Agent/team calls retain explicitly configured project/repository scope, budgets, reviews and
ordinary worker scheduling. Saving modes or enabling the listener does not require an agent
project, but submitting agent work does. POST /api/jobs and chat aliases return an asynchronous
job acknowledgment and access token. GET /api/jobs/:project/:id and POST its /cancel suffix
use that job token, independently of the listener key. The panel does not start a worker.
Team submission requires an already eligible supervisor and performs no unowned qualification.
Whole-tree activity, request accounting and cancellation include surviving descendants. The
configured timeout uses root/worker execution semantics; children keep their normal deadlines.

Current evidence: direct routing8, global accounting16, listener/auth14 and compatibility/modes57
passed. Two stronger quota-slot cases first reproduced an orphan-hold bug, then passed after
narrow definite-refusal classification repair. Independent source review has no outstanding
findings. Recursive typecheck/build and compact production browser acceptance passed. Full
router regression completed with 3,425 passed, five skipped and one supervisor startup timing
failure before shutdown/resume. That case passed unchanged in isolation. Its readiness wait now
matches the adjacent case's bounded 90-second startup allowance and includes diagnostics;
all three supervisor tests and recursive typecheck passed afterward. Request-count and recovery
assertions are unchanged. The entire aggregate was not repeated for this test-only correction. All
development inference uses isolated fake providers.

Existing runtime work stays untouched. Lead owns builds, the authorized panel lifecycle,
integration and publication; workers own only their briefed source/tests/reports. Main checkout
only; unrelated licensing/instruction/private edits remain outside this unit.

## Worker Briefs

### User-directed simplification revision
- Backend worker gpt-6.1-sol/max owns existing backend brief paths and report; first propose exact extra capacity/accounting paths and stable host/global-direct contract before edits. No hidden project or summarize dependency; retain model/key fallback, global quotas and paid admission. No runtime/provider/build/Git actions.
- Approved additional backend paths: routing/select.ts, routing/router.ts, qualification/stats.ts, gateway/gate.ts, gateway/capacity.ts, admission/admission.ts, admission/accounting-usage.ts, admission/request-ledger.ts, admission/sqlite-request-ledger.ts, admission/project-request-ledger.ts, paid/spend.ts; new named connections access/execution/ledger files and connection-listener-access.test.ts. Existing project grant paths retain their authority checks.
- Panel worker gpt-6.1-sol/medium owns the same four panel files and report. Compact enable/status plus host/port, one protocol/model/endpoint setup card, small mode controls; agent scope/limits and examples are secondary. No project prerequisite for global enablement; no direct profile field. Wait backend types before integration.
- Review worker gpt-6.1-sol/max owns its report only. Read-only review of global taskless Gate/capacity/accounting and configurable bind/auth/Host/origin contract; then review frozen changes. No source/runtime/tests/build/Git actions.

### Global direct routing regression revision
- Role/model/effort: worker gpt-6.1-sol/max, live_project_resume_now.
- Owns: packages/router/tests/client-connection-routing.test.ts; new packages/router/tests/client-global-routing.test.ts; own direct-routing report only.
- Must not touch production, other tests, panel, runtime/config, shared docs, Git or builds. No agents or live providers.
- Adapt actual Gate fake-transport tests to requestClientConnection({chat}, signal, accessToken?) with no selected project or completion/summarize profile, in legacy and split installations.
- Preserve caller history/tools/images, key rotation/model fallback and failed/uncertain accounting assertions. Verify no synthetic project/task rows.
- Add focused shared global/project quota and provider capacity tests, paid refusal/accounting and exact captured authority where existing public seams permit. Do not weaken project grants or refund unknown attempts to make fixtures pass.
- Read Current State, prior routing tests and backend stable contract; coordinate needed hooks with backend. Write tests now, wait lead validation slot before running.
- Return exact checks/results and unverified gaps in own report; production owner owns fixes.

### Full-regression failure investigation
- Role/model/effort: worker gpt-6.1-sol/max, connections_backend.
- Owns: its existing report only for this read-only pass; supervisor.test.ts and narrow supervisor startup/question paths are read-only while the aggregate runs.
- Investigate the interruption test's missing question after its fixed ten-second poll. Distinguish startup scheduling delay from a routing/lifecycle regression using source and available full-run evidence.
- No edits, tests, builds, runtime actions, Git or agents. Propose the smallest isolated reproduction with useful failure diagnostics for after the full run; do not weaken expectations or infer a timing flake without evidence.

### Backend discovery and contract
- Role/model/effort: worker gpt-6.1-sol/max, connections_backend.
- Goal: Design and implement connection modes after lead agrees concrete contract; first report narrow design and existing supported service seams.
- Owns: packages/router/src/connections/**, config/schema.ts, config/load.ts, core/service.ts, index.ts; specifically named connection tests; own connection-modes/reports/backend.md.
- Must not touch: panel, unrelated source/tests, runtime/config/keys, builds, Git or shared documents.
- Reads: Current State; existing connection dispatch/protocol/server; task/job submission/cancellation/status contracts and relevant config validation.
- Need: direct arbitrary supported chat/tool/multimodal requests without summarize instruction injection; actual Gate fallback/key-rotation tests; agent and team submission/status/cancel via existing service paths.
- Agent scopes must be selected registered project/repositories; durable connection ownership must prevent reading/cancelling arbitrary jobs. Settings explicitly enable modes and bound agent requests/time/spend.
- Propose minimal stable config/API types to lead before edits. Do not promise unsupported provider parameters or fabricate synchronous agent completion.
- No provider calls or agents. Focused isolated fake tests only after lead coordinates; report exact commands/results and remaining integration gaps.

## Work Ledger

### Panel modes
- Role/model/effort: worker gpt-6.1-sol/medium, connections_panel.
- Goal: Prominent direct/agent/team options, clear routing behavior and client setup/examples.
- Owns: apps/panel/components/client/connections.tsx, apps/panel/lib/connections.ts, apps/panel/app/api/connections/route.ts, apps/panel/app/all/connections/page.tsx; own connection-modes/reports/panel.md.
- Must not touch: router, other panel files, shared docs, runtime/config, Git, builds or live listener.
- Read Current State, owned files; inspect existing UI now, propose layout and wait for agreed backend types before edits.
- Show arbitrary supported direct conversation/tool requests route automatically across eligible models/keys; distinguish client tool execution from router agents.
- Agent modes need explicit enablement, project/repository scope and limits, truthful queued/running/result/cancel semantics; preserve saved state/default-off.
- Coordinate backend stable contract with lead. Isolated fake production browser validation later, serialized by lead. No provider calls or agents.

### Independent mode review
- Role/model/effort: worker gpt-6.1-sol/max, connections_review.
- Owns: only connection-modes/reports/review.md; source/shared docs/runtime/Git read-only.
- Review agreed contract first, then frozen backend/panel diff when ready; coordinate with owners without edits.
- Check external-input boundaries, token ownership/project isolation, budgets and revocation after awaits, active-job concurrency, exact cancellation scope and direct model/key fallback.
- Ensure aliases never misrepresent async acknowledgment as finished work, silently drop client tools/options, or bypass existing reviews and supervisor permissions.
- No tests/builds or live provider/SDK/config actions; report actionable findings immediately and final scope/remaining checks. No agents.

### Direct routing verification
- Role/model/effort: worker gpt-6.1-sol/max, live_project_resume_now.
- Owns: new packages/router/tests/client-connection-routing.test.ts and connection-modes/reports/direct-routing.md only.
- Must not touch: source, existing tests, runtime/config, panel, shared docs or Git. No builds/provider calls/agents.
- Read existing client-connections test fixtures and direct connection/Gate/provider transport seams needed for realistic tests; coordinate new protocol aliases/images with backend.
- Prove direct external requests preserve arbitrary caller history/tools, rotate usable keys after a key refusal, and fall back across eligible models/providers through real Gate with fake HTTP transport. Assert charged attempts/history and no hidden caller-tool execution.
- Add supported image/modality routing coverage if possible once backend new types are stable. Use fake metadata, fake keys and isolated temp stores only.
- Write test source now; run focused test only when lead assigns validation slot. Report exact result or why not run; no duplicating backend job lifecycle tests.

### 2026-11-05 — Inspection
- Agent: Lead.
- Validation: Read existing dispatch, protocol, panel config route, startJob and chat transport contracts.
- Outcome: Direct route uses Gate but needs explicit fallback proof; agent modes not present.
- Follow-up: Fix stable mode contract, implement disjoint backend/panel pieces, validate lifecycle and routing with fake providers and production panel.

### 2026-11-05 — Boundary review during implementation
- Agent: Lead and independent reviewer.
- Findings: Captured default repository scope must be checked against the fresh allowlist after validation; profile name alone cannot fence a changed profile mode. Team qualification must not create unowned work before insertion. Cancellation must fence pending legacy delegations and sweep newly discovered descendants. Terminal roots with active descendants remain active jobs for limits/status.
- Outcome: Backend owns targeted corrections and regressions. Panel mode configuration is implemented and awaiting integrated validation.
- Validation: Source traces only at this checkpoint; no test or live inference result claimed.
- Follow-up: Run direct Gate/key/model fake-transport cases, job authority/lifecycle races and production browser checks after source freeze.

### 2026-11-05 — Direct routing proof
- Agent: Direct-routing worker, backend owner and lead.
- Finding/fix: The direct request incorrectly set an aggregate task output budget equal to one response's output limit. A failed attempt consumed that allowance and blocked another key/model. Removed that aggregate override; retained each call's configured output ceiling, profile/tier budgets and all attempt accounting.
- Validation: Portable Node22 `vitest run tests/client-connection-routing.test.ts --maxWorkers=1` — 8 passed, 11.52s. Lead read the complete result summary. Both storage layouts cover 401/429 key rotation, model/provider fallback with uncertain 503 accounting, caller-owned tools/history and image protocols.
- Outcome: Direct routing parity verified with fake transport; no live provider quota spent.
- Follow-up: Agent lifecycle, existing compatibility regression, typecheck/build and production browser checks remain.

### 2026-11-05 — Agent lifecycle proof
- Agent: Backend worker and lead.
- Validation: Portable Node22 `vitest run tests/connection-modes.test.ts --maxWorkers=1` — 29 passed, 34.99s; lead inspected full result summary. Tests cover durable token ownership, legacy/split execution by separate workers, already-proven supervisor execution, qualification refusal without spend, scope/budget revocation, atomic active-tree caps, cancellation/delegation races and distinct physical accounting.
- Outcome: Scoped agent/team lifecycle verified with isolated fake providers. A completed supervisor response remains not_verified when no acceptance proof exists.
- Follow-up: Existing compatibility, integrated build/typecheck and production browser validation remain.

### 2026-11-05 — Integrated validation
- Agent: Lead and panel worker.
- Validation: `vitest run tests/client-connections.test.ts --maxWorkers=1` — 26 passed; `vitest run tests/client-supervision.test.ts --maxWorkers=1` — 8 passed, 34.82s. `pnpm --filter meritrouter build`, `pnpm -r typecheck` and `pnpm -r build` all exited 0.
- Validation: Isolated production panel validator — 18 grouped checks passed, four fake-provider calls, six screenshots, zero browser exceptions. Lead read results and inspected desktop/mobile mode screenshots. Covers mode settings, persisted restart, direct/native/streaming calls, queued agent/team/default aliases, token status/cancel, disable cancellation and occupied-port preservation.
- Outcome: User panel restored through supported lifecycle; Connections page/API HTTP 200, saved default direct and listener off preserved. Owned test processes and demo fixtures removed; only the authorized panel remains on its port.
- Follow-up: `vitest run --maxWorkers=2` is running with isolated fixtures before publication. No live provider quota spent on this feature's validation.

### 2026-11-05 — User-directed global direct revision
- Agent: Lead, backend, panel and independent routing-test workers.
- Decision: Global enablement requires no project. Direct uses intrinsic installation routing and a host-owned empty-member execution; no configured completion profile, hidden project or task. Agent scope stays separate and explicit. Host/IP and port are editable; non-loopback binding uses a generated, hash-only Connections key.
- Validation: Prior full regression deliberately interrupted on the new user correction after five files passed (70 tests); no aggregate result. Process inspection found no remaining Vitest workers. The previous panel remains available until the replacement build is ready.
- Validation: Revised runtime `tsc -p packages/router/tsconfig.build.json --noEmit` passed (backend); lead `pnpm --filter meritrouter build` passed, 9.86s; `pnpm --filter meritrouter-panel typecheck` passed, 6.18s. TEMP browser validator `node --check` passed.
- Review: Compact panel source review found no concrete issues. Lead corrected a generated-key encoding mismatch with the owners before testing. Runtime source frozen for independent review; new direct/global tests and host/auth/browser validation pending.

### 2026-11-05 — Global routing proof and boundary corrections
- Validation: `vitest run tests/client-connection-routing.test.ts --maxWorkers=1` — 8 passed, 8.86s. Lead inspected JSON and log. Both storage layouts preserve key/model fallback, caller history/tools/images and uncertain attempt accounting with no selected project/completion profile, no task rows and no project/grant mutation.
- Review findings: Stale saved agent scope must not prevent global enablement; known policy/abort/config refusals before a reservation must not be misclassified as persistence uncertainty and quarantine an empty provider slot; positively identified global direct accounting must not consume every split project's individual share or paid cap.
- Decision: Backend owns narrow fixes and regressions. Extra owned accounting-usage.ts and paid/spend.ts separate known direct usage from project-only totals while preserving global/key totals and conservative unknown legacy attribution. Unknown transport/persistence exposure remains retained; no age-based refund or automatic direct orphan recovery is introduced.
- Follow-up: Complete new shared quota/capacity/paid and listener tests, repeat affected typechecks/build, validate compact production panel and publish only after observed acceptance.

### 2026-11-05 — Revised acceptance and deployment
- Validation: `vitest run tests/client-global-routing.test.ts --maxWorkers=1` — 16 passed, 14.86s; `vitest run tests/connection-listener-access.test.ts --maxWorkers=1` — 14 passed, 9.59s; compatibility plus modes — 57 passed, 50.11s. Lead read logs and JSON results.
- Reproduction/fix: Stronger hour/day quota-refusal tests failed twice with an uncertain provider slot despite retired local preparation and no global receipt or dispatch. After quota-only typed refusal following successful durable retirement, the same filtered tests passed 2/2, 7.42s, preserving the earlier charge and leaving no slot, receipt, request or active preparation. Lead inspected both outputs and the five-line source change; independent review confirmed the retained uncertainty boundary.
- Validation: Final `pnpm -r typecheck` and `pnpm -r build` exited 0. Isolated compact production validator passed 10 grouped checks, three fake-provider calls, four screenshots and zero browser exceptions; lead inspected results plus desktop/mobile screenshots. Initial Host-header/collision fixture assumptions were corrected without product changes.
- Outcome: Authorized panel restored through its supported lifecycle; revised Connections page/API HTTP 200. No direct profile field or hash appears in ordinary API views; default host, disabled state and null agent project are preserved. Test ports/processes/demo fixtures were cleaned.
- Follow-up: `vitest run --maxWorkers=4` full router regression is running with frozen source. No aggregate result or publication is claimed yet.

### 2026-11-05 - Final regression and publication readiness
- Validation: `vitest run --maxWorkers=4` completed in 2464.16s: 270 files passed, one skipped, one failed; 3,425 tests passed, five skipped, one failed. The sole failure was the supervisor interruption fixture expecting a question within ten seconds, before shutdown/resume.
- Validation: Unchanged `vitest run tests/supervisor.test.ts --maxWorkers=1 -t "a shutdown while waiting for an answer"` passed (one test, 19.63s total). After aligning readiness with the adjacent bounded 90-second startup wait and adding status/request/event diagnostics, `vitest run tests/supervisor.test.ts --maxWorkers=1` passed all three tests in 83.76s. Exact request counts and interruption/resume assertions remain unchanged.
- Validation: Final `pnpm -r typecheck` exited 0 after the test-only correction; production sources remain those of the successful recursive build and compact browser acceptance. Full aggregate not repeated. Final live Connections page/API returned HTTP 200 with saved disabled/default-direct/null-agent-project settings preserved.
- Outcome: Acceptance complete; intended source, tests and public documentation selected for dev/main publication. Unrelated checkout changes and private operational evidence remain excluded. ThreatIntel untouched.
