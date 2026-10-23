# MeritRouter rename and documentation
Status: Complete
Status detail: Rename, onboarding, requested UI refinements and acceptance complete; authorized publication to dev/main.
Created: 2026-10-23
Last updated: 2026-10-23
Owner: Senior supervisor agent
Scope: Product identity, runtime contracts, package and panel names, examples, onboarding and current authored documentation.
Paired document: none
Related: [handoff](handoff.md), [index](README.md)

## Current State

Implementation is integrated on feat/meritrouter-rename: canonical MeritRouter runtime,
package/CLI, public types, configuration, environment, storage defaults, MCP and panel identity.
README begins with a copyable agent prompt; setup and migration docs preserve existing data,
keys and explicit paths. Historical paths and narrow cross-version protocol markers remain.

User UI refinements are integrated: Jobs lists work before a collapsed creation form; #new
opens it on direct/client navigation and preserves drafts. Overview includes reported token
totals and usage charts with operational details in Activity, no separate Usage tab. Agents
has role filters, status/session/task summaries and first/last activity. Requests with partial
cache accounting show approximate reported tokens without altering backend provenance.

Frozen checkpoint 9fa547a passed the full router suite: 117 files, 1193 tests passed, 2
Linux-only skips, 1138.85s. Clock and UI followups integrated as f3666cb and 23fa896.
Final recursive build/typecheck pass; final affected suites pass 49/49. Final installed
tarball CLI/setup/MCP (42 tools)/bundled panel smoke passes after integration.
Hardened demo exits 0, including 3 nested integrations/1 rebase and stopped fixture services.
Final browser interactions/mobile overflow and usage-focused visual refinement pass, including
19 branded routes, 8 changed-page screenshots and no browser exceptions. Chart axes accommodate
large token counts; token chart units are explicit.

Acceptance found and fixed two defects: legacy generated panel staging collided with an
existing user process (restored and SHA256-verified 1812 files; new staging bundled-panel
never touches it), and await_tasks used real time to reconcile injected-clock actions.
The clock fix has 3 regressions; demo phases now fail/settle unfinished tasks before changing
historical time. No user configuration or running service was changed.

Hosted repository is now https://github.com/aidens113/MeritRouter; origin updated and fetch
verified. Local acceptance is complete; supervisor is publishing dev/main. No npm publication
or live deployment. User services remain unchanged; follow setup migration before upgrading.


## Phases

1. Rename runtime/package/CLI/config/env/Git namespaces/examples; regenerate presets with script.
2. Rename panel imports/branding/cookies/launch scripts; retain UX and security semantics.
3. Rewrite onboarding and docs navigation; README prompt first, prerequisites, source install,
   configure a repository/key, connect MCP, first bounded task and approval workflow.
4. Integrate workspace/lockfile, inspect remaining old-name references and document exceptions.
5. Frozen recursive typecheck/build/full router tests, seeded demo routes/screenshots, outside
   checkout package install/CLI/MCP/bundled panel acceptance; no provider spend.
6. Record evidence, commit/merge/push dev/main under standing repository rules; no live deploy.

## Worker Briefs

### Isolated Jobs form layout
- Panel worker owns ONLY apps/panel/app/p/[slug]/jobs/page.tsx and NEW apps/panel/components/client/job-create-section.tsx if needed, plus own reports/job-form.md IN .claude/worktrees/meritrouter-job-form. No primary-tree edits.
- Move New job below all existing jobs. Collapse by default with clear accessible disclosure/summary. Retain full existing form and setup warning; preserve unsaved draft when toggled.
- Existing /jobs#new links must open/scroll to the form on initial and client navigation. Change empty-state copy from form above to below; preserve enabled/disabled/labs behavior. No endpoint/security/routing changes.
- Offline frozen pnpm install permitted in own worktree. Focused syntax/type checks only, no build/full/demo/user config/process operations. Root owns integrated production browser and publication; no commits.
- Extension: same worker additionally owns app/p/[slug]/page.tsx, app/p/[slug]/agents/page.tsx, components/requests-view.tsx in isolated UI worktree. Project Overview gets existing usage graphs inline, token stat/input-output chart from existing DTOs, no Usage tab; legacy usage query resolves Overview. Agents uses existing AgentRow role/label/running/timestamps/tasks/sessions/status with proper filter/summary/badges/scopedlinks, no backend/N+1. Requests unknown-cache state shows ~reported total with honest reported-token label/concise provenance, known-cache exact unchanged. No backend metric mutation.
- Ordering refinement: Overview is usage-first; existing Labs/running-jobs/repositories blocks move into Activity so they do not precede the charts. All existing navigation remains available.

