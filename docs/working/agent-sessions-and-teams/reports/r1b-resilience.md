# Report: r1b-resilience

Worker report for "Brief: r1b-resilience" in [agent-sessions-and-teams.md](../../agent-sessions-and-teams.md).
Worktree `D:/sy-wt/r1`, branch `feat/r1b-resilience`. Nothing was committed.

## Outcome

Done. All three deliverables are in, with tests:

- **Progress watchdog.** A stuck run is aborted, its session ends `interrupted` with stop reason
  `watchdog`, and the task is queued again. The next run resumes the same session through S2.
- **Per-provider circuit breaker.** It lives in `ProviderHealth`. Routing ranks platforms with an
  open breaker after cooling ones, and the gate skips them. Its state is visible through
  `insights.providerHealth`.
- **R1 acceptance test.** A real `dist/cli.js worker` child process is killed with
  `taskkill /T /F` while it waits on a model request. A second worker process, started on the same
  storage, finishes the task by resuming the same session, and the edit is made once.

Validation:
- `pnpm --filter switchyard-router build` passes.
- `pnpm -r typecheck` passes for both the router and the panel.
- `npx vitest run tests` passes 181 of 181: the 170 existing tests plus 11 new ones.
- Some full-suite runs on this machine had timing flakes in other test files. The same flakes
  happen with my test file excluded. See "Commands run".

## What changed and why

**`src/config/schema.ts`** (execution and routing keys only)
- `execution.watchdog_minutes`: default 10; 0 turns the watchdog off; fractions are allowed.
- `routing.circuit_breaker`:
  - `enabled`: default true;
  - `failure_threshold`: default 5;
  - `open_seconds`: default 30;
  - `max_open_seconds`: default 900.
- Both keys have defaults, so existing configs and presets still parse. The presets were not
  regenerated.

**`src/gateway/breaker.ts`** (new; `src/gateway/**` is mine)
- `countsAsProviderFailure(err, coolingReported)` decides which failures count:
  - always: `server`, `timeout`, `transport`;
  - `rate_limited` and `pool_exhausted` with status 429, 5xx, or no status: only when FreeLLMAPI
    has not reported a cooldown for the platform. This is my reading of "429 after cooldown".
  - never: 4xx, auth, unknown model, `policy_violation`, `aborted`. Invalid model output never
    reaches the gate as an error, so it cannot count either.
- `openDurationMs`: `open_seconds` doubled on each consecutive opening, capped at
  `max_open_seconds`.
- `CircuitBreakers`, one per platform (`ep.providerId`), covering both chain and direct routes:
  - **closed:** counted failures add up, and any success resets them. Reaching the threshold opens
    the breaker.
  - **open:** `admit()` returns false until `openUntil`. After that, the next `admit()` moves to
    half-open and takes the single probe.
  - **half-open:** a second caller is refused while the probe is in flight. A failed probe re-opens
    with a doubled backoff. A successful probe closes the breaker and resets `opens`. `release()`
    frees the probe slot when the request was aborted or skipped.
- State is kept in memory and mirrored to `meta` under `circuit:<platform>`, validated with zod on
  read (`readBreakerRecords`). Two reasons:
  - the panel runs in a different process from the worker;
  - a restarted worker keeps an open breaker. A half-open probe that was in flight comes back ready
    to probe.
- Settings are read live through a getter, because a config reload mutates `cfg` in place.

**`src/gateway/gate.ts`**
- `ProviderHealth` changes:
  - it owns `breakers`;
  - `lookup()` now also returns `circuitOpenUntil` while a breaker is open or its probe is in
    flight;
  - new `recordOutcome(platform, err | null)`. Any answer from the provider (including a 4xx)
    counts as success, an abort releases the probe slot, and a cooling 429 is neutral.
