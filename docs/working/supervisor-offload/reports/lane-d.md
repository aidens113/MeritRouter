# Lane D: integrations (connect, inbox, hooks)

## Outcome
Done, with one external dependency noted below: `meritrouter inbox`/`connect` are complete and
tested against an injected fake channel, but the real `meritrouter inbox` command only works
once lane B assigns `MeritRouter.channel` (currently `undefined` at runtime — confirmed by a
manual run, see "Validation").

## What changed and why

- `packages/router/src/cli/connect.ts` (new): `connectCommand(sy, target, flags, cliDistDir)`.
  - Ensures the project exists (`admin/insights.js` `createProject`, the same path
    `projects create` uses), accepting `--repo <dir>` (the repository, aliased `app`) and
    `--project-dir <dir>` (the project's own store directory) as two independent paths — this
    is what lets the connected repository (including this one, which must never hold a
    `.MeritRouter` of its own) point its project's store somewhere else.
  - Claude: merges `mcpServers.meritrouter` into `<repo>/.mcp.json` (any other server kept) and
    appends a marked block to `<repo>/CLAUDE.md`.
  - Codex: merges `[mcp_servers.meritrouter]` into `$CODEX_HOME/config.toml` (default
    `~/.codex/config.toml`) as literal-quoted TOML (`'...'`, so a Windows backslash path needs no
    escaping) and appends a marked block to `<repo>/AGENTS.md`. The TOML format was verified
    against `docs/setup.md`'s own documented `codex mcp add` output, not guessed.
  - The marked block (`<!-- meritrouter:offload:start/end -->`) is replaced on re-run, never
    duplicated, and never touches anything outside the markers.
  - `--hooks` (Claude only; refused with `codex`) merges three hook entries into
    `.claude/settings.json` (`PreToolUse`, `Stop`, `SessionStart`), replacing only entries this
    tool itself installed (matched by script basename in the command string) so unrelated hooks
    survive re-runs untouched.
- `packages/router/src/cli/inbox.ts` (new): `inboxCommand(sy, projectScope, json)` renders
  `sy.channel.listPendingForSupervisor(projectScope)` — requests awaiting an answer vs. replies
  not yet delivered — as a table or JSON. Read-only; it is also what the Stop/SessionStart hooks
  below shell out to.
- `packages/router/integrations/claude-code/hooks/{pretool-nudge,stop-inbox-gate,sessionstart-inbox}.mjs`
  (new): plain Node ESM, no dependencies, each wrapped so any error fails open (exit 0, no
  block). `stop-inbox-gate.mjs` is the only one that can block, and only by printing
  `{"decision":"block","reason":...}` when `inbox --json` has pending rows — it never touches
  "unreviewed finished reports" since nothing in the current channel contract exposes those yet
  (only worker *messages*; see Open Questions).
- `packages/router/integrations/codex/README.md` (new): documents why `connect codex` writes
  TOML directly instead of shelling out to `codex mcp add` (not guaranteed installed) and why
  `--hooks` is refused for Codex (no hook mechanism exists to install into).
- `packages/router/src/cli.ts`: added the `connect` and `inbox` cases, the `project-dir`/`hooks`
  flags, and exempted `connect` from the existing "project must already exist" precheck (it may
  be creating that project). No other command's dispatch changed.
- `docs/setup.md`: new "One-command connect" subsection after the existing Claude Code/Codex
  manual-registration steps, documenting `connect`'s flags and `--hooks`' three scripts.
- `README.md`: "Connect your agent" now leads with `connect claude|codex`, keeping the manual
  `claude mcp add`/`codex mcp add` form as the documented fallback.
- `packages/router/tests/cli-connect.test.ts` (new, 9 tests): project creation + idempotent
  `.mcp.json`/CLAUDE.md merge and preservation of unrelated content; idempotent `--hooks` merge
  preserving an unrelated hook; idempotent Codex TOML/AGENTS.md merge preserving another server;
  `--hooks` refused for Codex; `--project` required; unknown target refused; `inbox` rendering
  against an injected fake `SupervisorChannelService` (both a populated and an empty inbox).

## Commands run and observed results
- `cd packages/router && npx tsc -p tsconfig.json --noEmit` → exit 0 (clean; two earlier failures
  in `src/admin/offload-metrics.ts` and `src/admin/exchange-export.ts` — untracked files owned by
  another lane, not touched by me — were gone by the final run, presumably fixed concurrently).
- `cd packages/router && npx vitest run tests/cli-connect.test.ts` → **9/9 passed** (~11-15s).
- `cd packages/router && pnpm build` → exit 0 (`tsc -p tsconfig.build.json`, clean).
- `pnpm -r typecheck` (repo root) → both `packages/router` and `apps/panel` report `Done`.
- `pnpm -r build` (repo root) → `packages/router build: Done`; `apps/panel build` **fails**, but
  with a Turbopack/Next.js internal panic ("Cache corruption detected: checksum mismatch...
  00000005.sst") — a local Turbopack cache issue, not a code error, and `apps/panel` is outside
  my owned paths and was not touched by this brief.
- Manual run in an OS temp directory (git fixture built via a Node script, not the Bash tool
  directly, per the worker git restriction):
  - `node dist/cli.js init <tmp>/install --preset claude-code --project demo --repo app=<tmp>/myrepo`
    → provisioned project `demo` at `<tmp>/myrepo/.MeritRouter` (single-repo auto-provision from
    the already-landed init fix).
  - `node dist/cli.js connect claude --project demo --repo <tmp>/myrepo --hooks` → created
    `<tmp>/myrepo/.mcp.json`, `.../CLAUDE.md`, `.../.claude/settings.json` with the three hooks,
    all inspected directly (shown in full in the worker's transcript).
  - `node dist/cli.js connect codex --project demo2 --repo <tmp>/myrepo --project-dir <tmp>/myproj`
    (with `CODEX_HOME` pointed at a temp dir — never the real `~/.codex`) → **created project
    `demo2` with its store at `<tmp>/myproj/.MeritRouter`, leaving `myrepo` itself untouched** —
    the exact "repository may never hold its own `.MeritRouter`" scenario this flag exists for.
  - `node dist/cli.js inbox --project demo --json` → `Cannot read properties of undefined
    (reading 'listPendingForSupervisor')`, because `sy.channel` is not yet assigned (lane B not
    landed in this checkout). Confirms the dependency named in the brief; `inboxCommand` itself
    is correct per the unit tests, which inject a fake.
  - `node integrations/claude-code/hooks/stop-inbox-gate.mjs <cli> <config> demo` → exit 0 (fails
    open on that same error, as designed), though the underlying error text leaks to the hook's
    own stderr rather than being fully silent — harmless (never blocks) but noted below.
  - An attempt to run `connect codex` against the *real* `~/.codex` (forgetting `CODEX_HOME`) was
    correctly refused by the permission system before anything was written.
  - Temp fixture cleaned up afterward; one leftover log file under the OS temp directory could
    not be deleted (Windows file lock, same situation the Phase-0 operational-health audit noted)
    and is left for OS temp cleanup — outside the repository, harmless.

## Not verified
- The real (non-fake) `sy.channel.listPendingForSupervisor` end-to-end, since lane B had not
  wired `MeritRouter.channel` in this checkout as of this run.
- `codex mcp add`/`codex mcp get` against an actual installed Codex CLI (verified only against
  `docs/setup.md`'s own documented output format, per the brief).
- `--hooks`' Stop/SessionStart behavior inside an actual Claude Code session (verified by
  directly invoking the scripts with the same arguments `connect` would write, not by running
  Claude Code itself).
- `pnpm -r build`'s panel step (pre-existing local Turbopack cache issue, outside my paths).

## Open questions or contradictions found
- The brief and the Stop hook's description both say it should block on "unreviewed finished
  reports" as well as unanswered messages, but the current channel contract
  (`core/channel.ts`, `listPendingForSupervisor`) only exposes worker *messages* (question,
  tool_request, help, blocked, probe-answers) — there is no "report reviewed" concept yet. The
  Stop hook currently gates on pending channel messages only; once a report-review signal exists
  (likely lane A/E), `stop-inbox-gate.mjs` and `inbox.ts` should be extended to include it.
- `src/cli/help.ts` (not in my owned paths) does not document `connect` or `inbox` yet; the lead
  or whichever lane owns it should add them so `meritrouter --help` stays accurate.
- `packages/router/package.json`'s `files` array (not in my owned paths) does not list
  `integrations/`, so an installed tarball would ship `connect --hooks`' default script paths
  pointing at files that don't exist in that install. Source-checkout use (this repo, and
  dogfooding under `D:/MeritRouterProjects/`) is unaffected; worth a one-line fix by whoever owns
  that file before `package:build` is next run for release.

## Report
`docs/working/supervisor-offload/reports/lane-d.md` (this file).

---

Outcome: Done
Changed: `packages/router/src/cli/connect.ts` (new), `packages/router/src/cli/inbox.ts` (new), `packages/router/src/cli.ts`, `packages/router/integrations/claude-code/hooks/{pretool-nudge,stop-inbox-gate,sessionstart-inbox}.mjs` (new), `packages/router/integrations/codex/README.md` (new), `packages/router/tests/cli-connect.test.ts` (new), `docs/setup.md`, `README.md`
Validation: `cd packages/router && npx tsc -p tsconfig.json --noEmit` -> exit 0; `npx vitest run tests/cli-connect.test.ts` -> 9/9 passed; `pnpm build` (router) -> exit 0; `pnpm -r typecheck` (root) -> both packages Done; `pnpm -r build` (root) -> router Done, panel fails on an unrelated local Turbopack cache panic (not my paths); manual `connect claude --hooks` and `connect codex --project-dir <separate dir>` runs in an OS temp fixture, files inspected directly
Not verified: real (non-fake) `sy.channel` end-to-end (lane B not yet wired in this checkout); `codex mcp add` against a live Codex CLI; hooks inside an actual Claude Code session; panel build
Report: docs/working/supervisor-offload/reports/lane-d.md
Notes: typecheck errors seen mid-session in `src/admin/offload-metrics.ts`/`exchange-export.ts` were other lanes' untracked WIP files, not touched by me, and gone by the final check. `--hooks` scripts aren't yet in `packages/router/package.json`'s `files` list (not my path) — fine for this checkout, would break an installed tarball.
