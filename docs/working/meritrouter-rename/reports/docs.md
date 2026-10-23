# Authored documentation report

Status: complete; owned source documents frozen for supervisor review.

## Changes

- Added `docs/README.md` as a goal-based documentation map.
- Updated setup with a short first-run path, source and locally built package options,
  prerequisite/pnpm checks, exact CLI/config/project/MCP paths, UI provider-key steps,
  bounded read-only first task, security expectations and symptom-based troubleshooting.
- Added `Upgrading from SwitchYard` at the root README's requested anchor. It requires
  stopping old processes, preserving resolved state/key/brain/repository paths, explicit old
  config selection, legacy database fallback, environment replacement, service/MCP
  re-registration and client reconnection. No automatic user-data move or npm publication
  is claimed. Historical Git refs/worktrees remain intact.
- Renamed current public contracts in setup, roles, operations and decisions. Added reading
  orientation/navigation to roles and operations; retained detailed reference contracts.
- Removed obsolete external-runner setup/containment advice and marked historical external
  session evidence and original checkout-only packaging decisions as historical.
- Preserved dated provider evidence and sources without asserting new prices/availability.
  Remote MCP guidance now describes our transport without promising a changing client UI.

## Validation observed

- Read CLI argument handling/help, config discovery/path resolution, package engine/scripts,
  presets and storage database filenames. Confirmed canonical `meritrouter` package/bin,
  `MERITROUTER_*`, explicit config/project handling, package build and legacy DB contract.
- Local script checked all five owned docs: balanced fenced code blocks and existing relative
  Markdown link targets. Passed.
- `git diff --check -- docs/setup.md docs/roles.md docs/operations.md docs/decisions.md docs/README.md`
  passed; only repository line-ending normalization warnings appeared.
- No build, provider/network request, user-data access, package install or client/service
  registration was run. No source files changed and no commit made.

## Supervisor checks / limitations

- Clone URL is the intended `aidens113/MeritRouter` URL; supervisor owns hosted rename and final
  verification before publication.
- Client registration commands retained from the existing guide and renamed; not exercised
  against installed Claude/Codex clients. Source build/package acceptance belongs to supervisor.
- Existing long reference sections remain below onboarding rather than being discarded.

## Final read-only onboarding audit

Inspected root README, package README, docs index/setup and CLI/config/vault/package-build
contracts during supervisor's frozen full-suite run. No shared docs/source changes made.

- All documented relative local link targets and heading anchors across those four entry
  documents resolve (checked with a local Markdown heading/link script).
- Top prompts state client supervisor ownership, bounded delegation, paid-off, human approval
  and credentials in the panel. No invented npm release or global install-from-registry claim.
- Root source commands and installed package README commands are correctly distinguished.
  Main setup needs one explicit rule replacing source CLI invocations with `meritrouter` for
  installed users, so subsequent examples do not imply the checkout is still required.
- Migration now sets the runtime master-key environment before opening the old installation.
  Remaining ordering issue: pin omitted legacy storage/brain defaults before the displayed
  `doctor` command, not after it; doctor can prepare repositories/open state.
- Clarify that runtime `SWITCHYARD_*` variables are renamed, while arbitrary provider
  `api_key_env` names must either remain unchanged or be updated in configuration and
  environment together. Blind environment-only renaming can make configured keys disappear.
- Root copyable prompt's “Read its README and docs/setup.md” can refer to downstream project
  docs when pasted there. Identify the MeritRouter checkout/documentation explicitly.
- Source examples using POSIX environment assignment/background `&` are fenced bash; separate
  PowerShell panel setup is provided. MCP examples use absolute paths. A short reminder that
  bash-fenced optional daemon/job commands need PowerShell equivalents would aid Windows users.
- Intended GitHub URLs remain supervisor's pending final hosted rename verification.

Actionable items above sent to supervisor; no tests, installs, network or provider calls run.

## Bounded demo seed follow-up: diagnosis

Read the nested scripted fixture, its explicit operator/historical clock, and raw SQLite plus
JSONL evidence under `apps/panel/.demo` without constructing a service or mutating the DB.

