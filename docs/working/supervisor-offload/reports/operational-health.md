# Operational health audit: MCP offload readiness (read-only)

Date: 2026-11-25. Scope: can a Claude Code supervisor use MeritRouter as an MCP offload
tool right now, using only commands/paths this repo documents. No edits to tracked files;
no real provider calls; no touching `~/.meritrouter` or `D:/SwitchYard*`; user's panel/daemon
left untouched.

## 1. Typecheck / build / targeted MCP tests

- `pnpm -r typecheck` (root): **PASS** — both `packages/router` and `apps/panel` report `Done`.
- `pnpm -r build` (root): **FAILS**, but not from MeritRouter code. `packages/router build`
  itself succeeds (verified separately: `cd packages/router && pnpm build` → `tsc -p
  tsconfig.build.json`, clean exit). `apps/panel build` aborts with Next.js's own
  `[SecurityFatalError]`: "Your version of Next.js is affected by a known security
  vulnerability," halting the build and recommending `next upgrade --agent=security`. This is
  Next's built-in CLI nudge, not a MeritRouter defect, but it means **the top-level build command
  documented for contributors (`pnpm -r build`) currently fails outright** until the panel's
  Next.js version is addressed. Router `dist/` is present and current either way.
- Targeted MCP tests: `cd packages/router && npx vitest run tests/mcp.test.ts
  tests/mcp-http.test.ts tests/mcp-credit-usage.test.ts tests/mcp-passive-startup.test.ts
  tests/mcp-lifecycle-v2.test.ts` → **5 files, 30/30 tests PASS** (33s). Covers stdio tool
  exposure/persistence, Streamable HTTP (loopback/token rules), credit-usage accounting,
  passive-vs-worker startup, and project-scoped delivery lifecycle.

## 2. `.mcp.json` and the correct invocation

- `git ls-files .mcp.json` → **empty output: the file is NOT tracked** (confirmed also by its
  absence from `git status`). It's local-only stale state, not a committed defect.
- It points to `D:/SwitchYardRouter/packages/router/dist/mcp.js` and
  `D:/SwitchYard/switchyard.config.yaml`. `ls` confirms **neither path exists** — both are
  pre-rename artifacts from before the SwitchYard→MeritRouter rename.
- Correct current invocation per `docs/setup.md`/README:
  `node D:/MeritRouter/packages/router/dist/cli.js mcp --config <abs config.yaml> --project
  <slug>` (docs/setup.md:761, 774-776; README.md:96). `dist/mcp.js` directly still works too
  (docs/setup.md:714-715 calls it the form "for older registrations") but `cli.js mcp` is the
  current documented form. Net: the local `.mcp.json` is simply untracked leftover pointing at
  the old project name/location; it needs regenerating with current repo paths, not a code fix.

## 3. Onboarding steps (README.md / docs/setup.md) — and a real blocker found

README Quick Start (README.md:55-96) is 4 steps: (1) install deps/build, (2) `cli.js setup
--preset claude-code --project <slug> --repo app=<path>`, (3) optionally `daemon start`, (4)
`claude mcp add ... mcp --config ... --project <slug>` (or Codex equivalent). docs/setup.md's
own walkthrough (lines 1-19) is similarly ~4 numbered steps plus registering the MCP client.
Step count is small and reasonable.