- `Gate` changes:
  - its constructor attaches the breakers to the database and to `cfg.routing.circuit_breaker`.
    No change was needed in `service.ts`.
  - Each candidate takes `admitted(ep)` right before it is reserved and dispatched, so a skipped
    candidate never holds the probe slot. This applies to chain routes and, after key selection,
    to direct routes.
  - An open breaker records the attempt `skipped: circuit open for <platform>`. A failed
    reservation releases the slot.
  - Outcomes go to `recordOutcome`.
  - If nothing was dispatched and a breaker was among the reasons, the gate throws
    `GatewayError("rate_limited", ..., retryAfterMs = time to the next probe, possiblyConsumed=false)`.
    The executor already defers that for capacity, so the task waits instead of failing with
    `no_eligible_endpoint`.

**`src/routing/select.ts`**
- `ProviderHealthLookup` can return `circuitOpenUntil`.
- `CandidateExplanation.circuitOpenUntil` is a new field. The change is additive, and the panel
  typecheck still passes.
- Ranking order: healthy platforms first, then cooling ones, then platforms with an open breaker.
  Open-breaker platforms are demoted, not excluded, which matches how cooling platforms are
  handled. The gate does the actual skip. Once the backoff has passed, the platform is no longer
  demoted, so the next request becomes its probe.

**`src/core/watchdog.ts`** (new file; see Open questions 1)
- `sessionProgress(db, sessionId)` reads the last indexed event (type, name, `at`) and
  `sessions.updated_at`. It uses the SQLite index, not the log file.
