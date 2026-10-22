# H1L-a Linux helper prerequisite

Status: FROZEN for independent supervisor verification. Implemented bounded namespace fixture only; hydrated runtime remains unavailable.
Baseline:07ddb50, feat/linux-browser-helper. No commits or shared-document edits.

## Owned files and contract

- `labs/browser-linux-plan.ts`: strict zod private launch/release schemas and pure fixed fixture plan. Pre-validation bounds reject accessors/cycles/non-JSON/oversized input before schema parsing. Human-approved file pins contain canonical absolute path/device/inode/size/SHA256; executable paths are fixed to installed bwrap and Python3.10. The only target is `namespace_fixture_v1`. No arbitrary browser/executable/argv/environment/mount/evaluate authority or lease exists.
- `labs/browser-linux-helper.py`: trusted native monitor and inner gate, with independent strict bounded Python validation at the native boundary. No third-party package, compiler or system installation. Frames are at most8KiB and strict key sets/duplicate-key rejection/depth/node limits apply. Errors contain fixed codes only, never raw exceptions/config/paths/env. Initial launch and release use separate frames; wrong nonce/generation, extra authority, EOF and deadlines refuse.
- `tests/browser-linux-helper.test.ts` and `tests/fixtures/browser-linux-helper-fixture.py`: pure plan rejection cases plus opt-in actual installed-Ubuntu namespace tests. All fixture roots are fresh owned0700 temporary directories, helper copies0600, and teardown deletes only the directly created root after process checks. Existing untracked logs preserved.

The returned plan/private helper events explicitly contain runtimeEnabled:false. Kernel observation fields in the private ready event are not a serialized containment capability and cannot construct H1's nominal lease. Public capability, static/browser/process/check/schema integration, configuration, exports and migrations are untouched. No packaging change copies the Python file into dist: this is deliberately a source prerequisite, not an installable adapter claim.

## Native authority and lifecycle

The monitor validates exact parent PID/startTicks/boot ID and pins that owner with a pidfd. Its only inherited descriptors are stdin/stdout/stderr; owner control may explicitly be a FIFO or connected AF_UNIX stream socketpair (as Node stdio may be). Extra inherited sockets/FDs or ambient environment are rejected. Only fixed PATH/LANG enter the monitor, fixed PATH/LANG/HOME enter the inner stage. The inner application's stdio is /dev/null; gate/status are exact anonymous pipe descriptors6/7 and bwrap info8 is not passed through to the stage.

Regular file hash/identity/permissions, canonical path/ancestors and non-setuid bwrap are checked. Shared sticky /tmp is permitted only as an ancestor of the private fixture directory; arbitrary writable/symlinked ancestors and helper/executable aliases refuse. The actual native host profile is deliberately limited to x86_64 Ubuntu-style Python3.10 and approved bwrap0.6.1. Unsupported host/kernel/proc observations fail closed, without alternative commands or namespace-try flags.

Bwrap creates explicit user/net/mount/PID/IPC/UTS/cgroup namespaces, inside uid/gid65534, zero capabilities, no_new_privs, a new session and a trusted PID1 reaper. The fixed fixture root contains only the Python executable, Python stdlib/x86_64 libraries/loader directory, trusted entry script and private proc/dev/shm/tmp/run/home. It excludes host /etc,/sys,/mnt,/run, DBus/resolver/WSLg and WSLInterop paths. Host root/admin and approved binaries remain trusted. These library directory binds are a fixed fixture profile, not yet an accepted arbitrary-browser root.

The inner stage verifies its fixed environment, uid/gid, only-lo interfaces and zero caps/NNP, sets fixture CPU/address-space/FD/core/file-size limits, then emits gated metadata and blocks on an exact framed release. EOF never releases it. Bwrap --block-fd is not used as an authority gate. Before release the outer monitor independently observes:

- Pinned bwrap, PID1 and stage process births/parent relationships; distinct outer namespaces matching between PID1 and stage.
- Stage and PID1 zero capabilities/NNP, exact stage FD set/types/inode links and /dev/null stdio.
- Exact bounded mountpoint set, read-only executable/library/helper/proc masks, file bind identities matching original approved pins, library bind inode identities and absent host broker paths.
- Repeated birth/kernel checks immediately before release, plus current owner pidfd liveness.

The fixture then execs a single fixed short-lived Python command that forks exactly one bounded child. The monitor independently pins/checks that descendant's birth/parent/namespace relationship. It does not run a browser or general workload. Owner EOF/death, helper death and timeout close the gate/lifecycle; exact owned PID1 pidfd termination kills its namespace descendants. Normal completion waits for PID1, stage and descendant pidfds to signal exit, separately from bwrap monitor exit. An initial immediate check incorrectly reported cleanup_ambiguous because PID1 can still be exiting when the outer bwrap monitor returns; a bounded pidfd drain now establishes actual exit.

No proof/profile path is ever removed by the product helper. Every refusal reports preserveArtifacts:true, including ambiguous teardown; only observed normal fixture completion returns preserveArtifacts:false. Popen child kill is limited to the monitor's own unreaped child, and descendant kills use the pinned PID1 fd. There is no PID/name/token discovery adoption or broad cleanup.