### Isolated clock correction
- Separate worktree .claude/worktrees/meritrouter-clock, branch feat/meritrouter-clock-fix based9fa547a. Root checkout remains frozen for full suite.
- Security worker owns ONLY packages/router/src/harness/supervisor-tools.ts, new packages/router/tests/supervisor-action-clock.test.ts and own reports/clock.md IN THAT WORKTREE. No edits in primary checkout.
- Pass s.ctx.now to both await_tasks WorkerActionRequests constructors; keep Date.now for elapsed waits. Regress pending action survival/projection with historical injected clock, operator real execution, actual injected expiry still refused. No weaker authority/expiry checks.
- Worker may pnpm install --offline --frozen-lockfile and focused Vitest in isolated worktree; no build/demo/full suite/provider/userconfig operations. All commands stay in worktree/repository. Send freeze/diff/results, no commits.
- Supervisor reviews, commits in child worktree, then integrates only after primary full run finishes and rechecks affected suites. Demo fixture may be strengthened separately after diagnosis; never mask clock defect.

### Router rename
- Own packages/router/** except package.json (supervisor owns manifest); no panel/root/docs edits.
- Read this Current State, relevant package/runtime/config/setup source, then discover own tree.
- Replace brand variants consistently: SwitchYard/Switchyard => MeritRouter; SWITCHYARD => MERITROUTER; switchyard-router => meritrouter; remaining switchyard => meritrouter.
- Include public class/error/type symbols, MCP identity/tool descriptions, service names, Git refs, env/default config/storage, scripts/fixtures/charters/evals/examples. Rename example filename and regenerate presets via script, never hand edit generated YAML.
- Review durable Git/service/protocol markers: migration must not destroy old data; explicit old config paths remain usable. Report any compatibility hazards needing supervisor decision.
- Add/update proportionate rename/config discovery tests; preserve existing behavior assertions, no provider calls. No broad build/full tests while others edit. Report in meritrouter-rename/reports/router.md, no commits.

### Panel rename
- Own apps/panel/** only; no router/root/docs edits except own report.
- Read this Current State and discover branding/import/env/script/icon surfaces.
- Library import/package becomes meritrouter; panel package meritrouter-panel; title/labels/assets MeritRouter; MERITROUTER_* env and meritrouter lowercase cookies/storage/script names.
- Preserve UX/security/current API behavior. Do not rename standard protocols or unrelated external entities. No builds until supervisor freezes all source. Report inventory/verification in meritrouter-rename/reports/panel.md, no commits.

### Panel packaging safety follow-up
- Own src/operations/panel.ts, scripts/package-build.mjs, packages/router/.gitignore and tests/operations-panel.test.ts + packaging.test.ts; root owns package manifest allowlist.
- Generated package target becomes fixed bundled-panel, never delete/rebuild old panel staging used by existing processes. Source checkout selection prefers existing apps/panel before installed bundled-panel; explicit override remains first. Keep fingerprints/portable externals.
- Add real source-vs-installed discovery tests, focused checks only, no builds/process/user-config operations. Supervisor restores prior generated old bundle and runs package acceptance.

### Authored docs
- Own docs/setup.md, docs/roles.md, docs/operations.md, docs/decisions.md and NEW docs/README.md only, plus own report. Supervisor owns root README and working docs.
- Read this Current State and current setup/CLI/MCP sources as necessary read-only; no source edits.
- Apply canonical MeritRouter names/commands/env/paths. Rewrite setup with clear source-build then installed-package alternatives, numbered steps, POSIX/PowerShell only where different, exact MCP registration/stdio JSON, provider-key UI, first task and troubleshooting. Do not claim npm package published or hosted repo renamed.
- Add docs index by reader goal; improve roles/operations readability without deleting required contracts or historical sourced decisions. Explain old-install explicit --config migration without moving vault/store/brain or dropping old Git refs; new services/MCP names require re-registration. Default human-only security and unsupported external runners must be visible.
- Report actual CLI/source checks and unresolved naming decisions in meritrouter-rename/reports/docs.md. No network/provider/live user data, no commits.

## Work Ledger

### 2026-10-23 - Inventory and dispatch
- Agent: senior supervisor
- Evidence: clean baseline, README/setup/manifests/config discovery inspected;360 active files reference former brand.
- Decision: full runtime rename with explicit migration guidance; source setup remains supported without npm publication.
- Validation: not yet run on rename candidate.
- Outcome: Partial; three workers to implement disjoint files, supervisor integrates.

### 2026-10-23 - Integrated acceptance
- Agent: senior supervisor
- Evidence: full frozen suite 117 files, 1193 passed, 2 Linux-only skips; final affected 49/49.
- Validation: recursive build/typecheck pass; fresh installed package CLI/MCP42tools/panel pass;
  hardened offline seed exits 0 with 3 nested integrations/1 rebase; browser interactions and
  mobile layout pass with 8 screenshots and no exceptions.
- Decision: preserve old generated panel used by existing process; canonical staging isolated.
  Fix injected-clock reconciliation and reject seed time changes with unfinished tasks.
- Outcome: final visual refinement passes; tarball SHA1 924b1f3fa33088c47fa3adbd58d399962324c7de
  reinstalled and smoke-tested. Hosted repository renamed, origin updated and fetch succeeds.

## Open Questions

None for this unit. Existing user services/MCP clients require the documented migration and
reconnection; this source publication does not restart them or publish an npm package.
