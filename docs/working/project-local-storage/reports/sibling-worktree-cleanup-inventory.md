# Sibling development-folder cleanup inventory

Worker: sibling_cleanup_inventory
Date: 2026-10-26
Status: read-only inventory complete; supervisor owns all cleanup.

## Twelve registered sibling worktrees

Every listed HEAD is an ancestor of current dev e5989ce. Every tracked status is empty,
and every nonignored untracked count is zero. The directory roots are ordinary directories,
not junctions/symlinks. No actual running process, Windows service or scheduled-task action
referenced these paths. The inspection command matched itself and was excluded as evidence
of runtime use. Launcher/MCP registration search returned no matches (rg exit1).

| D:/SwitchYardRouter- suffix | Retained ignored content | Cleanup recommendation |
| --- | --- | --- |
| active-validation | Dependencies and compiled router | Git-aware remove candidate |
| approval-navigation | Dependencies, panel/router builds, demo runtime and test evidence | Preserve ignored demo evidence first, then Git-aware remove |
| command-feedback | Dependencies and compiled router | Git-aware remove candidate |
| context-snapshot | Dependencies and compiled router | Git-aware remove candidate |
| dependent-source | Dependencies, panel/router builds | Git-aware remove candidate |
| mcp-passive | Dependencies and compiled router | Git-aware remove candidate |
| memory-headroom | Dependencies and compiled router | Git-aware remove candidate |
| repair-hydration | Dependencies, panel/router builds | Git-aware remove candidate |
| repair-quiescent | Dependencies and compiled router | Git-aware remove candidate |
| repair-reference | Dependencies and compiled router | Git-aware remove candidate |
| terminal-evidence | Dependencies and compiled router | Git-aware remove candidate |
| transport-recovery | Dependencies and compiled router | Git-aware remove candidate |

The approval-navigation demo contains generated seed projects (`billing`, `storefront`,
`navigation-core`, `repo`, `web`, `brain`), its own `.meritrouter` store/worktrees/Labs,
demo config/model YAML, navigation result JSON, and seven-tab browser screenshot/results.
An all-ignored/nonbuild file inventory finds 1583 files, about9MB. No contents or secrets
were printed. It is not source divergence, but deleting it discards otherwise untracked
validation evidence. Recommend preserving this exact `.demo` as private evidence beneath
the main repository's ignored `.MeritRouter/validation/` before parent checkout removal.
Treat such an archive as historical evidence, not an automatically runnable relocated Lab:
its nested Git registrations/config paths may still name original locations.

PowerShell size inventory without `-Force` initially omitted hidden `.git` file sizes and
printed hidden-item lookup errors; file-name discovery itself succeeded. The size is only
an estimate, not an archival completeness proof. Supervisor must verify a real archive.

## Other alternate development locations

`D:/SwitchYardPanelBaseline` is not a registered Git worktree and has no root `.git`.
It contains291 nonbuild source/config/test files plus dependencies/build outputs. A Node
read-only audit computed raw Git blob SHA1 for all291 files and compared them to
`git rev-list --objects --all`: all291 exact raw blobs already exist in repository history,
zero unique blobs. No line-ending normalization was needed. Its root/apps/packages are
ordinary directories. No process/service/task or launcher/MCP reference matched it.
It is a removable baseline-copy candidate, after the supervisor resolves/checks the exact
absolute target and confirms no unexpected later edits.

`D:/sy-wt` contains `dp`, `r1`, `s2`, `sn`, `v1`, ordinary directory roots. An explicit
`rg --files --hidden --no-ignore` excluding only node_modules, .next, dist and tsbuildinfo
finds zero remaining files. Only empty parent skeletons and dependency/build residue remain.
It is not in the main Git worktree registry. No process/service/task/launcher/MCP reference
matched it. It is a removable owned-development-residue candidate after exact-target checks.

## Method and limits

- `git worktree list --porcelain` identified registrations/HEADs.
- Twelve `git merge-base --is-ancestor <HEAD> dev` checks returned0.
- Per-tree `git status --porcelain --untracked-files=no` and
  `git ls-files --others --exclude-standard` returned empty.
- `git ls-files --others --ignored --exclude-standard --directory` classified caches/demo.
- `Get-Item -Force` checked directory-root LinkType; no root links found.
- CIM process/service inventory and scheduled-task actions checked known launch references;
  no claim of exhaustive open-handle or arbitrary shell-current-directory proof.
- Raw blob audit read source bytes without writing Git objects; output only counts/paths.
- `rg` excluded dependency/build trees while comparing baseline/source residue. Those trees
  may contain normal package-manager links; no blanket claim every descendant is unlinked.

Use Git-aware worktree removal for the twelve registered checkouts, without a broad drive-root
wildcard deletion. Stop on dirty/locked/ownership failures; never force-remove foreign data.
Loaded shared Windows native modules may block cache removal despite no active sibling process.
Do not stop the user's main panel merely to delete a cache; report any exact locked residue.

Preserve `D:/SwitchYard`, `D:/SwitchYardProjects`, `D:/SwitchYardTests`, the main repository,
the active in-project metadata-exclusion worktree, and unrelated user folders. None of these
are disposable sibling variants under this inventory.

No directories/files were deleted or moved, no new directories/checkouts created, no source
or shared documents edited, no tests/builds/providers/Docker called, and no commits/pushes made.

## Supervisor execution update — 2026-10-26

The above is the original read-only inventory, not the final cleanup state. User later
explicitly prohibited source-repository .MeritRouter; its unfinished source was preserved
in main and its inactive contents moved to D:/.pnpm-store/meritrouter-agent-cleanup-20261026.
All twelve D:/SwitchYardRouter-* siblings and baseline/sy-wt are absent from their old paths.
Permanent recursive deletion was rejected twice by automatic approval review; no permanent
deletion claim. Package-cache quarantine is inactive and must never run a checkout/process.

Additional hidden-worktree audit: all twelve registered .claude/worktrees HEADs are merged
into dev, but roadmap-labs has source drafts, roadmap-process a tracked fixture change,
and several trees untracked validation logs. Git worktree move preserved each entire tree
under the same existing quarantine with legacy- prefixes. Unregistered overview-horizons
residue was moved there with Move-Item after explicit absolute boundary/occupied-target checks.
No actual worker process referenced these paths; only the inventory command matched itself.
.claude/worktrees is now empty; .MeritRouter remains absent. Retired Git administrative
directories were subsequently copied and every file SHA256-verified in OS TEMP at
meritrouter-retired-worktree-admin-20261026. Quarantine .git pointer files renamed .git-retired,
then git worktree prune removed only invalid registrations. Git now lists ONLY main.
Dirty source, logs, staged-index/admin recovery and branches remain preserved.
