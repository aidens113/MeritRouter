# Live validation

- **Owner:** senior supervisor agent
- **Status:** Active
- **Scope:** First runs against real providers and a real Claude Code client: what broke, what was
  fixed, what is still open. Each finding names its commit.
- **Started:** 2026-10-21

## Current State

2026-10-23: latest corrective source and offline acceptance are recorded in
[Correctness and panel flows](correctness-and-panel-flows.md). Earlier live results below are
historical and do not establish current panel/MCP process versions. This corrective effort used
only temp repositories/configuration and the demo; no real providers, downstream projects or
actual4477 deployment were operated. Outside actions now default to human-only approval.

**Environment (2026-10-21):** the user's install at `D:\SwitchYard` (config
`switchyard.config.yaml`, standalone-free preset, paid routing off), one Ollama Cloud key
(`free_tier`, free plan), projects `my-project` (`D:\my-app`) and `tetris` (`D:\SwitchYardTests`).
Claude Code reaches SwitchYard through a project `.mcp.json` at the repository root, excluded
from git locally (`.git/info/exclude`): the `claude mcp add --scope local` entry is keyed
`D:/SwitchYardRouter` while VS Code opens `d:\SwitchYardRouter`, so it never loaded.

**Verified live:**
- Ollama Cloud discovery: 22 models, exact parameter counts and contexts from `/api/show`.
- A standalone Tetris job (`t_0mviuxwvqa4f3a521f085`, supervisor on `ollama-cloud/beam`) completed
  in 47 s with 13 requests: it wrote index.html, style.css, game.js, README.md itself (no
  delegation), passed `node --check game.js`, and left the job branch for review. Played in
  headless Chrome: loads without errors (only a favicon 404), pieces, ghost, next preview, game
  over, and restart work. Merged into `D:\SwitchYardTests` master and served at
  http://127.0.0.1:8080 (python http.server, detached).
- `switchyard panel` started the real panel on 4477; pages answer 200.

**Fixed (all on dev):**
- f26f932: hosted Ollama has no `num_ctx`/`/api/ps`: use `model_info.<arch>.context_length`
  (every model had been "context limit unknown"). Adding or re-keying a key lists its models.
- cab760a, 77f2762: a 402 "not included in your free usage" or a 403 "being rolled out ... not yet
  available to you" is `not_in_plan` for that model, not the key out of credits or invalid (the
  first Tetris job failed because the key was disabled for six hours).
- 398f29f: routing leaves out a model every usable key's plan refused (preview and requests).
- 04a5616: status showed a supervisor's tier cap (12) instead of its profile cap (60): "14/12".
- Token accounting (user request): new input (input minus cached) is reported beside the total
  with cached, per task, in usage summaries, the panel, and the CLI. The Tetris job read 143k
  input tokens, 128k of them from Ollama's cache.
- 1ba099c panel auto-start: the MCP server and `switchyard worker` start the panel when
  nothing answers on `panel.port`; `switchyard panel`; MCP `panel` tool; URL in the server's
  instructions.
- Current follow-up (2026-10-22, uncommitted): user observed an Ollama Cloud 402 plan refusal
  shown as `waiting_for_capacity`. The existing HTTP classifier already recognizes the message
  as `not_in_plan`; the disposition layer incorrectly treats its shared `pool_exhausted` gateway
  kind as retryable capacity after fallback. The fix preserves fallback, then ends an exhausted
  model-plan refusal as `gateway_not_in_plan`. Separately, scheduler tick failures were silently
  swallowed and permanently stopped claims; the worker now logs and retries with bounded backoff.
  Focused validation: 39 tests across scheduler, provider errors, and project disposition pass.
  The optional LLM diagnosis for genuinely unrecognized provider messages is not implemented:
  these known status/code patterns remain deterministic, and any model-based diagnosis must use
  Gate and must never override authoritative HTTP/status/accounting facts. Router typecheck/build
  and the new execution regression pass. Two default-parallel full-suite runs each hit the
  120-second timeout in the existing long `task-recovery-retention.test.ts` case; it passed alone
  (10/10, 59.95 s). The full suite then passed with bounded parallelism:
  `npx vitest run --maxWorkers=2 --minWorkers=2` (107 files, 1,092 passed, 2 skipped).
