# Linux helper explicit proc policy correction

Status: FROZEN for independent supervisor verification; namespace fixture acceptance only.
Baseline:2506941, feat/linux-browser-proc-policy. No commits/shared-document edits.

## Change and reason

The accepted helper previously required three proc mask mountpoints that ordinary-user Bubblewrap omits. Investigation established that all preceding independent kernel observations succeeded; this was a root-specific exact mount expectation, not a need for additional observer privileges. This unit supersedes the earlier report's ordinary-user unsupported outcome for this fixed helper fixture only.

`labs/browser-linux-helper.py` now adds fixed `--remount-ro /proc` immediately after constructing the private proc mount. The extracted private `validate_mounts` retains all required base entries and permits only the three named optional masks `/proc/sysrq-trigger`, `/proc/irq`, `/proc/bus`. Every present proc mount, including the required base, must be read-only. Existing immutable executable/library/helper mounts remain read-only. Unknown mountpoints, duplicates, missing required entries, malformed and oversized observations still refuse. No blanket optionality, permission-only inference, outer user namespace or privileged fallback was introduced.

Kernel parent/birth/pidfd, owner identity, namespace separation, capabilities/NNP, FD/private-root/bind identity checks, exact nonce/EOF gate, original trusted file pins and candidate PID1 cleanup authority remain intact. Mount policy input is the independently read bounded kernel mountinfo, never a child's public attestation. No changes to plan metadata were necessary.

## Tests and observed evidence

Owned tests changed only `tests/browser-linux-helper.test.ts` and `tests/fixtures/browser-linux-helper-fixture.py`:

- Two additional Python cases exercise all eight subsets of the only three optional masks; writable base/proc masks, unknown proc/WSL mount, duplicate targets, missing required helper/base proc, malformed/oversized/too-many-line observations all refuse. These negative/policy fixtures do not replace positive kernel proof.
- The opt-in native wrapper now runs the full19-case Python suite twice: ordinary setpriv uid65534 and default root uid0. Each invocation reports and asserts its actual UID, zero failures and zero errors. All17 prior native authority/protocol/death regressions remain present.
- Actual root and ordinary-user success includes full helper pin/proc/kernel validation, fixed gate release, executable fixture and independent descendant proof/drain. Actual EOF/wrong-release/deadline and owner/helper SIGKILL cases at the gate and after exec run in both modes, with ancestor pidfd checks for PID1/stage/descendant termination. Forged-info cleanup and stale-owner-birth regressions remain enforced; no foreign signal permission is granted.

Final focused command after source freeze:

`SWITCHYARD_TEST_LINUX_HELPER=1 pnpm --filter switchyard-router exec vitest run tests/browser-linux-helper.test.ts tests/browser-isolation.test.ts tests/browser-pipe.test.ts`

Observed39/39 Vitest cases pass in10.53s overall:26 unchanged H1 cases,11 pure plan cases and2 native wrappers. Root native wrapper6.654s; ordinary wrapper3.258s. Each executes the19-case Python suite; do not count wrappers as separate proof of a browser. Final router typecheck and build both pass. git diff --check passes. Final cleanup query reports zero owned fixture directories and zero running fixture helpers; old untracked validation logs remain preserved.

Only helper.py, the two helper-specific test files and this new report changed. No user data/configuration, listening ports, host settings, services, engines, cgroup configuration, downloads or distro changes.

## Limits retained

This establishes ordinary-user **fixed namespace fixture** behavior on the installed Ubuntu WSL2 substrate, not general Linux or browser availability. No Chrome, CDP pipe handoff, arbitrary application scripts, transport zero-contact suite, accepted nominal isolation lease, durable Lab recovery, installable Python-helper packaging, seccomp or cgroup/resource delegation was added or verified. Existing public runtime remains unavailable.

Explicit proc-ro may prevent future Chrome sandbox uid_map/gid_map/setgroups writes or other required proc controls. Actual Chrome compatibility is unresolved, and disabling its sandbox is not an acceptable substitute. The fixed trusted short-lived target needs no such writes. Earlier resource-limit and deterministic pre-bwrap-hook startup-death limitations remain unchanged; RLIMITs bound this fixture only. All privileged/same-owner adversarial host mutation exclusions and artifact-preservation requirements from the accepted helper report still apply.

Supervisor must independently verify this correction before integration. Any later browser/root policy, ordinary-user platform expansion, resource containment or runtime availability needs its separately written bounded brief.
