# Independent runtime path contract review

Reviewer: project_directory_config (author of distinct configuration files)
Date: 2026-10-26
Scope: read-only review of projects/runtime-paths.ts and project-runtime-paths.test.ts

## Actionable findings

Final source review: all three findings below are resolved. Namespace rejection now uses
the slash-normalized Windows spelling and includes four namespace regression variants.
Repository alias prefix compatibility (`_lib`, `-lib`, `.repo`) is preserved by a dedicated
alias schema and hash-backed directory component. No remaining isolated-foundation source
blocker found. Runtime activation followups below remain mandatory. Final31-test source
was inspected but not rerun by this reviewer; supervisor owns latest combined checks.

2026-10-26 re-review: both original findings below are corrected in final author source.
Windows roots require drive-qualified/UNC form, and repository paths now use readable
case-sensitive-ID hash components. Independent focused run passes 24/24 (424ms).
One remaining correction is required before accepting this foundation:

3. **Slash-form device namespace bypass.** The device/extended namespace rejection tests
   original `value` while the preceding UNC check uses slash-normalized `windowsValue`.
   `//?/C:/project` and `//./C:/project` therefore pass that validation and normalize to
   unsupported `\\?\C:\project` / `\\.\C:\project` syntax. Apply the namespace rejection
   to the same normalized Windows spelling; test both variants. Pure Node `path.win32`
   parsing/normalization probe confirms root `//?/C:/` and normalized device path.
   Supervisor notified; reviewer changed no source.

1. **Windows root-relative paths are accepted as stable absolute roots.**
   `validateAbsoluteDirectory` relies on host `path.isAbsolute`. On Windows that accepts
   `\\project` (one leading separator) or `/project` even without a drive. Those paths depend
   on the process current drive and are not stable project identities. `projectRuntimePaths`
   normalizes but does not resolve/reject that form. Require drive-qualified absolute paths
   or supported full UNC paths on Windows. Add platform-appropriate root-relative tests;
   existing tests cover ordinary relative paths and drive root, not this case.

2. **Repository alias paths can collide on case-insensitive filesystems.**
   `safeComponent` accepts uppercase repository aliases; `runtimeWorkspacePath` places the
   alias directly in `repositories/<alias>`. `app` and `APP` therefore map to the same
   physical workspace on Windows (and many macOS volumes). Job/subject identity hashing
   already protects equivalent label/ID cases, but repository naming does not. Resolve via
   collision-safe stable repository identity or explicit canonical restriction/conflict
   validation in a persisted ownership registry before activation. Test distinct aliases
   differing only in case. This foundation must not silently promise alias isolation.

These are inspected code/host-path semantic findings, not executed regression tests.
Supervisor notified with precise remediation suggestions. No source changed.

## Positive findings

- Traversal and unsafe portable components rejected by strict zod schemas; generated
  job/subject components derive readable slugs plus case-sensitive ID hashes.
- Original labels and generated directory names have a validated round-trip identity.
  Rename stability depends on reusing persisted identity, stated directly by the API.
- Manifest version/duplicate-job checks and unknown-key rejection prevent casual schema drift.
- Candidate preflight uses `path.relative` boundary checks, rejects existing file ancestors
  and existing junctions/symlinks along the candidate chain, and detects legacy metadata casing.
- Preflight explicitly does not claim race-free authorization. It creates no directories.
- Tests cover tampered manifests, invalid attempts, traversal, casing migration, existing
  file ancestors and escaping junctions, using temporary directories.

## Followups before runtime activation (not new source blockers for isolated foundation)

- Manifest currently persists only job identities. Task/version/repository identity ownership,
  initial-label immutability, project marker authority, and atomic CAS writes need a separate
  persisted registry contract before callers create or delete actual workspaces.
- A standalone identity does not prove job membership/project ownership; consumers must
  validate persisted associations, not accept arbitrary model-supplied valid identities.
- The SHA-256 suffix is truncated to 128 bits. Collision is practically remote, but creation
  still needs exclusive claim/manifest conflict checks rather than trusting path uniqueness.
- Revalidate physical containment at actual mutations, with link-swap/race handling and typed
  ownership receipts. This preflight is insufficient alone for privileged deletion/migration.
- The 1024-character workspace bound is not proof every Git/Windows tool supports that length;
  use actual platform runtime checks and document supported path-length policy.
- Safe nested-storage activation also requires Git exclusions and hard agent-discovery
  exclusions; pure path construction does not supply those protections.

## Verification and limits

Reviewed the two named source/test files. Initial review ran no tests. Re-review ran
`pnpm exec vitest run tests/project-runtime-paths.test.ts` -> 24/24 pass, exit0, 424ms;
and a pure Node path parsing probe for the remaining finding. No builds, user-state
inspection, live runtime commands, source edits, commits or migrations performed.
No full security acceptance claim.
