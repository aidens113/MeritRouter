# Gate 1 wave C2: authored documentation for project-local storage (worker report)

Worker: wave-c2 (worker). Date: 2026-10-27. Branch dev, main checkout, no commits. Docs-only
brief: edit no code.

## Outcome

Done.

## What changed and why

- **docs/setup.md**: fixed the two stale lines the inventory flagged (old global `.meritrouter`/
  shared-brain wording at the former lines 49 and 514) and rewrote the "Projects" section to
  document `storage.layout: split|legacy`, the fresh `setup`/`init` defaults (`split` +
  `durability: full` + `.MeritRouter` spelling), the per-project directory requirement in split
  layout, the three creation entry points (panel `/new`, CLI `projects create <slug>
  [<directory>]`, MCP `create_project`), that deletion is not exposed over MCP, and that `init`
  refuses an installation directory inside a project repo. Also fixed two other stale
  lowercase-spelling lines found while verifying (`.master-key` path, daemon log path) to use the
  current default/placeholder. Checked the MCP registration examples (Claude Code, Codex) —
  already use the current `dist/cli.js mcp` form, so left unchanged.
- **docs/operations.md**: added split-installation backup/restore (installation backup refuses
  when its coordination store holds `tasks`/`sessions`/`artifacts` rows; `backupProjectStore`/
  `restoreProjectStore` as library-only functions with their refusal conditions), a migration
  subsection (quiescent-project definition, phases, startup recovery, rollback scope), split-layout
  specifics under "Deleting a project" (removes only `<directory>/.MeritRouter`, keeps accounting/
  tombstone, recovery after an interrupted deletion by rerunning), a one-line fix to the stale
  `.meritrouter/pre-restore-<time>` literal, and a note that `_qualification` gets its own
  installation-owned store in split layout.
- **docs/decisions.md**: new dated entry "Project-local storage: split layout (2026-10-27)"
  covering the explicit `storage.layout` key vs. the rejected durability-trigger design,
  qualification's installation-owned synthetic store, paid routes not yet authorised for split
  projects, and the legacy fence having no production caller yet (blocked on where a legacy
  coordination store would live).
- **docs/roles.md**: added a dated note under "Project isolation (D4)" distinguishing
  brain-folder isolation (D4) from the newer storage-level isolation a split installation gives
  each project, including the qualification and paid-routing points, cross-linked to
  decisions.md/operations.md.
- **README.md / packages/router/README.md**: no changes. Neither states the old global/shared
  layout; README's quick start already uses placeholder paths and doesn't describe `.meritrouter`
  defaults.

## Verification against source (file:line)

- `storage.layout` enum/default and doc comment: `packages/router/src/config/schema.ts:787`
  (durability), `:794` (layout); `storage.directory` default `.MeritRouter`: `schema.ts:781`;
  `brain.path` default `~/.MeritRouter/brain`: `schema.ts:514`.
- Lowercase fallback on case-sensitive FS: `packages/router/src/config/load.ts`
  (`resolveStorageDir`), per wave-b2a report.
- Fresh setup/init writes split+full+`.MeritRouter`: `packages/router/src/cli/setup.ts:34-44`.
- `init` overlap refusal: `packages/router/src/cli.ts:146-158`.
- `projects create <slug> [<directory>]`: `packages/router/src/cli/projects.ts:17` (comment) and
  `admin/projects.ts:211-334` (`CreateProjectInput.directory`, `createProject`).
- `projects delete <slug> --confirm <slug>`: `packages/router/src/cli/projects.ts:91`.
- MCP `create_project` tool: `packages/router/src/mcp/tools.ts:135-155` (slug/name/directory/
  repositories input).
- Split deletion mechanics: `packages/router/src/projects/deletion.ts`
  (`verifyProjectRuntimeRoot`, `removeProjectRuntimeRoot`), `admin/projects.ts`'s
  `deleteSplitProject` — cross-checked against wave-b2b's report rather than re-reading every
  line, since wave-b2b already verified it against its own tests.
- Installation backup coordination-rows refusal: `packages/router/src/operations/backup.ts:159-165`.
- Project backup/restore refusals: `packages/router/src/operations/project-backup.ts:149-150`
  (backup state check), `:292-312` (restore identity/generation/state/lease/claim checks).
- Migration quiescence checks and phases: `packages/router/src/projects/store-migration.ts:121-166`
  (SQL_CHECKS), `:461+` (`migrateLegacyProject` phase comment and body).
- Paid-route refusal in split mode: `packages/router/src/core/project-runtime-host.ts:187-190`.
- Qualification's installation-owned store: `packages/router/src/qualification/store.ts`
  (`qualificationStoreDirectory`, `ensureQualificationStore`), per wave-b2c report.

## Commands run and observed results

| Command | Result |
| --- | --- |
| `git diff --check` | clean for the four touched doc files (two pre-existing CRLF warnings on `packages/router/src/runners/supervisor.ts` and `packages/router/src/workspaces/repository-command.ts`, neither edited by me) |
| `git diff --name-only` | confirms only `docs/decisions.md`, `docs/operations.md`, `docs/roles.md`, `docs/setup.md` changed by me; the three code/test files already modified at session start are untouched |

No build/typecheck run: docs-only brief, no code changed.

## Not verified

- No test suite run (not applicable to a docs-only change).
- I relied on the wave-a/b1/b2a/b2b/b2c/inventory reports for some mechanics I did not
  independently re-derive line-by-line (e.g. the exact step ordering inside `deleteSplitProject`),
  cross-checking only the parts I could cite directly in source. If any of those reports' own
  claims are later revised, the corresponding doc text should be revisited.
- No panel opened and no screenshots taken (out of scope for this brief; C2's panel work per
  wave-b2b's open questions is separate from this docs wave).
- No CLI/MCP command currently exposes project backup/restore or migration; I documented them as
  library-only APIs rather than inventing command syntax. If a future wave wires them to a CLI,
  `operations.md`'s backup/restore and migration subsections will need command examples added.

## Open questions or contradictions found

None beyond what the read reports already flagged (legacy fence has no caller; paid routes
unauthorised in split; qualification's restart-recovery gap for runtime-registered repositories
per wave-b2c's open question 1) — recorded as decisions/limitations in `decisions.md` and
`operations.md` rather than left silent.