- Supervisor submission incident (2026-10-22): SwitchYard job
  `t_0mvkcn4s2a693fac65bd2` surfaced a workflow defect while the user's requested clone work was
  active. The `inspect` worker had repository-only tools, so it searched for a *declared*
  Node version rather than obtaining the running runtime; it repeated overlapping searches and
  exhausted its 20-request execution budget before `submit_result`. A second inspect task had
  no command tool either and reported that limitation correctly in two requests. A later
  `implement` probe successfully ran `node --version` and `pnpm --version` in its first two
  command calls, but its first result cited check-log artifacts in unsupported
  `artifact:<id>#L<n>` form; `checkEvidenceRef` accepted only file refs. After reading the logs
  and submitting valid refs, verification treated
  the report-only implement task's zero-file diff as `output_contract` failure, escalated it, and
  the retry edited `package.json` despite the goal being only to report versions. This is the
  substantive failure: SwitchYard had the answer but its tool and task contracts prevented the
  answer from completing cleanly. Model size was not the primary cause.
  The first inspect task used 41 requests across its T1-to-T2 retry; the second used 3. The
  implement probe then used 20 requests in its T2-to-T3 retry path before cancellation.
  Task-level usage for the first inspect task showed 413,773 input / 14,400 output tokens and zero cached; the
  panel also showed 285,165 new input, which does not reconcile with total input and zero cached
  and remains a metrics discrepancy. The supervisor itself had an uncapped request pool.
  Fix: read-only tasks may run only exact checks declared in their brief (single repository),
  and their check result is retained for verification. The log can now be cited as `artifact:<id>`
  evidence. Inspector and supervisor instructions distinguish runtime queries from repository
  metadata and prohibit repeated searches when the necessary capability is absent. Shell remains
  policy-gated; no arbitrary shell access is granted. Regression test:
  `packages/router/tests/readonly-checks.test.ts` passes, including refusal of an undeclared
  compound command, exact `node --version` execution, and artifact-evidence acceptance. The
  existing `ollama-cloud` provider config
  has `promptCache: "none"`, so zero cached input is expected for that provider; this does not
  explain the inconsistent “new input” aggregate.
  The redundant version-probe child and clone parent were cancellation-requested; the installed
  worker was stopped to prevent further requests. The clone repository itself was left untouched.
- Repeat-loop follow-up (2026-10-23): the models could see prior tool results; the harness was
  executing exact duplicate calls before warning the model, so the warning alone could not stop
  wasted requests. The guard now canonicalizes JSON argument keys and stops stable exact repeats
  before execution, while explicit dynamic tools (`await_tasks`, budget requests) retain their
  own state-aware behavior. Successful edits/commands invalidate older signatures so a failed
  check can be retried after the workspace changes, but an immediate duplicate remains blocked.
  A live clone attempt exposed this edge: `pnpm build` failed, install succeeded, and the identical
  build was then incorrectly blocked; the invalidation fix covers it. That root job ended failed
  with `repeated_tool_call:run_check` after 68 model requests/75 tool calls. Its status could not
  be resumed because it was already failed. After the authorized MCP process restart, its tool
  catalog did not reconnect; the same configured SwitchYard install is being operated through
  the local CLI instead. Full router suite: 108 files, 1,096 passed, 2 skipped; typecheck and
  build passed. Fresh job `t_0mvkoxhjr81f88ce4245a` started from the empty `e307174` baseline
  with `pnpm test` and `pnpm build` declared as checks. Initial status: running, 3 execution
  requests, $0 reported, no child tasks yet; project-scoped worker PID 8508 is confirmed active.
  The fresh job failed after 46 model requests ($0 reported; no provider request failures): the
  scaffold session stopped on `repeated_tool_call:read_file`, and the supervisor stopped on
  `repeated_tool_call:delegate`. The guard prevented re-execution but its immediate stop made both
  tasks fail. The delegate transcript shows the model sent a JSON-stringified task array while the
  handler accepted arrays only, returning `tasks is empty`; the scaffold reread unchanged
  `package.json` after a successful read. The 13-file scaffold remains only in the failed,
  isolated SwitchYard worktree; the target repository is still the clean `e307174` baseline.
  Follow-up fix: delegate/plan parsing now accepts JSON-stringified object arrays with Zod
  validation; a first exact replay of a successful read/idempotent result returns the cached
  result and allows progress, while a further repeat still stops. Side-effecting calls remain
  protected. Initial timeline also showed two distinct undeclared supervisor environment checks
  and an undeclared `pnpm typecheck` in the scaffold task; they were refused without execution.
  Focused regression tests (28) and `pnpm -r typecheck` pass; the full Router suite is running.
  No job-wide request cap was added; paid routing remains off.

