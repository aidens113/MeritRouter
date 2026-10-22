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

**Checkpoint:** provider routing/registry/quarantine accepted and pushed at 7a1873f (624 tests,
recursive typecheck/build and demo browser acceptance). E1 checkpoint5704654 and Labs L1
checkpoint33630ee merged locally into roadmap-core; supervisor focused tests 5/5 and 8/8.
Project recovery and packaging merged locally and independently tested (19 focused tests,
outside-checkout native/CLI/MCP/panel/setup smoke). Accountingec92e74 independently27/27,
external bridge6fc8d60 independently5/5 and merged locally. Service supervisor real-process
start/reuse/stop keeps queued model work untouched. Root b9da590 wires pending L2 APIs;
L2/L3 and panel work active; Windows process identity/orphan cleanup is receiving final tests.
Durable integration mutex190e98b independently5/5 and deletion races4d9099c independently9/9
are merged locally. Reported blank Verification source fixed pending browser acceptance;
model-history link404 reproduced and fix underway (current exact reported URL reads200).
L2/L3 is now merged at002515e; supervisor20/20 focused tests pass. Historical model links
fixed atb5d0723; Team metrics hint selectors are scoped to their own trigger at9e23fb6.
Integrated typecheck passes; first full run686/691 exposed an MCP schema portability defect,
stale tool-count expectations and an external session-note prefix regression. Repairs6a77c4a
pass the frozen repeat691/691(77files,393.07s). L4 production acceptance is active and exposed
a Next-bundled CLI launcher path defect plus partial-create status handling; repairs remain
in its isolated tree. L5 static browser checks have a bounded isolated worker brief; hydrated
JS checks remain separate. R2 storage inventory found81 direct SQLite consumers; the first
actual async Gate request-accounting migration is dispatched, PostgreSQL remains disabled.
Whole integrated checks and push remain pending. No whole-roadmap completion claim.

## Execution phases

| Phase | Work and acceptance | Dependencies/state |
| --- | --- | --- |
| E1 | Reproduce/fix sub-job scope propagation, batch result preservation and external context; meaningful regressions | Merged locally, focused checks pass; full integrated checks pending |
| E2 | Labs L1 schema/store/lifecycle/ports/process supervisor/checks/CLI; two running fixture labs, restart/adoption/idle/destroy | Core/service/CLI local; final process identity hardening in L2 tree |
| E3 | Labs L2/L3 job/tools/brain/charters plus promotion/refresh/overlap/conflict handling; scoped fixture job and competing promotions | Final worker acceptance in progress |
| E4 | Labs L4 panel/settings/demo/docs; production pages/API/screenshots | Draft complete, pending E3 merge and production acceptance |
| E5 | npm config discovery/setup/bundled panel; pack and install outside checkout, CLI/MCP/panel smoke checks | Independent smoke passes; fresh integrated package pending, no publishing |
| E6 | External runner checks/budget tools; provider quarantine/order/metadata/pricing; project/restore fixes | Merged locally/independently checked; provider unit pushed |
| E7 | Concurrent-process/crash/CLI/MCP acceptance, caching/verification edge cases, performance measurements | Process/deletion fixes and baseline measurements accepted locally; integrated remeasurement pending |
| E8 | Design/implement explicitly future L5 and R2 as bounded follow-on phases; browser/ephemeral/Compose checks and two-host queue acceptance | Architecture review after E2/E3; no silent completion claim |

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

## Open Questions

- No implementation choice blocks initial work. Documented defaults apply. Real-provider and externally installed-service validation depends on credentials/budget/environment authorization; code completion must not be reported as that evidence.
