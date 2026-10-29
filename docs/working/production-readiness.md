# Production readiness execution sequence
Status: Active
Status detail: Additional split controls independently checked and rebuilt; retained Commons retry running, full final suite active; product acceptance open.
Created: 2026-10-26
Last updated: 2026-10-28
Owner: Senior supervisor agent
Scope: Authoritative priority and release gates across current MeritRouter efforts.
Paired document: none
Related: [storage](project-local-storage.md), [delivery](supervisor-lifecycle-stall.md), [supervised delivery](supervised-delivery-v2.md), [platform backlog](roadmap-completion.md)

## Current State

Latest checkpoint: dev f8f89bd pushed (split mutex/recovery/Resume/shutdown). Additional split command/FINAL/queue publication repairs root51/51 PASS plus final fixture rerun5/5, recursive typecheck/build PASS. Actual scoped FINAL status now resolves retained retry. Worker20592 (exec98097) reconciled same supervisor/session with requests preserved (latest66 +prior43 =109/400, paid0); rebuilt panel4477 job200. Full final suite active exec66121, OS-temp meritrouter-gate2-final-full.json, aggregate pending. Initial serial full rerun was interrupted, not passing evidence. No application code authored by Codex; actual MVP/FINAL acceptance still open, main held. Earlier cwd refusal/rollback and FINAL store failures retained in gate2 working record.

Latest execution2026-10-28: combined split integration/lock/refusal/startup/Resume fixes independently119/119 PASS, shutdown24/24 PASS, recursive typecheck/build PASS. Actual production stop API tested on isolated seeded split demo:2clean cycles, no repository/Brain lock, database ok, foreign-Origin403, rendered screenshot viewed. Current combined-tree full-suite rerun remains outstanding; older full/serial evidence below is predecessor source only. Detailed record: [gate2-auto-integration.md](gate2-auto-integration.md).

Active retry t_0mvsr8qoi4c6b92cdff6b, cap357/maxPaidUsd0, supervisor s_0mvsr8ziid56f0ef3550b, worker17808 (exec28651), rebuilt panel4477. Earlier t_0mvsovety5bfa4069dc69 retains43requests/$0 and all source/history; aggregate trial cap400, no refunds/reset. Its expired attempt recovered into run2, then failed safely before model send on retained mutation marker. Root checked absentPID18308/exact hash/physical identity/all16worktree guards and reversibly archived only marker; GitHEAD/status unchanged, bytes retained. Panel stop race separately reproduced/repaired without attributing historical PID from timestamp alone. New retry adds verified Windows/Node/dependency context and ignore/CSS/deterministic-test requirements. No manually authored application source; canonical delivery/FINAL acceptance still OPEN. Main held. This supersedes all older in-flight/runtime statements below.

Earlier checkpoints and lead handoff:

Latest checkpoint 2026-10-28 (Codex supervisor): user requested repeated router-driven Facebook MVP delivery with no manual application source. Retained integration fix reviewed and repaired through worker integration_review. Recursive typecheck/build pass. Full four-worker suite: 2413 passed / 7 failed / 5 skipped (1947.87s); every failing file then passed serially, 36/36 (263.52s). New integration 8/8, nesting 7/7, source binding 22/22 and lifecycle 46/46 independently observed passing. Full-run timing failures remain disclosed; no wholly-green aggregate claim. Details: [integration acceptance](gate2-auto-integration.md).

Fresh pilot2 `t_0mvsovety5bfa4069dc69`, cap400/free-only, paused at43 requests/$0. Split mutex classification failure caused supervisor session s_0mvsovmzo8ebfbc0be76a to interrupt `lease lost`; children terminal, branch empty. Bound-mutex repair is independently checked33/33, typecheck/build PASS and panel4477 rebuilt. Root caught/repaired6 intermediate admission regressions without weakening old tests. Custom supervisor-profile split integration and unbound legacy crash locks remain scoped limitations. This source is not yet committed/pushed; dev6227470 is the initial integration unit only.

