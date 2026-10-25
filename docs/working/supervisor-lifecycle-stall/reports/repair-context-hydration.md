# Native retained-candidate repair hydration

Status: Complete; awaiting supervisor independent review/integration
Worker: repair_context_handoff
Branch/worktree: feat/repair-hydration / D:/SwitchYardRouter-repair-hydration
Base: fba7b01

## Delivered

Explicit `repair_from_task` implementation-brief field resolves an owned terminal sibling into strict `context.repairSource`. Current job HEAD remains the new workspace integration base. Before the first model call, a new clean repair worktree receives the source's bounded ordered commits through internal hooks-disabled Git cherry-pick with original author/message/model/task trailers plus -x provenance. Newer disjoint integrated changes remain present. Source acceptance and charges are unchanged.

Persisted plans now bind optional `repairFromTask` (defaultnull for historical node JSON), and the exact planned-brief guard rejects changes before dispatch. No migration. The current supervisor must explicitly replan a repair brief with its source before delegation; merely mentioning a task in prose still grants nothing.

Files owned/changed:
- core/task.ts: strict immutable source descriptor.
- harness/supervisor-tools.ts: explicit brief field, authoritative ownTask resolution and dispatch context.
- storage/plans.ts, harness/supervisor-lifecycle.ts: source bound to persisted plan/exact brief.
- NEW workspaces/repair-hydration.ts: source verification, scope/commit limits, quiescence, safe replay and typed durable receipts.
- runners/coding/finish.ts: hydrate before worktree_ready; verify completed receipt before workspace reuse.
- runners/coding/native.ts: session pointer records real hydrated head; worker told actual source already exists.
- NEW tests/repair-hydration.test.ts and tests/supervisor-lifecycle.test.ts.

## Enforcement

Source must be same parent/project/writable repository, terminal coding task with retained clean author workspace and exact recorded head/base. Refuse active sessions, corrupt/paged history, unfinished effect intents, active merge, pending/running actions and unresolved uncertain commands (500cap conservatively refuses). Source Lab context and Lab checks refuse initially.

At most100ordinary linear commits, 8MiB cumulative per-commit patch bytes and4MiB per-tree metadata. Every changed path in EVERY inherited commit must fit both original and new allowed paths; rename old/new names retained via no-renames. Merge/nonlinear history, missing Agent/Model/Task attribution, symlink/submodule tree entries, dirty source and source-head mismatch refuse. Protected-file detection is preserved in collect/integration rather than bypassed by hydration.

Task-local strict zod receipts record started before replay and completed only after authority-checked head/tree capture. Failed replay records failed when authority remains; authority loss leaves started. Any missing/partial/stale/malformed receipt refuses workspace reuse/model execution. Resume proves hydrated head remains ancestor of current worker HEAD and its immutable tree matches. Successful hydration does not replay twice. A new worktree with a stale receipt also refuses.

Git uses internal executable-config/hook/cwd protections, AbortSignal and30second per-command timeout. Run authority checked before each effect and after each awaited mutation; source terminal/head/action state rechecked during replay. No original, integration or shared worktree is mutated. Partial target is preserved as evidence on failure; no broad reset/delete or hidden retries.

## Validation observed

- `pnpm install --offline --frozen-lockfile`: exit0,219cached packages,0downloads; panel executable-bin warnings expected before router dist exists.
- `pnpm --filter meritrouter typecheck`: final source exit0.
- `pnpm exec vitest run tests/repair-hydration.test.ts tests/supervisor-lifecycle.test.ts`: final production source33/33 pass,2files,55.50s (17hydration +16lifecycle).
- Added two test-only action-quiescence cases after that run; `pnpm exec vitest run tests/repair-hydration.test.ts -t 'unquiesced'`:2pass/17not-selected,7.85s. Production source unchanged.

