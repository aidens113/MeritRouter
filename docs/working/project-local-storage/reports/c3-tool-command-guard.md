# C3 tool and command guard worker report

Status: source frozen 2026-10-26; focused acceptance complete. Supervisor independently validates integration and broad checks.

## Owned files

- `packages/router/src/harness/tools.ts`
- `packages/router/src/harness/edit-operations.ts`
- `packages/router/src/harness/operation-lifecycle.ts`
- `packages/router/src/harness/loop.ts`
- `packages/router/src/harness/worker-actions.ts`
- `packages/router/src/harness/command-process.ts` (new)
- `packages/router/src/harness/windows-command-job.ts` (new, approved OS implementation split)
- `packages/router/src/workspaces/repository-command.ts` (new)
- `packages/router/src/workspaces/repository-mutation.ts` (minimal active-command admission hook)
- `packages/router/tests/project-metadata-command.test.ts` (new)
- `packages/router/tests/project-metadata-tool-write.test.ts` (new)
- This report only. No other reports/shared docs/runner-owned files edited in this work unit. Nine production source files, two test files.

## Implementation

Actual legacy write/replace/delete acquire the repository mutation fence, derive the actual workspace guard if no runner hook was supplied, and recheck the captured task lease after asynchronous admission immediately before the synchronous filesystem effect. V2 rechecks each edit's revision while holding that same host capability; nested legacy writes reuse it. Typed repository mutation and selected-commit errors propagate through V2/operation/loop boundaries instead of becoming partial results or model-facing ordinary failures. Genuine standalone non-Git tools remain supported; invalid/inaccessible Git metadata does not silently bypass admission.

`createRepositoryEffects(root)` exports `withWrite(action, capability?)` and `runCommand(input, control?)`. Native/supervisor runner injection is owned separately by c3_message. Approved worker requests and supervisor direct command execution also derive the guard from the captured validated cwd at actual execution; no injected callback is necessary for admission. Worker source/lease/policy authority is rechecked under short admission and pre-send scopes. Pending human approval creates no command marker. Uncertain command failures no longer receive a false `quiescedAt`; waiting callers receive typed command uncertainty.

Command admission creates a small durable per-worktree receipt under the actual Git directory, with random id/nonce, descriptor digest and process identity. Full command/env/output are not persisted there. A short physical common-owner lease protects admission, helper-start recording and retirement; the command/compilation/waits run without that lease. Ordinary mutation is blocked while any active receipt remains. An opaque host permit skips exactly its own unchanged receipt to record/retire it; serialized/copied/foreign capabilities cannot skip all active commands. Merely changing a stored state label to terminal never provides process proof; retirement must archive the exact admitted receipt. Unknown owner death, invalid proof or retirement failure retains the guard for explicit inspection. No age-based theft or parent-exit retirement exists.

Windows execution uses a static C# helper compiled/cached in normal OS temp, never the source checkout or downstream project. The helper creates a Job with kill-on-close and no breakaway, creates cmd.exe suspended, assigns it before resuming user code, and queries kernel active-process count until zero. Timeout/cancellation terminates the whole Job, then requires observed zero. Job-owner death without proof retains the durable marker. A helper that dies before user payload is sent can produce a host-owned definitely-unsent result.

Child stdout/stderr are bounded untrusted data. They cannot act as control output. Completion travels separately as a bounded file signed with a per-invocation HMAC key supplied only to the helper stdin/memory; identity/nonce/signature/schema are verified before minting an opaque host proof. The helper executable is checked against its source/cache manifest on every execution. Cache installation is exclusive; stale/incomplete foreign cache state is retained rather than stolen.

This establishes process lifecycle containment, not a hostile same-user filesystem/security sandbox. Approved programs still have their normal OS filesystem/network authority. The implementation currently supports verified execution on Windows only; unsupported/unknown platforms retain the command guard and report uncertainty, not an invented cross-platform proof. Native compilation requires PowerShell/.NET Add-Type; failure before any user payload yields honest definitely-unsent containment-unavailable. A crash during the suspended-process creation/assignment window may leave a suspended process and retained receipt requiring inspection; it never authorizes source mutation based on parent exit alone.

Windows API basis: [AssignProcessToJobObject](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-assignprocesstojobobject), [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects), and [process creation flags](https://learn.microsoft.com/en-us/windows/win32/procthread/process-creation-flags). No polling-only descendant discovery is used as proof.

## Observed validation

- Initial native six-case run: 5 passed / 1 failed (closed-stdio orphan fixture observation deadline caused by nested shell quoting). Replaced inline `node -e` fixture with an OS-temp .cjs fixture; production executor was unchanged by that fixture correction.
- Corrected native six-case run: 6/6 PASS, 17.87s total. Actual command execution, real detached closed-stdio orphan with forged JSON stdout, timeout whole-Job termination, signed unsent shell spawn failure, owner-loss retained marker, opaque capability forgery rejection.
- New direct-write/V2 six + existing Harness V2 sixteen: 22/22 PASS, 18.98s total. Actual bytes preserved on refused writes, late captured-lease loss after waiting, nested capability without deadlock, existing partial/revision/CRLF behavior.
- Existing outside-operation ten + physical mutation ten + repeat-policy twenty-one: 41/41 PASS, 54.32s total. Independent actual Node processes still serialize; aliases and linked-worktree journals still work after command admission hook.
- Final native seven + write six: 13/13 PASS, 23.45s total (session 86523). Includes conservative refusal of forged stored terminal label and explicit assertion that no common lease remains during the live orphan command.
- No live provider, broad build/typecheck, commit, alternate checkout or router-source metadata was performed by this worker. Earlier compacted session 66583 was unavailable when resumed; no result is claimed for it.

Supervisor integration follow-up: recursive typecheck found `lease.active` inferred as literal `true` despite mutable capability lifetime. Added explicit `CommandLease` annotation to the admission result (type-only, runtime unchanged); source re-frozen. Supervisor owns confirming recursive typecheck.

## Supervisor verification

Independent final command/write/resume run:24/24 PASS105.04s (command7, write6, resume11).
Added archive-failure regression: completed command whose audit cannot be archived returns
command_uncertain and retains active mutation guard; final command8/8 PASS18.71s. Final
source keeps terminal-label receipts blocking while in active directory; archive failure is
not swallowed. Root reviewed native proof consumer, admission/retirement and tool wrappers.

Microsoft Job Objects documentation was read independently. The guarantee concerns processes
associated with the Job and ordinary CreateProcess descendants. The documentation explicitly
excludes processes launched through Win32_Process.Create; service-mediated launches and
hostile same-user manipulation remain outside this process-lifecycle scope. This is not an
OS filesystem/security sandbox or a guarantee about arbitrary host service side effects.
