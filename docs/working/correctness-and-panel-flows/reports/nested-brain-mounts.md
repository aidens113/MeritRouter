# Nested brain mount post-suite correction
Status: Implemented and frozen

## Full source/test inventory
- src/brain/mount-git.ts (new): owning concern for verified Gitroot/common-dir identity, original mount/virtual prefixes, physical document-path containment, mount-only adoption pathspecs with lock exclusion, mount-bound rename history and whole-commit subject privacy.
- src/brain/brain.ts: delegates Git mount resolution/history; write/remove/adopt use verified Gitroot and literal selected-document pathspecs; validate physical target before reading/writing/unlinking; blame normalizes mounted Gitroot. File remains701lines.
- src/admin/brain-entities.ts: root-relative literal history/detail paths with retained mount prefix for rename/copy/project visibility and whole-commit subject inventory; mount-relative no-renames patch output.
- src/attribution/index.ts: commitAs opts.paths scopes cached-diff existence check AND commit --only -- same paths, so unrelated staged changes remain. Undefined/empty paths retain previous all-path behavior. Existing identity/trailer environment reused.
- tests/admin-brain-entities.test.ts:6 added nested regressions (15total): safe subject/detail/blame, outside-mount rename masking, disjoint core.worktree redirect, enclosing-root different common-dir redirect, adopt/write/new/remove preserving outside cached+unstaged changes/untracked files, legitimate managed-worktree read/write with unchanged source HEAD.
- tests/attribution.test.ts:1 added scoped-commit regression (4total), proving selected no-op returnsnull and selected edit/add/delete leave unrelated staged addition/edit/deletion binary diff unchanged, with correct trailers.

## Behavior and privacy
- No generic Git containment exemption. Diagnostic root discovery must prove canonical mount containment and identical canonical Git common-dir at mount/discovered root before content/mutation.
- Original mount prefix remains authoritative after changing cwd to actual Gitroot. Outside rename/copy ancestors stop history; mixed/outside-mount commits retain generic subject; document patches never expose sibling paths. Existing project-specific admin filtering remains.
- Adoption stages only configured mount and excludes its active lock; scoped commits never absorb parent/outside staged changes. Fixed Git executable-config policy still applies.
- Previously reported nested mutation/history limitation is resolved by this authorized extension, not deferred.

## Validation
- Final admin-brain-entities:15 passed in33.89s.
- Attribution:4 passed; brain:10 passed; projects-brain:8 passed (latest combined run). Total37 passing affected tests across observed final file results.
- Prior combined run had one new assertion expecting later common-dir diagnostic, while containment correctly denied earlier. Assertion corrected to exact containment diagnostic, and separate enclosing-root fixture now exercises common-dir identity branch. No production behavior weakened.
- Only temporary fixture repos/fake clients; no real providers/user data. No broad validation or commits. Source frozen for supervisor integration/typecheck/native/full acceptance.

## New brief: packaged panel build fingerprint
- Scope authorized by supervisor: operations/panel.ts, router/scripts/package-build.mjs, package files allowlist if necessary, relevant panel operation tests and worker report only.
- Problem: tarball extraction resets dist mtimes after panel BUILD_ID, causing a false stale warning despite matching packaged router content.
- Plan: build script writes versioned deterministic relative dist path/content digest bound to panel BUILD_ID. Runtime validates bounded manifest with Zod, compares actual router file inventory/content, warns on invalid/mismatched metadata, ignores extraction timestamps when fingerprint matches. Workspace builds without manifest retain existing mtime fallback.
- No package builds or installs by worker; supervisor owns final packagebuild/reinstall. Focused temp fixture tests only; freeze source promptly.

## Packaged fingerprint correction outcome
Status: Implemented and source frozen
- Exact inventory: packages/router/src/operations/panel.ts; packages/router/scripts/package-build.mjs; packages/router/tests/operations-panel.test.ts. No package files allowlist change needed because panel/.next is already included.
- Shared exported algorithm sha256-runtime-path-content-v1 hashes sorted relative dist file paths plus each file's SHA256 content; declaration files and source maps excluded because they do not change executable runtime behavior. Rejects symbolic links, nonregular files, empty builds, more than20000 runtime files or256MiB content. Absolute paths and mtimes absent.
- Package script builds router, imports the same helper from freshdist, snapshots fingerprint, builds panel, then refuses if router content changed during panelbuild. Generated panel/.next/router-build.json binds version/algorithm/digest/filecount to BUILD_ID. No build timestamp fingerprint.
- Runtime strictly validates bounded manifest via Zod, rejects unexpected fields/version/algorithm/invaliddigest/filecounts, checks BUILD_ID binding, compares current content inventory. Invalid/unreadable or mismatched metadata returns a clear reinstall/rebuild stale warning, never blindly disables checks. Missing manifest retains development mtime fallback.
- BUILD_ID accepts the same maximum200 trimmed characters and4096 raw bytes in script/runtime, including a trailing newline.
- Tests cover relocated extraction and newer dist mtimes with equal content, changed content/additional path, BUILD_ID mismatch,200-character ID+newline, declaration/map nondeterminism ignored, malformed/oversized/unexpected metadata, linked outside files refused, legacy mtime fallback and normal fake panel launches.
- Validation: node --check package-build.mjs passed; operations-panel12 + packaging4 passed (16tests). No packagebuild or reinstall run by worker; supervisor owns final acceptance. No commits.