## Reproduced root cause during implementation

The first native mount proof correctly refused a recursive read-only `/usr` bind: WSL's `/usr/lib/wsl/drivers`9p submount was inherited. Earlier report-only absence of /mnt/DBus paths would not have detected that. The fix narrowed the root to required Python/library subtrees rather than accepting the extra mount. Exact mount validation also accounts for bwrap's known read-only proc masks and minimal dev device mounts, not arbitrary new entries. Temporary traceback instrumentation used to locate the refusal was removed; product diagnostics are fixed codes. One fixture edit initially misplaced a finally block, producing SyntaxError; corrected before final validation.

## Observed validation

Final command: `SWITCHYARD_TEST_LINUX_HELPER=1 pnpm --filter switchyard-router exec vitest run tests/browser-linux-helper.test.ts tests/browser-isolation.test.ts tests/browser-pipe.test.ts`.

- 38/38 Vitest cases pass in5.77s overall: 26 unchanged H1 regressions,11 new pure TypeScript cases and1 opt-in native wrapper.
- The native wrapper executes15 Python unittest cases (not an additional38): real namespace fixture execution/descendant drain; pre-release EOF/deadline/wrong nonce/generation; owner SIGKILL and helper SIGKILL at the gate and after execution; pidfd-verified descendant death; inherited socket/environment refusal; AF_UNIX socketpair owner control; changed pins/boot/birth; symlink/writable helper refusal; mocked kernel parent/namespace/capability forgery; malformed/duplicate/deep/oversized JSON and initial EOF/corruption; preserved source/artifact paths on refusal. Direct native run passed15/15 in2.382s before final bound-file identity additions; the final wrapper reran the same15 cases successfully afterward.
- Final router typecheck and build passed after source freeze.
- A separate ordinary uid65534 probe through setpriv returned kernel_proof_unavailable before release. No fallback or privileged installation was attempted. This is not ordinary-user adapter acceptance and remains an explicit blocker to general availability.
- Final cleanup observation: zero `/tmp/switchyard-helper-fixture-*` directories and zero matching running helper processes. All processes/resources were local owned fixtures; no listening ports, services, user profiles or data were used. git diff --check passed; only the four new implementation/test files and this report belong to the unit.

## Deliberate limits and next prerequisites

No Linux Node/Chrome downloads, actual CDP FD3/4 handoff, transport zero-contact sentinel suite, script execution, browser sandbox compatibility, installable helper packaging or hydrated checks were attempted. Existing public unavailable status remains correct. Ordinary-user positive kernel proof is absent; current successful namespace observations ran under the WSL root owner with the inner uid mapping. Kernel/proc restrictions may require a separately reviewed observer design, never JSON attestation fallback.

RLIMITs bound only this deterministic fixture. There is no accepted cgroup/resource delegation, seccomp filter, fork-bomb/memory containment, durable Lab launch record/recovery integration or general browser workload permission. The report's earlier launch-window death prior to bwrap parent-death-hook installation is not deterministically instrumented/accepted here; actual tests cover pre-initial-config failure and the proved gate/after-exec phases. Broader phase injection/OS proof and real-browser acceptance remain required before any available lease.

Pinned paths/hashes are caller-approved trusted inputs; source files and host libraries are not protected against adversarial privileged or same-owner host mutation by this helper. It checks identities and actual binds but does not claim atomic executable sealing against a hostile root/admin. It does not implement host filesystem/native-code sandbox safety or a browser-origin broker. The helper never clears uncertainty or deletes proofs on an unsupported observation.

Supervisor next review: validate this bounded prerequisite independently, decide the ordinary-user proof strategy, resource/lifetime constraints and packaging, then assign H1L-b adapter/nominal-lease factory changes separately. H2 integration and H3 durable recovery remain serial ownership units; no runtime-toggle patch is authorized by this report.

## Review correction: cleanup signal authority

Supervisor review found that a child-pid fd previously became eligible for finally-block SIGKILL before its parent relationship was checked. `pin_owned_pid1` now keeps that fd as a local candidate until the owned bwrap pidfd is live, bwrap's pinned birth still matches, and the candidate's independently observed parent and stable birth bind it to that exact bwrap. Invalid/stale/foreign metadata closes the candidate without granting cleanup authority; the monitor may still kill only its own Popen child and preserves artifact uncertainty. `pin_pid` also closes its fd if its stability check rejects.

Two additional Python regressions exercise this boundary: a forged-info full monitor/finally path names the unrelated fixture-owner process and asserts no pidfd_send_signal call while the owned Popen child's kill path runs; stale bwrap birth closes the candidate fd without signal authority. Signal delivery is mocked in the forged-process test, so regressions cannot harm the runner. Its input/select/environment seams isolate only the monitor scenario; the remaining actual namespace/death cases run unchanged.

Refrozen final focused rerun passes38/38 Vitest in2.86s, now including17/17 native Python cases in the wrapper. Final router typecheck/build passed after this correction. Runtime availability and all limitations above remain unchanged.
