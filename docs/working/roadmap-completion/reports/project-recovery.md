# Report: project-recovery

## Outcome
Done: restore staging/rollback and focused project/config UI follow-ups implemented and validated in isolated feat/roadmap-project. Supervisor integration and browser acceptance remain separate.

## What changed and why
- `operations/backup.ts` stages copied data and schema migration before replacing live entries. `brain-backup.ts` stages/fetches/verifies a replacement brain before any live swap. Final brain or store swap errors restore prior live entries; successful restores preserve previous state under unique pre-restore paths. A rollback failure retains prior-state directories and reports recovery locations. Only generated staging directories are deleted; cleanup errors cannot trigger a partial rollback after a committed restore.
- `admin/project-settings.ts` inspection now identifies monorepo subfolders containing files tracked by an enclosing repository and drive/home roots; refusal hints replace the misleading promise to initialize Git. Inspection is read-only; save keeps the authoritative preparation check.
- New async `admin/config-edit.ts` wrappers prepare changed/new project repository paths before writing or acknowledging generic saves. Invalid/preparation-failed saves keep the config intact; concurrent config changes during preparation cause retry instead of overwrite. Existing synchronous config APIs are unchanged. Generic raw and structured config API routes await the new wrappers.
- Archived project metadata supplies the actual name in the switcher, while archived entries stay out of its picker and navigation remains settings-only. General settings explicitly mark the name read-only, disable it, and explain how to unarchive before editing. Changes limited to project switcher/shell, metadata helper, settings form and approved generic API routes; no layout changes.
- New `tests/roadmap-project.test.ts` covers corrupt bundle replacement/creation, injected final brain/store swap errors, tracked-subfolder hints, prepared structured/raw saves and refusal without changing config. Fixtures use temporary directories only.
- Strict promotion repository-alias matching is deliberately retained: D9 explicitly rejects project aliases in proposed global knowledge. Distinguishing generic prose such as "the app" from a repository reference is ambiguous without an explicit new convention; weakening it would breach the gate. This is policy, not an unimplemented fix.

## Commands run and observed results
- `pnpm install --frozen-lockfile --offline` passed in 2m58s; expected missing prebuild CLI-bin warnings.
- Baseline `pnpm exec vitest run tests/roadmap-project.test.ts --maxWorkers=1`: all 3 probes failed. Both corrupt-bundle cases replaced original store marker with the backup marker; tracked monorepo folder problem was null.
- First fixed focused run: 3/3 passed (5.70s).
- `pnpm exec vitest run tests/roadmap-project.test.ts tests/admin-project-settings.test.ts tests/projects-followups.test.ts tests/projects-operations.test.ts tests/operations.test.ts --maxWorkers=2`: 44 passed, 1 CLI-dependent test skipped before router build (25.96s).
- `pnpm --filter switchyard-router build` and `pnpm --filter switchyard-router typecheck`: passed.
- Post-build `pnpm exec vitest run tests/projects-operations.test.ts tests/operations.test.ts --maxWorkers=2`: 26/26 passed, including the real CLI daemon with fake HTTP provider and brain round trips (26.17s). Tests stop their fixture daemons.
- `pnpm --filter switchyard-panel build`: passed, including TypeScript and generated routes. Supervisor explicitly authorized a temporary generated-dist bridge adding the two new exports to `dist/admin/insights.js` and `.d.ts`; source `admin/insights.ts` was not touched and generated files are ignored/uncommitted.
- `git diff --check`: passed. No commits/push; worker source frozen.

## Not verified
- Supervisor owns production browser, API HTTP and screenshot acceptance. This worker did not start a panel or mutate the root demo/user install.
- No full repository suite or recursive integrated build; no real providers or OS service installation.
- This provides staging and rollback for operational exceptions, not a cross-directory atomic transaction across abrupt machine/process death. If rollback itself cannot rename a previous directory back (external locks/writers), its original data is retained with an explicit recovery path.

## Open questions or contradictions found
- Root must add `writePreparedConfigText` and `patchPreparedConfig` to the `admin/insights.ts` exports after copying config-edit.ts. Root owns that file; the worker did not edit it. The generated build bridge is not a source implementation or a committed artifact.
- Authored setup/operations/project docs should be updated by supervisor with this integration; shared docs were excluded from worker ownership.