Actual integration test uses real `integrate_task`, not just a copied patch:12-file UI-like failed candidate +one-file correction integrates all inherited files with original Task/Model trailers, both on unchanged base and newer disjoint API base. Original failed result stays unmet. Tests also cover foreign parent/project, active source, Lab, changed head/dirty source, active merge, unfinished effect, inherited scope narrowing, merge commit, oversized patch, protected paths, cancellation before and after replay, conflict receipt, partial receipt refusal and idempotent completed resume. Plan source alteration rejected before children/effects.

Initial test failures were fixture issues (missing integration committer identity in manual test picking, then syntheticResult defaultnot_verified while test asserted unmet). Replaced manual picks with actual integrate_task and explicitly marked failed fixture unmet. Final tests above pass. Two accidental wrong-working-directory attempts wrote nothing and selected0tests; neither counted as validation.

## Limits and follow-up

No broad suite/build/live-provider tests run by worker; root owns those and independent source review. No live app or configuration edits, no source deployment and no commits. Only own report written in main checkout; implementation remains isolated.

Lab-bound repairs and quality-retry startFrom combined with hydration fail closed. Source sessions exceeding validated event-page cap refuse, as do source ranges above bounds. Already-integrated/effectively empty cherry-picks can conflict/refuse rather than auto-skip; no silent scope widening. Failed hydration requires a deliberate new repair task, not automatic restart from partial state. Source and actual replayed target paths/modes are checked after every pick and against final integration base; source commit lineage is preserved by replay; new task budget/paid admission stays on existing normal delegation path.

Not yet separately exercised:100+commit limit, real malicious hook fixture, real repository conflict rather than injected Git error, native full model loop after hydration refusal, and paid-budget-specific scenarios. Source helper uses the existing safeGit primitive and unchanged delegation budget machinery; root should decide targeted additions before release.


## Independent-review correction (2026-10-25)

The first frozen candidate had two real blockers: source-only path validation missed Git following newer target renames outside repair scope, and a net-only8MiB patch check missed cumulative large add/revert history. Reviewer also identified a final awaited-pick source-state race and missing positive renewed-lease resume regression.

Corrections now inspect actual target no-renames raw diff paths and old/new file modes after EACH pick (previous actual HEAD..newHEAD), then final base..hydratedHEAD before completion. Invalid raw metadata, out-of-scope target path or nonregular mode refuses with a failed receipt before model execution. Source patch bytes are charged for every inherited commit against remaining8MiB, with bounded Git output; add/revert cannot hide work. A source terminal/head/action/active-merge fence runs after final awaited target reads immediately before the completed receipt.

New regressions exercise a real newer-base rename outside scope,4.5MiB add+revert (>8MiB cumulative while netdiff small), source becoming active after final actual cherry-pick, and normal resumeWorkspace after a repair commit with interrupted/resumed task and fresh lease (no replay). Initial selected test had one fixture-only unsupported git mv; replaced it with filesystem rename plus normal attributed commit. The other3new cases passed. Final package typecheck passed. The first corrected39-case run had38pass/1fixture failure: the rename fixture triggered Git conflict before the guard. Replaced it with40stable lines and a line20edit so the actual pick succeeds and the guard-specific scope assertion is exercised. Exact rename selected1/1 passed6.83s. Final typecheck passed again. Final39-case group is running; do not use earlier33+2 or38/39 for corrected-source acceptance.


### Final corrected frozen receipt

- `pnpm --filter meritrouter typecheck` -> exit0 on final source and corrected fixtures.
- `pnpm exec vitest run tests/repair-hydration.test.ts tests/supervisor-lifecycle.test.ts` -> **39/39PASS**,2files,74.28s (23hydration +16lifecycle), final run16:36:36local. No edits during run.
- Guard-specific real rename regression passes (4.075s in finalgroup); cumulative transient add/revert, final sourceactive fence and actual resumed repairHEAD/newlease all pass.
- Independent reviewer reports final source clear; separately reran exact rename1/1PASS4.83s. See repair-hydration-review.md. Root still owns integrated/global validation, commit and activation.
- Implementation/test files frozen in D:/SwitchYardRouter-repair-hydration; no commits or live changes.