- Parent `t_0mvlgcu3rac8eb623ddb5` and child `t_0mvlgd25529f1fb841b6e` completed/met.
  Child mean worker `t_0mvlgd8shd3388e3bb3b5` instead completed/needs_supervisor:
  final check action `wa_0mvlgdfia5d39d310e889` was cancelled with
  “Original task authority ended before execution”; its check artifact records cancellation.
- Child await_tasks returned both completed workers, not an early pending result. Integrating
  mean then failed on needs_supervisor. Integrating range succeeded with both helper commits;
  the script falsely reported a rebase and finished. Parent integration therefore produced
  two genuine integrations and zero rebases, correctly failing fixture assertions.
- Cause: `harness/supervisor-tools.ts` await_tasks constructs `WorkerActionRequests(s.db)`
  without injected `s.ctx.now`. Listing pending actions reconciles historical live leases
  against real time and cancels them. Fixture operator itself correctly passes `clock`.
- Sent supervisor the diagnosis and seed-only workaround proposal (wait bounded real child
  completion in scripted provider before emitting await_tasks), while recommending an actual
  narrowly owned runtime clock fix instead of masking that injected-clock defect.

No seed edit yet: supervisor must signal original seed process exited and choose the remedy.

### Proposed proper runtime fix (prepared read-only)

Supervisor authorizes runtime remediation after the frozen full suite, owned by security
worker. Exactly two constructors occur in `harness/supervisor-tools.ts`, both inside
`await_tasks` (current lines 646 and 649). Change each:

```diff
-new WorkerActionRequests(s.db)
+new WorkerActionRequests(s.db, s.ctx.now)
```

Both paths matter: the first is the loop's early-return predicate; the second projects actions
into the tool result and can cancel a request even if the first predicate short-circuits.
Keep `Date.now()` for elapsed wait timeout calculations; those measure real wall time and must
not become an injected/frozen task clock.

Regression design: create a supervisor plus worker using an injected time well before real
wall time, with live leases/deadlines relative to that injected time. File an exact worker
check request and invoke the actual supervisor `await_tasks` tool. Assert early returned output
contains its action ID/decision guidance, the persisted request remains pending (not cancelled),
and an explicit fixture operator using the same injected clock can approve it and obtain real
exit-zero check evidence. Cover both constructor paths, including already-completed target IDs
while another owned pending action exists, so the loop short-circuit cannot hide the second
constructor. Retain stale/expired lease cancellation coverage using an advanced injected clock.

Seed follow-up after process exit: detect failed `integrate_task` outcomes before emitting
success/rebase claims; fail the offline fixture with actual tool error details. Do not silently
accept failed checks, fabricate rebase evidence, or bypass the runtime wait operation.

### Clock-fix child seed: rounding timeout diagnosis

Read-only raw SQLite/JSONL inspection of the closed clock worktree demo database. No service
construction, DB mutation or source edit. Nested fixture now passed 3 integrations/1 rebase.

Rounding task `t_0mvlgsz3md52ebf7c94de` was running, not queued or blocked on provider
admission. Classification, T2 analysis and deliberately failing review consumed roughly 49s.
T3 escalation began around 49s and issued successful model/read_file intent around 54.7s.
The phase's default 60-second wait expired before that read completed. Seeder then advanced
its historical offset from 1.6h to 1.4h, jumping injected time forward 720000ms while the
task's lease lasted only 30s. Its read intent at 1792784172590 and successful outcome at
1792784898010 differ by 725420ms: exactly that jump plus 5420ms real work. Session then ended
with lease lost; task became interrupted/worker lease expired. No AIMD/provider-slot deadlock
evidence was present. Concurrent validation IO timing likely caused the initial 60s overrun.

Recommendation sent to supervisor: phase must never advance the shared clock with unfinished
tasks. On timeout fail/stop the fixture, or explicitly cancel and settle the old phase before
moving time. Merely increasing waits can hide the lifecycle flaw. If preserving the expected
false-rejection calibration evidence, completion must be asserted rather than silently skipped.
