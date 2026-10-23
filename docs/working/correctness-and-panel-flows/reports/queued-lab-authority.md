# Queued Lab authority

Status: Implemented; supervisor acceptance pending

Persist original supervisor LeaseRef on queued lab operations and newly started services. Reject legacy
task-prefixed requests without lease proof. Execute model operations within AsyncLocalStorage scope that
checks current trusted outside-repository policy, configured supervisor mode, exact project and live task
lease/generation. Abort scope-owned running effects on revocation. Guard setup/check/service commands,
readiness probes and later service starts after awaits. Retain service origin for daemon backoff/recovery;
never reinterpret an expired model operation as an operator action. Human existing services retain null
origin and are excluded from revocation cleanup. Promotion Git effects use the same scope guard.

Root owns control caller propagation of trusted `options.taskLease`; no model-controlled actor JSON.
Source frozen. Focused validation:
`npx vitest run tests/worker-lab-authority.test.ts --maxWorkers=1 --minWorkers=1`:
9/9 passed,8.16s. Covers queued policy disable/cancellation/task-incarnation/generation loss (zero new
command effects), active supervisor positive execution, explicit operator distinction, forged actor/legacy
unproved rejection, revocation during await, no subsequent service start, preserving preexisting human
services on rollback, and daemon refusing restart of revoked model-origin services.

Migration appends authority_json to lab_operations and lab_services. Service origin is persisted before
spawn; ownership cleanup targets only newly started/recorded model services. Promotion fixed Git effects
check the same live scope before and after awaits. Lab HTTP accepts fourth `{signal}` options, combines it
with timeout and checks cancellation after ownership awaits and before network/response processing.

Extracted shared LeaseRefSchema/type to leaf storage/lease-ref.ts; task-leases.ts reexports compatibility.
This avoids a circular dependency from core TaskLab evidence/check schemas through task storage. Authority
SQL mirrors dispatchable's state/project/owner/incarnation/generation/lease-expiry/deadline/cancel semantics.

No commit, broad validation, real engine/provider or live config operations performed. Tests create temporary
Lab worktrees and mock shell effects; supervisor owns caller propagation and complete acceptance.

## Acceptance fixture migration

Replaced obsolete unrestricted worker Task Lab-success scenarios in tests/task-lab-caller.test.ts with
supported pending/refusal semantics. Native workers retain original source pins and captured task lease;
Lab requests remain pending without creating an attempt/engine or starting a dedicated supervisor. Explicit
operator generic reports cannot become immutable Lab proof or waive human acceptance. Cancellation exits
pending waits; external coding is rejected before model/workspace/Lab effects. Passing explicitly supervised
ordinary checks still cannot satisfy missing required Lab evidence. Native dependency artifacts and explicit
pins remain covered, along with immutable claimed workspace generation after mutable task-row advancement.

Removed the obsolete dedicated-daemon teardown wait (up to45s) and queue drain interval. Each asynchronous
case now explicitly settles or cancels its request before fixture removal. Existing direct service lifecycle
tests in labs-task-attempt.test.ts and acceptance fences in task-lab-verification.test.ts retain the separate
supported immutable-attempt coverage; this migration does not fabricate successful autonomous worker proof.

Validation: initial six-case run5/6 passed20.93s; fixture's invalid empty labChecks array corrected to omission.
Isolated explicit-pin/dependency native regression passed9.28s. Final owned-file run:
`npx vitest run tests/task-lab-caller.test.ts --maxWorkers=1 --minWorkers=1` passed6/6,33.93s
(31.73s tests). No product edits or broad tests in this migration.

## Session fault fixture migration

Owned tests/session-faults.test.ts only. `crashThenRecover` now starts worker-enabled instances with
explicit temporary operator approvals for the exact declared native/supervisor fixture check. Worker-disabled
inspection and operator-resume instances retain plain `open`; no blanket approvals or effect reconciliation.
The shared helper stops and drains approvals before closing each simulated process. Existing fault injection,
single-edit/delegation, recovered-commit, model/spend-count and session identity assertions remain intact.

Focused file run:9/10 passed49.23s. Remaining deterministic regression is a real resume/repeat interaction:
after_tool_intent:replace_in_file crashes before execution; recovery proves no edits, yet repeating the
known-not-run edit ends repeated_tool_call:replace_in_file with zero changes after two model requests.
Isolated reproduction failed5.89s. Reported to supervisor for loop fix; no production source modified here.
Test edits frozen pending root fix and focused rerun.
