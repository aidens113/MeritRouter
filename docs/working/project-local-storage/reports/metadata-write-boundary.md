# Repository metadata mutation boundary

Worker: project_directory_config
Date: 2026-10-26
Status: source frozen for supervisor integration and validation

## Implementation

`harness/tools.ts:workspacePath` calls shared `assertNotProjectMetadataPath(rel)` after
canonical relative-path normalization and file-path validation, before allowlist/guard
checks and any filesystem lookup/read/write/directory creation. Existing link, hardlink,
trusted-config and containment safeguards remain unchanged.

All legacy write/replace/delete tools use this canonical path function. `edit-operations.ts`
already invokes it for every edit during initial batch preflight; therefore one metadata
edit refuses a mixed batch before any earlier safe file changes. No edit-operations source
change was necessary. Its original mutation-time preflight/journaling remains intact.

Reserved names include root/nested `.MeritRouter`, case variations and backslash spellings.
Trailing-dot/space aliases are refused by existing canonical-path validation before effects.
The check is relative to workspace, preserving ordinary source in a worktree whose ancestor
directory happens to be `.MeritRouter`.

## Validation

- `pnpm exec vitest run tests/project-metadata-write.test.ts` ->14/14 PASS, exit0,
  1.20s (60ms execution), real temporary filesystem fixtures.
- Cases: all legacy mutation tools, create/replace/patch/delete batch preflight with safe
  first edit, existing private bytes preserved, no safe directory creation on refused batch,
  case/separator/Windows aliases, positive ordinary edits and batch under metadata ancestor,
  hardlink and junction protections.
- `git diff --check -- packages/router/src/harness/tools.ts` ->exit0/no output.
- Root notified source freeze before combined checks. No package-wide checks performed here.

## Limits

Only harness/tools.ts, new project-metadata-write.test.ts and this report changed for this
brief. No permissions, commands, staging, source identity, live state, commits or pushes.

This guard protects repository edit tools. It does not claim an approved arbitrary command
cannot read/write private metadata, nor make existing link checks race-free. Git staging
and exact-candidate protections remain separate implementation partitions. Authorized scoped
Brain/artifact tools are unchanged.
