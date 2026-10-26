# Project directory configuration foundation

Worker: project_directory_config
Date: 2026-10-26
Status: implemented foundation; source frozen for supervisor review

## Changed

- `packages/router/src/projects/schema.ts`: optional `projects.<slug>.directory`, bounded
  nonempty string, trimmed and control-character validation through zod.
- `projects/resolve.ts`: `ResolvedProject.directory: string | null`. Explicit directories
  resolve against config location. One distinct resolved repository path supplies default,
  including duplicate aliases. Multi/no-repository ambiguity remains null. No ancestor inference.
- Explicit ownership overlaps with any known resolved owner are rejected lexically, including
  exact duplicates and nested owners. Existing inferred-only overlaps retain compatibility.
- `projects/context.ts` and `registry.ts`: `ctx.projectDirectory: string | null` is a project
  overlay, never a global-storage fallback. Qualification has null ownership even after refresh.
  Existing `ctx.project` shape remains unchanged for consumers.
- `tests/project-directory.test.ts`: 14 checks for explicit/default/ambiguous/legacy ownership,
  invalid inputs, overlap rejection, existing inferred compatibility, refresh identity,
  per-project separation, qualification null and unchanged storage behavior.

## Verified

- `pnpm exec vitest run tests/project-directory.test.ts` (packages/router): 14/14 pass,
  exit 0, final run 2.55s (39ms test execution).
- `git diff --check -- packages/router/src/projects/schema.ts packages/router/src/projects/resolve.ts packages/router/src/projects/context.ts packages/router/src/projects/registry.ts`:
  exit 0, no output.
- Root notified source is frozen and can run combined package checks. No package-wide build,
  typecheck, full suite or panel checks performed by this worker.

## Limits and integration requirements

This is ownership metadata only. No storage paths, databases, worktrees, logs or approvals
move. No filesystem writes or live runtime operations were performed.

Directory checks are lexical configuration checks, not physical containment/security proof.
Future activation must use the separate runtime-path filesystem validation and ownership
manifest; symlinks/junctions may alias roots and cannot be ruled out by this phase.

Current refresh can update directory metadata because it has no runtime ownership effects yet.
Once project-local state activates, hot-editing an owner directory must be rejected unless
the explicit quiescent journaled migration protocol authorizes the transition. Do not wire
storage activation into refresh as-is.

Legacy single-project top-level configuration gets inference only because this brief excludes
config/schema.ts; explicit multi-repo ownership is supported via the modern projects map.
Qualification context remains null intentionally; internal fixture ownership requires its
own installation-scoped policy. Unknown/ambiguous roots must fail closed at activation.

No source changes outside the five owned implementation/test files. No commits or pushes.
