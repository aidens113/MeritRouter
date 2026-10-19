# Report: v1-surface

Worker report for "Brief: v1-surface (after v1-exec)" in `docs/working/importance-and-verification.md`.
Worktree `D:/sy-wt/v1`, branch `feat/v1-verification`. Nothing was committed.

## Outcome

Done, including the supervisor's follow-up (next section).

- `pnpm -r typecheck` passes for both the router and the panel.
- The panel builds.
- The full router suite passed on the final run: 19 files, 162 of 162 tests. This was after
  v2-review's later edits.

The first-pass results lower down are kept for the record.

## Follow-up (supervisor, same session)

1. **The MCP client is not a human acceptor.**
   - `accept_result` and `reject_result` record `{kind: "supervisor", id: "mcp:<client>"}`.
   - The supervisor asked for `kind: "agent"`. `SupervisorDecisionSchema.by.kind` in
     `src/core/task.ts` allows only `supervisor | human`, and that file is v1-core's (v2-review
     has it modified). So I used `supervisor`, which matches "acting as the job's or user's
     supervisor".
   - `applySupervisorDecision` refuses every non-human kind with `human_acceptance_required`.
     So with `strict_acceptor: human`, an MCP accept of a strict result is refused, the same way
     the supervisor tool is.
   - Reject over MCP is still allowed.
   - The tool descriptions now say this and point people to `switchyard accept` or the panel.
   - `decideTaskAcceptance` now takes `by: SupervisorDecision["by"]`. The CLI passes
     `{human, cli:<user>}`, the panel routes pass `{human, panel}`, and MCP passes
     `{supervisor, mcp:<client>}`.
   - If the kind must be `agent`, it is a one-word enum change in `task.ts` plus the `kind` in
     `mcp.ts`. The refusal logic already covers it.
2. **"Allowed" uses the contract's total.** In `src/core/service.ts`, the private `status()`
   behind `getStatus` and `listTasks` now shows the stored contract's `budget.total` as
   `maxModelRequests` when a contract exists. I changed only that display logic. A corrupt
   contract falls back to the old cap. Without a contract the value is unchanged.
   - Checked on the reseeded demo, where the CLI `status` and the panel show the same numbers:

     | Task | Allowed |
     | --- | --- |
     | Implement | 2/24 |
     | Review | 5/24 |
     | Analyses | 5/24 and 3/24 |
     | Queued or waiting (no contract) | 0/4 |
     | Supervisor job | 1/12 |

   - The panel task detail read "2 of 24 allowed", matching the CLI.
3. **The demo `analyze` limit is still 10.** It is left for you to revisit.

Tests changed in `tests/verification-surface.test.ts` (now 6 tests):

- The in-process detail test asserts that `getStatus` and `listTasks` show the contract total,
  which exceeds the T1 run cap. A supervisor-kind accept of a strict result under the human
  acceptor is refused with `human_acceptance_required`.
- The no-contract test asserts the old cap (4).
- The CLI test asserts that `status --json` and the table show the contract total.
- MCP is split into two tests:
  - Under `strict_acceptor: human`, `accept_result` is refused ("only a human can accept"),
    reject records `{supervisor, mcp:test-client}`, and `collect_results` shows `a`
    `needs_supervisor` and `b` `unmet`.
  - Under the default (supervisor) acceptor, `accept_result` gives `met`, recorded as
    `{supervisor, mcp:test-client}`.

Commands for the follow-up:

- `pnpm --filter switchyard-router build`: ok.
- `pnpm -r typecheck`: `packages/router typecheck: Done`, `apps/panel typecheck: Done`.
- `npx vitest run tests/verification-surface.test.ts tests/mcp.test.ts`: `Test Files 2 passed (2)`,
  `Tests 7 passed (7)`.
  - The first attempt hard-coded a total of 8. It got 24, because v2-review's allocation changed
    the total. The tests now compare against the stored contract instead.
- `npx vitest run tests` (full): `Test Files 19 passed (19)`, `Tests 162 passed (162)`.
- Panel:
  - `pnpm --filter switchyard-panel build` and `seed:demo`: ok. The critical task ended
    `needs_supervisor`.
  - `next start -p 4531`: `/tasks` and four task detail pages compared with the CLI `status`.
  - The server was stopped, and no listener is left on 4531.

New observation for v2-review or the supervisor: every contract total in the demo is 24, even for
`summarize` (profile cap 4) and `review` (cap 4). The old totals were the profile, task, or tier
caps (8, 16). Status now reports this number, so check that the allocation is intended.

## What changed and why

