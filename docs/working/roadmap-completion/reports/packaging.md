# Report: packaging
## Outcome
Done: installable tarball and default setup validated outside checkout; bundled production panel, native SQLite and MCP work without checkout filesystem access.
## What changed and why
- Config precedence: explicit argument, SWITCHYARD_CONFIG, nearest ancestor switchyard.config.yaml, platform user config directory. SWITCHYARD_HOME overrides the application directory; platform defaults are LocalAppData/SwitchYard, Library/Application Support/SwitchYard, or XDG_CONFIG_HOME/switchyard (~/.config/switchyard fallback).
- `init [dir]` retains local initialization; explicit --config targets a filename. `setup [dir]` initializes the discovered/default config and starts the panel; --no-panel only initializes. Existing configs/models are kept. Setup has no placeholder repositories, scopes its brain below its config, and resolves supplied repository paths from invocation cwd.
- Package build/prepack builds router+panel, stages production .next/static/public assets and a runtime config/manifest, and ships charters/presets/evals. Panel launcher prefers bundled assets and resolves its Next runtime from normal installed package dependencies, preserving checkout and explicit override behavior.
- Distribution uses normal production Next build and package runtime dependencies rather than standalone node_modules. This is intentional: shipping host-specific better-sqlite3 binaries from standalone would break target-platform installs. The package's native dependency installs for its consumer platform normally.
- Generated panel directory is ignored; build caches/dependency trees excluded from staging/package.
- Turbopack emits hashed native-module junctions. Packaging inspects every external alias and requires its package to be a declared runtime dependency, then generates a small CommonJS forwarding package under runtime-modules. Launcher prepends only that directory to the child NODE_PATH. No host binary, workspace link or compiled-chunk rewrite is shipped. Next/React runtime versions are pinned to the versions used by the panel build and checked before packaging.
## Commands run and observed results
- `pnpm install --frozen-lockfile --offline`: passed; initial pre-build CLI-bin warnings expected before dist exists.
- `pnpm install --lockfile-only --offline`, then frozen offline install: passed for manifest dependency additions.
- `pnpm --filter switchyard-router typecheck` and router build: passed.
- `pnpm exec vitest run tests/packaging.test.ts tests/operations-panel.test.ts --maxWorkers=2`: 10/10 passed.
- First Turbopack panel build compiled in 27s, but staging correctly exposed an EPERM trying to copy its host-native hashed junction. No artifact was accepted from that attempt.
- A webpack alternative hit its default ~4GB JS heap limit (exit134); abandoned rather than accepting an unvalidated fallback. Working Turbopack build plus inspected forwarding aliases is the final design.
- Final `node packages/router/scripts/package-build.mjs`: passed router + Turbopack production panel + portable alias staging; compile105s under shared-machine load.
- `npm pack --ignore-scripts --json` (npm8.19.4): exit0; unexpectedly ran prepack despite ignore flag, and that additional production build also passed. Output is lifecycle text followed by JSON. Artifact `packages/router/switchyard-router-0.1.0.tgz`: 41,684,760 bytes, 2,302 entries. Tar inspected: required charters, examples/presets, evals, panel BUILD_ID and alias; zero node_modules folders, .node binaries, .env, DB or demo state.
- Final `pnpm exec vitest run tests/packaging.test.ts tests/operations-panel.test.ts --maxWorkers=2`: 11/11 passed, including real tiny alias-loading panel fixture.
- Final router typecheck passed.
- Outside install: `pnpm --dir packages/router exec node scripts/packaging-smoke.mjs ./switchyard-router-0.1.0.tgz C:/Users/mrjoh/AppData/Roaming/npm/node_modules/pnpm/bin/pnpm.cjs` installs151 production dependencies into a fresh C:Temp directory using cached D:store (offline). First attempt with drive-default C:store lacked cached packages; script now passes the source store explicitly.
- Smoke harness corrected its createRequire base to the real installed package directory (pnpm's symlink facade does not expose private dependencies). Reused install only after verifying its lockfile contains the exact tarball SHA512. No consumer code changed for that harness correction.
- Final smoke rerun with the same command plus existing root `C:/Users/mrjoh/AppData/Local/Temp/switchyard-package-install-Chzlir`: exit0. Actual native SQLite SELECT passed; installed CLI help/init/setup/default discovery/projects list passed; installed MCP36 tools + usage_summary passed; production panel8 pages/API routes (including qualification) + stylesheet passed; setup first reused the owned foreground panel, then actually launched a detached bundled panel after it closed. The fixture called its stop API and verified the port closed.
- Every CLI/MCP/panel runtime in the final smoke had a preload guard rejecting filesystem reads into the source checkout. No guarded accesses occurred. Thus asset paths were also verified, rather than merely checking that npm links were absent.
- Evidence logs (untracked): package-build-final.log, package-install-smoke-final.log; archive inventory packages/router/packaging-pack.json.
## Not verified
Linux/macOS installation and public npm publication were not run. No real providers, user config/install or OS service touched. Full recursive integration checks and authored/shared docs remain supervisor-owned.
## Open questions or contradictions found
No blocking architecture decision. Supervisor owns Labs CLI integration after the announced CLI freeze and authored/shared documentation.

## Integration and cleanup notes
Integrate only tracked source/manifest/lock changes plus new packages/router/.gitignore, .npmignore, scripts/package-build.mjs, scripts/packaging-smoke.mjs, src/cli/setup.ts, tests/packaging.test.ts and this report. Do not integrate generated panel/, tarball, build logs or pack inventory. CLI freeze was announced before Labs integration.
Temporary successful install is retained for supervisor inspection at `C:/Users/mrjoh/AppData/Local/Temp/switchyard-package-install-Chzlir`; partial first offline-cache attempt at `.../switchyard-package-install-CV82uz` is also test-only. All test services are stopped. Clean these after independent review. Generated package panel assets intentionally remain ignored in the worker checkout for review.
