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

**Checkpoint:** provider routing/registry/quarantine unit independently accepted (624 tests,
recursive typecheck/build and demo browser acceptance); merge/push follows. E1 checkpoint5704654,
Labs L1, project recovery and packaging have returned; supervisor independent integration is
pending. Labs L2/L3 is the next dispatched phase. No whole-roadmap completion claim.

## Execution phases

| Phase | Work and acceptance | Dependencies/state |
| --- | --- | --- |
| E1 | Reproduce/fix sub-job scope propagation, batch result preservation and external context; meaningful regressions | Assigned team-correctness |
| E2 | Labs L1 schema/store/lifecycle/ports/process supervisor/checks/CLI; two running fixture labs, restart/adoption/idle/destroy | Core assigned; CLI after packaging |
| E3 | Labs L2/L3 job/tools/brain/charters plus promotion/refresh/overlap/conflict handling; scoped fixture job and competing promotions | E2 |
| E4 | Labs L4 panel/settings/demo/docs; production pages/API/screenshots | E3 stable API |
| E5 | npm config discovery/setup/bundled panel; pack and install outside checkout, CLI/MCP/panel smoke checks | Assigned packaging; no publishing |
| E6 | External runner checks/budget tools; provider quarantine/order/metadata/pricing; project/restore fixes | Partition after initial workers return |
| E7 | Concurrent-process/crash/CLI/MCP acceptance, caching/verification edge cases, performance measurements | Affected APIs stable; no real providers |
| E8 | Design/implement explicitly future L5 and R2 as bounded follow-on phases; browser/ephemeral/Compose checks and two-host queue acceptance | Architecture review after E2/E3; no silent completion claim |

For each phase the supervisor reviews diffs, runs relevant tests then recursive typecheck/build
and full router suite for integrated code. Panel work additionally uses seeded demo production
HTTP/API routes and headless Chrome desktop/phone light/dark captures. Only complete coherent
passing units reach dev/main. Documentation and source commit together.

## Worker Briefs

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

## Work Ledger

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

## Open Questions

- No implementation choice blocks initial work. Documented defaults apply. Real-provider and externally installed-service validation depends on credentials/budget/environment authorization; code completion must not be reported as that evidence.
