# Fix: supervisor startup waits for a known active_command instead of failing (Cause 3)

Worker: fix_supervisor_command_wait (worker). Branch dev, main checkout. No commits (lead commits).

## Outcome

Partial. Option (a) is implemented exactly as decided and verified for the one-off-command
scenario (`active-validation-ownership.test.ts`, 18/18 including a new test). `labs-scripted.test.ts`
cannot be made to pass within this brief's ownership boundary: its conflict is not a timing race
but a structural one (a Lab's own persistent service), which option (a) cannot fix without
touching `src/labs/**` (explicitly forbidden). This is reported below as a distinct finding for
the lead, not silently worked around.

## What changed and why

**`src/workspaces/repository-command.ts`**: added `soleActiveRepositoryCommand(repo)`, exported.
It re-scans the same `meritrouter-commands/active` directory `assertNoActiveRepositoryCommand`
scans, and returns `{ id, createdAt }` only when there is exactly one active receipt, it parses
cleanly, and its `ownerPid` is currently alive on this host (via `process.kill(pid, 0)`). Anything
else — no active directory, more than one active command, a parse/scan failure, or a dead/foreign
owner — returns `null`. This is the "known, live, owned" test from the brief, built directly from
the fence's own data so the wait-decision can never diverge from what the fence itself would
refuse on. No existing behavior of `assertNoActiveRepositoryCommand` changed.

**`src/runners/supervisor.ts`**: `integrationRepos`'s top-level `withRepositoryMutation(requested, …)`
call (the one that throws today, confirmed by a reproduction trace — see below) is now wrapped by
a new `awaitingActiveCommand(ctx, requested, attempt)`. On a `RepositoryMutationError` of kind
other than `active_command`, or an `active_command` for which `soleActiveRepositoryCommand` finds
no known/live/owned receipt on any requested path, it rethrows immediately — unchanged behavior.
Otherwise it:
- records `ctx.tasks.event(ctx.taskId, "supervisor_awaiting_active_command", { repo, commandId })`
  once per distinct command id (durable, queryable progress), and calls `ctx.session?.note(...)`
  each poll (advances the progress watchdog's last-event time when a session exists, so a
  legitimately bounded wait does not look stalled);
- honours `ctx.signal`: an abort during the wait rejects with the *original* `active_command` error
  rather than hanging;
- polls every 250ms, retrying the whole admission attempt, bounded by a 60s cap
  (`ACTIVE_COMMAND_SETTLE_CAP_MS`) — this layer has no visibility into the blocking command's own
  deadline/lease (`CommandRecord` carries no deadline field), so per the brief this is "a clear cap
  if none": a fixed, documented constant;
- on cap timeout, rethrows the *original* `active_command` error, exactly as the brief specifies.

The fence (`assertNoActiveRepositoryCommand`, `withRepositoryMutation`) is untouched. No other
refusal kind is retried. Worktree creation is not exempted — it is still refused immediately when
the active command is uncertain/foreign, and it still runs inside the same admission scope once
the known command settles.

**`tests/active-validation-ownership.test.ts`**: the "actual supervisor cannot cancel approved
validation…" test was restructured (assertion was genuinely wrong for the new behavior — explained
below), and one new test was added.

## Why the existing test needed restructuring (not just a retry)

I ran the unmodified test first and traced the exact throw site:
`assertNoActiveRepositoryCommand src/workspaces/repository-command.ts:65` →
`validateOwners repository-mutation.ts:72` → `repository-mutation.ts:150` →
`SupervisorRunner.run supervisor.ts:204` → the test's own `run()` call, at **1761ms** — i.e. it
fails before the agent loop (and thus before any model turn) ever runs.

The test's narrative released the long-running command only from *inside* the mocked model's
third turn (`f.release()` was called from within the scripted callback that only fires once the
agent loop is running). But the agent loop cannot start until `integrationRepos` resolves, and
`integrationRepos` cannot resolve until the command settles — releasing it from inside a model
turn that cannot run yet is a genuine, unbreakable circular dependency under option (a)'s design
(the wait happens once, synchronously, at startup, before any model turn). I confirmed this is not
a transient timing issue: with the fix applied but the test unmodified, the run *does* eventually
get past admission — but only via the command's own native ~10s helper timeout killing the
process (observed total test time ≈12.2s, i.e. 10s kill + agent-loop overhead), which settles the
receipt but leaves the command's outcome as a forced kill, not the graceful `exitCode: 0` the test
expected, and leaves the `worker_action_requests` row no longer "running" by the time the model's
first turn runs — so `cancel_tasks`'s "operator-approved and running" refusal (which the test
relied on from *inside* the agent loop) no longer applies either.

