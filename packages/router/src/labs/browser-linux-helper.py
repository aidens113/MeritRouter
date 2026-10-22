"""Trusted Linux namespace fixture prerequisite. No browser, arbitrary exec or runtime lease.

Protocol and proc observations are private. All errors are fixed codes; never echo config.
Installed helper/executable pins and the kernel are the caller's trust boundary.
"""
import ctypes
import hashlib
import json
import os
import re
import resource
import select
import signal
import socket
import stat
import subprocess
import sys
import time

MAX_FRAME = 8192
NAMESPACES = ("net", "mnt", "pid", "user", "ipc", "uts", "cgroup")


class Refused(Exception):
    def __init__(self, code):
        self.code = code


def require(condition, code="invalid_input"):
    if not condition:
        raise Refused(code)


def keys(value, wanted):
    require(type(value) is dict and set(value) == set(wanted))


def integer(value, low, high):
    require(type(value) is int and low <= value <= high)


def bounded_json(frame):
    require(type(frame) is bytes and 0 < len(frame) <= MAX_FRAME)
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result)
            result[key] = value
        return result
    value = json.loads(frame.decode("utf-8", "strict"), object_pairs_hook=pairs,
                       parse_constant=lambda _: (_ for _ in ()).throw(Refused("invalid_input")))
    nodes = [0]
    def visit(v, depth):
        nodes[0] += 1
        require(nodes[0] <= 200 and depth <= 8)
        if type(v) is dict:
            for key, item in v.items():
                require(type(key) is str)
                visit(item, depth + 1)
        else:
            require(type(v) in (str, int, bool) or v is None)
    visit(value, 0)
    return value


def frame(fd, deadline):
    # Byte-at-a-time is bounded at8KiB and leaves following protocol frames unread.
    result = bytearray()
    while True:
        remaining = deadline - time.monotonic()
        require(remaining > 0, "deadline")
        require(select.select([fd], [], [], remaining)[0], "deadline")
        byte = os.read(fd, 1)
        require(byte, "owner_closed")
        if byte == b"\n":
            return bounded_json(bytes(result))
        result.extend(byte)
        require(len(result) <= MAX_FRAME)


def emit(fd, value):
    data = json.dumps(value, separators=(",", ":")).encode() + b"\n"
    require(len(data) <= MAX_FRAME)
    # Protocol messages fit PIPE_BUF; owner/event readers must remain bounded consumers.
    require(os.write(fd, data) == len(data), "protocol_io")


def birth(pid):
    text = open("/proc/%d/stat" % pid, encoding="ascii").read(4096)
    fields = text.rsplit(") ", 1)[1].split()
    return {"pid": pid, "parent": int(fields[1]), "startTicks": fields[19]}


def boot_id():
    return open("/proc/sys/kernel/random/boot_id", encoding="ascii").read(64).strip()


def validate_launch(value):
    keys(value, ("version", "generation", "nonce", "target", "deadlineMs", "owner", "pins"))
    require(type(value["version"]) is int and value["version"] == 1)
    require(type(value["generation"]) is str and re.fullmatch("[0-9a-f]{32}", value["generation"]))
    require(type(value["nonce"]) is str and re.fullmatch("[0-9a-f]{64}", value["nonce"]))
    require(value["target"] == "namespace_fixture_v1")
    integer(value["deadlineMs"], 500, 10000)
    keys(value["owner"], ("pid", "startTicks", "bootId"))
    integer(value["owner"]["pid"], 1, 2**31 - 1)
    require(type(value["owner"]["startTicks"]) is str and re.fullmatch("[1-9][0-9]{0,19}", value["owner"]["startTicks"]))
    require(type(value["owner"]["bootId"]) is str and re.fullmatch("[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}", value["owner"]["bootId"]))
    keys(value["pins"], ("bwrap", "python", "helper"))
    identities = set()
    for kind, pin in value["pins"].items():
        keys(pin, ("path", "device", "inode", "size", "sha256"))
        p = pin["path"]
        require(type(p) is str and 1 < len(p) <= 1024 and p.startswith("/") and not p.startswith("//") and not any(c in p for c in "\x00\r\n") and not any(s in (".", "..") for s in p.split("/")))
        require(os.path.realpath(p) == p, "unapproved_executable")
        if kind != "helper":
            require(p == {"bwrap": "/usr/bin/bwrap", "python": "/usr/bin/python3.10"}[kind], "unapproved_executable")
        integer(pin["device"], 0, 2**53 - 1)
        integer(pin["inode"], 1, 2**53 - 1)
        integer(pin["size"], 1, 32 * 1024 * 1024)
        require(type(pin["sha256"]) is str and re.fullmatch("[0-9a-f]{64}", pin["sha256"]))
        require((pin["device"], pin["inode"]) not in identities, "unapproved_executable")
        identities.add((pin["device"], pin["inode"]))
    return value


