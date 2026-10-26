# Independent C2 metadata index transaction review

Reviewer: runtime_path_contract
Date: 2026-10-26
Scope: isolated metadata-exclusion tree; git.ts/process-policy diff, new transaction/staging,
focused tests and author report. No source/main/dist/live changes.
Status: no blocking defect found for trusted-host stage-only contract; C3 commit not accepted.

## Reviewed authority and publication

- Capability is an opaque frozen WeakMap identity. Canonical repository binding, active flag
  and deadline reject copies/forgeries/foreign/replayed/expired authority. Raw GIT_INDEX_FILE
  remains denied; internal environment injection occurs only after capability authorization.
- Command whitelist excludes commit/ref/config mutation; redirection options are denied.
  Internal executable Git config/filter/hook policies remain active. Capability commands cap
  output/time/arguments, and their actual returned promises are tracked for revoke/drain.
- Callback completion revokes its capability before postflight; a private validation scope
  cannot be used by the callback. Unawaited in-flight commands drain and cause refusal.
- Native index.lock and actual worktree Git index resolution are used; ancestry/index/link
  checks refuse foreign redirection. Original index stays untouched until owned lock publish.
  Unborn state initializes a temporary index; committed missing-index case refuses recovery.
- Postflight parses complete index including stage/mode, refuses unmerged/submodule state,
  physical aliases/private paths and bounds. HEAD hash, symbolic branch and original index
  bytes are compared before publish. Cleanup only removes owned lock/temp paths.

## Before-content physical protection

`stageWithoutProjectMetadata` evaluates original positive/negative pathspecs with Git, filters
reserved names and checks ALL selected physical inputs before its first add. Literal chunks
are rechecked before copying. Junction/symlink/hardlink inputs refuse; ordinary missing tracked
paths remain deletions. Complete postflight refuses unsafe index paths outside selection too.
The sentinel tests confirm selected private alias content is absent from Git object storage.

This guarantee belongs to the guarded consumer. The lower-level host callback can deliberately
perform raw add and create objects before postflight fails: it is trusted authority, not a model
sandbox. Preserve this distinction and never expose callback/capability to model-controlled args.

## Independent checks

- Ran `pnpm exec vitest run tests/project-metadata-index-transaction.test.ts --maxWorkers=1`
  in isolated packages/router ->13PASS/1POSIX-only SKIP, exit0,36.30s.
- Independent Node ESM probe transpiled only exact source helpers into a disposable OS-temp
  module fixture, then used actual Git in another directory within that fixture. No repository
  source/dist outputs. Exit0,4.64s; temporary files cleaned.
  - Advance probe-local Date.now beyond capability deadline after temporary add: refused;
    original index byte-identical.
  - Change symbolic HEAD to another existing branch during callback: refused; original index
    byte-identical. Transaction did not roll back the simulated external ref change.
  - Active-capability diff --output redirection: denied.
  - No index.lock or meritrouter-index-* directories remain after these cases.

## Limits and next acceptance gates

- Stage-only transaction never commits/updates HEAD. Its HEAD comparison is a preflight,
  not an atomic ref lock/CAS; external ref updates after that comparison remain a race.
  Do not describe this as an atomic HEAD+index transaction. C2b/C3 needs explicit ref publication.
- Physical checks are preflights, not protection against malicious concurrent link swaps or
  native-lock bypass. Existing trusted Git wrapper policies are not OS sandboxing.
- 60second lease,20k candidate/index entries and32MiB indexes/output may refuse larger/slower
  repositories. Sequential filesystem postflight is bounded but not benchmarked for20k files.
- Never-settling trusted callback can retain its lock; no unsafe automatic stale-lock deletion.
  Filesystem failures may leave owned recovery artifacts; uncertain effects require typed recovery.
- Submodules/symlinks/hardlinks/missing committed index refuse conservatively. Split/sparse index
  portability is not proven. POSIX-only actual trailing-dot/space test is skipped on Windows.
- Exclude setup may change info/exclude even when staging later refuses; original index
  preservation does not imply absolutely no filesystem writes or removal of ordinary Git objects.
- Existing collect/commitAs/initial snapshot/resume callers are untouched; no migration or
  physical project-local storage activation follows from accepting this helper.