**However, while reproducing this via `init` (the lower-level command docs/setup.md documents
as equivalent, used for probing below) I hit a reproducible blocker**: `meritrouter init <dir>
--preset claude-code --project <slug> --repo app=<path>` writes `storage.layout: split` (the
fresh-install default per docs/setup.md:210-224) but its generated `projects.<slug>` entry has
**no `directory:` key**. Per docs/setup.md:228-236, a split-layout project's store is only
provisioned the first time it is created *with* a directory (via `projects create <slug>
<dir>`, the panel's New Project form, or the MCP `create_project` tool) — `init --project` does
not do this. The result: `doctor` and `mcp` both fail with `web access belongs to project
stores; create a split project first` / `project <slug> has no project-local store; create it
as a split project first`, and the documented recovery command refuses: `projects create <slug>
<dir>` replies `project <slug> already exists` because the slug is already in the config from
`init`, with no hint to add a `directory` or any other escape hatch. Manually adding
`directory:` to the YAML by hand does **not** retroactively provision the store either — it must
go through the `projects create` provisioning code path, which can't run again once the slug
exists. The only way I found to reach a working project was to skip `--project` on `init` (or
hand-remove the stub project block) and run `projects create <slug> <dir>` fresh with a project
directory that is neither the install dir nor the repo dir.
**This means the exact command README.md:61 tells a new user to run
(`setup --preset claude-code --project my-app --repo app=...`) needs verification — it's a
different code path (`setup`, not `init`) and may provision correctly; I did not test `setup`
directly because it also starts the bundled panel, which the brief told me not to touch. If
`setup` has the same gap as `init`, a first-time split-layout user following the README literally
cannot get past `doctor`/`mcp` without hand-editing config and knowing the `projects create`
internals.** This is worth the lead verifying with `setup --no-panel` before relying on the
quick-start docs as-is.

## 4. `packages/router/evals/`

Contents: `suite.json` (versioned `2026-10-19.2`), `fixtures/`, `hidden/`. This is a
**qualification/grading suite** for scoring whether a candidate (usually free) model can pass
bounded coding/read-only tasks (e.g. `fix-range`, `add-duration`, `rename-option`,
`locate-validator`, `diagnose-crash`), each with `acceptanceCriteria`, hidden grading tests, and
a `maxModelRequests` budget. Run via `meritrouter qualify <model> --trials N` /
`qualify status` (docs/setup.md:905-909); a running worker executes and grades the trials.
**There is no benchmark here, or found elsewhere in `docs/decisions.md` / `docs/operations.md`,
that measures supervisor-side offload economics** — i.e. fraction of a Claude-Code task
completed by free/cheap workers, Claude supervisor tokens saved, or an acceptance/rejection rate
for delegated work in production use. The qualification suite scores raw model capability per
task, not the end-to-end offload ratio a Claude Code user would care about.

## 5. MCP server smoke test (temp config, no real providers)

Built a throwaway split-layout install entirely under the OS temp scratchpad (never touching
`~/.meritrouter` or any SwitchYard path), using `cli.js init` + `cli.js projects create
<slug> <dir>` (needed a project directory distinct from both the install dir and the repo dir —
`projects create` refuses when they overlap) with no provider keys configured. `doctor --project
<slug>` then reported the project/repo/brain as `ok`, with only the expected `FAIL` for
no provider keys / no models (fake config, no live providers used) and one `WARN` that the
panel build predates a newer router build (a pre-existing dev-env drift unrelated to MCP).

Spawned `node cli.js mcp --config <tmp config> --project <slug> --no-worker` over stdio from a
small Node probe script (sent in temp scratchpad only), did `initialize` →
`notifications/initialized` → `tools/list`, then killed the child:

- **Tool count: 50**
- **Total `tools` JSON (names + descriptions + input schemas): 39,888 bytes**
- Names include task lifecycle (`submit_tasks`, `await_results`, `get_task_status`,
  `collect_results`, `cancel_tasks`, `resume_task`, `accept_result`, `reject_result`), budget/
  routing (`budget_requests`, `decide_budget_request`, `preview_route`, `usage_summary`),
  job/lab tooling (`start_job`, `job_status`, `get_plan`, `get_job_tree`, `get_job_metrics`,
  `lab_status`/`lab_control`/`lab_operation`/`lab_logs`), the brain (`brain_search`,
  `brain_read`, `brain_write`, `brain_start_working_doc`, `brain_promote_lesson`, etc.), and
  project/session management (`create_project`, `list_sessions`, `resume_session`,
  `list_questions`, `answer_question`, `blame`). The server started and answered within the
  probe's 20s timeout with no provider keys configured — startup itself does not require live
  providers.

## 6. Uncommitted work (`git status --short`)

`git status --short | wc -l` → **62** lines. Mostly `??` (untracked): new root-level licensing
files (`CODEX.md`, `COMMERCIAL-LICENSING.md`, `LICENSE.md`), a large batch of untracked
`docs/working/gate2-auto-integration/reports/*.md` and an `archive/` subfolder (36 of the 62
lines), plus several other untracked working-doc folders (`client-connections/`,
`connection-modes/`, `supervisor-lifecycle-stall/`, `trial-failure-audit/`,
`unpublished-model-sizes/`, and this audit's own new `supervisor-offload/`). Modified (`M`)
tracked files are a small, coherent set: root/package docs (`README.md`, `AGENTS.md`,
`CLAUDE.md`, `docs/decisions.md`, `docs/working/{README,handoff,framework-validation,
gate2-auto-integration,production-readiness}.md`), `.gitignore`, and two `package.json`s plus
`packages/router/scripts/package-build.mjs`. Overall this reads as an in-progress licensing
rollout plus a large backlog of completed sub-agent working-document reports/archives from the
`gate2-auto-integration` workstream that haven't been committed yet — not random drift.

## Cleanup

Probe scripts and most temp install/config directories were removed from the OS temp
scratchpad. One leftover, `…/scratchpad/mcp-audit-install/.MeritRouter/meritrouter.db{,-shm,-wal}`,
could not be deleted (Windows "device or resource busy" — a SQLite handle was still settling
after the probe's child process exited); it is outside the repository, in this session's
disposable OS temp directory, and harmless to leave for OS temp cleanup. No tracked file was
modified; no process affecting the user's real panel/daemon/config was touched (the only running
`node … next start` process found via `Get-CimInstance Win32_Process` was the user's own
pre-existing panel, which this audit did not start, stop, or query).

## Bottom line

MeritRouter's own typecheck, router build, and MCP-specific test suite are healthy (30/30
passing), and a from-scratch MCP stdio server does start and correctly list 50 tools with no
providers configured. But the repo is **not cleanly plug-and-play right now**: (a) the
top-level `pnpm -r build` fails due to the panel's Next.js security-advisory gate, (b) the
checked-in-looking `.mcp.json` (actually untracked/local) references pre-rename, nonexistent
paths, and (c) the `init --project` onboarding path used in this audit hit a real, reproducible
dead end provisioning a split-layout project's store, with no documented recovery short of
hand-editing config internals — this needs the lead to confirm whether `setup` (the command the
README actually tells new users to run) avoids it before calling onboarding solid.
