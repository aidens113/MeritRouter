# Report: t3-capacity

Worker report for "Brief: t3-capacity" in [agent-sessions-and-teams.md](../../agent-sessions-and-teams.md).
Worktree `D:/sy-wt/v1`, branch `feat/t3-capacity`. Nothing was committed.

## Outcome

Partial. Everything in the brief is built and tested. `tests/team-capacity.test.ts` has 8 tests,
and they pass on three runs in a row.

The full suite has 298 tests: 297 pass and 1 fails.
- **The failing test.** `tests/team-graph.test.ts` > "runs independent nodes concurrently up to
  team.max_agents ..." expects 3 requests in flight on one platform. The brief's default of
  2 slots per platform now caps that at 2. I don't own the file.
- **The fix.** A one-line config change, under Open questions 1. I checked it on a temporary copy
  of the test: 11 of 11 passed. The copy is deleted.

I also made two small edits outside the paths I own, `src/storage/tasks.ts` and
`src/core/service.ts`. Without them the scheduler cannot hold a task back for a provider slot. See
Open questions 2.

## What changed and why

### Config (`src/config/schema.ts`, team section only)

All of these keys have defaults, so existing configs still parse. I did not regenerate the presets.

| Key | Default | Meaning |
| --- | --- | --- |
| `team.provider_concurrency_enabled` | true | Off: no slot limit |
| `team.provider_concurrency_start` | 2 | Slots a platform starts with |
| `team.provider_concurrency_increase_after` | 5 | Consecutive successes that add one slot |
| `team.provider_concurrency_max` | 8 | Ceiling for every platform |
| `team.provider_concurrency_limits` | `{}` | Confirmed ceiling per platform, below the max |

FreeLLMAPI v0.2.1 does not report a concurrency limit; `GET /v1/providers` reports only status,
keys, `resume_at`, and `requests_remaining_pct`. The "reported limit" ceiling is therefore one the
user confirms in `provider_concurrency_limits`. A reported cooldown is used as a halving signal.

### Migration (`src/storage/migrations.ts`, one appended entry)

New table `provider_slots`. Its columns are id, platform, kind, holder, task_id, lease_owner,
priority, since, and seen_at, with indexes on (platform, kind), task_id, and holder. There are
three kinds of row:

- **`request`**: one in-flight model request, held from reservation to reconciliation. A prompt
  batch is one request, so it holds one slot.
- **`claim`**: a task the scheduler admitted on a platform that has not sent its first request.
- **`wait`**: a request waiting for a slot. Supervisors and reviewers wait at priority 1.

The t3-metrics worker may also append a migration. The merge must set the order.

### Limiter and slots (`src/gateway/capacity.ts`, new)

**AIMD rules.** These are pure functions: `ceilingFor`, `afterSuccess`, `afterThrottle`.
- Each success adds 1 to a counter. At `increase_after` the platform gains a slot, up to the
  ceiling, and the counter resets.
- A throttle halves the slots, with a floor of 1, and bumps a **generation** number.

**`ProviderCapacity`.** This holds the persisted state.
- Each platform's AIMD record lives in `meta` under `concurrency:<platform>` and is validated with
  zod. It is read-modify-written in an IMMEDIATE transaction on every change. Every process
  therefore shares one live state: a restarted worker, a second worker, and the panel all see it.
  This differs from the breaker, which keeps its state in each process and mirrors it to `meta`.
- **`throttle(platform, reason, generation?)`** ignores a failure from a request sent under an
  older generation. A burst of 429s from requests sent together therefore halves once.
- **`observeCooldown`** halves once for each FreeLLMAPI `resume_at` value.
- AIMD writes are advisory. They are wrapped in try/catch, so a busy or closing store never fails
  a request that was served.

**Slot requests.**
- `tryAcquire` runs in an IMMEDIATE transaction:
  1. It purges dead rows.
  2. It counts the live `request` rows.
  3. It takes the slot only when fewer waiters rank ahead of it than there are free slots. A
     waiter ranks ahead with a higher priority, or with the same priority and an earlier wait.
  4. Taking a slot deletes the holder's `wait` rows and the `claim` rows of its tasks.
- `release` deletes the row and wakes local waiters.
- `wait` and `leave` keep the holder's place in the queue.
- `nextWake` polls every 250 ms. It returns at once when this process frees a slot or raises a
  limit, or when the request is aborted.

**When rows stop counting.** A row counts only while its task holds a live lease: the task is
`running` or `cancel_requested`, `lease_expires_at` is still ahead, and `lease_owner` matches.
Each kind also has a freshness limit:
- `request` rows: twice the request timeout plus 60 s;
- `claim` rows: 60 s;
- `wait` rows: 15 s since their last refresh.