def check_pin(pin):
    fd = os.open(pin["path"], os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and not info.st_mode & 0o6022 and info.st_uid in (0, os.getuid()), "unapproved_executable")
        require((info.st_dev, info.st_ino, info.st_size) == (pin["device"], pin["inode"], pin["size"]), "unapproved_executable")
        digest = hashlib.sha256()
        read_bytes = 0
        while True:
            data = os.read(fd, 65536)
            if not data:
                break
            read_bytes += len(data)
            require(read_bytes <= pin["size"], "unapproved_executable")
            digest.update(data)
        require(digest.hexdigest() == pin["sha256"], "unapproved_executable")
        require(os.fstat(fd).st_mtime_ns == info.st_mtime_ns, "unapproved_executable")
    finally:
        os.close(fd)
    # Parent-writable helper directory must be private, never a shared symlinked ancestor.
    parent = os.path.dirname(pin["path"])
    while parent != "/":
        meta = os.stat(parent, follow_symlinks=False)
        require(stat.S_ISDIR(meta.st_mode) and (not meta.st_mode & 0o022 or parent == "/tmp" and meta.st_mode & stat.S_ISVTX), "unapproved_executable")
        parent = os.path.dirname(parent)


def owner_channel(fd):
    mode = os.fstat(fd).st_mode
    if stat.S_ISFIFO(mode):
        return
    require(stat.S_ISSOCK(mode), "invalid_descriptor")
    sock = socket.socket(fileno=os.dup(fd))
    try:
        require(sock.family == socket.AF_UNIX and sock.type == socket.SOCK_STREAM, "invalid_descriptor")
        sock.getpeername()
    finally:
        sock.close()


def release(value, generation, nonce):
    keys(value, ("op", "generation", "nonce"))
    require(value["op"] == "release" and value["generation"] == generation and value["nonce"] == nonce, "invalid_release")


def capabilities(pid):
    rows = {}
    for line in open("/proc/%d/status" % pid, encoding="ascii"):
        key, _, value = line.partition(":")
        if key.startswith("Cap") or key == "NoNewPrivs":
            rows[key] = value.strip()
    require(all(rows.get(k) == "0000000000000000" for k in ("CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb")) and rows.get("NoNewPrivs") == "1", "kernel_proof_unavailable")


def pin_pid(pid):
    before = birth(pid)
    fd = os.pidfd_open(pid, 0)
    try:
        require(birth(pid) == before, "kernel_proof_unavailable")
        return fd, before
    except BaseException:
        os.close(fd)
        raise


def pin_owned_pid1(pid, bwrap_fd, bwrap_birth):
    # Untrusted child-pid metadata must never grant cleanup signal authority.
    candidate_fd, candidate_birth = pin_pid(pid)
    try:
        require(not select.select([bwrap_fd], [], [], 0)[0], "kernel_proof_unavailable")
        require(birth(bwrap_birth["pid"]) == bwrap_birth and candidate_birth["parent"] == bwrap_birth["pid"], "kernel_proof_unavailable")
        require(birth(pid) == candidate_birth, "kernel_proof_unavailable")
        return candidate_fd, candidate_birth
    except BaseException:
        os.close(candidate_fd)
        raise


