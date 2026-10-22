# Roadmap completion
Status: Active
Status detail: User requested implementation of the remaining-work audit on 2026-10-22; initial correctness, Labs and packaging work dispatched.
Created: 2026-10-22
Last updated: 2026-10-22
Owner: Senior supervisor agent
Scope: Execute the remaining implementation and validation backlog recorded in handoff.md, preserving explicit spending and user-data boundaries.
Paired document: none
Related: [handoff](handoff.md), [labs](labs.md), [budget-control](budget-control.md), [direct-providers](direct-providers.md)

## Current State

Baseline dev/main e9a0726: Panel v2 and budget B1/B2 accepted; 622 tests passed. The user's
"ok BUILD IT THEN" authorizes implementing the remaining audit, rather than another audit-only
turn. Use documented defaults: feature labs, four active, isolated data, manual promotion;
package the panel with the CLI. Work is sequential where file ownership overlaps.

No live provider quota, paid routing, npm publication, user-install mutation or OS service
installation is implied. Build and validate with fake providers, temporary installs and demo
panel on spare ports. Real credentials/environment checks remain explicitly distinguishable
from completed code. Previously deferred R2/L5 require their architecture/acceptance design
before implementation; they are tracked below rather than silently omitted.

**Accepted integrated source e0aad08:** E1 correctness, Labs L1-L4, package discovery/setup/
bundled panel, external task tools, cache/catalog accounting, provider follow-ups, project
restore/deletion/config safety and process-race fixes. Supervisor frozen checks701/701
(78files,422.38s), recursive typecheck and isolated recursive build pass. Independent production
Labs lifecycle/API/live/browser, legacy migration and model navigation pass. Verification with
no metadata renders explanations; hovering the Team metrics section opens0 hints, one trigger
opens1, keyboard focus/closing work. Historical model links and catalog-only refresh pass.

Fresh tarball51,561,351bytes/2489entries installs outside checkout (QiBFVy); native SQLite,
CLI discovery/init/setup, MCP40tools,8 production panel/API routes and stylesheet, detached
setup start/reuse/stop pass with checkout reads forbidden. Owned fixtures are stopped. This
coherent unit was pushed to dev/main at77914fc (remote heads verified equal). Actual user
panel4477 and MCP processes were not restarted or used for tests; no deployed-fix claim.

**Next accepted source6d61b8e:** static-render browser checks, all-heads evidence reuse and
first async Gate accounting boundary, plus corrected MCP final-supervisor dispatch. Supervisor
observed734/734 tests in83files (484.47s), recursive typecheck/build, production policy UI/MCP,
model navigation, Labs18screenshots and legacy recipe API checks. Viewed desktop/phone captures.
Fresh tarball53,308,449bytes/2522entries installs outside checkout (hrAtm3): native SQLite,
CLI, MCP42tools,8 panel/API routes/CSS and setup start/reuse/stop pass; owned processes closed.

The async queue claim prerequisite418b106/public exports6754a11 is also accepted:753/753 tests,
85files,542.28s, recursive typecheck and isolated recursive build passed. Claims/companions await
validated data-only receipts; renew/finish/session/Git migration remains separate.

**Continuing:** Hydrated JS, ephemeral task Labs and Compose remain open. R2 inventory found81 SQLite consumers;
PostgreSQL/multi-host is not enabled. Ephemeral integration plan records attempt identity,
exact commit/tree evidence and durable auxiliary-process recovery prerequisites.
User additionally clarified MCP final-supervisor dispatch must default OFF, while bounded
sub-supervisors remain available. That setting/guard/UI work is merged locally under
[external-supervisor-guidance](external-supervisor-guidance.md); obsolete guidance-enable
toggle semantics were rejected. The corrected feature is accepted in the combined checks above.
Task-Lab lifecycle, async queue claim implementation and Compose design are dispatched under
file-partitioned briefs. No whole-roadmap completion claim. After explicit user approval,
accepted9682e92 was built and panel4477 restarted; live read-only browser confirms new default-OFF
setting, exact MiniMax model URL and Verification explanation. Config hash unchanged. Existing
MCP remains running its prior in-memory code until its client reconnects/restarts the server.
The user subsequently requested complete clone removal:8082 stopped, project resources deleted
through the supported API, remaining repository moved to Recycle Bin after automatic permanent
delete rejection. No clone at its old path. Wait for the user's future fresh Next.js/Node.js
build prompt after readiness. Richer model-request detail is newly requested and active in an
isolated UI/projection unit; it is not included in this accepted queue change.

## Execution phases