- `watchdogVerdict(cfg, progress, now, {checks})` works on fake time and returns one of
  `disabled`, `exempt`, `ok`, or `stuck` (with `idleMs`, `allowanceMs`, and `waitingOn`).
  - The base allowance is `watchdog_minutes`.
  - Work that has its own timeout extends the allowance to `max(base, bound + 60 s)`. The bounds:

    | Last event | Bound |
    | --- | --- |
    | `model_request` (pending) | `request_timeout_seconds × (max_endpoint_fallbacks + max_paid_attempts)` |
    | `tool_intent` with no outcome | `check_timeout_seconds` |
    | `model_response` (its tool calls are running; also covers an external agent's in-process tools) | `check_timeout_seconds` |
    | any other event while the task has checks (final checks run without being journaled) | `checks × check_timeout_seconds` |

  - A `tool_intent` for `await_tasks` or `ask_user` is exempt.

**`src/core/executor.ts`** (the watchdog hook)
- `AbortReason` adds `"watchdog"`, and `WATCHDOG_STOP` is exported.
- `runSingle` registers the run in a `watched` map, with a getter for the current session. The run
  is removed from the map in `finally`.
- New `checkWatchdog()`. For each watched run with a live session that is `stuck`, it writes a
  `watchdog_abort` task event (`sessionId`, `idleMs`, `allowanceMs`, `waitingOn`) and calls
  `controller.abort("watchdog")`.
- From there the existing abort path handles the run:
  1. `classify` returns `abandon: watchdog`.
  2. `endForDisposition` ends the session `interrupted` with stop reason `watchdog`.
  3. `settle` calls `requeueStuck`, which does `tasks.interrupt`, then `tasks.resume(id, {sessionId})`
     while `run_count < MAX_AUTO_RESUMES`. The cap stops a run that keeps getting stuck from
     looping.
- Batch runs are not watched. They make one request, which the gateway timeout already bounds.

**`src/core/scheduler.ts`**
- `MAX_AUTO_RESUMES` is exported.
- `tick()` calls `executor.checkWatchdog()` before `recoverExpiredLeases()`.

**`src/admin/insights.ts`** (provider health view only)
- New `providerHealth(sy)` returns:
  - `providers`: the FreeLLMAPI status;
  - `breakers`: the records from the store, merged with this process's own records when those are
    newer, each with:
    - `effective`: `closed`, `open`, `probe_due`, or `half_open`;
    - `probeInMs`;
  - `settings`.
- It is exported through `insights.*` in `src/index.ts`. I did not change the panel.

**`tests/resilience.test.ts`** (new, 11 tests)
- **Breaker (3 tests):**
  - the counting table;
  - the full transition sequence on a fake clock: threshold, open, probe due, one probe only,
    failed probe doubles the backoff, the cap, release, and close on success;
  - persistence to `meta`, read back by a second instance, and `enabled: false`.
- **Routing:**
  - Ranking: openrouter (healthy), then mistral (cooling), then groq (breaker open), with
    `circuitOpenUntil` in the explanation.
  - Gate, end to end with summarize tasks and a fake clock:
    - groq returns 502 three times and falls over to openrouter;
    - with groq's breaker open, groq is ranked last and never dispatched;
    - a plan computed before the breaker opened still has groq first, and the gate records
      `skipped: circuit open for groq`;
    - `insights.providerHealth` shows `open` with failures 3;
    - after +31 s, the probe goes to groq, succeeds, and closes the breaker.
  - When every candidate's breaker is open, the request fails `rate_limited` with
    `retryAfterMs` > 25 s instead of failing outright.
- **Watchdog (4 tests):**
  - Three pure `watchdogVerdict` tests on fake time:
    - the base allowance;
    - extensions for a tool, a pending request, a response, and final checks;
    - the exemptions, and 0 turning it off.
  - One integration test with `now = Date.now() + offset`, lease 3600 s, and a client whose
    second request hangs until it is aborted:
    - at +9 min the task is still running;
    - at +11 min it is aborted, then resumed in the same session and completed;
    - ended events are `[interrupted/watchdog, completed/worker_submitted]`;
    - one `resumed` event;
    - the aborted request is logged as `model_error` `gateway:aborted`;
    - task events include `watchdog_abort` (`waitingOn: "model request (tool_loop)"`),
      `interrupted`, `resumed`, and `session_resumed`;
    - 3 requests in all.
- **R1 acceptance (real processes, about 12 s):**
  - Setup:
    - an in-test HTTP FreeLLMAPI double (`GET /v1/providers`, `POST /v1/chat/completions`, with
      `x-routed-via` set);
    - a native-coding `implement` task with a check, submitted from a non-worker `Switchyard`;
    - lease 10 s.
  - Steps:
    1. Worker 1, `node dist/cli.js worker --config <temp>`, runs `replace_in_file`. Its second
       request is held open.
    2. The test asserts the session journal has one `replace_in_file` intent and 2 model requests,
       with `model_request` as the last event.
    3. The test runs `taskkill /PID <pid> /T /F` (SIGKILL on other platforms), confirms the task is
       still `running`, and waits for the lease to expire.
    4. Worker 2 starts and finishes the task.
  - Assertions:
    - one session id, the same as before;
    - ended stop reasons `[process_died, worker_submitted]`;
    - one `resumed` event, which dropped the lost request;
    - one `replace_in_file` intent;
    - `export function subtract` appears once in the worktree;
    - exactly 3 chat requests in all;
    - acceptance `met`, and the check exits 0.
  - The test skips when `dist/cli.js` is missing; the reason is in the test name.
  - Workers are spawned with `windowsHide`, `FREELLMAPI_API_KEY=test-key`, and
    `SWITCHYARD_FAULT_AT` removed. All storage is in temp directories, and the brain is
    `brain/` inside the temp directory.

## Commands run and observed results

- `npx tsc --noEmit -p .` after each edit group: no output.
- `pnpm --filter switchyard-router build`: `tsc -p tsconfig.build.json`, no errors.
  `dist/cli.js` was rebuilt before the kill test.
- `pnpm -r typecheck`: `packages/router typecheck: Done`, `apps/panel typecheck: Done`.
- `npx vitest run tests/resilience.test.ts`:
  - First run: 2 failures, both in my tests:
    - the summarize reply was not the JSON the completion runner needs (`invalid_output`);
    - I wrongly expected a dropped request, but the aborted request is logged as `model_error`.
    The kill test passed on that first run.
  - Next run: the breaker test expected a gate skip, but routing had already demoted groq. I fixed
    the test to assert both behaviours.
  - After that: 11 of 11 passed, three runs in a row (15.5 s, 16.6 s, 23.4 s).
- Full `npx vitest run tests`:
  - Several runs: 181 of 181 passed, including the final run.
  - Earlier runs under load showed two kinds of failure.
  - **My `killHard`, now fixed:** after the task finished, `taskkill /T` failed on a grandchild
    that had already exited, and the fallback `child.kill` then threw EPERM. It now waits up to
    5 s for the exit before falling back.
  - **Timeouts in other test files:** `brain.test.ts` and `attribution.test.ts` hit 5 s timeouts
    (git), and `scoring.test.ts` saw two classifier calls instead of one. The same flakes
    reproduced with `--exclude tests/resilience.test.ts`:
    - run 1: 4 failures (attribution, brain);
    - run 2: 1 failure (brain);
    - run 3: passed.

    So they come from load on this machine, not from this change.
- A check after the test runs found no orphaned `cli.js worker` processes
  (`Get-CimInstance Win32_Process`).

## Not verified

- **Non-cooperative hangs.** The watchdog aborts through the `AbortController`. A run that ignores
  its signal (a promise that never settles, or a tool that does not honour `signal`) stays stuck.
  The abort is recorded and the lease keeps being heartbeated. I chose not to force-settle from
  the timer, because the zombie run would later write `ended` into a session that a new run had
  reopened.
- **Watchdog on supervisors and external coding.** It is not exercised against a real supervisor
  run. The `await_tasks` and `ask_user` exemptions are tested only at the verdict level. It is
  also not exercised against external (OpenCode) coding: that agent's in-process tool time is
  covered only by the `model_response` rule.
- **The breaker with FreeLLMAPI's own proxy limiter.** A 429 with no code never reached a provider,
  but I cannot tell it apart from a provider 429, so it counts against the platform tried when no
  cooldown was reported.
- **A gateway that is down.** A FreeLLMAPI `transport` error (gateway unreachable) counts against
  every platform that was tried.
- **Breaker state across several workers.** It is per process, and the mirror is last-writer-wins.
  Workers do not consult each other's breakers live, only at start.
- **The kill test on Linux and macOS.** It ran only on Windows (taskkill). The SIGKILL branch is
  untested.
- **Backup/restore round trip** (named in the R1b decisions): not added here. `tests/operations.test.ts`
  from r1-ops already covers it.
- **Documentation:** not updated. That is outside my files. See Open questions 3.

## Open questions or contradictions found

1. **`src/core/watchdog.ts` is a new file outside the paths the brief lists.** The brief owns "the
   watchdog hook in `src/core/executor.ts` (small, self-contained)". I kept the executor change to
   the hook and put the pure verdict and the session progress query in their own file in
   `src/core`. Move it if you prefer.
2. **`sessionProgress` queries `sessions` and `session_events` directly**, because `src/sessions/**`
   was not mine. A `SessionStore.lastEvent(id)` method would be the cleaner home.
3. **Docs to update** (supervisor-owned): `docs/operations.md` (watchdog behaviour and keys, breaker
   keys and the `circuit:*` meta rows, `insights.providerHealth`) and `docs/decisions.md` (which
   failures count, demote versus skip, the persistence choice, the watchdog allowance rules).
   Also regenerate the presets if they should show the new keys.
4. **Panel follow-ups** (not in this brief):
   - show `insights.providerHealth` on the overview or routing page;
   - show `circuitOpenUntil` next to "rate limited" on `apps/panel/app/routing/page.tsx`.
5. **A watchdog abort uses one of the 3 automatic runs** (`MAX_AUTO_RESUMES`). After that the task
   stays `interrupted` until an operator resumes it. Confirm this cap is wanted.