**Ollama Cloud free plan (probed 2026-10-21, one 1-token request per model):** included: beam,
minimax-m3.1-flash, nemotron-3-super, gpt-oss:120b (all >= 100B), gemma4:31b,
nemotron-3-nano:30b, gpt-oss:20b, nemotron-3-ultra (context unreported, so unused). Refused (402):
12 others. mistral-large-4: 403 rolling out. Plans change: SwitchYard rechecks a refusal after a day.

**Added 2026-10-21 (user requests, merged):**
- d735298: plan-refused models were shown as "quarantined" (a served-model violation); they now
  read "Not available with your keys" and only real violations quarantine.
- Panel power button and off switch: `<storage>/panel.stopped`; background checks leave a panel
  the user turned off stopped; `switchyard panel` and the MCP `panel` tool force a start; a new
  MCP session clears the marker but respects `panel.auto_start`.
- Project deletion behind two dialogs (counts, then type the slug); CLI `projects delete --confirm`.
  Request and spend rows are kept, unlinked; their per-task charges are deleted with the tasks so
  foreign keys hold (the worker's version suspended foreign keys; changed in review).
- MCP for Codex and ChatGPT: `switchyard mcp`, Streamable HTTP (`--http`, token off loopback, token
  also accepted as `/mcp/<token>` because ChatGPT cannot send headers). Codex verified with a temp
  `CODEX_HOME` (34 tools over stdio and HTTP); ChatGPT itself not tried (needs a tunnel).
- The panel build bundles the router (Turbopack follows the pnpm workspace link), so a router
  change needs `pnpm -r build`; `ensurePanel` and `doctor` now warn when the panel build is older.

**Pomodoro team job (2026-10-21, project `pomodoro`, `D:\SwitchYardProjects\pomodoro`):** first
live delegation. The supervisor (`beam`) planned 4 implementer tasks and a review; only the README
task succeeded (timer, tasks, review ran out of requests after escalating; the UI task failed on
its dependency), so the supervisor wrote the modules itself; 17 `node:test` tests pass. It left a
stray `EOF` line at the end of `app.js` (a ReferenceError in the browser) that the declared checks
could not catch; a follow-up implement task fixed it (accepted by the supervisor after its review
ran out of budget). Served at http://127.0.0.1:8081. Fixes from what the sessions showed:
- 347f068: empty listings say plainly that the directory is empty (models re-listed up to 5 times);
  an escalation after a spent budget starts from the unfinished work (a 199-line module had been
  lost); coding task types default to 16000 output tokens, capped by the models' output limits.
- d53fa57: the final request offers only the terminal tool (a reviewer kept exploring instead of
  submitting its verdict; Ollama ignores tool_choice).
- Still seen: models ask for a `bash` tool (none offered without `coding.allowed_commands`); the
  difficulty classifier's 300-token reply is cut off on small models (it falls back to defaults).

**Facebook clone (2026-10-21, project `facebook-clone`):** team job t_0mvj17lbebb112697ce31; workers did
store/auth, frontend, README; posts, friends, server failed on the old caps and the supervisor wrote
them. 45 tests passed but a browser run found two integration bugs between agents' parts (signup
started no session; the frontend read `likes` as an array while the API returns a count), each
fixed by a SwitchYard implement task (accepted after supervisor review, merged). Served at
http://127.0.0.1:8082. SwitchYard fixes from this run: request caps raised in presets and the
user's config (7537187), stall nudge and repeat note, path aliases, bare file refs; brain index
links (25cb632); classifier failure never escalates to T4, classifier output 600/item (82e0cb7);
review reserves raised (deep 12, strict 16; a deep review had a 2-request cap and no verdict).
Follow-up completed 2026-10-22 (1c7f965): the plan annotates later matching supervisor changes
on the recorded job branch, links evidence and preserves original failure/acceptance. It does
not assert independent verification of those later changes.

**Open:**
- Packaging for npm: `switchyard mcp` now exists; still no default config location, the panel is
  not in the package, and no one-step setup.
- R2 (Postgres, several hosts): parked; the user was asked whether to do it.
- Deleting a project while another process runs against the store is untested.
- A successful delegation-heavy run of the new budget/delegate-only policies remains unverified
  live. Pomodoro and Facebook clone already exercised delegation, but workers hit the old caps.

**Next steps:** a delegation-heavy live job and live caching checks (C1/C2 implementation is done).
Packaging and Labs decisions remain separately scoped; see handoff.md Remaining-work audit.