def kernel_proof(pid1, stage, bwrap_pid, expected_fds, pins):
    require(birth(pid1)["parent"] == bwrap_pid and birth(stage)["parent"] == pid1, "kernel_proof_unavailable")
    ns = {}
    for name in NAMESPACES:
        expected = os.readlink("/proc/%d/ns/%s" % (pid1, name))
        require(expected == os.readlink("/proc/%d/ns/%s" % (stage, name)) and expected != os.readlink("/proc/self/ns/" + name), "kernel_proof_unavailable")
        ns[name] = expected
    capabilities(pid1)
    capabilities(stage)
    descriptors = os.listdir("/proc/%d/fd" % stage)
    require(set(descriptors) == {"0", "1", "2", "6", "7"}, "invalid_descriptor")
    for n in (0, 1, 2):
        require(os.readlink("/proc/%d/fd/%d" % (stage, n)) == "/dev/null", "invalid_descriptor")
    for n in (6, 7):
        require(os.readlink("/proc/%d/fd/%d" % (stage, n)) == expected_fds[n], "invalid_descriptor")
    root = "/proc/%d/root" % stage
    for p in ("run/dbus/system_bus_socket", "run/systemd/resolve/io.systemd.Resolve", "mnt", "sys", "etc", "proc/sys/fs/binfmt_misc/WSLInterop"):
        require(not os.path.exists(root + "/" + p), "kernel_proof_unavailable")
    for kind, target in (("python", "/usr/bin/python3.10"), ("helper", "/fixture/entry.py")):
        actual = os.stat(root + target)
        expected = pins[kind]
        require((actual.st_dev, actual.st_ino, actual.st_size) == (expected["device"], expected["inode"], expected["size"]), "kernel_proof_unavailable")
    for target in ("/usr/lib/python3.10", "/usr/lib/x86_64-linux-gnu", "/usr/lib64"):
        actual, expected = os.stat(root + target), os.stat(target)
        require((actual.st_dev, actual.st_ino) == (expected.st_dev, expected.st_ino), "kernel_proof_unavailable")
    allowed = {"/", "/usr/bin/python3.10", "/usr/lib/python3.10", "/usr/lib/x86_64-linux-gnu", "/usr/lib64", "/proc", "/dev", "/dev/null", "/dev/zero", "/dev/full", "/dev/random", "/dev/urandom", "/dev/tty", "/proc/sysrq-trigger", "/proc/irq", "/proc/bus", "/dev/pts", "/dev/shm", "/tmp", "/run", "/fixture/entry.py"}
    mount_text = open("/proc/%d/mountinfo" % stage, encoding="utf-8").read(65537)
    require(len(mount_text) <= 65536 and len(mount_text.splitlines()) <= 64, "kernel_proof_unavailable")
    seen = set()
    readonly = {"/usr/bin/python3.10", "/usr/lib/python3.10", "/usr/lib/x86_64-linux-gnu", "/usr/lib64", "/fixture/entry.py", "/proc/sysrq-trigger", "/proc/irq", "/proc/bus"}
    for line in mount_text.splitlines():
        parts = line.split()
        require(parts[4] in allowed and parts[4] not in seen, "kernel_proof_unavailable")
        seen.add(parts[4])
        if parts[4] in readonly:
            require("ro" in parts[5].split(","), "kernel_proof_unavailable")
    require(seen == allowed, "kernel_proof_unavailable")
    return ns


