# MeritRouter rename and documentation
Status: Active
Status detail: User authorized complete product rename and readable setup documentation with an agent prompt at the top of README.
Created: 2026-10-23
Last updated: 2026-10-23
Owner: Senior supervisor agent
Scope: Product identity, runtime contracts, package and panel names, examples, onboarding and current authored documentation.
Paired document: none
Related: [handoff](handoff.md), [index](README.md)

## Current State

All rename workers frozen. Recursive build passes; first parallel typecheck saw stale pre-rename
dist declarations, then ordered repeat passes. Presets regenerated, pnpm lock/link refreshed.
Package prepack exposed a staging collision: old MCP auto-started user4477 from generated
packages/router/panel; prepack rm of that staging directory failed EBUSY. No user process was
stopped or config changed. Supervisor restores exact prior generated files from own archived
accepted package with SHA256 verification. Panel worker now separates canonical bundled-panel
staging and prefers apps/panel in source checkouts. Supervisor restored/hash-verified1812 old
generated panel files, with user config/process unchanged. Safety focused18/18 passes; final
recursive typecheck passes. Full suite now running at bounded2workers on frozen source.
Installed fresh tarball passes renamed CLI init/setup, package README, stdio MCP42tools/name,
bundled overview/security/project/icon routes and clean stop, no stale warning. Demo nested-job
assertion failed: pending mean final_check cancelled by await_tasks reconciliation constructing
WorkerActionRequests without injected ctx.now. Worker diagnosed through raw readonly session/
SQLite evidence; no real-clock service opened against seed. Proper clock fix + regression is
queued until full frozen run finishes; do not mask it with looser demo assertions/timeouts.
Supervisor browser acceptance:19 branded routes,4 desktop/mobile screenshots inspected,
0exceptions; physical checkout path is an intentional exception. Owned demo4495 stopped before
reseed; owned Chrome9337 retained for final pass. Provider/API requests remain fake/offline.
Independent onboarding audit found/fixed migration ordering (pin paths/env before doctor),
user-chosen provider env references, installed CLI/source command distinction and prompt doc
location ambiguity. All local documentation links/anchors resolve.

Baseline clean dev3c06c69. Work branch feat/meritrouter-rename. User requests full rename from
the previous product name to MeritRouter and readable docs, especially an easy README with a
copyable prompt immediately below the title telling an agent to use MeritRouter.
Inventory:360 non-working-document files reference the old name: package/import/CLI names,
class/error symbols, config/environment/default storage paths, Git namespaces, MCP identity,
panel branding/cookies/scripts, examples/tests and authored docs. Rename must be integrated,
not cosmetic. Canonical names: MeritRouter, npm/library/CLI `meritrouter`, panel
`meritrouter-panel`, root private workspace `meritrouter-workspace`, env `MERITROUTER_*`,
config `meritrouter.config.yaml`, runtime `.meritrouter`, public class `MeritRouter`.

New defaults use new names. Do not silently move/delete existing installs, configs, databases,
vaults, brains, repositories or services. Existing config can be opened explicitly with --config;
relative stored paths must retain their meaning. Explain migration and service/MCP reconnect.
No old package/CLI alias is promised, no npm publication or provider/network job authorized.
Do not invent an available npm package or changed GitHub repository URL. Hosted repository
rename, if unavailable, must be recorded; clone instructions must use a verified working URL.
Historical working reports/commit hashes and real deployment paths remain historical evidence;
do not pretend old deployments or directories were renamed. No physical checkout move.

Three disjoint workers: router/runtime/tests, panel, current authored docs. Supervisor owns
README (root and new packages/router/README.md), root manifests/lockfile/ignore files/agent instructions, working docs, integration and
all release acceptance. No broad tests/builds until source freeze; workers use focused checks.
All worker commands must use this repository as workdir and touch only owned files; report
outside needs to supervisor. Tests temp fixtures permitted under existing testing protocol;
no user install/config/actual4477/paid provider work. No commits by workers.

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

## Open Questions

GitHub ADMIN capability verified for aidens113/SwitchYardRouter; full rename is user-authorized.
Supervisor will perform the hosted rename after local acceptance and verify the new clone URL
before publishing. No provider budget, npm publish or live deployment requested.
