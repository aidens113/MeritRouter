# Portable Linux Node/Chrome fixture preparation

Status: FROZEN report-only result. Reusable tools prepared; accepted helper proc-ro profile blocks real Chrome's normal sandbox. Runtime remains unavailable.
Baseline:351d867, feat/linux-browser-fixture-preparation. Product source/configuration/migrations unchanged; no commits.

## Reusable fixture and private provenance

Supervisor-authorized retained fixture:

- Root `/var/tmp/switchyard-browser-tools-7krb8yzs` (0711 traversal only); browser-readable root-owned `tools/` is separate from root-only `control/` (0700).
- Private manifest `/var/tmp/switchyard-browser-tools-7krb8yzs/control/manifest.json` (0600), final SHA256 `472527c3f5ce27eaa7982de4384d2b7367c7584d70ef26e9bcce465ba6ece31e`.
- Tiny private provenance mirror `C:\Users\mrjoh\AppData\Local\Temp\switchyard-browser-fixture-tsy7dr66\manifest.json`; Linux path `/mnt/c/Users/mrjoh/AppData/Local/Temp/switchyard-browser-fixture-tsy7dr66/manifest.json`. This is owned Windows TEMP, not repository/user configuration.
- Node executable `/var/tmp/switchyard-browser-tools-7krb8yzs/tools/node-v22.23.4-linux-x64/bin/node`.
- Full Chrome executable `/var/tmp/switchyard-browser-tools-7krb8yzs/tools/chrome-linux64/chrome`.
- State `reusable_tools_ready_browser_proc_ro_profile_blocked`, runtimeEnabled:false. Revalidate manifests/hashes before future use; these are local fixture paths, not shipped trusted profiles.

Observed WSL boot ID during retained preparation/final cleanup: `cbebf04d-71d1-4aaf-926d-7b81b3f10bc0`. Tools are read/execute for ordinary uid65534 and were mounted read-only for probes. Manifest/control, archives, release metadata/key/signature status, ELF needs/hashes and bounded probe diagnostics remain private. All generated browser homes/profiles were removed after namespace exit proof; no running fixture process remains.

## Official provenance and archive checks

