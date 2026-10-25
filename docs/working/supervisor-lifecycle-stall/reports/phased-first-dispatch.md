# Phased first dispatch after bounded discovery

## Cause and change
The bounded coordination allowlist included plan_work but excluded delegate. After six physical task requests a supervisor with a valid undispatched draft could not delegate its first phase; it had to resubmit the full plan with dispatch:true, potentially launching every fresh node. This contradicted supported phased execution.

supervisor-lifecycle.ts now offers/allows delegate after the cap only when an actual PlanStore plan exists and the persisted delivery stage is plan, implement, integrate or validate. Before that, delegation remains excluded. The execution boundary still validates the exact recorded brief, command/stage restrictions and scopes. An undispatched draft still does not restore unrestricted discovery.

## Validation
pnpm exec tsc --noEmit ->exit0.
Focused lifecycle test running at initial report write; final result appended below.
New regression retains the pre-plan exclusion and verifies an altered planned brief is refused with no child. An actual fake-provider supervisor publishes a two-node draft, reaches request7, sees delegate in the offered tools and delegates just its first exact node. It waits for that worker's completion and leaves the later node not_dispatched.

Only harness/supervisor-lifecycle.ts and tests/supervisor-lifecycle.test.ts edited. No app source, config/runtime state, paid policy or approval changes; no commits. Root owns integrated validation and deployment.

Final focused result: pnpm exec vitest run tests/supervisor-lifecycle.test.ts ->1file/11tests passed,26.27s,exit0. No test processes running.
