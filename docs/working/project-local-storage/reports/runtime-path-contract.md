# Runtime path contract implementation

Worker: runtime_path_contract
Date: 2026-10-26
Status: implementation foundation complete; service wiring and migration not implemented.

## Changed

- New `packages/router/src/projects/runtime-paths.ts` only: zod-validated layout v1,
  project root construction, persisted identity and readable workspace path contracts.
- New `packages/router/tests/project-runtime-paths.test.ts`:31 focused cases.
- No existing source, configuration, runtime state, commits or service wiring changed.

## API

- `createRuntimeIdentity(id, initialLabel)` derives a portable readable name plus128-bit
  SHA256 ID suffix; case-distinct IDs remain distinct on case-insensitive filesystems.
- `RuntimeIdentitySchema` validates original label/ID/directory consistency. Persist once;
  consumers must retain the initial label and directory when display names change.
- `ProjectRuntimeManifestSchema`: strict `{layoutVersion:1,projectId,jobs}` with unique job IDs.
  This is a foundation manifest, not a complete workspace/accounting ownership receipt.
- `projectRuntimePaths(absoluteProjectDirectory)` constructs `.MeritRouter` and state,
  brain, sessions, artifacts, jobs and manifest locations without filesystem writes.
- `runtimeWorkspacePath(projectDirectory,{job,subject,kind,attempt?,repository})` creates
  job/tasks/attempts/repositories or job/versions/repositories hierarchy. Task attempts
  required; version attempts forbidden. Inputs validated at boundary.
- `validateRuntimeLocation(projectDirectory,candidate)` read-only preflight requires an
  existing project directory and lexically contained candidate; walks existing ancestors
  and rejects symlinks/junctions (including inward links), files, and ambiguous/legacy
  metadata casing. Existing legacy state requires migration rather than silent adoption.

## Verification

`pnpm exec vitest run tests/project-runtime-paths.test.ts --maxWorkers=1` ->28/28 pass
(final strengthened source; prior17/17 and22/22 baselines). Covers persisted identities, version layout, invalid components,
reserved Windows names, tampering, duplicate IDs, layout version, attempt constraints,
relative/root directories, lexical sibling escape, legacy casing, file ancestors and an
actual Windows junction escape. Project/candidate paths themselves reject trailing dots/spaces,
reserved names, ADS colon syntax, traversal and Windows device namespaces; runtime root files
are rejected too. All filesystem tests used disposable temporary directories.
Root review additionally found Windows root-relative path acceptance and case-distinct
repository alias collisions. Both corrected: Windows paths must be drive-qualified/UNC;
repository directory names now include stable case-sensitive ID digests, with regressions.
Final root review found slash/mixed-separator namespace aliases could bypass the original
device-path check. Namespace detection now uses normalized Windows separators; four added
regressions cover forward-slash and mixed variants. Final focused28/28 pass, exit0.
Root compatibility followup preserves portable existing aliases `_lib`, `-lib`, `.repo` via
separate alias schema; digest-named directory safety is unchanged. Final combined metadata/
path run39/39 pass (31path tests), exit0. Supervisor owns combined package checks.

Package typecheck intentionally deferred at supervisor request while the independent
configuration worker edits; supervisor owns combined validation after both freeze.

## Limits and follow-up

- No caller uses this API yet; no claim current storage locations changed.
- Filesystem preflight is NOT atomic authorization; callers must validate again at mutation
  boundaries and enforce persisted ownership receipts for adoption/deletion/migration.
- Uses host filesystem dialect, does not interpret foreign-platform paths on another host.
- Paths bounded to1024characters, but Windows installations without long-path support may
  require shorter project roots/labels; this does not enable OS long-path support.
- Initial labels forbid slash-delimited Git refs; pass a portable display label and keep
  actual branch refs separately in the future ownership manifest.
- Existing symlinked ancestors are conservatively unsupported. Cross-project nested-root
  ownership checks and Git metadata exclusion remain integration responsibilities.
- No mkdir, immutable identity store, Git worktree move, DB split, approval migration,
  cleanup, registry integration, panel presentation or migration journal is implemented.
