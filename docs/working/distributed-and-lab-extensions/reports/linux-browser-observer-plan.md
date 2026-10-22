# Ordinary-user Linux observer investigation

Status: FROZEN report-only findings; current helper/runtime unchanged and unavailable.
Baseline:a1dfec5; feat/linux-browser-observer-plan. No source/build/config/migration/service changes or commits.

## Exact failure, replacing the earlier hypothesis

The ordinary uid65534 helper does **not** currently fail because kernel proc/ptrace observation is unavailable. It reaches `kernel_proof`'s final `seen == allowed` mountpoint equality (browser-linux-helper.py:241 at this baseline). Its only missing entries are `/proc/sysrq-trigger`, `/proc/irq`, `/proc/bus`; it has zero extra mounts. All earlier parent/birth/pidfd, distinct namespace, stage/PID1 capabilities/NNP, exact descriptor, private-root, executable/helper bind identity, library inode and read-only-present-mount checks passed. No check was weakened, skipped or turned into child JSON attestation to establish that result.

The location was measured by loading the unchanged accepted helper in an owned child with an in-memory `require` observer that logs only the rejecting caller function/line and mount-set difference, then calls the original require unchanged. It does not replace its result or release the gate. Its response remains `refused/kernel_proof_unavailable/preserveArtifacts:true`. The probe ran through `setpriv --reuid 65534 --regid 65534 --clear-groups /usr/bin/python3.10 -I -B -`, using the existing fixture's private temporary helper copy/pins and exact cleanup. No tracked source instrumentation was written.

## Why the mount sets differ

