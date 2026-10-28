# Gate 1 wave B2a: fresh installs default to split storage, `.MeritRouter` spelling (worker report)

Worker: wave-b2a. Branch dev, main checkout, no commits, no new worktrees. Paths below are
relative to `packages/router` unless stated.

## What changed and why

- **`src/config/schema.ts`**
  - New `storage.layout: z.enum(["split", "legacy"]).default("legacy")` with a doc comment
    explaining both values. Existing configs (no `layout` key) keep `legacy`.
  - `storage.directory` default spelling `.meritrouter` -> `.MeritRouter`.
  - `brain.path` default spelling `~/.meritrouter/brain` -> `~/.MeritRouter/brain`.
- **`src/config/load.ts`**
  - New private `resolveStorageDir(baseDir, directory)`: resolves `storage.directory` as before,
    but if the resolved (new-spelled) path does not exist *and* its basename case-insensitively
    names the old default (`.meritrouter`), falls back to an existing old-spelled sibling
    directory. On Windows/macOS (case-insensitive filesystems) the old-spelled directory already
    satisfies the new-spelled lookup via `existsSync`, so the fallback branch is a no-op there;
    it only actually redirects on a case-sensitive filesystem (Linux). A custom directory name
    never triggers it.
- **`src/core/project-runtime-host.ts` (`openInstallationLayout` only)**
  - Signature changed from `(db, durability)` to `(db, layout: "split" | "legacy")`, matching
    B1's stable contract note ("Flipping to force full on any empty DB is a one-line change").
  - A coordination store already marked split, or already bound without the mark (legacy
    migration), behaves exactly as before, regardless of the current config.
  - For an unbound store: `legacy` leaves it alone (unchanged). `split` on an **empty** store
    binds it as coordination and forces `synchronous=FULL` (unchanged mechanics, just reached by
    config instead of durability). `split` on a **non-empty** unbound store (legacy service data)
    now throws `MeritRouterError("split_layout_unavailable", ...)` with actionable text, instead
    of silently falling back to `legacy` — this is the one behavior change the brief asked for.
  - I did not touch anything else in this file (the qualification-store additions visible in
    `git diff` for this file — `qualificationBundle`, the `projectContext`/`ensureQualificationStore`
    imports, `runtimeOf`'s qualification branch — are from a concurrent wave editing the same file
    outside `openInstallationLayout`; not mine, see Open questions below).
- **`src/core/service.ts`**: the one call site, `cfg.storage.durability` -> `cfg.storage.layout`.
  No other line in this file touched.
