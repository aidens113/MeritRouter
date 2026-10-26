# Production readiness execution sequence
Status: Active
Status detail: User resumed the plan on 2026-10-26 and required investigation and prevention of drive-root folder sprawl.
Created: 2026-10-26
Last updated: 2026-10-26
Owner: Senior supervisor agent
Scope: Authoritative priority and release gates across current MeritRouter efforts.
Paired document: none
Related: [storage](project-local-storage.md), [delivery](supervisor-lifecycle-stall.md), [supervised delivery](supervised-delivery-v2.md), [platform backlog](roadmap-completion.md)

## Current State

Resumed explicitly by the user on 2026-10-26. First investigate drive-root folder sprawl,
enforce in-repository development/validation locations, then continue the storage checkpoint.
Preserve existing dirty work and services; do not treat historical worktrees as disposable.

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
3. **Deliver the Facebook pilot.** Recover or rebrief retained work through supported controls,
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