Node22 selection came from official current22.x checksum metadata, then version-specific SHASUMS and detached signature. Downloaded archive: [node-v22.23.4-linux-x64.tar.xz](https://nodejs.org/download/release/v22.23.4/node-v22.23.4-linux-x64.tar.xz),31,029,996 bytes. SHA256 `1805bcd35e6815559bd2eb97db438d3fdb0eb3a5e6a977b7c1badca76337e9ce` exactly matches the signed version-specific [SHASUMS256.txt](https://nodejs.org/download/release/v22.23.4/SHASUMS256.txt). Detached [signature](https://nodejs.org/download/release/v22.23.4/SHASUMS256.txt.sig) verification succeeded with fingerprint `5BE8A3F6C8A5C01D106C0AD820B1A390B168D356`, fetched from the official release-keys repository and checked against its listed fingerprint before import. GPG used only an owned control-directory keyring, --no-options/--batch/--no-autostart; no personal keyring or installed service was modified. [Official key](https://raw.githubusercontent.com/nodejs/release-keys/main/keys/5BE8A3F6C8A5C01D106C0AD820B1A390B168D356.asc), [authorized key list](https://raw.githubusercontent.com/nodejs/release-keys/main/keys.list), [verification guidance](https://github.com/nodejs/release-keys).

Trust basis: cryptographically valid signature with an official TLS-fetched listed Node release key and matching archive checksum. This does not claim a personal Web of Trust or independent out-of-band key authentication. Metadata, key bytes/URL, checksum bytes and GPG status are retained in control.

Chrome selection came from official [Chrome for Testing JSON](https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json), timestamp2026-10-22T20:37:14.033Z: stable156.0.8078.47, revision1706539, Linux64 full Chrome. [Exact archive](https://storage.googleapis.com/chrome-for-testing-public/156.0.8078.47/linux64/chrome-linux64.zip),200,206,486 bytes, locally computed SHA256 `e6c94490f0b6b337225aeb2d2a5034858516b7017356980ba94f5176d8774a50`. Metadata has no publisher SHA256; this is explicitly a locally recorded TLS/official-metadata fixture hash, not an independently signed publisher digest. [Official download metadata contract](https://github.com/GoogleChromeLabs/chrome-for-testing/blob/main/README.md).

Both archives were fully inspected before extraction:6,175 entries,617,498,400 uncompressed bytes,5,051 regular files. Archives total231,236,482 compressed bytes, below512MiB; extraction below2GiB. Before extracting anything, checks rejected absolute/traversal/empty/dot/backslash/NUL paths, duplicate entries, symlink ancestors, escaping/absolute/cyclic/indirect links, special/setuid/setgid files, encrypted/unsupported ZIP members, excessive names/counts and sizes. Relative links had to resolve within the archive's top-level root to a known regular/directory target; hardlinks to a known regular file. Files were explicitly created, directory modes0755, executable files0755 and other files0644; no archive extractall or archive ownership restoration. Browser-readable tree contains neither control metadata nor mutable profiles.

Deterministic extracted tree SHA256: `0a5ac1b5a82bcd3027fe91b63da6aac8aa8dd956cda109734bcaba7dee4787e3`. Algorithm walks sorted directories without following links; for each sorted directory/file name hashes UTF-8 JSON `[relativePath,mode&0777,token]` plus newline, where token is `dir`, `link:<literalTarget>` or the regular file's SHA256. The manifest retains archive/tree and individual ELF hashes. All nine ELF hashes were rechecked unchanged after execution.

## Preparation failures handled without product changes

Initial `/tmp/switchyard-browser-tools-ktk4vxxr` metadata/download/signature completed, but the whole directory disappeared before extraction. No binary from it executed. The cause remains unestablished: root reported no cleanup/restart; later inspection found /tmp on ext4, mode1777, with systemd tmpfiles `D /tmp` configuration. The first attempt did not record boot ID, so restart/cleanup cannot be inferred or ruled out. No host setting was changed. Supervisor authorized /var/tmp and a Windows TEMP provenance mirror; the retained fixture remained present across subsequent calls. The initial vanished archives plus retained archives total462,472,964 downloaded archive bytes, still below512MiB; only one fixture is retained.

An initial extraction implementation sought compressed tar members in sorted path order, causing repeated XZ decompression. Before any downloaded binary execution, the exact prep process was identified by its open private archive FD and fixed command, pinned with a pidfd and interrupted (PID507). Only the owned partial tools directory was removed after the process exited and its resolved path was checked. All archive checks were rerun and extraction resumed in forward sequential tar order. Node/Chrome archives and metadata were retained and rehashed. No broad process/distro kill or unrelated path deletion occurred.

## Dependency and bounded execution results

Before executing archive binaries, host readelf inspected DT_NEEDED on all9 ELF files. After provenance validation, ldd reported no missing dependencies for Node, Chrome, crashpad handler, chrome_sandbox, libEGL, libGLESv2, libvk_swiftshader, libvulkan and Widevine ELF. This is basic dynamic linking evidence, not complete runtime feature/dependency acceptance. No apt, external native module, Windows node_modules or system library copy/install was used.

All measured target processes ran as ordinary uid65534 through setpriv and explicit bwrap user/net/PID/mount/IPC/UTS/cgroup namespaces, private empty run/tmp/home/dev/proc, cleared environment, zero capabilities and a read-only tools/library/font tree. No host DBus/resolver/WSLg socket directories were mounted. Normal Chrome sandbox switches were left enabled: no --no-sandbox, no privileged/setuid helper installation. Background-network flags were fixed: disable-background-networking/component-update/sync/quic, no-first-run/default-browser-check/pings, metrics-recording-only, basic password store/mock keychain, dead-end proxy with loopback bypass removed, resolver MAP * ~NOTFOUND, and nonproxied UDP handling disabled. These flags are defense in depth, not universal transport proof.

Only `--version` and fixed `--dump-dom about:blank` were run. No application URL, provider, custom script, CDP evaluate, service or model traffic. Every command had a15s deadline and bounded64KiB stdout/stderr buffers. Private manifest records exact argv, timestamps, PID/startTicks and exit/cleanup. Launcher and reported PID1 births/parent relationships were independently checked before granting PID1 pidfd cleanup authority; namespace exit was observed before removing each generated profile.

| Probe | Proc policy | Exit / duration | Actual result |
|---|---|---|---|
| Node --version | read-only | 0 /0.097s | v22.23.4 |
| Chrome --version | read-only | 0 /0.236s | Google Chrome for Testing156.0.8078.47 |
| Chrome about:blank, normal sandbox | read-only | 134 /0.157s | Fatal “No usable sandbox!”, no DOM |
| Controlled same-argv Chrome comparison | diagnostic proc-rw only | 0 /1.163s | Expected `<html><head></head><body></body></html>` |

The proc-rw comparison was separately explicitly authorized by the supervisor and changed only the probe's proc remount setting; all other namespace/root/ordinary-user/normal-sandbox/target arguments stayed the same. It is a diagnostic result, not an accepted isolation profile or a product/helper policy change. DBus/GLib warnings in the successful comparison reflect deliberately absent buses/schema paths; no host bus was exposed to silence them. Sandbox-on command success was observed; individual renderer seccomp/namespace internals were not separately attested.

## Precise current blocker

A bounded fixed Python namespace probe under proc-ro successfully performed unshare(CLONE_NEWUSER), but opening `/proc/self/uid_map` O_WRONLY returned EROFS30; no UID-map or host-setting write occurred. Chromium's current primary source checks namespace sandbox usability by creating a new user namespace and setting GID/UID maps; failures leave neither namespace nor setuid sandbox selected and produce the observed fatal error. [Credentials namespace/map logic](https://raw.githubusercontent.com/chromium/chromium/main/sandbox/linux/services/credentials.cc), [zygote sandbox selection](https://raw.githubusercontent.com/chromium/chromium/main/content/browser/zygote_host/zygote_host_impl_linux.cc).

Together with the one-variable successful comparison, this supports proc-ro incompatibility as the measured profile blocker. The fatal message's generic AppArmor guidance is not proof that host AppArmor disabled user namespaces here. The source links are current upstream explanatory evidence, not a claim of exact downloaded binary source attestation. No sysctl/AppArmor/ptrace/system policy was changed. The accepted product helper still runs only namespace_fixture_v1 with explicit proc-ro; its current public runtime remains unavailable.

## Next bounded work and source partition

First resolve a **new browser proc policy** in a separately reviewed unit. Do not silently weaken the accepted fixture's proc-ro proof to match the diagnostic. It must permit Chrome's own per-process namespace setup while independently proving dangerous/global proc surfaces cannot be mutated, host process/FD access remains inaccessible, and descendant-created namespaces cannot escape the outer owner lifetime. Prove this under ordinary owner and nested Chrome credentials, not just initial os.access checks. Root-mode browser execution or SUID helper installation is not the proposed solution.

Proposed next brief (15 lines):

1. Read this report, current helper/proc proof and original hydrated design.
2. Own new browser-linux-browser-profile plan/probe files/tests and own report only.
3. Keep existing helper fixture target/public unavailable status/config/exports/migrations unchanged.
4. Reuse verified retained tools after fresh manifest/ELF hash checks; no new downloads/installs.
5. Design closed ordinary-user browser-specific proc/root policy with normal Chrome sandbox intact.
6. Establish kernel protection of global/dangerous proc under initial and nested userns credentials.
7. Independently verify exact mounts/process births/FDs/caps and outer PID lifetime; no child JSON authority.
8. Fixed blank/static fixture only; bounded stderr, deadlines and exact-owned cleanup.
9. Test owner/helper death including pre-release launch windows; preserve proof if cleanup ambiguous.
10. No arbitrary app/javascript/network target or runtime lease until policy reviewed.
11. Separate later unit owns real FD3/4 CDP adapter/private nominal-lease constructor after policy acceptance.
12. CDP unit proves actual pipe transport and normal sandbox with private browser profile, never evaluate authority.
13. Separate resource unit proves delegated bounded process/memory/CPU containment; cgroup namespace alone is insufficient.
14. Durable recovery, zero-contact transport sentinels and H2/H3 integration remain separate acceptance.
15. Freeze/check/report exact limits; supervisor integrates; no commits/shared edits.

## Cleanup and final scope

Final manifest: four runs all have observed namespace exit; runs directory empty, no matching owned tool launcher, nine ELF hashes unchanged. PID1 lifetime covered all descendants in each owned namespace. No probe process/service remains. Only reusable verified archives/tools/private metadata and Windows TEMP provenance mirror remain intentionally retained. Existing untracked workspace logs preserved.

Only this tracked report was authored. No product source/build/public export/config/migration changes, paid quota, engines, OS service/firewall/cgroup changes or user data. Ordinary tools/basic diagnostic success is not hydrated-browser, resource containment, zero-contact, installation/package or runtime-availability completion.
