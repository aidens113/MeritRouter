# Lane E: measurement — report

## Outcome

Done, with scope reductions noted below (no file outside the owned paths was touched; the live
offload eval was validated only with `--dry-run`, never run against real Claude/providers).

## What changed and why

### `src/admin/offload-metrics.ts` — `offloadReport(sy, {project?, since?, until?, sessionTaskIds?})`

Reads each in-scope project's `tasks` table (via `fanOutProjectRows`, which also covers the
legacy "no project" scope `''` that a single-project install's tasks actually land in) and
returns:

- `tasksByKindOutcome` — exact, from `tasks.profile` x the stored `WorkerResult.executionStatus`/
  `acceptanceStatus` (or bare `state` for unfinished tasks).
- `acceptedLines` — accepted changed lines (added/removed) attributed to the commit's `Model`
  trailer, via `git log --numstat` restricted to the window and grouped by model, separated into
  `byModel` (met tasks), `notAccepted` (commits for tasks that did not reach `acceptanceStatus:
  "met"`), and `otherAuthors` (commits with no `Task` trailer, e.g. a human or lead commit).
  Free/paid classification reads the live model catalog's `origin` field and is explicitly listed
  under `estimates` (a model that has since left the catalog classifies as `"unknown"`).
- `commandsRun` — exact, from `WorkerResult.checks` (only checks the harness actually ran).
- `contextCompression` — `bytesOfReportReturned` is exact (the real `renderReportV1` output,
  measured in UTF-8 bytes); `bytesHandedInEstimate` is explicitly an estimate and documented as a
  floor, not a measurement, because there is no byte-level instrumentation today of what a
  worker's own read/search tool calls returned (I looked for one — see "Not verified").
- `modelUsage` — exact, summed from each task's stored `WorkerResult.usage`.
- `channelActivity` / `acceptanceRate` — exact, from `channel_messages` and `task_rework`
  (including the legacy `''`-project fallthrough, which the cross-project reads elsewhere in
  `admin/` skip entirely — see the bug note below).
- `unavailableProjects`, `estimates` — explicit, so a caller never mistakes an estimate for a
  measurement.

**A real bug found and fixed in passing (within this file only):** `fanOutProjectRows` includes a
`project: ''` scope for tasks charged to no project (the normal case for every single-project
install, which is what every test fixture and most real installs are). My first draft's
channel/rework read and the git-repository resolution both explicitly skipped `projectId === ''`
or called `sy.projects.context('')` (which returns `undefined`), silently dropping all channel
and rework data for the common case. Fixed to route `''` through `sy.db` directly (channel/rework
tables) and through `sy.projects.primary` (repository resolution), mirroring how
`admin/projects.ts`'s `contextOfTask` already treats `''`. This was caught by the second and
fourth unit tests, not by inspection — flagging it in case another lane's admin read has the same
gap.

### `src/admin/exchange-export.ts` — `exportExchanges(sy, {project, since?})`

An async generator, one `ExchangeRecord` per task (oldest first, one project's store read at a
time — not buffered), with its mapped-back brief fields, tool grants (from `grant` channel
messages' `tool:<name>` refs), channel messages in order, the same `renderReportV1` text a
supervisor reads, verdicts (`verification.decisions`), harness-run checks, rework lineage
(`reworksTask` / `reworkedBy`, both directions via `task_rework`), and `servedEndpoints`.

Redaction: there is no existing helper that scrubs *unknown* secrets out of arbitrary text —
`providers/secret-masking.ts`'s `maskSecrets` only masks a secret it is already given, which
would require re-deriving a worker's own key visibility, a much bigger change than this lane
owns. I used the brief's documented fallback instead: pattern-based redaction (Bearer headers,
`sk-`/`sk-ant-`/`xox` prefixes, AWS access keys, `key=`/`token=`/`secret=`/`password=`
assignments) applied to every string field of the record before it is yielded. Tested with a
`sk-ant-...` string planted in a channel message body.

`exchangeRecordLine(record)` renders one JSONL line; the CLI uses it directly.

### `src/cli/exchanges.ts` — `exchangesExportCommand`, `parseExchangesExportArgs`

Exports the command function and an argv-tail parser only, per the brief; `src/cli.ts` is
untouched, so the lead (or lane D) still needs to register `exchanges export` and wire its flags
(`--project`, `--since`, `--out`) in `cli.ts` and `cli/help.ts`.