So the holds of a dead process expire with its task lease, and the next acquisition deletes them.

**Scheduler and panel helpers.**
- `admissible(platforms)` returns the first platform where in-flight requests, claims, and
  priority waiters add up to less than the limit.
- `recordClaim` adds a `claim` row.
- `readConcurrencyRecords(db)` and `liveSlotCounts(db, now)` serve the panel and insights.

### Gate (`src/gateway/gate.ts`)

**`ProviderHealth`.**
- It owns `capacity`.
- `recordOutcome(platform, err, generation?)` feeds the limiter:
  - a success adds a success;
  - a 429 or `rate_limited` halves for that generation;
  - a breaker that opens on this outcome halves, unless the 429 already halved.
- `refresh()` passes reported cooldowns to `observeCooldown`.

**`Gate`.**
- The constructor attaches capacity to the store and to `cfg.team`, with settings read live.
- `request()` is now a loop around `round()`, which is the previous body. For each candidate:
  1. Take a slot on its platform. A full platform is recorded as an attempt:
     `skipped: provider slots full for X (h/L in flight[, n waiting ahead])`.
  2. Take the breaker admission. If the breaker refuses, release the slot.
  3. Reserve. If the reservation fails, release both the slot and the breaker.
  4. Dispatch, then reconcile. The slot is released in a `finally` after reconciliation, for both
     chain routes and direct paid routes. The direct dispatch moved into `dispatchDirect` so that
     it could be wrapped this way.
- When nothing was dispatched and some platform was full, `request()` waits:
  - It registers wait rows and holds nothing, then retries.
  - The wait lasts at most `gateway.request_timeout_seconds`. After that it throws
    `rate_limited`, with `retryAfterMs` of 5000 and `possiblyConsumed` false, and the executor
    defers the task for capacity.
  - An abort throws `aborted`.
- Priority 1 goes to purpose `supervisor` or `verification` (the reviewer), and to any request
  whose plan profile is in supervisor mode.

### Scheduler admission

**`src/storage/tasks.ts`** (not owned)
- `ClaimLimits.providerSlots?: ClaimAdmission`, with two methods:
  - `check(row, spec)` returns null, or `{ wait, data }`;
  - `claimed(row, spec, owner)`.
- In `claim`, the check runs only for workers. Top-level supervisors and sub-supervisors are never
  checked. It runs before file leases, so a task that waits takes no lease.
- A waiting task stays queued with:
  - `state_reason waiting_for_provider_slot:<platforms>`;
  - one `waiting_for_provider_slot` event per new reason, with data
    `{platforms: [{platform, limit, inFlight, starting, waiting}]}`.
- New constant `WAITING_FOR_PROVIDER_SLOT`.

**`src/routing/claim-capacity.ts`** (new)
- `claimTiers` picks the tiers to look at before classification, in this order:
  1. a forced tier, the recorded tier, or the hint (T4 is read as T3);
  2. otherwise, every tier from the profile's `min_tier` up to T3.
- `ProviderSlotAdmission` takes the union of platforms from `TaskRouter.plan` over those tiers.
  Plans are cached for 1 s.
- It admits a task when one of those platforms is admissible, and records a claim there. A task
  with no route is admitted, so its run reports why it cannot route.

**`src/core/scheduler.ts`**
- The constructor takes an optional `providerSlots` and passes it to `claim`.

**`src/core/service.ts`** (not owned, 2 lines)
- An import, and `new ProviderSlotAdmission(cfg, this.router, this.health.capacity, this.now)` as
  the scheduler's new argument.

### Why this cannot deadlock

This is the design decision the notes asked for.
- **Only HTTP requests hold slots.** A slot is held from reservation to reconciliation, and its
  holder waits on nothing but its own request, which the request timeout bounds.
- **Waiting holds nothing.** Tasks waiting at claim hold nothing. Requests waiting at the gate
  hold only wait rows, which take no slot.
- **Claims are bounded.** A claim lasts until the task's first request or 60 s, whichever comes
  first, and dies with the task lease.
- **Supervisors are never held back.** The scheduler never holds a supervisor for a slot.
  Supervisors hold no slot while they wait in `await_tasks`. Their requests, and reviewer
  requests, are served before waiting workers, so they get the next free slot even when workers
  fill every slot.

### Staffing (`src/routing/staffing.ts`, new; `src/harness/supervisor-tools.ts`)

**`rulebookTier(cfg, brief, artifacts)`** computes the router's deterministic score from measured
features, with no classifier and no tags.
- It validates the brief with `WorkerTaskSchema`, loads its sources, and calls `measureFeatures`
  and then `decide` with basis `rules`.