| Phase | Work and acceptance | Dependencies/state |
| --- | --- | --- |
| E1 | Sub-job scope, partial batch results, external context | Accepted in integrated701-test unit |
| E2 | Labs L1 lifecycle/ports/process ownership/CLI | Accepted Windows fixture/process evidence |
| E3 | Labs L2/L3 tools/brain/team binding/promotion/refresh | Accepted focused20 and full integration |
| E4 | Labs L4 panel/settings/demo and reported UI regressions | Accepted independent production browser/API/screenshots |
| E5 | Config discovery/setup/bundled panel/package | Fresh isolated install passes; no publication or cross-platform install claim |
| E6 | External tools, accounting, providers, restore/config/project fixes | Accepted fake-provider/process/production checks; live-provider limits remain |
| E7 | Concurrent processes/crash/CLI/MCP/deletion/performance | Measured and passing integrated; no real-provider throughput claim |
| E8 | Remaining L5 and R2 phases | Static browser/first async ledger accepted; JS/ephemeral/Compose/PostgreSQL still open |
| E9 | User-requested configurable MCP final-supervisor ownership | Accepted default false + bounded sub-supervisors, dispatch/resume guards and UI |

For each phase the supervisor reviews diffs, runs relevant tests then recursive typecheck/build
and full router suite for integrated code. Panel work additionally uses seeded demo production
HTTP/API routes and headless Chrome desktop/phone light/dark captures. Only complete coherent
passing units reach dev/main. Documentation and source commit together.

## Worker Briefs

### Brief: distributed-storage-inventory
- Repository: `.claude/worktrees/roadmap-process`; read-only source investigation while integrated root acceptance runs. Existing uncommitted supervisor config files must remain untouched.
- Task: produce an executable R2 asynchronous persistence migration brief from actual source, not a generic design. Read distributed-and-lab-extensions.md in root read-only if absent here, task claims/service/admission/session/artifact/coordination boundaries and relevant callers.
- Owns: only `docs/working/roadmap-completion/reports/distributed-storage-inventory.md`. Do not edit code, manifests, shared documents, branches or generated files; no commits/push.
- Required output: inventory direct SQLite users grouped by subsystem, transaction boundaries that must remain atomic, concrete async interface signatures and staged file partitions. Identify the smallest genuinely integrated first slice (not unused adapter scaffolding), its callers, compatibility migration and acceptance tests.
- Include worker-host affinity and lease fencing dependencies; distinguish synchronous public API compatibility from backend-safe async work. No process-per-query emulation or shared network SQLite.
- Inspect available PostgreSQL fixture options without installation or starting OS services; downloads/container starts not in this brief. No user data/real providers. Report actual tool availability and commands, do not claim multi-host verification from local two-process tests.
- Return concise recommendation for next implementation partition with exact owned files and API contract; supervisor owns scope/integration and will independently verify.



### Brief: team-correctness
- Repository: .claude/worktrees/roadmap-team, feat/roadmap-team, isolated from root validation.
- Task: E1: reproduce and fix parent path restrictions lost by sub-jobs, partial completed batch results discarded on later failure, and external TASK.md missing inline/file context. Start from current implementation; preserve attribution, budget charging, resume and containment.
- Required reads: this Current State; agent-sessions-and-teams.md Current State; harness/supervisor-tools.ts, runners/batch.ts and coding runners/context as needed.
- Owns: harness/supervisor-tools.ts; runners/batch.ts; runners/supervisor.ts; core/executor.ts (authorized after reproduction showed partial-batch persistence must be handled there); runners/coding external context files; named task-scope enforcement if required; relevant tests. Report roadmap-completion/reports/team-correctness.md.
- Must not touch: config schemas, migrations, core/service.ts, CLI, labs, package files, panel, shared docs, provider code. No commits/push, real providers or user data.
- Acceptance: demonstrate original failures and passing regressions, including nested delegation enforcement and completed sibling retained after batch failure. Narrow tests/typecheck; report limits.