**Blockers:** none.

---

## Worker Briefs

### Brief: projects-delete-panel-power
- Repository: this repository; your own worktree on branch `feat/panel-controls`; run
  `pnpm install --frozen-lockfile` first. Two other workers edit other files at the same time.
- Task 1, delete a project (user request): router `previewProjectDeletion(sy, slug)` (counts:
  tasks, sessions, brain entries, worktrees) and `deleteProject(sy, slug, { confirm })`
  (`confirm` must equal the slug). Refuse while it has running or queued tasks, and refuse the
  last live project. Remove `projects.<slug>` through the config editor (backup kept); delete its
  per-project rows, session logs, artifacts, and SwitchYard worktrees (`git worktree remove`;
  keep branches); remove `projects/<slug>/` from the brain with a commit. Keep request, charge,
  and paid-spend rows for accounting (unlink them from the project). Never touch repository
  folders. New code in `src/projects/`, exposed through `src/admin/projects.ts`. CLI:
  `switchyard projects delete <slug> --confirm <slug>`.
- Task 2, panel: a Danger zone on the project settings page; "Delete project" opens modal 1
  (what is removed and what is kept, with the counts; Continue), then modal 2 (type the slug;
  red "Delete permanently"); `DELETE /api/projects/<slug>`; then go to `/`. Reuse
  `components/client/confirm-dialog.tsx`.
- Task 3, power button (user request) in the shell's top bar: a confirm dialog ("Agents keep
  running; the panel starts again when a new agent session begins or you run `switchyard
  panel`"); `POST /api/panel/stop` calls `markPanelStopped` (operations/panel.ts, on dev) and
  exits the process after responding; the page then shows a static "Panel turned off".
- Task 4, root cause: the panel build bundles router code although `next.config.ts` lists
  `switchyard-router` in `serverExternalPackages` (built chunks contain router strings), so a
  router change needs a panel rebuild. Make it external; if Turbopack cannot, make
  `ensurePanel` and `doctor` report a panel build older than the router's `dist/`.
- Owns: `packages/router/src/{admin/projects.ts,projects/**,operations/panel.ts,brain/**}`,
  `packages/router/src/cli/projects.ts`, `packages/router/tests/**` (new files or tests of these),
  `apps/panel/**` except the files the caching brief owns, `docs/operations.md`,
  `docs/working/reports/projects-delete-panel-power.md`.
- Must not touch: `src/{mcp.ts,cli.ts,cli/help.ts}` (put help text in your report), the
  caching brief's files, `docs/setup.md`, `docs/decisions.md`, this document.
- Definition of done: tests for refusal, confirm mismatch, what is deleted and kept, and the stop
  route; `pnpm -r typecheck`; full router suite; `pnpm -r build`; demo panel on a spare port
  (never 4477 or the user's config): both modals and the power button screenshotted at desktop
  and phone widths, light and dark; panel stopped afterwards.
- Report to: docs/working/reports/projects-delete-panel-power.md

### Brief: mcp-openai-clients
- Repository: this repository; your own worktree on branch `feat/mcp-clients`; run
  `pnpm install --frozen-lockfile` first. Two other workers edit other files at the same time.
- Task: make SwitchYard's MCP server usable from Codex and ChatGPT as well as Claude Code.
  Split `src/mcp.ts` into building the server and choosing a transport: stdio (default) and
  Streamable HTTP (`--http`, `--host` default 127.0.0.1, `--port` default 4478, path `/mcp`; a
  bearer token from `SWITCHYARD_MCP_TOKEN` is required whenever the host is not loopback,
  optional on loopback). Add `switchyard mcp [same flags]` to the CLI so an installed package
  needs no dist path. Check every tool's input schema suits OpenAI clients (no unsupported JSON
  Schema features; empty schemas are objects). No config-schema changes: flags and env only.
- Verify with Codex without touching the user's real Codex setup: the bundled binary
  `C:/Users/mrjoh/.vscode/extensions/openai.chatgpt-26.1007.21434-win32-x64/bin/windows-x86_64/codex.exe`
  with `CODEX_HOME` set to a temp folder: `codex mcp add` the stdio server on a temp test config,
  then `codex mcp list` and `get`. Make no model requests. ChatGPT needs a remote HTTPS URL:
  test the HTTP transport with the MCP SDK's Streamable HTTP client, and document the tunnel
  route and token for ChatGPT developer mode.