### Panel typecheck fix and every criteria/acceptance render site

- `apps/panel/app/tasks/[id]/page.tsx`: criteria render from `insights.taskDetail().criteria`
  (ids plus text). Each criterion's status comes from `verification.criteria[id].outcome` when
  the result has a record. Without one it falls back to `unresolvedCriterionIds`, then to the
  old text match.
- `apps/panel/app/jobs/[id]/page.tsx`: uses `criterionTexts(spec)`.
- `apps/panel/app/jobs/page.tsx`: the inline met/unmet/"not verified" text now uses
  `ACCEPTANCE_LABEL`, so `needs_supervisor` reads "needs supervisor".
- `apps/panel/components/task-badges.tsx`:
  - `AcceptanceBadge` handles `needs_supervisor` (warn tone) and gives each status a title.
  - New: `ACCEPTANCE_LABEL`, `VerificationBadge` with `VERIFICATION_LABEL` (all six statuses),
    `ImportanceBadge`, and `OutcomeBadge` (check and criterion outcomes).
- `apps/panel/lib/glossary.ts`: new `importance`, `verification`, `contract`, and `acceptance`
  entries. They explain `needs_supervisor` and the human strict acceptor.
- No other panel file renders criteria, `acceptanceStatus`, or `verificationStatus`. I checked
  with grep across `apps/panel`.

### Task detail (panel)

- **Header:** importance, acceptance, and verification badges.
- **"This result needs a decision" callout** when `acceptance.awaitingDecision` is set (the task
  is completed and its result is `needs_supervisor`).
  - It says why: strict (with the human-only wording when `strict_acceptor` is human), or that
    verification could not establish the result.
  - It lists the verification reasons.
  - It holds the new `components/client/acceptance.tsx`: a reason textarea plus Accept and
    Reject buttons. Reject needs a reason. Accept from this callout needs a reason too, because
    the library requires one for any result that is not already met.
- **Result card:** shows `changedPaths`, `scopeViolation`, and `protectedPathsChanged`, and the
  revision each check ran on.
- **New "Contract and verification" card:**
  - Contract side:
    - importance, with its source in plain words, the requested level if it differed, and the
      reason;
    - level, against the matrix level and tier;
    - a "raised on the result from X to Y" note;
    - rules matched;
    - required checks;
    - review requirement;
    - acceptance mode;
    - declared checks;
    - the budget split (total, classification, execution, review, repair, unallocated);
    - fingerprints;
    - the digest and compile time.
  - Record side: a checks table (required or not, outcome, detail), a criteria table (outcome,
    evidence refs, note), the reasons, the decisions (accepted or rejected, by id and kind, time,
    reason), and the policy and contract digests.
  - A corrupt contract shows a callout instead of breaking the page.
- **Timeline tones** for `result_accepted`, `result_rejected`, `verification_raised`, and
  `dependency_unverified`.

### Panel API

- New routes `POST /api/tasks/accept` (`{id, reason?}`) and `POST /api/tasks/reject`
  (`{id, reason}`, where zod requires the reason). Both call
  `insights.decideTaskAcceptance(sy, id, …, { kind: "human", id: "panel" }, reason)`.
- Auth is unchanged: `proxy.ts` matches every `/api/*` route, as it does for the existing
  cancel and resume routes.
- `apps/panel/lib/api.ts` maps the library refusal codes to HTTP statuses instead of 500:

  | Code | Status |
  | --- | --- |
  | `reason_required` | 400 |
  | `not_found` | 404 |
  | `cannot_accept_unmet` | 409 |
  | `human_acceptance_required` | 409 |

### Router (`src/admin/insights.ts`, `src/cli.ts`, `src/mcp.ts`)

- **`TaskDetail` gains:**
  - `criteria: Criterion[]`;
  - `contract: StoredContract | null`;
  - `contractError: string | null`, set when `ContractStore.get` throws;
  - `verification: VerificationRecord | null`;
  - `importance: TaskImportanceView | null`, with `{level, requested, reason, source,
    compiled}`. The level comes from the result's record when it exists (it may have been
    raised), then the contract, then the spec. `compiled: false` means only the requested level
    is known.
  - `acceptance: TaskAcceptanceView`, with `{awaitingDecision, supervisorAcceptance,
    strictAcceptor, decisions}`. `supervisorAcceptance` also looks at the record's level, so a
    level raised to strict counts.
- **New `decideTaskAcceptance(sy, id, "accept"|"reject", by, reason)`.** It throws
  `SwitchyardError("not_found")` for an unknown id, then calls `sy.acceptTask` or `sy.rejectTask`
  with the given `by`. The CLI, MCP, and panel all go through it. The signature was changed in
  the follow-up: `by` is now a `{kind, id}` object, not a string.