Restart then exposed recovery gaps: new worker7732 did not recover an expired-running-only project (managed scheduler starts only after queued fairness hint); CLI Resume reads installation-private sessions before scoped dispatch.7732 stopped idle; split_recovery worker implementing supported startup/CLI repair in temp fixtures. Parent still running with expired owner8420 lease, interrupted session28requests; no state surgery/budget reset. Root rejected scaffold6359879 through CLI for literal-backslash-n .gitignore, requesting retained-source worker repair. No application source manually authored; all usage/source retained. This supersedes older deployment/in-flight/budget statements below. Product acceptance remains OPEN.

Earlier handoff 2026-10-28 (Claude Code lead, session of 2026-10-27/28):

**Gate 1 (project-local storage): complete in code.** New installs default to
`storage.layout: split`: each project's DB, sessions, artifacts, worktrees, agent homes, Labs and
brain live under `<project directory>/.MeritRouter`; the installation store holds only
coordination data. The end-to-end exit test (tests/project-runtime-activation.test.ts) passes:
setup, create, retry, restart/resume, task Lab, project backup/restore, delete, quiescent legacy
migration with rollback, and no project rows or canary content under the installation. CLI has
`projects create --directory`, `projects backup|restore|migrate`. Details and reports:
[project-local-storage.md](project-local-storage.md). Runtime folders are spelled `.MeritRouter`
(lowercase fallback on case-sensitive filesystems). Known limits: paid routes refused in split
projects; legacy dispatch fence has no coordination store; forced restore leaves
`<project>/.MeritRouter/pre-restore-*`.

**Repository and environment.** Checkout renamed D:/SwitchYardRouter -> D:/MeritRouter and
projects to D:/MeritRouterProjects (pnpm relinked). dev pushed through 6325718 plus this handoff;
main held (unchanged) until a pilot delivers. Full parallel suite on this machine is CPU-bound
(~13900 s of tests in ~1300 s): last full run 2349 pass / 48 fail / 5 skip and every failing file
passed alone; judge failures by serial reruns.

