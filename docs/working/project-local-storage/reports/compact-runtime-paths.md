# Compact persisted runtime layout v2

Worker: runtime_path_contract
Date: 2026-10-26
Branch: feat/compact-runtime-paths
Base:1f5f219
Workspace: D:/SwitchYardRouter/.MeritRouter/development/compact-runtime-paths
Status: implemented; focused tests and final package typecheck pass; source frozen.

## Changed and compatibility API

- Owned only projects/runtime-paths.ts, tests/project-runtime-paths.test.ts and this report.
- Existing createRuntimeIdentity(id,label) still creates untagged v1 identities. V1 manifest
  parses unchanged, and runtimeWorkspacePath produces byte-identical legacy paths. Nothing
  renames or migrates existing identities. Long v1 paths remain constructible for locating
  retained data, but launch preflight requires explicit shorter-root/layout migration.
- createRuntimeIdentity(id,label,2) or createCompactRuntimeIdentity creates strict tagged v2
  identities. Lowercase base32 encodes the full128bit digest in26characters (decoded in test).
  Human labels retain16characters for jobs/tasks/versions,12for repository aliases.
- RuntimeIdentitySchema accepts exact legacy v1 and strict v2 identities. Layout version in
  job/subject/optional workspace input must agree. Manifest version must agree with jobs;
  duplicate identities or case-folded directory collisions refuse.
- createCompactRepositoryIdentity(alias) / CompactRepositoryIdentitySchema persist compact
  aliases (including existing _lib/-lib/.repo). V2 manifest has validated repositories entries.
  Case-distinct aliases retain different digest names on case-insensitive filesystems.
- Compact task layout: `.MeritRouter/jobs/<job>/tasks/<task>/run-01/<repository>`.
  Version layout: `.MeritRouter/jobs/<job>/versions/<version>/<repository>`.
  Root state/brain/sessions/artifacts layout unchanged. Each identity/name is persisted;
  changing a display label is not an instruction to rebuild its directory identity.
- assertRuntimeCwdSupported validates explicit absolute path and a conservative240character
  Windows cwd limit. V2 construction and validateRuntimeLocation invoke it BEFORE callers
  create paths. Overlong roots fail with actionable shorter-project-directory/explicit-migration
  guidance. Unix has no Windows limit; existing1024workspace bound remains.

## Observed verification

- `pnpm install --offline --frozen-lockfile --ignore-scripts`: exit0,1m49s,219reused,
  no downloads. Manifest/lock unchanged. Expected CLI bin warning: isolated dist not built.
- `pnpm exec vitest run tests/project-runtime-paths.test.ts --maxWorkers=1`: final37/37PASS,
  exit0,0.843s. Existing safety tests retained, plus strict version compatibility, legacy exact
  path/manifest roundtrip, alias conflicts/tampering, digest bit recovery and native cases.
- Real Windows Node process and Git --version launch succeeded from compact cwd with typical
  project/job label and maximal80character labels/alias plus attempt999999. Generated maximal
  cwd under ordinary temp owner is232characters, below240bound. Deep application file has
  two90character payload segments; Git add/ls-files succeed with core.longpaths=true per command.
- Initial probe intentionally exposed distinction: plain Git init from the compact cwd launched
  but failed on deep `.git/hooks/applypatch-msg.sample` path. Per-command core.longpaths=true
  also required for init; later test uses it for init/add/ls-files. This fixes launch length,
  not Git's internal long-filename policy. No global Git config changed.
- Final `pnpm run typecheck` in isolated packages/router: exit0 after final source.
- `git diff --check` from isolated repository root: exit0, no output.

## Limits and integration

No caller activates v2 yet, and no live project data, main tree/dist, Git policy, commits or
migration changed. C2b Git-policy owner must supply explicit deep-path support before activation;
do not describe compact path generation alone as proof arbitrary checkout/build paths work.
Tests prove process launch and actual deep Git staging, not an application production build.

240 is a conservative supported cwd contract, not a claim all Windows executables accept
arbitrarily deep application filenames. Longer owner roots must move explicitly or fail;
do not silently shrink persisted labels/digests or rename paths to squeeze them in.

Existing containment, namespace, casing, traversal, reserved-name and filesystem-link checks
remain. Filesystem preflight remains non-atomic; identity receipts and safe migration are still
required. No project database relocation, scheduler wiring or storage separation implemented.