### `packages/router/evals/offload/**`

- `fixture/` — a tiny standalone TypeScript project (3 source files, 2 test files, its own
  `package.json`/`tsconfig.json`, never part of the pnpm workspace: the workspace glob is
  `packages/*`/`apps/*` only). `src/money.ts` has a known duplication (`clampRange`) and is
  otherwise clean; `src/strings.ts` has a function named for the rename task; `src/stats.ts` has
  an untested function and a second clamp duplicate. `logs/failing-run.txt` and `review/sample.diff`
  are static text fixtures for the summarize and review tasks.
- `setup/buggy-money/` — an overlay applied only to tasks 01 and 05, breaking
  `formatCurrencyCents`'s sign placement. Kept out of the base fixture so every *other* task's
  check (which runs the full `npm test`) doesn't inherit an unrelated failing test — an actual bug
  I hit and fixed while building the self-test (see "Not verified" for the one thing I could not
  fully chase down: a Node 22.11/Windows quirk in how `--test` is invoked, below).
- `tasks/01..08-*.json` — scout, summarize, mechanical rename, small feature+tests, bug fix with
  a failing test, write missing tests, refactor, review a diff. Each has a supervisor-facing
  `prompt`, a `goal`, `writable`/`allowedPaths`/`contextFiles`, and `checkScript`.
- `checks/*.mjs` — one deterministic Node script per task, reading files back out of the fixture
  directory after a run (code files for edit/implement tasks; an `ANSWER.md` the prompts ask for
  scout/summarize/review tasks to write). Shared build/test logic lives in `lib/fixture-build.mjs`.
- `reference/<id>/` — the solution overlay for each task, used only by `--dry-run`'s self-test.
- `run.mjs` — `--dry-run` (validates every task file, then for each one: copies the fixture to a
  temp dir, applies `setup` if any, runs the check expecting **fail**, applies `reference/<id>`,
  runs the check again expecting **pass**); `--yes [--mcp-config <path>] [--task <id>] [--out
  <dir>]` for the real two-arm run (`claude -p`, `--output-format json` for baseline, plus
  `--mcp-config` for the offload arm), printing the planned spend and refusing without `--yes`.
  With neither flag it prints usage and exits 1.