**Live install (user's, real data: tests must never touch it).**
- Config `C:\Users\mrjoh\AppData\Local\MeritRouter\meritrouter.config.yaml` (fresh, split, durability
  full, `paid.enabled: false`, supervisor `paid_policy: never`, `delivery_budget.total_requests: 400`,
  `extension_requests: 20`). Store `...\MeritRouter\.MeritRouter\`. Old install D:\SwitchYard is in the
  Recycle Bin by user choice (fresh install chosen); do not restore it.
- One Ollama Cloud key, `free_tier`, entered by the user (vault:1). 22 models listed; operator
  disabled 11 that return 402 "not included in your free usage" or 403 rollout: kimi-k3,
  kimi-k2.6, kimi-k2.7-code, deepseek-v4-pro:0813, deepseek-v4.1-flash(+:1017), glm-5.2, glm-5.3,
  mistral-large-3:675b, mistral-large-4, muse-spark-open. Serving: beam, nemotron-3-super,
  gpt-oss:120b (and small gemma4/nemotron-nano for T1).
- Panel http://127.0.0.1:4477 started by the lead (user-authorized), stop it via
  `POST /api/panel/stop`, start with `node packages/router/dist/cli.js panel --config <config>`.
  Current panel/dist build includes the in-flight integration worker's UNCOMMITTED edits:
  rebuild (`pnpm -r build`) and restart the panel after that work lands or is discarded; until
  then the user was told not to Accept/Reject tasks in the panel.
- A `meritrouter worker` process was started from a Claude Code background shell for the pilot;
  it may have ended with the session. Start one with
  `node packages/router/dist/cli.js worker --config <config>` before running a job.
- Repo-root `.mcp.json` (git-excluded) still names `D:/SwitchYardRouter/.../mcp.js` and the deleted
  D:/SwitchYard config: update to `packages/router/dist/cli.js mcp --config <config> --project
  facebook-mvp` before using MeritRouter over MCP.

**Live pilot 1: failed, no usable app.** Project `facebook-mvp` (D:/MeritRouterProjects/facebook-mvp,
store in its `.MeritRouter`), job `t_0mvrt9n103e8186731851` via `meritrouter run` with checks
`npm test`, `npm run build` and three criteria (brief: original-branded "Commons" social app,
Next.js + SQLite + Tailwind, auth/feed/profile/people/notifications, seed, vitest, README; no
Facebook trademarks). 273 requests, $0; operator granted +120 to the supervisor (budget request 1)
to stay under the 400 cap. Ten worker tasks completed, tests budget_exhausted 18/30, review
dependency_failed; supervisor stopped `model_handoff_exhausted:repeated_tool_call:delegate`.
ROOT DEFECT: supervisor never called integrate_task (offered in 78 requests) and accept_task did
not integrate, so the job branch stayed at the empty initial commit and later tasks branched from
it; the code exists only in 12 detached task worktrees under the project's
`.MeritRouter/worktrees`. Slot release, model fallback, budget approval and attribution worked
live. Remaining under the original 400 cap: 127.

**In flight at handoff (UNCOMMITTED in the main tree, do not discard without review):** an Opus
worker implementing service-enforced job integration (reports to docs/working/
gate2-auto-integration.md): accept_task enqueues integration through the merge queue, dependents
start from the integrated job head, review/finish refused while accepted work is unintegrated,
delegate refused on a failed dependency, and why tests ended budget_exhausted at 18/30. Files:
src/harness/{delivery-tools,integration-tools,supervisor-tools}.ts, src/runners/supervisor.ts,
src/storage/tasks.ts, new src/storage/integration-obligations.ts, new
tests/job-auto-integration.test.ts. Last observed: `pnpm -r typecheck` clean; its tests not yet
verified by the lead. Next session: read its report, rerun its acceptance tests serially, review,
commit, rebuild, restart the panel.

**Waiting on the user:** rerun budget for pilot 2: (a) raise this pilot's cap to ~500 total or
(b) a fresh 400; and whether to remove two stray lines MeritRouter's tests wrote into
`C:\Users\mrjoh\.git\info\exclude` at 13:34 on 2026-10-27 (`# MeritRouter private project
metadata` and `.[mM][eE][rR][iI][tT][rR][oO][uU][tT][eE][rR]/`); the code that wrote them is fixed.

**Next steps, in order.** 1) Land the integration worker (above). 2) Rerun the pilot as a NEW job
in facebook-mvp with the user's budget choice; watch `meritrouter status/job/usage --project
facebook-mvp`, approve budget requests only within the cap, and verify integration onto the job
branch as tasks are accepted. 3) As FINAL acceptor, clone the job branch to OS temp and run
`npm install`, `npm run seed`, `npm test`, `npm run build`, then browser journeys; accept or
reject with evidence. 4) Gates 4-6 below. Known follow-ups: native coding task spawns ~521 git
processes and Brain report commits drain at ~0.6/s (performance pass); `setup` of a
non-repository project directory writes a self-ignoring `.MeritRouter/.gitignore`; MeritClaude's
report-guard hook did not enforce the return contract and its installer duplicates hooks when the
drive-letter case differs (MeritClaude repo, not this one).

MeritRouter supports supervised use; unattended delivery is unproven. No readiness percentage or
date is established by test counts. Do not infer runtime versions from older checkpoints.

## Ordered execution and exit criteria

1. **Establish project ownership and storage.** Implement readable project-local paths,
   explicit ownership, project content/state separation, safe migration and recovery.
   Exit: project creation, retry/resume, cleanup, backup/restore and migration rollback
   checked; project-owned content does not appear under the installation root.
   Detailed file ownership and phases: project-local-storage.md.
2. **Close delivery lifecycle failures.** Preserve model fallback, batching, valid retained
   source selection, command ownership, budgets and interrupted-session recovery.
   Exit: integrated source reviewed, recursive checks and final full suite observed;
   real failing journeys reproduced and corrected, with no fake acceptance or usage reset.
   Existing local fixes need final integrated validation/publication; do not assume published.
3. **Deliver the Facebook pilot.** Create a fresh project and brief through supported controls,
   finish remaining pages and near-1:1 visual polish through MeritRouter, then review exact
   integrated source and test actual desktop/mobile journeys, security and persistence.
   Exit: validated source materialized at canonical project root, reproducible startup,
   evidence tied to exact candidate, independent FINAL acceptance and clear limitations.
   Codex authors no downstream application source.
4. **Make operational attention obvious.** Address the recorded approval UX backlog:
   clear pending action, reason, location and next step; preserve exact command authority.
   Exit: actual desktop/mobile panel acceptance, including waiting/failure/recovery states.
5. **Prove repeatability.** Run another bounded end-to-end delivery without manual dependency
   bootstrap, direct state surgery or unnoticed stalls. Report intervention count, failures,
   request/cost usage and final product evidence. One rescued pilot does not prove autonomy.
6. **Publish a scoped release.** Update setup/operations/limitations and publish only a
   coherent checked unit. Claim single-machine supervised readiness only when demonstrated;
   unattended readiness requires the repeatability gate. Broader Compose, isolation,
   PostgreSQL/multi-host and cross-platform work remain separate gated roadmap phases.

Steps may overlap only where source ownership and validation trees are isolated. Do not
relocate active workers or replace the live daemon merely to activate a nonblocking fix.

## Work Ledger

### 2026-10-26 — Resume with drive-root containment
- Agent: supervisor
- Changed: resumed checkpoint, AGENTS.md worktree location/cleanup rule, storage inventory.
- Why: Explicit user resume and complaint about alternate D:/ folders.
- Validation: Git inventory identifies twelve merged sibling worktrees; `git diff --check` exit0.
- Outcome: Accepted policy; storage C2b implementation resumed in existing in-project tree.
- Follow-up: preserve legacy configuration/projects; no broad deletion or live activation.

### 2026-10-26 — Consolidate execution priorities
- Agent: supervisor
- Changed: production-readiness.md and working index.
- Why: Older plans have stale snapshots and no single current release sequence.
- Validation: not validated; planning document, no source/runtime change.
- Outcome: Accepted
- Follow-up: execute storage foundation and state-service contract, preserve pilot work.

### 2026-10-28 — Gate 1 activation, regression fixes, fresh install and live pilot 1
- Agent: Claude Code lead (Opus 5.5) with tiered workers (reports under project-local-storage/reports/ and gate2-*).
- Changed: split storage made default and wired end to end (waves A-C), Lab/supervisor/capacity/transport/enclosing-repo/view fixes, docs; fresh live install; pilot job t_0mvrt9n103e8186731851.
- Why: user directive to finish the plan and live test on a fresh Facebook project.
- Validation: `pnpm -r build` -> both Done; `npx vitest run` (router, full parallel) -> 2349 passed / 48 failed / 5 skipped, then each of the 25 failing files alone -> all passed; after later fixes `npx vitest run` on touched files (e.g. split-detail-views, split-cli-reads, project-admin-store-isolation, zero-project-installation -> 32 passed); `pnpm -r typecheck` at handoff -> router Done, panel Done; live panel pages curled 200 after restart; live pilot -> failed (see Current State).
- Outcome: Accepted for gate 1 code; live pilot 1 Rejected (no integrated product).
- Follow-up: land service-enforced integration (in flight, uncommitted), then pilot 2 with the user's budget choice.

## Open Questions

- Supervisor: state-service design determines migration staging and accounting boundaries.
- Supervisor: a release date requires measured completion of these gates.