The fix: moved the "cannot cancel while approved+running" assertion to a direct `f.cancel()` call
*before* invoking `SupervisorRunner.run()` (the same pattern the file's own "refuses
operator-approved running execution…" test above it already uses, so it does not depend on
integration/admission at all). Then scheduled `f.release()` from a `setTimeout` *outside* the
agent loop, immediately after `f.ready()`, so the command settles gracefully and quickly (within
one or two 250ms polls) rather than waiting out its native timeout. The remainder of the test
(finish-blocked-while-children-running → "continue await_tasks until they settle" →
`tasks.finish` → completed) is unchanged in substance, just renumbered (`step` goes from 3 to 2
turns, since the cancel attempt is no longer one of them). The new comments in the test explain
this chain.

Added a new test, `"does not wait on an uncertain admission refusal; only a known active_command
waits"`: spies on `withRepositoryMutation` (same pattern as `approval-execution-timeout.test.ts`
spying on `git`) to reject once with a synthetic `command_uncertain` `RepositoryMutationError`,
and asserts `SupervisorRunner.run()` rejects in well under 5s with that same error, calling
`withRepositoryMutation` exactly once (no retry).

## Cause 3 is two different problems under one symptom; only one is fixed here

Both `active-validation-ownership.test.ts` and `labs-scripted.test.ts` throw from the exact same
line (`integrationRepos`'s outer `withRepositoryMutation` call), so I initially assumed one fix
would cover both. It does not:

- **One-off command (fixed):** an approved validation command runs *directly in the source
  checkout* this job also needs; it will finish (or be killed by its own timeout) in finite time.
  Waiting is correct and the test now proves it.
- **Lab-rooted job vs. its own persistent service (not fixed, out of scope):** I instrumented
  `integrationReposLocked`'s Lab branch (`ctx.lab.rootJobId === ctx.taskId`, supervisor.ts ~143)
  and confirmed the throw happens in the *outer* call, before that branch's own inner
  `withRepositoryMutation` ever runs — because for a Lab's root job, `ctx.cfg.repositoryPaths`
  (via `labConfiguration`) already points `sources` at the Lab's worktree, so the outer
  admission conflicts with whatever is active there. In `labs-scripted.test.ts` that is the Lab's
  own `"web"` **service** (`kind: "lab-service"`), started by `owner.start()` *before*
  `sy.startJob()` runs, and it is deliberately long-lived: it is not released by anything during
  the test, so it never "settles" on its own. I confirmed empirically that with the fix applied,
  the wait consumes its full 60s cap and the job is still "running" when the test's own 60s
  `awaitResults` window elapses (ran to completion at 68.6s, failing on `outcome.pending` having
  length 1 instead of 0 — i.e. it got slower, not fixed).

  `LabManager` already has the right mechanism for this — internal Lab operations pass their own
  services' `RepositoryCommandPermit`s via `LabRepositoryCommands`/`withRepositoryServiceStatus`
  so they never trip this fence against their own known services. But those permits are opaque,
  module-private objects; nothing exposes them (or the underlying `RepositoryServiceCommand`
  handles) to `src/runners/supervisor.ts`, and the only place that could add such an accessor is
  `src/labs/lab.ts` / `src/labs/binding.ts` — both on the "must not touch" list for this brief.
  Waiting cannot substitute for this: a persistent service is, by design, never going to "settle".

  **This needs a follow-up brief that includes `src/labs/**`**, to either (a) expose the Lab's own
  active service-command permits through `LabRunContext` so `integrationRepos`'s Lab branch can
  pass them as the `command` option (the existing, narrow exemption mechanism — not a new one),
  or (b) a different policy decision from the lead for this sub-case.

## Commands run and observed results

- `npx tsc --noEmit` → exit 0, clean.
- `npx tsc -p tsconfig.build.json` → exit 0; rebuilt `dist/` (some fixtures in this suite run
  `dist/cli.js`, confirmed via the R1 acceptance test below).
- `npx vitest run tests/active-validation-ownership.test.ts` → **18/18 passed** (17 original + 1
  new), ~25.9s. The target test itself now takes ~2.4s (previously it either threw at ~1.8s
  unmodified-but-unfixed, or would have taken ~10s+ to clear admission via the native kill path
  before I restructured it).
- `npx vitest run tests/supervisor-lifecycle.test.ts tests/resilience.test.ts` → **57/57 passed**
  (46 + 11), ~126s.
- `npx vitest run tests/labs-service.test.ts tests/labs-compose-validation.test.ts tests/project-local-labs.test.ts`
  → 30/30 passed (extra check beyond the brief's list, since my change sits on every
  `SupervisorRunner.run()` startup; no regression).
- `npx vitest run tests/supervisor-startup.test.ts tests/lab-supervisor.test.ts tests/supervisor-human-approval-wait.test.ts`
  → all passed. `npx vitest run tests/supervisor.test.ts` → 2/3 passed; "serialises overlapping
  coding briefs through file leases and asks the user when needed" fails
  (`expected undefined to match object`, a missing `ask_user` question). **Confirmed pre-existing
  and unrelated**: I temporarily restored `supervisor.ts` and `repository-command.ts` to the
  committed HEAD content (via `git show HEAD:<path>` into the working file, not `git checkout`),
  re-ran the same test — identical failure at the identical line — then restored my edits from a
  byte-for-byte backup and re-verified `tsc --noEmit` and the active-validation suite both still
  pass. This failure is not touched by my change.
- `npx vitest run tests/labs-scripted.test.ts` → **still fails**, now at 68.6s instead of ~11s
  (`outcome.pending` has length 1, not 0 — the job is still "running" when the test's own
  `awaitResults` 60s window elapses). Root cause explained above; out of scope for this brief.

No provider/network calls were made; `fixture`/`makeEnv` use only temp directories.

## Not verified

- `labs-browser.test.ts` (~182s per the prior report) was not re-run; nothing in my change touches
  browser-check paths, and it does not create a persistent service before `startJob`, so I expect
  no regression, but this is inference, not an observed result.
- `labs-task-prune.test.ts` / `labs-task-attempt.test.ts` were not re-run here; they were verified
  by the prior worker (fix_lab_lock) and my change does not touch `src/labs/**` or
  `task-attempt-*.ts`.
- `pnpm -r build` / full `pnpm -r typecheck` (monorepo-wide) was not run; only the router package's
  `tsc` checks were, per the brief's acceptance list. Other agents have uncommitted work in
  `apps/panel/**` and `packages/router/src/admin/insights.ts`; I did not touch or read those.
- I did not verify behavior on a non-Windows host (the `activeRepositoryCommandOwner`/
  `soleActiveRepositoryCommand` liveness check uses `process.kill(pid, 0)`, which is documented as
  portable for an existence probe, but all testing here was on Windows).
- The 60s cap and 250ms poll interval are my own choice (the brief said "a clear cap if none");
  I did not get the lead's sign-off on the exact numbers.

## Open questions or contradictions found

- **labs-scripted.test.ts cannot pass without a `src/labs/**` change** (see above). I left it
  untouched since neither the fix nor a test edit can close this within my owned paths, and
  touching `src/labs/**` is explicitly forbidden by this brief. Recommend a follow-up brief for
  whoever owns `src/labs/**` to expose the Lab's own active service permits to
  `LabRunContext`/`integrationRepos`'s Lab branch, or an explicit lead decision to treat this
  sub-case differently (e.g. the Lab's root-job startup should always be exempt for its *own*
  already-known services specifically, which is narrower than "exempt worktree creation" and uses
  the fence's existing permit mechanism rather than weakening it).
- The original test's assertion about cancel refusal "while running" could only be preserved by
  moving it outside the agent loop (see above); I'm confident this is a genuinely-wrong assertion
  under the new semantics (not a judgment call I made lightly), but flagging it explicitly since
  the brief asked me to explain any such change.

## Return contract

Outcome: Partial
Changed: `packages/router/src/runners/supervisor.ts`, `packages/router/src/workspaces/repository-command.ts`, `packages/router/tests/active-validation-ownership.test.ts`
Validation: `npx vitest run tests/active-validation-ownership.test.ts` -> 18/18 passed; `npx vitest run tests/supervisor-lifecycle.test.ts tests/resilience.test.ts` -> 57/57 passed; `npx tsc --noEmit` -> clean; `npx tsc -p tsconfig.build.json` -> clean; `npx vitest run tests/labs-scripted.test.ts` -> still fails (structural, out of scope — see report)
Not verified: labs-browser.test.ts, labs-task-prune/attempt.test.ts (not re-run), monorepo-wide `pnpm -r build`/`typecheck`, non-Windows behavior of the new liveness check
Report: docs/working/project-local-storage/reports/fix-supervisor-command-wait.md
Notes: labs-scripted.test.ts needs a src/labs/** change (exposing the Lab's own active service permits) to pass; option (a) alone cannot settle a deliberately persistent Lab service. Everything else in the brief's acceptance list is green.
