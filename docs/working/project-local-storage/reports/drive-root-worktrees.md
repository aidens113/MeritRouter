# Drive-root folder investigation (2026-10-26)

Owner: supervisor. Read-only filesystem/Git/process inventory; no folders removed or moved.

## Finding

Twelve `D:/SwitchYardRouter-*` directories are Git-registered development worktrees,
created on 2026-10-25 for separate framework fixes. Each HEAD is an ancestor of current
`dev` (2bc5ab6). All twelve have zero tracked modifications and zero nonignored untracked
files. They contain ignored dependencies/builds; approval-navigation also contains demo
state. They are alternate source checkouts, not new user application projects.

| Directory suffix | Branch |
| --- | --- |
| active-validation | feat/active-validation-ownership |
| approval-navigation | feat/approval-navigation |
| command-feedback | feat/operator-command-feedback |
| context-snapshot | feat/delegated-context-snapshot |
| dependent-source | feat/dependent-review-source |
| mcp-passive | feat/mcp-passive |
| memory-headroom | feat/memory-resume-headroom |
| repair-hydration | feat/repair-hydration |
| repair-quiescent | feat/repair-quiescent-operations |
| repair-reference | feat/repair-reference-guard |
| terminal-evidence | feat/delivery-terminal-budget-state |
| transport-recovery | feat/transport-recovery |

The agent workflow required isolation for concurrent validation but did not prescribe
worktree placement or a cleanup gate. Prior agents used sibling paths and retained them
after integration. Historical handoff records show repair-hydration and repair-quiescent
were also used as runtime service trees. Git registration, folder timestamps and working
records support this explanation; a complete original shell-command audit was not done.

## Other nearby locations

- `D:/SwitchYard` holds live configuration, backups and `.switchyard` state. Preserve it.
- `D:/SwitchYardProjects` is the downstream project location; not disposable development state.
- `D:/SwitchYardTests` is the historically registered Tetris project, with Git metadata.
- `D:/SwitchYardPanelBaseline` contains a separate panel baseline checkout/build layout.
- `D:/sy-wt` contains older work areas (`dp`, `r1`, `s2`, `sn`, `v1`).
- `.pnpm-store` is dependency-store state, not another source checkout.

These are distinct roles. Do not delete by name prefix or infer that all are stale worktrees.

## Prevention and cleanup decision

AGENTS.md now prohibits new development/validation directories beside the repository or
in drive roots, requires ignored in-repository `.MeritRouter/development/<short-slug>` and
`.MeritRouter/validation/`, and requires integration cleanup checks. Existing main Git-local
exclude already protects `.MeritRouter`; `git check-ignore` must be verified for new trees.
This is an agent workflow rule, not an OS sandbox or a product data migration.

No process command line referencing a sibling worktree and no matching Windows service
was returned by the current CIM inventory. The connected passive MCP process runs from
the main repository against the existing external config. Process command lines do not
prove absence of open handles or scheduled/service launch references. Given historical
service usage and ignored demo state, preserve external trees for now; safe cleanup must
inventory retained evidence and launch references, then use Git-aware removal/relocation
without force and without discarding user data. Do not bulk-delete drive-root directories.

## Validation

- `git worktree list --porcelain`: twelve sibling worktrees, branch identities above.
- `git merge-base --is-ancestor <each HEAD> dev`: all twelve exit 0.
- `git -C <each path> status --porcelain --untracked-files=no`: all empty.
- `git -C <each path> ls-files --others --exclude-standard`: all empty.
- `git -C <each path> ls-files --others --ignored --exclude-standard --directory`:
  dependencies/builds as described; approval-navigation includes `apps/panel/.demo/`.
- `Get-CimInstance Win32_Process` and `Win32_Service`: observations above, not handle proof.
- `git diff --check`: exit 0 after policy/document edits.

No live provider calls, service changes, runtime migration, directory cleanup or source
code changes were necessary for this investigation.