- **CLI:**
  - `switchyard accept <id> [--reason]` and `switchyard reject <id> --reason` record
    `cli:<os user>`. The user comes from `os.userInfo()`, falling back to `USER`/`USERNAME`.
    Output is one line, or the outcome as JSON with `--json`.
  - `submit` gains `--importance low|normal|high|critical` and `--importance-reason`. They fill
    in only tasks that set no importance, so a task's own level is never overridden. Both are
    validated: an unknown level is a usage error, and so is a reason without a level.
  - The help text is updated.
- **MCP:**
  - `accept_result {taskId, reason?}` and `reject_result {taskId, reason}` record
    `{kind: "supervisor", id: "mcp:<client name>"}`. The first pass recorded `human`; the
    follow-up changed it. The client name comes from `server.server.getClientVersion()`;
    Claude Code reports its own name.
  - The `submit_tasks` description now documents object criteria, `importance`,
    `importanceReason`, `verification.atLeast` and `addChecks`, and
    `verification_budget_insufficient`. Its input schema was already a passthrough record
    validated by `submitTasks`, so the fields themselves already worked.

### Tests

- New `packages/router/tests/verification-surface.test.ts`. This is the first-pass list; the
  follow-up section has the current MCP and status tests (6 tests in all).
  - `taskDetail` exposes the contract, digest, record, importance, and the pending decision.
    `decideTaskAcceptance` records a `panel` human under `strict_acceptor: human`. An unknown id
    gives `not_found`.
  - The requested importance shows before the contract is compiled.
  - CLI `accept` and `reject` against a store seeded in-process:
    - reject without a reason fails;
    - the usage line appears when the id is missing;
    - accept records `cli:<user>`;
    - `reject --json` gives `unmet`, then a later accept fails with "cannot be accepted";
    - an unknown task fails.
  - CLI `submit --importance`:
    - it fills in tasks without an importance and keeps a task's own;
    - a bad level and a reason without a level are usage errors;
    - critical without a reason is refused.
  - MCP `accept_result` and `reject_result`:
    - accept without a reason is refused by the library;
    - reject without a reason is refused by the schema;
    - both record `mcp:test-client`, which then appears in `collect_results`.
- `tests/mcp.test.ts`: the expected tool list includes `accept_result` and `reject_result`.

### Demo seed (`apps/panel/scripts/seed-demo.mjs`)

- The demo config's `analyze` `max_model_requests` goes from 6 to 10, so strict's review reserve
  of 6 fits.
- New phases at 12.5h and 12h:
  - **Critical analysis** (label `billing-rounding`, object criteria `root-cause` and `fix`,
    importance critical with a reason). It is strict, ends `needs_supervisor`, and is left
    pending for the Accept/Reject UI.
  - **High-importance analysis.** It is deep and is accepted from the seed as `cli:demo` with a
    reason, so a decision shows.
- The seed warns if the critical task does not end `needs_supervisor`.

## Commands run and observed results

- **`pnpm -r typecheck` (at the start):** failed in `apps/panel`, as briefed: `jobs/[id]/page.tsx:121`,
  plus `tasks/[id]/page.tsx:116` and `:128`.
- **`pnpm --filter switchyard-router build` and router `tsc`:** failed for a while on
  v2-review's in-progress `src/core/executor.ts` (TS2554 at 172 and 317). I waited in a
  background loop until it compiled, then built.
- **`pnpm -r typecheck` (final):** `packages/router typecheck: Done` and
  `apps/panel typecheck: Done`.
- **`npx vitest run tests/verification-surface.test.ts tests/mcp.test.ts`:**
  `Test Files 2 passed (2)`, `Tests 6 passed (6)`. This was against a dist built from the tree
  that includes v2-review's current changes.
- **`npx vitest run tests` (full suite), run twice:**
  - First run: 156 passed and 5 failed.
  - Second run: 153 passed and 8 failed:
    - `paid.test.ts`: T4 premium. Served endpoints now include a second (review) model.
    - `verification-flow.test.ts`, 4 tests: these are V2 behaviour changes.
      - Submit-time rejection no longer happens.
      - The strict status is `inconclusive`, not `pending`.
      - The budget total is now 24 where 8 or 16 was expected.
    - `qualification.test.ts`, "the shipped suite is valid": the eval list grew to 13.
    - `attribution.test.ts` (1) and `brain.test.ts` (1, reported twice). Re-run alone,
      `attribution`, `brain`, and `qualification` gave 16 passed and 1 failed, the failure being
      the qualification suite test. So the attribution and brain failures are flakes under
      full-suite load.
  - All of these failing files and behaviours belong to v2-review (`evals/**`, `executor.ts`,
    `review.ts`, `paid.test.ts`, which is modified in the tree and not by me). I changed none of
    them.