- **`src/cli/setup.ts` (`initializeConfig`)**: now always builds a YAML doc (not just under
  `opts.setup`) and sets `storage.directory: .MeritRouter`, `storage.layout: split`,
  `storage.durability: full` for every config it creates (both `init` and `setup`). Brain path:
  `setup` keeps its app-directory override but respells it `.MeritRouter/brain`; `init` (which
  previously left the preset's home-based brain path untouched) now explicitly sets
  `~/.MeritRouter/brain`. An existing config is still never rewritten (`existsSync` guard
  unchanged).
- **`src/cli.ts` (the `init`/`setup` dispatch — I treated this as "the init implementation
  file"; `init` isn't implemented in `cli/projects.ts`, which only holds `initConfigText`)**: for
  `init` only, before writing the config, refuse a `--repo` whose resolved path equals or
  contains the installation directory (`path.dirname(configPath)`), with guidance to use
  `meritrouter setup` or a different directory. `setup` is unaffected (application-directory
  installs are already separate from project directories by convention).
- **Tests**
  - New `tests/install-layout.test.ts`: fresh `setup`/`init` write `layout: split`,
    `durability: full`, `.MeritRouter` storage and brain spelling; `init` never rewrites an
    existing config; an existing config's explicit `legacy` layout and old-spelled directory
    survive `loadConfig` and a repeated `init` untouched; `storage.layout` defaults to `legacy`
    for a config missing the key; the storage-directory fallback (old-spelled directory exists,
    new one does not) is asserted with an explicit platform branch (Windows/macOS short-circuit
    via case-insensitive `existsSync`; a Linux-only `it.skipIf` covers the branch where both
    spellings exist); a custom directory name never falls back; and five direct
    `openInstallationLayout` unit tests (split-binds-empty, legacy-leaves-unbound,
    split-on-non-empty-throws, split-stays-split-regardless-of-config).
  - `tests/packaging.test.ts`: updated the one assertion block that checked `.meritrouter`/
    `.meritrouter/brain` for a fresh `setup` to the new `.MeritRouter` spelling, and added
    assertions for `storage.layout`/`storage.durability`.
  - `tests/project-service-activation.test.ts`, `tests/project-runtime-registry.test.ts`,
    `tests/project-queue-isolation.test.ts`: these weren't in my owned-paths list, but all three
    built split-mode fixtures by setting `storage.durability: "full"` (B1's old trigger) — with
    the trigger removed, they'd silently fall back to legacy and the split-mode assertions in
    them would fail. Changed `fixture()`'s `durability` option to `layout` (default `"split"`)
    and the two fixed-config call sites to `storage.layout: "split"`. In
    `project-service-activation.test.ts` I also rewrote the one case that exercised "an
    installation with existing legacy rows, reopened with full durability" — under the old code
    this returned `"legacy"` silently; under the new contract it must throw. Rather than
    constructing that case through `new MeritRouter(...)` (whose constructor has no failure path
    that closes `this.db` — a thrown-away handle on a non-empty store leaked a Windows file lock
    and broke fixture cleanup with `EBUSY`, confirmed by reproducing it isolated), I call
    `openInstallationLayout` directly on a manually opened/closed db to check the throw, then
    reopen normally in legacy mode for the rest of the test.

## Commands run and observed results

All from `D:/MeritRouter/packages/router` unless noted.

| Command | Result |
| --- | --- |
| `npx tsc --noEmit -p .` | exit 0 (ran twice, clean both times, final run after all edits) |
| `pnpm --filter meritrouter-panel typecheck` (repo root) | exit 0 |
| `npx vitest run tests/install-layout.test.ts` | 12 tests, 11 passed, 1 skipped (Linux-only fallback case, skipped on this Windows box) |
| `npx vitest run tests/install-layout.test.ts tests/packaging.test.ts tests/rename-compatibility.test.ts tests/project-runtime-paths.test.ts tests/project-service-activation.test.ts` | first run: 2 failures in `project-service-activation.test.ts` (see below); after fixing the EBUSY leak path, rerun of just that file: all 9 pass |
| `npx vitest run tests/project-service-activation.test.ts tests/project-runtime-registry.test.ts tests/project-queue-isolation.test.ts` (final, serial) | 54 tests, 53 passed, 1 failed — see Open questions 1 |
| `npx vitest run tests/project-store-provision.test.ts tests/project-store-migration.test.ts tests/project-store-identity.test.ts` (not owned; ran to check for collateral damage from the schema/load.ts change) | 58/58 passed |

## Not verified

- `pnpm -r build`, MCP tests, the panel build/screenshots, and the full router suite (out of
  scope for this brief; the acceptance list above is what was asked for).
- The lowercase-fallback branch where *both* spellings exist on disk is skipped on this Windows
  machine (case-insensitive filesystem makes the two paths the same directory; `mkdirSync` of the
  second throws `EEXIST`). It is covered by `it.skipIf(process.platform !== "linux")` and
  verified logically (reads `existsSync(resolved)` first, which is true, so it never reaches the
  fallback branch) but not executed here.
- The brain-path lowercase fallback (brief: "brain `~/.meritrouter/brain` -> `~/.MeritRouter/brain`
  ... on case-sensitive filesystems, if the new-spelled default does not exist but the old one
  does, use the old one") is implemented for `storage.directory` in `load.ts` only. Brain path
  resolution happens in `src/brain/brain.ts` (`expandHome`/`path.resolve`), which is outside my
  owned paths (not in the Owned list), so I did not add an equivalent fallback there. This is a
  gap the lead should route to whichever wave owns `src/brain/**`, or assign back to me.
- The `init` overlap guard (cli.ts) has no automated test: `main()` in `cli.ts` isn't exported and
  runs top-level side effects (`process.exit`) on import, and there's no existing pattern in this
  suite of spawning the built CLI binary. I verified it by reading the logic and by typecheck
  only. If an automated check is wanted, the cleanest path is to extract the dispatch into an
  exported, testable function — out of scope here (touches `cli.ts` more broadly than this brief's
  single concern).

## Open questions or contradictions found

1. **Concurrent edits to files I partially own.** `src/core/project-runtime-host.ts` and
   `tests/project-service-activation.test.ts` are being edited by what looks like a concurrent
   wave (qualification-in-split-mode support: `ProjectRuntimeHost.qualificationBundle`,
   `ProjectStoreRouter.runtimeOf`'s qualification branch, and matching changes to
   `src/qualification/runner.ts`/`comparison.ts`, `src/admin/projects.ts`,
   `src/projects/deletion.ts`). This repo is a single shared checkout with no worktree isolation
   for this wave. My own edit to `project-runtime-host.ts` is scoped strictly to
   `openInstallationLayout` (confirmed by `git diff`, no overlap). But it means:
   - The one remaining test failure in the acceptance run —
     `project-service-activation.test.ts > "refuses an unregistered or qualification project..."`
     expecting `submitTasks({purpose:"qualification"})` to reject with `/qualification store/` —
     now fails because the concurrent wave made that submission succeed (qualification now has a
     store in split mode). This is not caused by anything in my diff; re-running just my changed
     files/functions in isolation (confirmed via the direct `openInstallationLayout` unit tests
     and the rest of `project-service-activation.test.ts`) shows no other regression. The lead
     should reconcile this assertion with whichever wave owns qualification-in-split-mode, not
     have me guess at its final contract.
2. **"The init implementation file."** `init` and `setup` are both dispatched inline in
   `src/cli.ts` (`cmd === "init" || cmd === "setup"`); `src/cli/projects.ts` only holds
   `initConfigText` (the preset-text templating), not the `init` command itself. I treated
   `cli.ts` as the owned "init implementation file" for the overlap guard (point 5) and left
   `cli/projects.ts` untouched. If the lead meant a different file, the guard is an eight-line,
   easily-relocated block.
3. **Folder spelling scope.** Presets (`examples/presets/*.yaml`) still literally say
   `storage: { directory: .meritrouter }` and `brain: { path: ~/.meritrouter/brain }`; I did not
   regenerate them (per the brief: generated, never hand-edited, and changing
   `scripts/build-presets.mjs` felt like a larger, separately-reviewable change than this brief's
   scope). Instead, `initializeConfig` overrides those three keys with `doc.setIn` after loading
   the preset text, for every config it creates, so the effective behavior (`init`/`setup` always
   write `.MeritRouter` spelling + `split` + `full`) holds regardless of what the preset literally
   says. If the lead wants the presets themselves to show the new defaults (e.g. for someone
   reading the YAML template directly), that's a `build-presets.mjs` change I did not make.

## Return contract

Outcome: Done
Changed: `src/config/schema.ts`, `src/config/load.ts`, `src/cli/setup.ts`, `src/cli.ts`,
`src/core/project-runtime-host.ts` (`openInstallationLayout` only), `src/core/service.ts` (one
line), `tests/install-layout.test.ts` (new), `tests/packaging.test.ts`,
`tests/project-service-activation.test.ts`, `tests/project-runtime-registry.test.ts`,
`tests/project-queue-isolation.test.ts`
Validation: `npx tsc --noEmit -p .` -> exit 0; `pnpm --filter meritrouter-panel typecheck` -> exit
0; `npx vitest run tests/install-layout.test.ts tests/packaging.test.ts
tests/rename-compatibility.test.ts tests/project-runtime-paths.test.ts
tests/project-service-activation.test.ts tests/project-runtime-registry.test.ts
tests/project-queue-isolation.test.ts` -> all pass except one pre-existing-as-of-this-session
failure in `project-service-activation.test.ts` caused by concurrent qualification-in-split-mode
work outside my owned paths (see Open questions 1)
Not verified: `pnpm -r build`; MCP/panel build+screenshots; the Linux-only fallback branch
(skipped on this Windows box); the brain-path lowercase fallback (brain.ts not owned); the `init`
overlap guard has no automated test (see Not verified above)
Report: docs/working/project-local-storage/reports/wave-b2a.md
Notes: The qualification test failure and the live edits to `project-runtime-host.ts`/
`project-service-activation.test.ts` from another wave need the lead's reconciliation, not a
guess from me. Everything else in the acceptance list is green.