- The result is never below the profile's `min_tier`.
- It returns null when the brief is invalid or its sources cannot be read.

**`plan_work` changes.**
- **Tiering new nodes.** Each new worker node without a difficulty (not `supervise`, not already
  dispatched) gets the rulebook's tier. It is set as both the plan node's `difficulty` and the
  task's `hints.difficulty`, so the critical-path weights are real and the classifier is skipped
  at run time.
- **Oversized nodes.** A node that scores T4 gets no tier and is reported for splitting.
- **Tool output.** It adds `tiers from the rulebook (nodes without difficulty): ...` and a line
  showing the provider slots in use: in flight/limit per platform, and waiting.
- **Input handling.** Items are copied before they are changed.
- **Stubbed contexts.** Both additions skip quietly when the context has no gate or artifacts, as
  in `team-integration.test.ts`.

### Charter (`charters/supervisor.md`)

- Added a paragraph to "Plan multi-part goals as a task graph":
  - leave out `difficulty` to get the rulebook's tier;
  - split nodes that score above T3;
  - when slots are free, prefer more, smaller T1/T2 nodes;
  - when slots are full, plan fewer, larger nodes;
  - keep T3 models for supervision, for nodes that need them, and for Deep/Strict review;
  - never raise a tier to start sooner.
- The difficulty bullet now notes the `plan_work` default.

### Tests (`tests/team-capacity.test.ts`, new, 8 tests)

1. **AIMD rules.** Increase after N successes, the ceiling, a confirmed per-platform limit, and
   halving down to the floor.
2. **Persisted state, on a fake clock.**
   - Additive increase up to the ceiling.
   - Three 429s from one generation halve once; later halvings stop at the floor.
   - A cooldown halves once per `resume_at`, and a cooldown already over does nothing.
   - Through `ProviderHealth`: a cooldown from `providers()` halves; a breaker opening (threshold
     2, two 502s) halves with reason `circuit_open`.
   - A second `ProviderCapacity` on the same store reads the same limits.
3. **Slots across two `ProviderCapacity` instances** (two processes).
   - The third holder is refused at 2 of 2.
   - A worker waits first, and a supervisor that waits later is served first; the worker is
     refused with `ahead: 1`.
   - Claims count until the task's first request.
   - After +61 s the task leases expire, every hold stops counting, and the rows are purged.
4. **The scheduler holds tasks** (real worker, 5 inspect tasks, 2 slots, requests held open).
   - 2 tasks run and 3 stay queued with `waiting_for_provider_slot:openrouter` and the event data.
   - Each released request lets exactly one more task start.
   - All 5 complete, at most 2 requests are ever in flight, and no request rows are left.
5. **A full job completes** (the deadlock proof).
   - Setup: limit 1 (start and max 1); a supervisor `plan_work` with 4 inspect nodes; each worker
     makes 2 slow requests.
   - The job completes `supervisor_completed` with all 4 children completed, and at most 1
     request is ever in flight.
   - Workers recorded `waiting_for_provider_slot`; the supervisor never did.
   - The tool output carries the rulebook tiers and the slot line, and each child's hint equals
     its plan node's difficulty.
6. **A 429 burst** (gate level, 4 claimed tasks, start 4, increase after 2).
   - 4 concurrent 429s give limit 2 and generation 1, not the floor.
   - Recovery: 2 successes give 3, 2 more give 4. No request slots are left.
7. **The gate waits instead of failing** (limit 1).
   - A second request waits while the first is held: 1 request and 1 waiter.
   - It takes the slot when the first finishes, and nothing is left afterwards.
8. **Staffing.**
   - A small inspect brief scores T1, and analyze scores T2 (its `min_tier`).
   - An invalid brief returns null.
   - `claimTiers` uses the hint, else every tier from the minimum.

## Commands run and observed results

All commands ran in `D:/sy-wt/v1` or in `packages/router`.

- `npx tsc --noEmit -p .` after each edit group:
  - no output, except one test typing error (a record literal typed too narrowly), which I fixed.
- `npx vitest run tests/team-capacity.test.ts`:
  - 8 passed on the first run, then 8 passed three more times in a row.
- First full `npx vitest run`, before staffing:
  - 289 passed, 1 failed: the team-graph test, `expected 2 to be 3`.
- Second full run:
  - 2 failed: the same team-graph test, and `team-integration.test.ts` > "plan_work records and
    passes redundancy". That one hit `Cannot read properties of undefined (reading 'health')` in
    `capacityLine`, because the stubbed context has no gate.
  - I made `capacityLine` and `staffNodes` tolerate a missing gate or artifacts. After that,
    `npx vitest run tests/team-integration.test.ts tests/team-capacity.test.ts` gave 13 passed.