- **`pnpm --filter switchyard-panel build`:** succeeded. The route list includes
  `/api/tasks/accept` and `/api/tasks/reject`.
- **`pnpm --filter switchyard-panel seed:demo`:** succeeded.
  - "critical analysis (strict: needs a decision)" ended `completed/needs_supervisor`.
  - "high-importance analysis (deep: awaits review)" ended `completed/needs_supervisor` and was
    then accepted, so the database shows `met`.
- **Production server** (`next start -p 4531`, `SWITCHYARD_CONFIG` pointing at the demo):
  - Pages, all 200: `/`, `/tasks`, `/jobs`, `/jobs/<finished job>`, `/jobs/<interrupted job>`,
    and `/tasks/<id>` for:
    - the critical task (`needs_supervisor`);
    - the high task (accepted);
    - the implement task (`met`);
    - the queued task (no contract);
    - the failed task.
  - The HTML of the critical page contains "This result needs a decision", "Accept result",
    "Reject result", "Contract and verification", `root-cause`, and the sha256 digest.
  - The high task's page contains `cli:demo` and "accepted". `/jobs` shows the
    "criteria met" and "not verified" labels.
  - API checks (curl):

    | Request | Result |
    | --- | --- |
    | Accept without a reason | 400 "accepting a needs_supervisor result needs a reason" |
    | Reject without a reason | 400 (zod) |
    | Unknown id | 404 |
    | Accept a failed task | 400 "only a completed task can be accepted" |
    | Reject the review task with a reason | 200, `unmet`, `by: {kind: human, id: panel}` |
    | Then accept it | 409 "an unmet result cannot be accepted" |
    | Accept the earlier analysis with a reason | 200, `met` |
    | Body that is not JSON | 400 |

  - With `SWITCHYARD_PANEL_TOKEN` set and no session cookie, both POST routes return
    401 "Sign in required".
  - Both servers were stopped. The node processes were killed by PID, and no listener is left on
    4531.
- **Screenshots (looked at), in the session scratchpad:**
  - `v1s-critical.png`: decision callout, badges, and criteria with ids and outcomes.
  - `v1s-critical-full.png`: the full page, including the contract and the verification record
    (checks, criteria, reasons, no decisions).
  - `v1s-high-accepted.png`: a deep task with the reviewer's run, "Skipped: budget", and the
    `cli:demo` accepted decision.
  - `v1s-rejected.png`: the review task after the panel rejected it. It shows "Criteria unmet",
    high importance raised by a policy floor, and no callout.

## Not verified

- I did not click the Accept and Reject buttons in a browser. I exercised the routes with curl
  and confirmed the rendered callout and buttons through screenshots. The client component's
  disabled states and success messages are not checked.
- The panel's light theme was not screenshotted; only the dark theme was.
- MCP `accept_result` is tested with an SDK client named `test-client`. The id Claude Code
  reports (`mcp:<its client name>`) was not observed live.
- `contractError` (a corrupt stored contract) has no test.
- The full suite was red during the first pass because of v2-review's in-progress work. It was
  green (162/162) on the final follow-up run.
- The `kind: "agent"` the supervisor asked for is not implemented, because it needs a
  `task.ts` enum change that is not mine (see the follow-up).

## Open questions or contradictions found

1. **Resolved in the follow-up: MCP is not a human acceptor.** MCP now records
   `{kind: "supervisor", id: "mcp:<client>"}` and is refused for strict results under
   `strict_acceptor: human`. Still open: should the kind be a new `agent` value (a `task.ts`
   schema change) rather than `supervisor`?
2. **Resolved in the follow-up: status shows the contract's `budget.total`.** New concern: in
   the current tree every contract total is 24, including `summarize` and `review`, whose
   profile caps are 4. v2-review should confirm the allocation is intended.
3. **The demo phase label is out of date.** It says "deep: awaits review", but with V2 the
   review now runs (and in the demo it is skipped for budget). Rename it if V2 lands.
4. **Accept always needs a reason in the panel callout.** It is only shown for
   `needs_supervisor`, where the library requires a reason anyway. Accept and Reject are not
   offered for `not_verified` results. The routes accept them, but the brief scoped the buttons
   to `needs_supervisor`.