**Scope note on the live runner:** `run.mjs --yes` spawns `claude -p` itself but does **not**
stand up a MeritRouter MCP server or project (that is `meritrouter connect`, lane D's
`integrations/` module, and Phase 3's integration step) — it only accepts an existing
`--mcp-config` path to hand to `claude -p`. I did not fabricate that wiring; it is out of this
lane's owned paths and Phase 3 is where the real server exists to point at. I have not run this
path at all, per the brief and per "never call real providers."

### A Windows/Node 22.11 bug worth flagging upward

`node --test <directory>` (an explicit directory as a CLI argument) does **not** recurse that
directory on Node 22.11/Windows — it treats the path as a module specifier and fails with
`MODULE_NOT_FOUND`, even though the directory and its `*.test.js` files genuinely exist on disk.
Auto-discovery only works with **no** path argument, relying on `cwd`. I hit this building
`lib/fixture-build.mjs::testFixture` and the fixture's own `npm test` script, and fixed both to
`cd` into `dist` and run bare `node --test`. This is a general Node/Windows gotcha, not specific
to this fixture — worth a line in `AGENTS.md`'s environment-gotchas section if another lane hits
it (I did not add it myself: that file is outside my owned paths).

## Commands run and observed results

- `cd packages/router && npx tsc --noEmit -p .` → clean for every file I own. The only remaining
  errors are in `tests/cli-connect.test.ts` (lane D's file, pre-existing, unrelated to this lane —
  I did not touch it, per the brief).
- `cd packages/router && npx vitest run tests/offload-metrics.test.ts tests/exchange-export.test.ts`
  → **6 passed (2 files)**: 4 in `offload-metrics.test.ts` (kind/outcome/commands/usage/channel
  counts; git-attributed accepted lines vs. not-accepted vs. other-author commits; rework ->
  afterRework acceptance; project/`sessionTaskIds` scoping), 2 in `exchange-export.test.ts` (full
  record shape including redaction of a planted `sk-ant-...` string; `since` filtering).
- `cd packages/router && node evals/offload/run.mjs --dry-run` → `8/8 tasks self-test cleanly`,
  exit code 0. Each task's check genuinely fails against its (possibly `setup`-broken) unmodified
  fixture and genuinely passes once `reference/<id>` is overlaid.
- `node evals/offload/run.mjs` (no flags) → prints usage, exit code 1 (refuses to run anything).
- Did **not** run `node evals/offload/run.mjs --yes` (would spend real Claude usage and free
  provider quota; the brief says not to, and I have no `--mcp-config` to give it anyway).

## Not verified

- The live `--yes` path (`claude -p` spawning, JSON usage parsing, the offload arm) has never
  actually been run — only read for correctness. Its JSON-usage-parsing (`parsed.usage ??
  parsed.result?.usage`) is a guess at Claude Code's `--output-format json` shape; the first real
  run should check and adjust it if it's wrong, before trusting any numbers from it.
- `offloadReport`'s `acceptedLines` git attribution is exercised against one small test repo with
  a handful of synthetic commits; I did not test it against a merge commit, a repository path
  containing special characters, or a model id that has aliases/renames in the catalog (the
  `classify` lookup is first-match `id === model || gatewayModelId === model`, which is correct
  today but will silently read "unknown" for any served model that is later renamed or removed
  from `models.yaml`).
- `exportExchanges`'s pattern-based redaction is pattern-based, not exhaustive — it will not catch
  a secret that doesn't match one of the five listed shapes. I flagged this as a documented
  limitation in the module's own comment rather than overstating it as complete.
- `contextCompression.bytesHandedInEstimate` is a known floor, not a real "bytes read" number,
  because MeritRouter has no instrumentation of tool-call read/search payload sizes today. I did
  not add that instrumentation (it is not file I own — it would touch `src/harness/**`, lane C's
  path) — flagged in the module's doc comment and in `estimates`.
- I have not run the full router suite (`cd packages/router && npx vitest run` with no file
  filter) or `pnpm -r build`; only the two new test files and the typecheck, per the brief's
  acceptance list. Given the Work Ledger's "known failing, not caused here" note about
  `project-task-lab-deletion`, a full-suite run belongs to Phase 3's integration pass regardless.

## Open questions or contradictions found

- None blocking. One judgment call worth flagging: the brief's acceptance item 1
  ("`pnpm typecheck` clean for your files") — I ran `npx tsc --noEmit -p .` (the whole package)
  rather than a files-only invocation, since that is what actually catches a break I introduce in
  a shared type; the only remaining errors are confirmed pre-existing and in lane D's owned file.

---

```text
Outcome: Done
Changed: packages/router/src/admin/offload-metrics.ts, packages/router/src/admin/exchange-export.ts,
  packages/router/src/cli/exchanges.ts, packages/router/tests/offload-metrics.test.ts,
  packages/router/tests/exchange-export.test.ts, packages/router/evals/offload/** (fixture, setup,
  tasks, checks, reference, lib, run.mjs)
Validation: `cd packages/router && npx tsc --noEmit -p .` -> clean except pre-existing errors in
  tests/cli-connect.test.ts (lane D, untouched); `npx vitest run tests/offload-metrics.test.ts
  tests/exchange-export.test.ts` -> 6 passed (2 files); `node evals/offload/run.mjs --dry-run` ->
  8/8 tasks self-test cleanly, exit 0; `node evals/offload/run.mjs` (no flags) -> usage, exit 1
Not verified: the live --yes two-arm run (never executed, per the brief); offloadReport's git
  attribution against merge commits or renamed/removed catalog models; exhaustiveness of
  pattern-based secret redaction; bytesHandedInEstimate as a real read-byte measurement (no
  instrumentation exists yet); full router suite / pnpm -r build (not in this brief's checklist)
Report: docs/working/supervisor-offload/reports/lane-e.md
Notes: Found and fixed a real gap in my own new code (not pre-existing) where cross-project reads
  must route project_id '' through sy.db/sy.projects.primary, same as admin/projects.ts already
  does; flagging since other admin/ reads may share the pattern. Also hit and worked around a
  Node 22.11/Windows `--test <dir>` quirk (MODULE_NOT_FOUND on a real, existing directory);
  worth a line in AGENTS.md's environment gotchas if another lane meets it.
```