- Team-graph fix on a temporary copy:
  - `sed 's/team: { max_agents: maxAgents }/team: { max_agents: maxAgents, provider_concurrency_start: 8 }/'`
    into `tests/t3cap-tmp-graph.test.ts`, then `npx vitest run` on it: 11 passed. The copy is
    deleted.
- Final checks:
  - `pnpm --filter switchyard-router build`: exit 0.
  - `pnpm -r typecheck`: `packages/router typecheck: Done`, `apps/panel typecheck: Done`.
  - `npx vitest run`: 32 files, 298 tests; 297 passed, 1 failed, which is only the team-graph
    test above.

## Not verified

- **Two real worker processes contending for slots.** This is covered only with two
  `ProviderCapacity` instances on one store. The IMMEDIATE transactions serialise processes, but
  no multi-process test ran.
- **A worker process killed while holding a slot.** Expiry with the task lease is tested on a fake
  clock, not with a real kill.
- **Real FreeLLMAPI 429s and cooldowns**, and any live provider.
- **A reviewer (Deep/Strict) waiting at priority 1 end to end.** Priority is tested at the slot
  level and with a supervisor's requests, not with an actual reviewer run.
- **The gate's wait running out after `request_timeout_seconds`**, and the deferral that follows.
  The code path exists, but no test waits 300 s or shortens the timeout.
- **Direct paid routes under slots.** The code path changed (the `dispatchDirect` extraction);
  `tests/paid.test.ts` still passes, but no test fills a paid platform's slots.
- **Whether AIMD should grow only when a platform's slots are actually in use.** It grows on any
  consecutive successes, as the brief says. A quiet platform therefore climbs to its ceiling, and
  a later burst at that size may 429 once before it halves.
- **Presets.** Not regenerated. The keys have defaults, so the presets still parse.
- **Documentation.** Not updated; those files are not mine. See Open questions 4.

## Open questions or contradictions found

1. **`tests/team-graph.test.ts` needs the supervisor's edit.**
   - The change: in `teamConfig`, change
     `team: { max_agents: maxAgents }` to
     `team: { max_agents: maxAgents, provider_concurrency_start: 8 }`.
   - The test measures the per-job agent cap (3) with every node on one platform. The new default
     of 2 slots per platform hides that cap.
   - Alternative: `provider_concurrency_enabled: false`.
2. **Edits outside my paths.**
   - **`src/storage/tasks.ts`**: the `ClaimAdmission` hook, the check in `claim`, the `claimed`
     call, and `WAITING_FOR_PROVIDER_SLOT`. Without these the scheduler cannot keep a task queued
     with a reason; `claim` is the only place that decides this, inside its transaction.
   - **`src/core/service.ts`**: 2 lines that pass the admission to the `Scheduler`.
   - Neither file is on the brief's "Must not touch" list or in t3-metrics' ownership.
3. **For t3-metrics and the panel** (`src/index.ts` is theirs).
   - Not exported yet: `readConcurrencyRecords`, `liveSlotCounts`, `ProviderCapacity`,
     `ConcurrencyRecord`, and `WAITING_FOR_PROVIDER_SLOT`.
   - Waiting time on a provider slot can be derived from `waiting_for_provider_slot` task events,
     followed by `claimed`. The state reason prefix is `waiting_for_provider_slot:`.
   - Live state:
     - `meta` rows `concurrency:<platform>`;
     - `provider_slots` rows, which count only while their task lease is live (use
       `liveSlotCounts`).
4. **Docs to update** (supervisor-owned).
   - `docs/operations.md`: the new team keys; slots and their expiry; the `provider_slots` table
     and the `concurrency:*` meta rows; the gate waiting up to one request timeout, then deferring.
   - `docs/decisions.md`:
     - FreeLLMAPI reports no concurrency limit, so the ceiling is a confirmed config value;
     - one halving per generation;
     - priority for supervisors and reviewers;
     - the deadlock argument;
     - rulebook tiers for plan nodes skip the classifier.
   - `docs/roles.md`: supervisor staffing guidance.
5. **Watch file length.** `src/harness/supervisor-tools.ts` is now about 735 lines, close to the
   800-line rule. The staffing and capacity helpers could move out if it grows.
6. **Plan-node tiers skip the classifier.** A rulebook tier set as `hints.difficulty` acts as a
   floor and skips the classifier, so classifier tags can no longer raise a plan node's tier. This
   is the cheaper path the brief asks for, but it changes behaviour for nodes that used to be
   classified (for example `analyze`, `classify: auto`). To keep the classifier, set the tier on
   the plan node only and not as a hint.
