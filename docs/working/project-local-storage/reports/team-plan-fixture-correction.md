# Team plan redundancy fixture correction

Worker: project_storage_discovery
Date: 2026-10-26
Source frozen: yes, after focused and complete-file checks below.

## Changed

Only `packages/router/tests/team-integration.test.ts`, within the redundancy-only planning
test, plus this report. No production source, unrelated test case, timeout, skip or existing
assertion changed. No commits, live data or provider calls.

The raw TaskStore stub inserted a parent with empty project identity; its context used the
configured `demo` project. `delegatedSourceSnapshot` correctly rejects that discrepancy before
dispatch. The test also assigned a writable `core` repository without constructing a real
Git integration workspace, although the test only checks plan schema/redundancy persistence
and delegate forwarding and never reads source.

The corrected fixture configures/assigns no repositories and explicitly attributes parent and
stub-submitted children to `cfg.brain.project`, matching real service ownership semantics.
All existing redundancy/supervise-schema/dispatch assertions remain. Added assertions confirm
parent and both children retain that explicit project identity. No fake source commit/branch
or guard bypass was introduced.

## Observed verification

Before edit, from `packages/router`:

```text
pnpm exec vitest run tests/team-integration.test.ts -t "plan_work records and passes redundancy" --maxWorkers=1
```

Exit1: exact selected test failed deterministically with
`delegated_source_refused: parent project identity changed` at delegated-source.ts:13.
Four other tests were deselected by `-t`, not newly skipped.

Same command after correction: exit0, selected test **1 PASS**, 2.72s.

```text
pnpm exec vitest run tests/team-integration.test.ts --maxWorkers=1
```

Exit0: **all5 tests PASS**, 22.75s. This includes the real temp-Git nested supervisor
carve/branch/integration/undo flow, channel behavior and watchdog checks. Cleanup completed.
Final source diff reviewed; only the intended fixture and two ownership assertions changed.

Full combined suite, recursive typecheck/build and publication remain supervisor-owned;
this report does not claim the prior full-suite run was green.