- Owns: `packages/router/src/{mcp.ts,cli.ts,cli/help.ts}`, new files under `src/` for the
  server split (not `operations/panel.ts`, which you only call), `packages/router/tests/mcp*.test.ts`,
  `docs/setup.md`, `docs/working/reports/mcp-openai-clients.md`.
- Must not touch: the other briefs' files, `docs/operations.md`, `docs/decisions.md`, this document.
- Definition of done: stdio and HTTP tests (tools listed, a call works, the token enforced off
  loopback); Codex lists the server with a temp `CODEX_HOME`; `pnpm -r typecheck`; full router
  suite; `pnpm -r build`; setup.md has Claude Code, Codex, and ChatGPT sections.
- Report to: docs/working/reports/mcp-openai-clients.md

---

## Work Ledger

### 2026-10-21 — first live runs, fixes as found
- Agent: senior supervisor (no workers)
- Changed: see Current State, Fixed.
- Why: the user's first MCP test (Tetris) failed; the user asked to fix SwitchYard while running it.
- Validation: `pnpm -r typecheck` (router and panel Done); `npx vitest run` `Tests 495 passed
  (495)`; panel build checked in a separate worktree for f26f932; live: model scan, plan probe,
  Tetris job completed, game played headlessly, `switchyard panel` started the real panel.
- Outcome: Accepted

### 2026-10-21 — quarantine fix, panel controls, project deletion, MCP clients
- Agent: workers projects-delete-panel-power and mcp-openai-clients; supervisor fixes
- Changed: see Current State and merges 0bbaaf4, 02cb358.
- Why: user requests (quarantine display, deletable projects, panel power, ChatGPT/Codex).
- Validation: both packages typecheck; `npx vitest run` `Tests 524 passed (524)`; worker panel checks
  on demo ports 4591 with screenshots (reviewed); Codex `mcp list`/`get` with a temp CODEX_HOME;
  live panel models page: 0 "Quarantined", 28 "Not available with your keys".
- Outcome: Accepted

### 2026-10-23 — stop exact repeat calls and recover the clone run
- Agent: senior supervisor
- Changed: `packages/router/src/harness/loop.ts`, tool repeat policies, runner/verification
  propagation, related regression tests, and the live-run error handling documented above.
- Why: the clone supervisor repeated a failed `run_check` despite having its output, consuming
  requests without progressing; the user asked to fix the loop rather than cap the job.
- Validation: full Router suite, 108 files / 1,096 passed / 2 skipped; `pnpm -r typecheck`;
  `pnpm -r build`; `git diff --check` passed before adding the ledger and will be rerun after it.
- Outcome: repeat guard validated; fresh clone job `t_0mvkoxhjr81f88ce4245a` started and is being
  monitored. It failed before completing any task; its isolated scaffold was not merged into the
  target repository.

### 2026-10-23 — fresh clone job checkpoint
- Agent: senior supervisor
- Changed: no clone files in the source repository; SwitchYard writes only to its isolated job
  worktrees. Recorded the new runtime findings above.
- Why: verify the exact-repeat guard and watch the requested fresh clone job without imposing a
  job-wide request cap.
- Validation: CLI job/session/metrics inspection confirms the root remains based on `e307174`;
  after 46 requests the job failed before any task completed. Two identical-call stops were
  observed; the tool calls were not re-executed. Three distinct undeclared `run_check` commands
  were refused. Reported cost $0; paid routing remains off.
- Outcome: failed; no clone acceptance, tests, build, or browser behavior verified.

### 2026-10-23 — recover from cached-read and serialized-delegation failures
- Agent: senior supervisor
- Changed: `src/harness/loop.ts` now gives one cached replay of a successful replay-safe tool call
  before stopping further repeats; `src/harness/supervisor-tools.ts` parses model-stringified task
  and plan arrays with Zod. Added regression tests in `tests/native.test.ts` and
  `tests/budget-control.test.ts`.
- Why: the live job failed when one repeated successful read immediately failed the scaffold, and
  model-encoded `delegate.tasks` as a string caused an empty-array error followed by repeated
  delegate calls.
- Validation: focused tests in `native.test.ts` and `budget-control.test.ts` pass (28); recursive
  typecheck passes. Full Router suite is running; build and final diff checks remain.
- Outcome: fix is focused-tested; fresh job restart is pending full validation.

---

## Open Questions

- Packaging: should the panel ship inside the npm package (prebuilt standalone) or as a second
  package? See Open in Current State.
