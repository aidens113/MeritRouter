# Production readiness execution sequence
Status: Active
Status detail: Drive-root sprawl investigated/prevented by agent policy; standalone storage prerequisites integrated, caller activation and migration pending.
Created: 2026-10-26
Last updated: 2026-10-26
Owner: Senior supervisor agent
Scope: Authoritative priority and release gates across current MeritRouter efforts.
Paired document: none
Related: [storage](project-local-storage.md), [delivery](supervisor-lifecycle-stall.md), [supervised delivery](supervised-delivery-v2.md), [platform backlog](roadmap-completion.md)

## Current State

2026-10-27 (Claude Code lead): repository renamed D:/SwitchYardRouter -> D:/MeritRouter and
D:/SwitchYardProjects -> D:/MeritRouterProjects by the user. pnpm junctions were absolute and
dangling; `pnpm install --frozen-lockfile` relinked them; recursive typecheck/build PASS.
The old live install D:/SwitchYard (config, switchyard.db, vault, .master-key) is in the
Recycle Bin (user deleted 2026-10-27 01:52). User chose a FRESH install, not a restore; the
recycled copy stays untouched and recoverable. Repo-root .mcp.json still names the old paths.
Live pilot budget reconfirmed: 400 model requests, $0 paid. Order: trustworthy test baseline
(first full run 259/85/23 overlapped a build, untrusted) -> gate 1 default activation -> gate 2
-> fresh install + Facebook pilot -> gates 4-6. Reports: project-local-storage/reports/
baseline-triage-20261027.md and gate1-remaining-inventory-20261027.md.
2026-10-27 evening: gate 1 waves A-C, split Labs, operator CLI and panel landed (see
project-local-storage.md). First full run on a clean tree (pnpm -r build PASS; router suite
2256 pass / 92 fail / 5 skip in 1304 s, heavily CPU-bound). Serial re-run of the 33 failing
files: 26 pass alone. Real failures: transport-recovery 24 (strict Slot schema predates
121be75 grant columns), task-lab-caller 3, security .git containment 1, worker-lab-authority 1,
labs.test 2, process-acceptance hard-kill 1, process-performance 1. Three Opus workers fixing
(reports fix-transport-recovery, fix-containment-tasklab, fix-labs-process-perf). Push waits
on these. Gate-2 inventory: gate2-inventory-20261027.md.
2026-10-27 night: all real failures fixed (transport recovery for split slots, split slot leak
on timeouts/errors and key retries, ledger recovery wired, Lab team admissions and leaks,
enclosing-repository writes, doomed Lab repairs, merge lock release, stale tests). Final:
pnpm -r build PASS; full parallel router run 2349 pass / 48 fail / 5 skip, and every one of
the 25 failing files passes alone (CPU contention: ~13900 s of tests in 1301 s). dev pushed
at a359200; main held until the live pilot. Next: fresh install, user enters Ollama key,
supervised Facebook pilot (400 requests, $0 paid).
2026-10-28 LIVE PILOT 1 (fresh split install, Ollama Cloud free key, job
t_0mvrt9n103e8186731851, project facebook-mvp): 273 requests, $0. 11 models answered 402/403
(not in free usage) once each and were cached unavailable, then disabled by the operator; beam,
nemotron-3-super and gpt-oss:120b served. 12 worker tasks: scaffold, db/auth, auth API, posts,
users/friends, notifications, shell, pages, seed, README completed; tests budget_exhausted 18/30;
review dependency_failed. Supervisor stopped model_handoff_exhausted:repeated_tool_call:delegate
(re-delegating the review against the failed dependency). ROOT DEFECT: integrate_task was offered
in 78 supervisor requests and never called; accept_task does not integrate, so the job branch
stayed at the empty initial commit and later tasks branched from it (pieces built in isolation).
Integration must be enforced by the service, not left to the model. Also found live and fixed:
worker startup recovery crash (3517a72); found live, fix in progress: split CLI session/job
reads and panel by-id job/task/request pages (not found).
Naming decision (user, 2026-10-27): every runtime FOLDER is spelled `.MeritRouter`. Project
runtime already is (projects/runtime-paths.ts). Install defaults still say `.meritrouter`:
config/schema.ts:514 brain `~/.meritrouter/brain`, :781 storage `.meritrouter`, cli/setup.ts:35.
Change them in gate-1 activation, with case-sensitive-FS fallback to an existing lowercase
folder. Docker labels `io.meritrouter.*`, service ids and `.meritrouter-lab.json` stay as is.

2026-10-26 latest user directive: FINISH THE PLAN; continue live Router testing on Facebook,
delete the old Facebook project and start fresh. Also clean sibling variant folders and enforce
all project Labs/data under that project's .MeritRouter. This supersedes earlier instructions
to preserve the old Facebook project's task/source payloads; shared accounting remains intact.
Fresh trial budget announced400 model requests/$0 paid. No downstream app source by Codex.
Do not stop at prerequisite publication; continue C3 activation, state split/migration and
actual pilot/approval UX/repeatability acceptance. Existing checkout only, serial validation.

Drive-root folder sprawl investigated: sibling variants and hidden historical worktrees retired
with dirty work preserved in inactive quarantine. Source-repository .MeritRouter is prohibited
and absent. Development uses main only; validation artifacts use OS TEMP. Old Facebook reset
verified complete. C3 runner/command guards and S2 local accounting active; runtime wiring,
migration and actual fresh-provider acceptance remain unfinished.

Latest accepted local checkpoint d042de0 adds lease-bound project tools/services; independent
tools12 and runtime-registry19 pass. Root private evidence isolation6 passes; S5 coordinated
queue and C3 Labs native-process adapters remain active. No fresh Facebook job/provider calls
have started. Current panel projects are my-project, tetris and pomodoro, all not live.

MeritRouter supports supervised use; unattended production delivery is unproven.
User authorized continued plan execution on 2026-10-26. Current implementation focus is
project-local storage, preserving existing project state and retained pilot source.
Do not infer current runtime versions or readiness from older roadmap checkpoints.
No production-readiness percentage or date is established by test counts.

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

## Open Questions

- Supervisor: state-service design determines migration staging and accounting boundaries.
- Supervisor: a release date requires measured completion of these gates.