### Brief: labs-core
- Repository: .claude/worktrees/roadmap-labs, feat/roadmap-labs, isolated.
- Task: Labs L1 core from labs.md D1-D11: validated recipes/config, persisted lifecycle/ports, branch worktrees/data/env/setup, supervised services/readiness/logs/restart/idle/adoption, declared checks, destroy preserves branches. Commands remain config owned; strong project/port/process ownership checks.
- Required reads: labs.md Current State/design/acceptance; config/project schemas and resolution; migrations; workspaces/git; coding process; core service lifecycle read-only.
- Owns: new src/labs/**, config/schema.ts, projects/schema.ts and project config resolution necessary for lab fields; storage/migrations.ts appended entry; tests/labs*.test.ts and own fixtures; report roadmap-completion/reports/labs-core.md.
- Must not touch: core/service.ts, CLI/index exports, panel, harness/supervisor tools, shared docs, packages or provider code. Supervisor integrates service/CLI/public exports later. No commits/push or user data.
- Contract: provide exported LabManager API and validated schemas; public integration owned by supervisor. Services run only configured commands in owned fixture worktrees. Validate persisted rows with zod. No catch-all files or files >800 lines.
- Acceptance: real tiny fixture HTTP processes, two labs distinct ports/data, readiness, crash/backoff, idle, destroy process-tree cleanup/branch retained and owner adoption; bounded tests and clear report. Never kill arbitrary PID without verifying ownership.

### Brief: packaging
- Repository: .claude/worktrees/roadmap-package, feat/roadmap-package, isolated.
- Task: npm distribution implementation: deterministic default config discovery and init/setup, ship runnable panel with package using standalone build (or a concrete equally installable design), preserve explicit --config/SWITCHYARD_CONFIG. Produce/install tarball into temp outside repository; CLI help/init, MCP and demo panel smoke checks. No npm publish.
- Required reads: handoff packaging gaps; cli.ts/cli args/help/operations, config/load.ts, panel launch/runtime, package manifests, next.config.ts and build scripts.
- Owns: CLI files, config/load.ts, panel launch area, package manifests/build scripts/lockfile if needed, next.config.ts; packaging tests/new named packaging files; report roadmap-completion/reports/packaging.md.
- Must not touch: schemas, migrations, labs, core/service.ts, harness/runners/providers, panel pages/components, shared docs. Supervisor integrates Labs CLI after you freeze.
- Acceptance: tarball includes required runtime assets/charters/presets, native dependency installs, temp install runs without checkout workspace links, no real config/store used. Narrow meaningful tests; report exact commands and limits. Do not publish or commit.

### Brief amendment: project-recovery (next worker after E1)
- Repository: .claude/worktrees/roadmap-project, feat/roadmap-project, baseline e9a0726; isolated from root validation.
- Task: Reproduce/fix partial store+brain restore on brain-phase failure; archived project naming/read-only presentation; repository-preparation hints and generic settings path-save preparation. Inspect strict promotion repository aliases and improve only when unambiguous without weakening project boundaries.
- Required reads: projects.md Current State; operations restore/backup, admin project/settings/config editing and relevant panel components. This document Current State defines boundaries.
- Owns: src/operations backup/restore files; admin/project-settings.ts, admin/config-edit.ts and admin/projects.ts if needed; project switcher/sidebar and project settings forms only; relevant project/operations tests; own report roadmap-completion/reports/project-recovery.md. Ask before editing other shared files.
- Must not touch: schemas/migrations, core/service.ts/executor.ts, config/load.ts, CLI, provider/model/gateway/routing files, Labs or shared docs. No commits/push, user data or live quota.
- Acceptance: forced brain restore failure leaves original store/brain intact or restores both; happy restore and backup compatibility pass. Panel read-only/name/hints verified with focused tests/build; supervisor browser acceptance. Preserve source evidence and scoped alias refusals.

### Brief: labs-integration (after L1 checkpoint)
- Repository: labs worktree, new branch after supervisor commits L1 and merges team-correctness checkpoint; read root Current State and labs.md.
- Task: L2/L3: lab-bound jobs with enforced one root team per lab, subjob inheritance, lab integration branch and after-integration checks/restart; scoped harness/MCP tools and charters; gated refresh/promotion queue, overlaps/behind state/conflicts. Preserve standalone job behavior and manual promotion never writes target automatically.
- Owns: labs/**; appended migrations; core/task.ts lab schema; runners/types.ts; runners/supervisor.ts, harness/supervisor-tools.ts and integration-tools.ts after E1 merge; mcp/tools.ts; charters and CLAUDE.delegation.md; focused labs integration/promotion tests and own report. Root owns core/service.ts/executor.ts/public exports/CLI/panel and shared docs.
- Contracts: LabManager status/lifecycle stable. Expose typed job branch/context binding, integration hook, scoped http and logs/checks/status APIs; root injects manager into RunContext and service. No arbitrary model commands or cross-project lab lookup.
- Ownership/control: add validated persisted operation/desired-state requests handled by current leased owner so CLI/panel can stop/restart without stealing a live lease; root implements labs serve/CLI launcher. No model worker is auto-started just to supervise services. Concurrency must not start services twice.
- HTTP: require running owned service and current token/listener-tree verification, not just allocated port; only that lab's loopback endpoints, bounded response/timeout, reject external redirect/URL/header escapes. Test stopped port rebound by unrelated process.
- Promotion: capture exact checked heads, serialize per target, recheck heads/cleanliness/ownership before target mutation; manual only prepares and gives instructions. Refresh conflicting work remains in lab for its team; preserve source/user checkout and attribution. Overlap paths and behind status are evidence, not prompt guarantees.
- Requirements: reject project/repo config deletion while retained labs exist (coordinate with root/project worker; do not edit their files). Surface readable SwitchyardError codes. No commits/push, live providers or user data.
- Acceptance: real scripted lab job/tools/integration/restart/checks; two conflicting labs promotion order; manual target untouched; cross-lab HTTP refused and concurrent lifecycle control safely routed. Narrow tests/typecheck and exact report.
- Report: roadmap-completion/reports/labs-integration.md. Send API contract early; no broad panel edits.

### Brief: cache-catalog-accounting
- Repository: .claude/worktrees/roadmap-accounting, feat/roadmap-accounting from roadmap-core.
- Task: retain provider-sourced parameter provenance, quantization and trained/max context metadata in catalog; separately account Anthropic cache-creation tokens/pricing without silently undercharging paid budgets.
- Required reads: caching-and-continuity Current State; catalog/enrichment; gateway usage normalization/pricing; paid accounting/admission and session usage schemas. Official provider documentation for wire contracts; no hard-coded changing prices.
- Owns: models catalog/enrichment files; gateway usage/types/Anthropic pricing integration; paid pricing/spend; admission/admission.ts; usage/session schemas needed for cache-creation accounting; focused tests and report cache-catalog-accounting.md.
- Must not touch: config/schema.ts or migrations (nullable cache_creation_input_tokens and optional cache_write_input_usd_per_million already supplied by L1); runners/coding, harness, core service/executor, CLI/public exports, panel or shared docs. Ask before expanding ownership. No commits/push/user data/live providers.
- Contract: preserve null/unknown distinctions and existing rows; configured/verified write prices only. Authoritative provider-reported cost wins. Paid reservations must bound writes, not only ordinary input/read; unknown write pricing must fail closed or disable cache creation with a demonstrably enforced wire boundary. Send proposed unknown-price policy to root before implementation.
- Acceptance: fake Anthropic creation/read/ordinary usage normalization and persistence, actual configured cost/reservation safety, unknown-price boundary, backwards compatibility; provider provenance/quantization/context retained. Narrow tests/typecheck, exact report and limits.

### Brief: labs-panel
- Repository: isolated roadmap-labs-panel worktree/branch; supervisor supplies current service and L2/L3 APIs before implementation validation.
- Task: E4/L4 project-scoped Labs list/detail/editor/settings, create/start/stop/restart/check/logs/refresh/promotion controls and lab choice for new jobs; clear ownership/queued-operation state and meaningful failures. Preserve archived-project read-only policy and live page refresh.
- Required reads: labs.md Current State/L4; root roadmap Current State; LabManager publicStatus/control API and recipe schema; existing project routes/forms/admin insights and live subscriptions.
- Owns: new admin/labs.ts, panel Labs pages/components and api/labs/**; project navigation Labs entry, job creation form/API lab selection; project settings recipe/editor section; demo seed Labs fixtures. Own tests/report labs-panel.md. Root alone owns admin/insights.ts, admin/live.ts, service/executor/CLI and shared docs.
- Boundaries: data through public router/admin facade; no service tokens, raw env, secret commands or unscoped project lookup in API/UI. Recipe commands remain human config, model tools cannot author them. Models/services never auto-run on page load; route writes enqueue to existing Labs supervisor after explicit human action. Coordinate launcher public API with root; do not launch model worker.
- Initial step: inspect and report intended files/API contract; wait for supervisor dependency merge before edits relying on missing APIs. Do independent UI/design work while dependencies integrate; no fake success flags or generated-dist source substitutes.
- Acceptance: focused tests, production router+panel build, demo pages/API plus desktop/phone light/dark screenshots (root independently verifies). Create two fixture labs, logs/check/control queue/promotion reason/denied cross-project controls, archived read-only, no token exposure. No user data/providers/OS install/commits/push/shared docs.
- Report: roadmap-completion/reports/labs-panel.md, list exact checks and remaining limits.

### Brief: process-acceptance
- Repository: isolated roadmap-process worktree, feat/roadmap-process from current core checkpoint.
- Task: E7 independent real-OS-process fake-provider acceptance for queue claims/leases/recovery/provider slots/integration serialization and CLI/MCP budgets/transports. Reuse existing meaningful fixtures; add missing regressions rather than mirror implementation.
- Owns: new tests/process-acceptance*.test.ts, own fixtures under tests/fixtures/process-acceptance, report process-acceptance.md. Read affected source only for reproductions. No source edits without root scope amendment, no shared docs/commits/push.
- Boundaries: temp configurations/stores/repos/brains, fake provider HTTP servers only. Never real credentials/4477/userinstall/paid routes/public service installations. All spawned services/listeners/processes stopped in finally; verify owned process before kill. No repository-wide validation in another worker's tree.
- Acceptance: competing independent worker processes do not double claim or exceed provider slots; killed owner recovery/resume preserves durable attribution/session records without automatic coding replay; competing integrations serialize. Real CLI and MCP budget approvals/denials/accounting and HTTP/stdio schema refusals. Record exact commands/measurements and distinguish missing acceptance from actual defects.
- Follow-up: report reproduction and suggested bounded file ownership to root for any source fix; don't silently weaken assertions or call hard-kill persistence verified from caught exceptions. Keep test duration bounded; no live quota.
- Amendment: supervisor authorizes owning merge-queue source plus focused regressions after deterministic subprocess reproduction of live-owner recovery. Different process owner alone is not stale evidence; verify current leases/owner, preserve attribution and public API. Coordinate Labs worker if API changes.

### Brief: process-performance
- Repository: existing roadmap-process isolated tree after its source checkpoint; no edits to accepted process/queue files.
- Task: measure fake-provider concurrent task throughput/latency at bounded loads, live watcher cost on a realistically larger temporary store, and concurrent project deletion refusal/revalidation. Establish evidence for E7 gaps; do not equate fixture throughput with provider throughput.
- Owns: new tests/process-performance.test.ts or named scripts/benchmark-process.mjs and own report process-performance.md. Root owns admin/live.ts and projects deletion source; send findings before any source edits.
- Required reads: this Current State and exact public service/live/deletion contracts used. No broad discovery or real providers; use temporary SQLite/repos/brains and fake provider only.
- Acceptance: record dataset size, concurrency, elapsed/p50/p95, provider peak and watcher quiet/write tick costs; meaningful assertions for no lost/double work and scoped live changes. Revalidate parent source after Labs dependency merge if it changes measurement paths. Stop all owned processes/listeners and distinguish limitations.
- No commits/push/shared docs/user install/OS services/paid quota. Existing process source is frozen for root review; add only new benchmark/test/report files while root verifies it.

### Brief: model-navigation-regression
- Repository: roadmap-process worktree after its performance/deletion source is frozen; edits disjoint from those files. Supervisor creates a separate checkpoint before integration.
- Task: investigate user-reported model detail links yielding Not Found. Root read exact reported URL and model list via GET only: both200, correct model h1, no404 marker. Do not conclude client navigation is verified from that. Reproduce with isolated production demo and actual clicks, including slash/dot model IDs, model changes and tab query preservation; diagnose stale client/navigation behavior or missing historical-model details.
- Owns: panel model detail/list page and shared ModelLink/format modelHref only if reproduced; new focused regression/temporary isolated browser harness and own report model-navigation.md. Root owns task Verification fix, shared docs, public insights facade and live watcher. Ask before touching router catalog/data APIs.
- Must not mutate/restart4477, user config/store/browser profile, call providers or run tests against user data. Any production build uses your isolated worktree; coordinate memory-heavy Next compile with panel worker/root. Stop owned demo/browser services.
- Acceptance: concrete source cause and meaningful regression if defect reproduced, direct and client navigation with encoded IDs and tab switches, historical/unknown ID distinction. Report unverified browser state honestly; no speculative claimed fix. No commits/push/shared docs.

## Work Ledger

### 2026-10-22 - Request release and capture acceptance progress
- Agent: supervisor.
- Changed: reviewed/merged request journal UI3da30cf and classifier isolation06a154a. Capture82dfe80 independently29/29 tests passed12.02s and source reviewed; private admin/UI/purge integration remains local work in progress.
- Validation: request-only f77401c recursive typecheck/build pass. Unbounded-concurrency full suite765 passed/3 failed (87 files,336.95s): two Chrome broker/navigation timing failures and45s throughput timeout under overlapping builds/process tests. Single-worker rerun17/17 browser/performance tests passed155.30s, including actual Chrome8/8 and24-task concurrency1/4 throughput. No full-green claim; repeat bounded full suite after historical scope integration.
- Finding: deletion removes accounting cohorts, so journal original shared-member proofs must also be checked. Request projection now withholds missing/mismatched/deleted member proofs; independent8/8 tests passed4.92s. Session worker implements the corresponding historical guard and restores scoped failed-request accounting.
- Outcome: Partial. No richer request/capture deployment or whole-roadmap completion claim. Caller end-to-end fixtures passed in worker tree; independent final validation remains pending.

### Acceptance ledger: 2026-10-22 — browser, ledger and client supervision
- Agent: supervisor.
- Changed: accepted source6d61b8e with bounded static browser checks, fail-closed all-repository evidence reuse, awaited default Gate request accounting, corrected final-supervisor ownership setting/guards/UI.
- Validation:734/734 tests,83files,484.47s; recursive typecheck/build; actual production policy/model/Labs/legacy API/browser checks;18 Labs and4 policy screenshots, desktop/phone light/dark; fresh package53,308,449bytes/2522entries installed at temporary hrAtm3 with checkout reads forbidden, native/CLI/MCP42/panel8routes+CSS/setup lifecycle passed and processes closed.
- Outcome: Accepted coherent unit; no full-roadmap or user-install deployment claim.
- Follow-up: isolated task-Lab lifecycle and queue-claim workers implement next prerequisites; Compose worker writes executable design. Hydrated JS, full ephemeral integration, Compose and PostgreSQL/two-host acceptance remain open.

### Brief: external-runner-tools (next worker after project recovery)
- Repository: isolated roadmap-external branch/worktree based on E1 checkpoint plus current dev; supervisor creates it.
- Task: provide external OpenCode/command coding agents the declared run_check and request_more_budget capabilities, with the same code-enforced checks/limits/decision behavior as native agents. Inspect official adapter/source contracts before integration; never claim arbitrary command agents use a tool automatically.
- Required reads: budget-control Current State; runners/coding, policy gateway, harness/budget-tools and check tool, native loop budget growth, existing MCP transport/tool patterns, session journals and relevant tests.
- Owns: runners/coding/** after E1 freeze; harness/budget-tools.ts/check tool extraction if required (not supervisor-tools.ts or integration-tools.ts); new gateway external-task tool bridge; admission budget helpers only if required; focused external-tool/coding tests and own report. Ask before changing core/service, executor, exports/config/CLI or other public/shared files.
- Runtime boundary: loopback task-scoped authenticated bridge, current lease/task/lifecycle validation, only declared commands and bounded per-task check count; no provider secrets. No cross-task budget decisions, arbitrary commands or scope bypass. Journal real calls/results/charges and close listeners on every exit.
- Integration: use OpenCode's documented configuration/MCP mechanism and bounded command-agent connection metadata/context; preserve existing config overrides/provider gateway. Approved budget must reach subsequent external model requests, with paid caps unchanged and no extra requests during the wait.
- Acceptance: real temporary external fixture process invokes checks and budget tool, supervisor/human approval and denial, stale/foreign token/task rejection, command refusal/check-run cap, cleanup, approved continuation past old cap. Include command and OpenCode config generation tests. No real models or user install.
- Report: roadmap-completion/reports/external-runner-tools.md. No commits/push/shared docs. Root independently verifies and integrates.

### 2026-10-22 - Execution started
- Agent: supervisor
- Changed: created this execution plan from the consolidated audit and existing Labs design.
- Validation: read repository rules, protocol, current handoff/Labs plan and relevant integration seams; no new code validated yet.
- Outcome: Partial
- Follow-up: dispatch independent isolated workers; supervisor owns integration, broader acceptance and remaining phases.

### 2026-10-22 - Provider follow-up implementation begun
- Agent: supervisor, root feat/roadmap-provider; workers isolated in their named worktrees.
- Changed: health ranks before paid policy preference; free quota uses registry key-info shape; provider-key forms use registry metadata rather than hard-coded local IDs.
- Validation: source inspection established ordering/metadata gaps. Targeted regressions and recursive typecheck running; no passing claim yet. Found refreshPaidPrices already accepts injected fetch, so that audit item is stale rather than new work.
- Outcome: Partial
- Follow-up: observe tests/build and production demo browser checks; integrate only passing coherent work. Team worker may edit executor/supervisor as explicitly amended above; root service lifecycle integration waits for Labs core API.

### 2026-10-22 - E1 worker returned; provider checks and next dispatch
- Agent: supervisor; team-correctness worker.
- Changed: E1 worker frozen with scope enforcement, partial batch completion retention and full external task context; report awaits independent integration review. Project/recovery worker dispatched in a fresh isolated tree.
- Validation: root provider targeted suite passed 60/60; added model-quarantine live regression passed 18/18 live tests; recursive typecheck passes after rebuilding public router declarations. Initial full production build passed; follow-up model/key live subscriptions require final panel build/browser validation. Full router suite in progress.
- Outcome: Partial
- Follow-up: root provider/browser acceptance, integrate/review E1; Labs real-process fixtures and portable package smoke underway. Labs worker exclusively owns optional paid cache-write config field and a separate nullable usage-column migration requested by supervisor for later accounting integration; no guessed prices.

### 2026-10-22 - Provider unit accepted
- Agent: supervisor
- Changed: availability-first routing, registry-driven provider UI/free quota, reasoned quarantine retry with retained evidence, API and live model/key invalidation; authored docs and acceptance report.
- Validation: targeted60/60; live18/18; final frozen full suite624/624(63files,328.83s); recursive typecheck/build pass; final panel rebuild pass. Demo API400/404/409, UI retry preserves evidence; independent682ms refresh retains document marker. Four desktop/phone light/dark captures inspected; no overflow/exceptions; demo acknowledgement restored and services stopped.
- Outcome: Accepted for bounded provider unit; remaining E6 accounting/catalog work stays open.
- Follow-up: merge/push unit; independent E1/L1 verification running before integration. Report provider-followups.md records discarded overlapping run and fixture corrections.

### 2026-10-22 - Core checkpoints and independent package acceptance
- Agent: supervisor
- Changed: merged E1 5704654, L1 33630ee, project recovery 04fd8c5 and packaging 6cfa823 locally into roadmap-core. Added missing prepared-config public exports; retained-Lab config/deletion guards in progress. Labs L2/L3 and external tools dispatched; accounting brief extended narrowly to providers/anthropic.ts, enrich.ts, discovery.ts and gateway/direct.ts.
- Validation: independent E1 5/5 and Labs 8/8; independent existing-tarball outside-checkout smoke passed native SQLite, CLI discovery/init/setup, MCP36 tools/usage_summary, eight panel/API pages plus stylesheet, detached setup launch and shutdown. No checkout runtime reads, live quota or user install changes. Root focused project/package checks running; no integrated acceptance claim yet.
- Decision: unknown paid Anthropic cache-write price disables all cache markers at the wire boundary; native server search also disables paid caching until an internal-token reservation bound exists. Configured ordinary/read/write maximum bounds known prompt-only writes. Provider-reported cost remains authoritative; worker to verify with fake wire tests and primary documentation.
- Outcome: Partial
- Follow-up: finish project/browser guards, Labs service/CLI integration and accounting/external reports; integrated full checks and fresh package needed before push. Provider unit alone already pushed to dev/main at7a1873f.

### 2026-10-22 - Process races fixed; reported panel bugs added
- Agent: supervisor and bounded workers
- Changed: merged external tools6fc8d60, accountingec92e74, durable integration mutex190e98b and project deletion4d9099c locally; root config writerdccaa42 supplies transaction serialization and expected-text comparison. Added Labs native/external tools, read-only lane context, scoped live source and follow-on L5/R2 architecture (pending L2 API merge, not integrated acceptance).
- Validation: supervisor independently external5/5; accounting27/27; process acceptance5/5(10.07s) including actual kill/recovery and CLI/MCP; performance/deletion9/9(28.10s). Under concurrent build load fake throughput10.46/s atc1 and20.69/s atc4;61k rows quietp95.279ms/writep95211.81ms. These are fixture measurements, not provider performance claims.
- Findings: concurrent archive/delete and simultaneous deletions could remove last live project; stale config and failed config backup could lose data. Corrected with final serialized lifecycle/snapshot revalidation and write-before-purge rollback. Windows PID-only ancestry in Labs also falsely associated an older unrelated listener; worker replacing /T termination with birth/command-verified individual processes before final acceptance.
- User steering: model detail links reported404 and task Verification tab empty. Root read exact reported model URL successfully200/correcth1/no404 marker; client behavior remains under isolated browser investigation. Verification source had an unconditional empty return when all persisted metadata absent; removed so explanations render. Browser regression is required before calling it fixed.
- Outcome: Partial
- Follow-up: accept L2/L3 after process identity fix and scripted job/brain ledger regression, merge into panel tree with real insights exports, then production/browser and frozen integrated checks. E8 remains architecture-only; no whole-roadmap or live-provider completion claim.

### 2026-10-22 - Integrated suite exposed MCP contract gaps
- Agent: supervisor
- Changed: portable descriptive Lab operation MCP schema retains unknown fields for strict runtime validation; updated tool inventory assertions for four new tools; restored external coding session-note prefix.
- Validation: first integrated full suite686/691(77files,372.58s); exact failures were MCP operation oneOf/no-type portability, three stale36-tool assertions and session-note prefix. After repairs router build, recursive typecheck and focused MCP/session16/16(16.77s) pass, including invalid operation field/missing check name regressions.
- Outcome: Partial
- Follow-up: repeat full suite before push; L4 production/browser acceptance active in isolated tree. L5 static-render browser checks and concrete R2 persistence inventory dispatched with written briefs; neither completes its full future phase.

### 2026-10-22 - Frozen integrated checks pass; partial Lab status repaired
- Agent: supervisor
- Changed: status omits an endpoint whose declared placeholders are not yet allocated during creating/failed creation; normal states retain strict substitution. This preserves readable recovery evidence instead of throwing while the durable create operation runs.
- Validation: frozen6a77c4a full suite691/691(77files,393.07s), recursive typecheck and router build pass. Subsequent partial-status regression initially caught a wrongly scoped fixture root (corrected); focused labs-service2/2(4.44s) pass for creating/failed/stopped and normal team binding.
- Outcome: Partial
- Follow-up: L4 production/browser report pending supervisor repetition; rebuild and full suite with L4/partial-status fix before push. New user request for configurable external supervisor guidance tracked separately.

### 2026-10-22 - Independent panel acceptance and catalog watcher regression
- Agent: supervisor
- Changed: restore explicit catalog-version mark while retaining narrow meta invalidation; the earlier global-meta optimization missed catalog.bump-only changes.
- Validation: independent frozen L4 admin8/8; real production Labs lifecycle/API/browser run passed with18 screenshots, actual hover/focus/Verification assertions, promotion instructions, zero model-request delta; legacy migration production API passed. Owned processes1888/23396/8240/2456/23272/20336 verified absent. Screenshots detail/light, recipe/phone/dark and Team metrics focused inspected.
- Findings: independent model-navigation initially lacked its required production server (fixture invocation corrected); then timed out on catalog-only title refresh. Root live regression19/19(9.03s) passes after narrow catalog-version repair; full browser repetition pending.
- Outcome: Partial
- Follow-up: merge L4, fix API project-slug parity, repeat model browser against final production build, integrated full checks/package. New external supervision feature separately active.

### 2026-10-22 - Labs/core/package coherent acceptance
- Agent: supervisor
- Changed: integrated L4b4039ae, catalog-version39c966d, partial-status9e06031 and project-slug paritye0aad08; updated authored Labs operations/setup/current state and user-corrected final-supervisor plan.
- Validation: frozen e0aad08 full701/701(78files,422.38s); recursive typecheck and isolated recursive build pass. Independent final production Labs/Verification/hover-focus/live/API18captures, legacy migration and model navigation all pass; no browser exceptions. Fresh npm tarball51,561,351bytes/2489entries; outside install QiBFVy native/CLI/MCP40/panel8routes+CSS/setup launch/reuse/stop passes with checkout reads forbidden.
- Outcome: Accepted for coherent E1-L4/package/correctness unit
- Follow-up: push dev/main under standing authorization, then continue E8/E9. User4477 untouched; future static browser/ledger/policy code not part of this acceptance. Earlier failed runs and repairs remain recorded above.

### 2026-10-22 - Accepted unit pushed; extension reviews continue
- Agent: supervisor
- Changed: merged accepted roadmap unit to dev and fast-forwarded main; both remote heads verified77914fc. No user process restarted. Merged async ledger0178ba7 and static browserb82be18 locally after independent review; added whole-environment browser-head reuse check and public validated contracts.
- Validation: supervisor browser8/8(131.52s) actual Chrome; ledger17/17(6.08s) including post-reservation persisted lease/cancel/deadline refusal; final-check reuse + scripted Lab2/2(13.19s). User-corrected final-supervisor policy independently13/13(9.62s) plus prior actual UI/MCP browser run and inspected desktop/phone screenshots; policy not integrated yet.
- Outcome: Partial for next extension/policy unit
- Follow-up: integrate policy and final commit-time revocation guard, full checks/build/browser/package. Static checks do not close JS/hydration, ephemeral/Compose or PostgreSQL. External user requested default final dispatch OFF with sub-supervisors allowed.

### 2026-10-22 - Corrected policy integrated; next combined checks start
- Agent: supervisor
- Changed: merged corrected policy5b4725a with ledger/static-browser units; optional supervisionScope persists bounded/project ownership, current permission rechecked before insertion, scopes/resumes validated. Authored roles/setup/operations updated. Public ledger/browser schemas and whole-environment evidence reuse exposed.
- Validation: independently policy13/13 plus corrected actual production browser/MCP save/reload and inspected4captures; scripted Lab + evidence2/2. First combined router build caught nullable unavailable heads in reuse-helper type; corrected to fail closed on null, added regression and router build passes.
- Outcome: Partial
- Follow-up: freeze for combined recursive typecheck/build and full suite; repeat production policy/Labs/model browser and fresh package before push. Accepted base remains dev/main77914fc.

## Open Questions

- No implementation choice blocks initial work. Documented defaults apply. Real-provider and externally installed-service validation depends on credentials/budget/environment authorization; code completion must not be reported as that evidence.