Bubblewrap0.6.1 attempts to cover selected proc surfaces only when its access check finds them writable. Its source skips absent/inaccessible/already-read-only surfaces. That is consistent with the observed privilege-dependent additional masks; it does not justify silently accepting arbitrary omitted or additional mounts. [Approved-version primary source, SETUP_MOUNT_PROC](https://raw.githubusercontent.com/containers/bubblewrap/v0.6.1/bubblewrap.c).

The original ordinary-user proc mount is `rw,nosuid,nodev,noexec,relatime`. `os.access(..., W_OK)` reports false for /proc,/proc/sys,/proc/sysrq-trigger,/proc/irq,/proc/bus, but `statvfs(...).ST_RDONLY` is false. Thus current denial relies on permissions/kernel ownership rather than a read-only mount. Do not describe those unmasked surfaces as inherently mounted read-only.

Bounded native probes used the accepted fixed bwrap argv expression, read from the approved source AST, replaced only its final target with a fixed Python observation command and added explicit `--remount-ro /proc`. No arbitrary browser or model workload was executed. Both direct child observations and exit status were inspected:

| Owner mode | Explicit proc policy | Observed proc mounts | Target status |
|---|---|---|---|
| Ordinary uid65534, original profile | None | /proc only, rw | Exit0; all five queried paths W_OK false, ST_RDONLY false |
| Ordinary uid65534 | --remount-ro /proc | /proc only, ro/nosuid/nodev/noexec | Exit0; all five queried paths W_OK false, ST_RDONLY true |
| Root uid0 owner, inner uid65534 | --remount-ro /proc | /proc ro plus exactly sysrq-trigger/irq/bus read-only submounts | Exit0; all five queried paths ST_RDONLY true |

These observations establish a promising **fixture** correction: explicitly remount /proc read-only and accept only the exact fixed base mount set plus those three optional read-only proc masks. Unknown mounts, duplicate targets, writable proc or missing required nonoptional mounts must still refuse. Do not make every mount optional or infer omitted dangerous paths safe from actor permissions alone. The helper has not been changed or positively rerun with that proposed policy in this report unit.

Important later limitation: a wholly read-only proc may prevent a real Chrome sandbox from writing uid_map/gid_map/setgroups/other required proc controls for its own nested namespace setup. No Chrome is installed or downloaded here, and no browser compatibility or security acceptance follows. A future browser profile must keep Chrome's sandbox enabled and validate the actual restriction; do not use --no-sandbox to make it pass. The fixed prerequisite target does not need such writes.

## Outer-user-namespace feasibility, optional rather than required

An ordinary owner can run `unshare --user --map-root-user /usr/bin/python3.10 ...` here. The observer becomes uid0 only inside a fresh namespace, with uid_map `0 65534 1`, dumpable1 and namespace capabilities. This grants no initial-host root identity. Linux documents that user-namespace privilege is scoped and capabilities can apply to descendants; proc/ptrace access also depends on actual credentials/capabilities and dumpability, so record observations rather than assuming a namespace alone grants every future read. [Linux user namespace contract](https://man7.org/linux/man-pages/man7/user_namespaces.7.html), [ptrace access checks](https://man7.org/linux/man-pages/man2/ptrace.2.html).

A short outer-userns Python observer launched nested bwrap with the same fixed namespace/private-root profile and explicit proc-ro, a fixed gated child, and an info FD. It retained a live pidfd for its ordinary parent outside the namespace. Observed result:

- Exit0; owner pidfd remained live, all seven target namespace IDs differed from the observer.
- Independent target root access, fd symlink reads and mountinfo reads worked. The target had exactly the three probe stdio pipe FDs; this probe did not claim the product's descriptor6/7 handoff.
- Target effective/permitted/inheritable/bounding/ambient capabilities were zero and NoNewPrivs1.
- Child was held on its own EOF-sensitive probe pipe, then closed and waited; target/PID1 pidfds signaled exit. These were fixed observation children, not a browser or nominal lease.

However, running the **unchanged full helper** inside that outer namespace rejects earlier in `check_pin` (line131): initial-host uid0 system executables become unmapped/overflow ownership rather than the current accepted `0 or os.getuid()` ownership set. Preserving human-approved original file authority would require additional deliberately designed opened-file/credential-mapping provenance. No pin check was weakened to obtain a full-helper success.

The outer strategy is therefore feasible for a raw observer but unnecessary for the current measured defect. It adds user mapping, executable ownership, namespace lifetime and credential transitions without fixing the actual exact-mount-set expectation. Retain it as an optional later design if actual browser non-dumpability or tighter kernel policy prevents required independent observations. A target becoming unreadable must continue to fail closed; current dumpable fixture success cannot prove future Chrome remains observable.

## Owner lifetime and unresolved boundaries

The accepted helper's existing owner pidfd/control protocol and gate/death cases remain unchanged. This investigation did not rerun or expand their acceptance. For an outer observer, the owner must remain outside with its original birth/boot proof, retained owner pidfd and EOF channel; unshare must not sever/reparent or leak the owner's write end. A gate must still require an exact nonce release after independent kernel proof, not bwrap info alone. Parent-death credential/fork transitions and the pre-bwrap-hook startup window need separate deterministic death-phase tests before runtime availability. The raw feasibility probe establishes live owner pidfd retention, not a new crash-proof monitor protocol.

No cgroup was created or changed. Namespace capabilities and a cgroup namespace do not provide accepted CPU/memory/process-count delegation. Existing RLIMITs bound only the deterministic fixture. Arbitrary browser resource containment, executable atomic pinning against privileged peers, seccomp, CDP pipe handoff, installable helper packaging, durable Lab recovery and transport zero-contact acceptance are still absent. None are resolved by a proc-ro correction.

## Recommended next source partition

One narrow serial worker owns existing new prerequisite files `labs/browser-linux-helper.py`, its fixed-plan metadata only if needed, `tests/browser-linux-helper.test.ts`, `tests/fixtures/browser-linux-helper-fixture.py` and own report. No changes to H1 public capability/lease, static browser/runtime, manager, configuration, exports or migrations. Supervisor owns integration/authored current-state updates. Outer-userns helper code is not recommended in this correction.

### Proposed implementation brief (12 lines)

1. Implement explicit proc-ro and exact optional mask correction in isolated helper unit.
2. Read accepted helper/report and this measured ordinary-user investigation.
3. Own helper.py, existing helper-specific tests/fixed-plan metadata if necessary and own report only.
4. Add fixed bwrap --remount-ro /proc after private proc construction.
5. Require exact base mounts plus only fixed optional proc sysrq-trigger/irq/bus masks; every present proc mount read-only.
6. Preserve all parent/birth/pidfd/namespace/caps/NNP/FD/root/bind/seal checks and EOF gate.
7. Prove omission is permitted only for the listed proc masks and only under independently enforced proc-ro.
8. Test root and ordinary owner real helper positive execution, gate failure/death and exact-owned cleanup.
9. Test writable/unknown/duplicate/missing-required mounts refuse, without mocked positive kernel proof.
10. Keep cleanup authority hardening and all17 native regressions; add ordinary-user cases explicitly.
11. No outer-userns/root-privilege fallback, Chrome/download/config/resource/runtime/lease changes.
12. Freeze, focused tests/router typecheck/build/report; no commits/shared edits; supervisor verifies.

## Return and cleanup

Only this report was written. No source/build/test-suite execution, host sysctls/ptrace/dumpability settings, cgroup configuration, downloads, engines, services or distro termination. Probe Python processes and namespaces were short-lived and bounded by subprocess deadlines. Temporary files were only the existing fixture's fresh owned helper copies; every fixture teardown ran. No user repositories/configuration/data or listening ports were used. Runtime capability remains unavailable pending separate implementation and independent acceptance.