def inner(generation, nonce):
    require(re.fullmatch("[0-9a-f]{32}", generation) and re.fullmatch("[0-9a-f]{64}", nonce))
    require(os.getuid() == 65534 and os.getgid() == 65534, "kernel_proof_unavailable")
    require(set(os.environ) <= {"PATH", "LANG", "HOME", "PWD"}, "invalid_environment")
    require(os.environ.get("PATH") == "/usr/bin:/bin" and os.environ.get("HOME") == "/home/fixture", "invalid_environment")
    require(socket.if_nameindex() == [(1, "lo")], "kernel_proof_unavailable")
    capabilities(os.getpid())
    # Fixed fixture bounds only; RLIMIT_NPROC is deliberately not claimed as browser containment.
    for kind, value in ((resource.RLIMIT_CPU, 2), (resource.RLIMIT_AS, 256 * 1024 * 1024), (resource.RLIMIT_NOFILE, 32), (resource.RLIMIT_CORE, 0), (resource.RLIMIT_FSIZE, 0)):
        resource.setrlimit(kind, (value, value))
    emit(7, {"event": "gated", "generation": generation})
    release(frame(6, time.monotonic() + 10), generation, nonce)
    os.close(6)
    emit(7, {"event": "executing", "generation": generation})
    # Execute only this fixed short-lived fixture. There is no browser path/argv mode.
    os.execve("/usr/bin/python3.10", ["/usr/bin/python3.10", "-I", "-B", "-c", "import os,time; p=os.fork(); os.write(7,b'executed\\n') if p else None; time.sleep(0.35 if p else 0.25); os._exit(0)"], {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"})


def monitor():
    require(sys.platform == "linux" and os.uname().machine == "x86_64" and hasattr(os, "pidfd_open") and hasattr(signal, "pidfd_send_signal"), "unsupported_host")
    owner_channel(0)
    actual_fds = set()
    for candidate in os.listdir("/proc/self/fd"):
        try:
            os.fstat(int(candidate))
            actual_fds.add(candidate)
        except OSError:
            pass
    require(actual_fds == {"0", "1", "2"}, "invalid_descriptor")
    config = validate_launch(frame(0, time.monotonic() + 2))
    require(config["owner"]["pid"] == os.getppid() and birth(os.getppid())["startTicks"] == config["owner"]["startTicks"] and boot_id() == config["owner"]["bootId"], "owner_identity_mismatch")
    # Monitor itself is trusted; caller must not inject Python/loader options.
    require(set(os.environ) <= {"PATH", "LANG"} and os.environ.get("PATH") == "/usr/bin:/bin", "invalid_environment")
    for pin in config["pins"].values():
        check_pin(pin)
    require(os.path.realpath(__file__) == config["pins"]["helper"]["path"], "unapproved_executable")
    version = subprocess.run(["/usr/bin/bwrap", "--version"], capture_output=True, timeout=1, env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"})
    require(version.returncode == 0 and version.stdout == b"bubblewrap 0.6.1\n", "unsupported_host")
    deadline = time.monotonic() + config["deadlineMs"] / 1000
    owner_fd, _ = pin_pid(config["owner"]["pid"])
    fds = [owner_fd]
    process = None
    pid1_fd = None
    stage_fd = None
    clean = False
    try:
        # Duplicates are moved high before reserving the exact child-only descriptors.
        import fcntl
        def pipe():
            pair = os.pipe2(os.O_CLOEXEC)
            high = tuple(fcntl.fcntl(fd, fcntl.F_DUPFD_CLOEXEC, 16) for fd in pair)
            for fd in pair:
                os.close(fd)
            fds.extend(high)
            return high
        gate_read, gate_write = pipe()
        status_read, status_write = pipe()
        info_read, info_write = pipe()
        expected = {6: os.readlink("/proc/self/fd/%d" % gate_read), 7: os.readlink("/proc/self/fd/%d" % status_write)}
        for source, dest in ((gate_read, 6), (status_write, 7), (info_write, 8)):
            os.dup2(source, dest, inheritable=True)
            fds.append(dest)
        argv = ["/usr/bin/bwrap", "--unshare-user", "--uid", "65534", "--gid", "65534", "--unshare-net", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--unshare-cgroup", "--die-with-parent", "--new-session", "--cap-drop", "ALL", "--clearenv", "--setenv", "PATH", "/usr/bin:/bin", "--setenv", "LANG", "C.UTF-8", "--setenv", "HOME", "/home/fixture", "--ro-bind", "/usr/bin/python3.10", "/usr/bin/python3.10", "--ro-bind", "/usr/lib/python3.10", "/usr/lib/python3.10", "--ro-bind", "/usr/lib/x86_64-linux-gnu", "/usr/lib/x86_64-linux-gnu", "--ro-bind", "/usr/lib64", "/usr/lib64", "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64", "--symlink", "usr/bin", "/bin", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/dev/shm", "--tmpfs", "/tmp", "--tmpfs", "/run", "--dir", "/home/fixture", "--ro-bind", config["pins"]["helper"]["path"], "/fixture/entry.py", "--chdir", "/tmp", "--info-fd", "8", "/usr/bin/python3.10", "-I", "-B", "/fixture/entry.py", "--inner", config["generation"], config["nonce"]]
        process = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, pass_fds=(6, 7, 8), env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"})
        bwrap_fd, bwrap_birth = pin_pid(process.pid)
        fds.append(bwrap_fd)
        for fd in (gate_read, status_write, info_write, 6, 7, 8):
            os.close(fd)
            fds.remove(fd)
        # Bwrap info is corroborated against direct proc parent/birth observations below.
        info_bytes = bytearray()
        while True:
            require(time.monotonic() < deadline, "deadline")
            ready = select.select([info_read, 0, owner_fd], [], [], max(0, deadline - time.monotonic()))[0]
            require(ready, "deadline")
            require(0 not in ready and owner_fd not in ready, "owner_closed")
            data = os.read(info_read, 1024)
            if not data:
                break
            info_bytes.extend(data)
            require(len(info_bytes) <= MAX_FRAME)
        info = bounded_json(bytes(info_bytes))
        integer(info.get("child-pid"), 1, 2**31 - 1)
        pid1 = info["child-pid"]
        pid1_fd, pid1_birth = pin_owned_pid1(pid1, bwrap_fd, bwrap_birth)
        fds.append(pid1_fd)
        gated = frame(status_read, deadline)
        require(gated == {"event": "gated", "generation": config["generation"]}, "invalid_release")
        children = open("/proc/%d/task/%d/children" % (pid1, pid1), encoding="ascii").read(4096).split()
        require(len(children) == 1, "kernel_proof_unavailable")
        stage = int(children[0])
        stage_fd, stage_birth = pin_pid(stage)
        fds.append(stage_fd)
        namespaces = kernel_proof(pid1, stage, process.pid, expected, config["pins"])
        emit(1, {"event": "ready", "generation": config["generation"], "runtimeEnabled": False, "proof": {"pid1": pid1_birth, "stage": stage_birth, "namespaces": namespaces}})
        ready = select.select([0, owner_fd, bwrap_fd], [], [], max(0, deadline - time.monotonic()))[0]
        require(ready, "deadline")
        require(owner_fd not in ready and bwrap_fd not in ready, "owner_closed")
        command = frame(0, deadline)
        release(command, config["generation"], config["nonce"])
        require(birth(pid1) == pid1_birth and birth(stage) == stage_birth, "kernel_proof_unavailable")
        kernel_proof(pid1, stage, process.pid, expected, config["pins"])
        require(not select.select([owner_fd], [], [], 0)[0], "owner_closed")
        emit(gate_write, command)
        require(frame(status_read, deadline) == {"event": "executing", "generation": config["generation"]}, "invalid_release")
        marker = bytearray()
        while b"\n" not in marker:
            ready = select.select([status_read, 0, owner_fd], [], [], max(0, deadline - time.monotonic()))[0]
            require(ready, "deadline")
            require(0 not in ready and owner_fd not in ready, "owner_closed")
            data = os.read(status_read, 32)
            require(data, "fixture_failed")
            marker.extend(data)
            require(len(marker) <= 32)
        require(marker == b"executed\n", "fixture_failed")
        descendants = open("/proc/%d/task/%d/children" % (stage, stage), encoding="ascii").read(4096).split()
        require(len(descendants) == 1, "kernel_proof_unavailable")
        descendant_fd, descendant_birth = pin_pid(int(descendants[0]))
        fds.append(descendant_fd)
        require(descendant_birth["parent"] == stage, "kernel_proof_unavailable")
        for name in NAMESPACES:
            require(os.readlink("/proc/%d/ns/%s" % (descendant_birth["pid"], name)) == namespaces[name], "kernel_proof_unavailable")
        emit(1, {"event": "executed", "generation": config["generation"], "runtimeEnabled": False, "fixtureDescendant": descendant_birth})
        while process.poll() is None:
            remaining = deadline - time.monotonic()
            require(remaining > 0, "deadline")
            ready = select.select([0, owner_fd, bwrap_fd], [], [], min(remaining, 0.05))[0]
            require(0 not in ready and owner_fd not in ready, "owner_closed")
        require(process.returncode == 0, "fixture_failed")
        pending = {pid1_fd, stage_fd, descendant_fd}
        while pending:
            remaining = min(deadline - time.monotonic(), 1)
            require(remaining > 0, "cleanup_ambiguous")
            exited = select.select(list(pending), [], [], remaining)[0]
            require(exited, "cleanup_ambiguous")
            pending.difference_update(exited)
        clean = True
        emit(1, {"event": "closed", "runtimeEnabled": False, "preserveArtifacts": False})
    finally:
        # Never unlink proof/profile paths: this prerequisite returns disposition only.
        if process is not None and not clean:
            if pid1_fd is not None:
                try:
                    signal.pidfd_send_signal(pid1_fd, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            if process.poll() is None:
                process.kill()
            try:
                process.wait(timeout=1)
            except subprocess.TimeoutExpired:
                pass
        for fd in set(fds):
            try:
                os.close(fd)
            except OSError:
                pass


def main():
    try:
        if len(sys.argv) == 2 and sys.argv[1] == "--monitor":
            monitor()
        elif len(sys.argv) == 4 and sys.argv[1] == "--inner":
            inner(sys.argv[2], sys.argv[3])
        else:
            raise Refused("invalid_input")
        return 0
    except BaseException as error:
        code = error.code if isinstance(error, Refused) else "unsupported_host"
        try:
            emit(1, {"event": "refused", "code": code, "runtimeEnabled": False, "preserveArtifacts": True})
        except BaseException:
            pass
        return 1


if __name__ == "__main__":
    sys.exit(main())
