"""Owned short-lived Linux fixtures. No browser/network contact or host configuration."""
import copy
import hashlib
import importlib.util
import json
import os
import select
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

source = os.path.realpath(sys.argv[1])
sys.argv = [sys.argv[0]]
spec = importlib.util.spec_from_file_location("linux_helper", source)
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


def pin(path):
    path = os.path.realpath(path)
    meta = os.stat(path)
    return {"path": path, "device": meta.st_dev, "inode": meta.st_ino, "size": meta.st_size,
            "sha256": hashlib.sha256(open(path, "rb").read()).hexdigest()}


class HelperFixture(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="meritrouter-helper-fixture-")
        os.chmod(self.root, 0o700)
        self.path = os.path.join(self.root, "entry.py")
        shutil.copyfile(source, self.path)
        os.chmod(self.path, 0o600)
        self.children = []
        self.config = {"version": 1, "generation": "1" * 32, "nonce": "2" * 64, "target": "namespace_fixture_v1", "deadlineMs": 4000,
                       "owner": {"pid": os.getpid(), "startTicks": helper.birth(os.getpid())["startTicks"], "bootId": helper.boot_id()},
                       "pins": {"bwrap": pin("/usr/bin/bwrap"), "python": pin("/usr/bin/python3.10"), "helper": pin(self.path)}}

    def tearDown(self):
        for proc in self.children:
            if proc.poll() is None:
                proc.kill()
            proc.wait(timeout=3)
            for stream in (proc.stdin, proc.stdout, proc.stderr):
                if stream:
                    stream.close()
        # Only this directly created mkdtemp root is removed; helper never removes proof paths.
        assert os.path.basename(self.root).startswith("meritrouter-helper-fixture-") and os.path.dirname(self.root) == tempfile.gettempdir()
        shutil.rmtree(self.root)

    def start(self, patch=None, env=None, extra_fds=(), control=None):
        config = copy.deepcopy(self.config)
        if patch:
            patch(config)
        proc = subprocess.Popen(["/usr/bin/python3.10", "-I", "-B", self.path, "--monitor"], stdin=control if control is not None else subprocess.PIPE,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, pass_fds=extra_fds,
                                env=env or {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"})
        self.children.append(proc)
        if control is None:
            proc.stdin.write(json.dumps(config).encode() + b"\n")
            proc.stdin.flush()
        return proc, config

    def event(self, proc):
        return helper.frame(proc.stdout.fileno(), time.monotonic() + 5)

    def ready(self, proc):
        result = self.event(proc)
        self.assertEqual(result.get("event"), "ready", result)
        return result

    def finish_release(self, proc, config):
        proc.stdin.write(json.dumps({"op": "release", "generation": config["generation"], "nonce": config["nonce"]}).encode() + b"\n")
        proc.stdin.flush()

    def assert_dead(self, proof):
        for key in ("pid1", "stage"):
            pid = proof[key]["pid"]
            try:
                fd = os.pidfd_open(pid)
            except ProcessLookupError:
                continue
            try:
                self.assertTrue(select.select([fd], [], [], 2)[0], (key, pid))
            finally:
                os.close(fd)

    def test_actual_namespace_and_descendant_exit(self):
        proc, cfg = self.start()
        ready = self.ready(proc)
        self.finish_release(proc, cfg)
        self.assertEqual(self.event(proc)["event"], "executed")
        self.assertEqual(self.event(proc), {"event": "closed", "runtimeEnabled": False, "preserveArtifacts": False})
        self.assertEqual(proc.wait(timeout=2), 0)
        self.assert_dead(ready["proof"])

    def test_eof_before_release_never_executes(self):
        proc, _ = self.start()
        ready = self.ready(proc)
        proc.stdin.close()
        self.assertEqual(self.event(proc)["code"], "owner_closed")
        self.assertEqual(proc.wait(timeout=2), 1)
        self.assert_dead(ready["proof"])
        self.assertTrue(os.path.exists(self.path))

    def test_wrong_release_nonce_and_generation(self):
        for field in ("generation", "nonce"):
            with self.subTest(field=field):
                proc, cfg = self.start()
                ready = self.ready(proc)
                cfg[field] = "3" * len(cfg[field])
                self.finish_release(proc, cfg)
                self.assertEqual(self.event(proc)["code"], "invalid_release")
                self.assertEqual(proc.wait(timeout=2), 1)
                self.assert_dead(ready["proof"])

    def test_deadline_does_not_release_gate(self):
        proc, _ = self.start(lambda c: c.update(deadlineMs=500))
        ready = self.ready(proc)
        self.assertEqual(self.event(proc)["code"], "deadline")
        proc.wait(timeout=2)
        self.assert_dead(ready["proof"])

    def test_helper_sigkill_at_gate_kills_namespace(self):
        proc, _ = self.start()
        ready = self.ready(proc)
        proc.kill()
        proc.wait(timeout=2)
        self.assert_dead(ready["proof"])

    def test_helper_sigkill_after_exec_kills_proved_descendant(self):
        proc, cfg = self.start()
        ready = self.ready(proc)
        self.finish_release(proc, cfg)
        executed = self.event(proc)
        self.assertEqual(executed["event"], "executed")
        ready["proof"]["descendant"] = executed["fixtureDescendant"]
        descendant_fd = os.pidfd_open(executed["fixtureDescendant"]["pid"])
        try:
            proc.kill()
            proc.wait(timeout=2)
            self.assert_dead(ready["proof"])
            self.assertTrue(select.select([descendant_fd], [], [], 2)[0])
        finally:
            os.close(descendant_fd)

    def test_owner_sigkill_at_gate_and_after_exec(self):
        # Independent ancestor stays alive and owns pidfds while the monitor's real parent dies.
        driver = """import json,os,subprocess,sys,time,select
c=json.loads(sys.argv[2]); c['owner']['pid']=os.getpid(); c['owner']['startTicks']=open('/proc/self/stat').read().rsplit(') ',1)[1].split()[19]
p=subprocess.Popen(['/usr/bin/python3.10','-I','-B',sys.argv[1],'--monitor'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,env={'PATH':'/usr/bin:/bin','LANG':'C.UTF-8'})
p.stdin.write(json.dumps(c).encode()+b'\\n'); p.stdin.flush()
r=json.loads(p.stdout.readline()); print(json.dumps({'monitorPid':p.pid,'ready':r}),flush=True)
if sys.argv[3]=='executed':
 p.stdin.write(json.dumps({'op':'release','generation':c['generation'],'nonce':c['nonce']}).encode()+b'\\n');p.stdin.flush();print(p.stdout.readline().decode().strip(),flush=True)
sys.stdin.readline()
"""
        for phase in ("gate", "executed"):
            with self.subTest(phase=phase):
                driver_proc = subprocess.Popen(["/usr/bin/python3.10", "-I", "-B", "-c", driver, self.path, json.dumps(self.config), phase], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                self.children.append(driver_proc)
                record = self.event(driver_proc)
                self.assertEqual(record["ready"]["event"], "ready", record)
                monitor_fd = os.pidfd_open(record["monitorPid"])
                descendant_fd = None
                if phase == "executed":
                    executed = self.event(driver_proc)
                    self.assertEqual(executed["event"], "executed")
                    descendant_fd = os.pidfd_open(executed["fixtureDescendant"]["pid"])
                try:
                    driver_proc.kill()
                    driver_proc.wait(timeout=2)
                    self.assertTrue(select.select([monitor_fd], [], [], 2)[0])
                    self.assert_dead(record["ready"]["proof"])
                    if descendant_fd is not None:
                        self.assertTrue(select.select([descendant_fd], [], [], 2)[0])
                finally:
                    os.close(monitor_fd)
                    if descendant_fd is not None:
                        os.close(descendant_fd)

    def test_changed_pin_and_owner_birth_rejected(self):
        for kind in ("pin", "birth", "boot"):
            def patch(c):
                if kind == "pin":
                    c["pins"]["helper"]["sha256"] = "0" * 64
                elif kind == "birth":
                    c["owner"]["startTicks"] = "1"
                else:
                    c["owner"]["bootId"] = "00000000-0000-0000-0000-000000000000"
            proc, _ = self.start(patch)
            result = self.event(proc)
            self.assertEqual(result["event"], "refused")
            self.assertEqual(proc.wait(timeout=2), 1)

    def test_inherited_environment_refused(self):
        proc, _ = self.start(env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "DBUS_SESSION_BUS_ADDRESS": "private-canary"})
        result = self.event(proc)
        self.assertEqual(result["code"], "invalid_environment")
        self.assertNotIn("private-canary", json.dumps(result))
        proc.wait(timeout=2)

    def test_inherited_socket_refused(self):
        left, right = socket.socketpair()
        try:
            proc, _ = self.start(extra_fds=(left.fileno(),))
            self.assertEqual(self.event(proc)["code"], "invalid_descriptor")
            proc.wait(timeout=2)

        finally:
            left.close()
            right.close()

    def test_unapproved_executable_symlink_and_writable_helper_refused(self):
        for kind in ("path", "symlink", "mode"):
            if kind == "mode":
                os.chmod(self.path, 0o622)
            if kind == "symlink":
                os.symlink(self.path, self.path + ".alias")
            def patch(c):
                if kind == "path":
                    c["pins"]["python"]["path"] = "/bin/sh"
                if kind == "symlink":
                    c["pins"]["helper"]["path"] += ".alias"
            proc, _ = self.start(patch)
            result = self.event(proc)
            self.assertEqual(result["code"], "unapproved_executable")
            self.assertTrue(result["preserveArtifacts"])
            proc.wait(timeout=2)
        os.chmod(self.path, 0o600)

    def test_kernel_observation_refuses_parent_namespace_and_capability_forgery(self):
        with mock.patch.object(helper, "birth", return_value={"parent": 999}):
            with self.assertRaises(helper.Refused):
                helper.kernel_proof(1, 2, 3, {}, {})
        with mock.patch.object(helper, "birth", side_effect=[{"parent": 3}, {"parent": 1}]), mock.patch.object(helper.os, "readlink", return_value="net:[shared]"):
            with self.assertRaises(helper.Refused):
                helper.kernel_proof(1, 2, 3, {}, {})
        with mock.patch("builtins.open", mock.mock_open(read_data="CapEff:\t0000000000000001\nNoNewPrivs:\t1\n")):
            with self.assertRaises(helper.Refused):
                helper.capabilities(1)

    def test_forged_info_never_grants_foreign_cleanup_signal(self):
        # Exercise monitor's real finally path with forged bwrap info naming this unrelated owner.
        # All signal delivery is mocked, so a regression cannot kill the fixture runner.
        owner_birth = helper.birth(os.getpid())
        owned_birth = {"pid": 2**30, "parent": os.getpid(), "startTicks": "123"}
        quiet_read, quiet_write = os.pipe()
        config = copy.deepcopy(self.config)
        config["pins"]["helper"]["path"] = source
        process = mock.Mock(pid=owned_birth["pid"])
        process.poll.return_value = None
        original_pin = helper.pin_pid
        def fake_pin(pid):
            if pid == owned_birth["pid"]:
                return os.dup(quiet_read), owned_birth
            return original_pin(pid)
        original_birth = helper.birth
        def fake_birth(pid):
            return owned_birth if pid == owned_birth["pid"] else original_birth(pid)
        original_select = helper.select.select
        def fake_select(readable, writable, exceptional, timeout):
            return original_select([fd for fd in readable if fd != 0], writable, exceptional, timeout)
        def fake_popen(*args, **kwargs):
            os.write(8, json.dumps({"child-pid": os.getpid()}).encode())
            return process
        try:
            with mock.patch.dict(helper.os.environ, {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"}, clear=True), mock.patch.object(helper, "owner_channel"), mock.patch.object(helper, "frame", return_value=config), mock.patch.object(helper, "check_pin"), \
                 mock.patch.object(helper.os, "getppid", return_value=os.getpid()), mock.patch.object(helper.os, "listdir", return_value=["0", "1", "2"]), \
                 mock.patch.object(helper.subprocess, "run", return_value=mock.Mock(returncode=0, stdout=b"bubblewrap 0.6.1\n")), \
                 mock.patch.object(helper.subprocess, "Popen", side_effect=fake_popen), mock.patch.object(helper, "pin_pid", side_effect=fake_pin), \
                 mock.patch.object(helper, "birth", side_effect=fake_birth), mock.patch.object(helper.select, "select", side_effect=fake_select), mock.patch.object(helper.signal, "pidfd_send_signal") as send:
                with self.assertRaises(helper.Refused) as refused:
                    helper.monitor()
                self.assertEqual(refused.exception.code, "kernel_proof_unavailable")
                send.assert_not_called()
                process.kill.assert_called_once()
        finally:
            os.close(quiet_read)
            os.close(quiet_write)

    def test_stale_bwrap_birth_closes_candidate_without_authority(self):
        read_fd, write_fd = os.pipe()
        candidate_fd = os.dup(read_fd)
        try:
            with mock.patch.object(helper, "pin_pid", return_value=(candidate_fd, {"pid": 22, "parent": 11, "startTicks": "1"})), \
                 mock.patch.object(helper, "birth", return_value={"pid": 11, "parent": 0, "startTicks": "changed"}), \
                 mock.patch.object(helper.signal, "pidfd_send_signal") as send:
                with self.assertRaises(helper.Refused):
                    helper.pin_owned_pid1(22, read_fd, {"pid": 11, "parent": 0, "startTicks": "old"})
                with self.assertRaises(OSError):
                    os.fstat(candidate_fd)
                send.assert_not_called()
        finally:
            os.close(read_fd)
            os.close(write_fd)

    def test_eof_and_corruption_before_initial_launch(self):
        for raw in (b"", b"private-canary\n", b"{\"version\":1", b"x" * 8193):
            proc = subprocess.Popen(["/usr/bin/python3.10", "-I", "-B", self.path, "--monitor"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                    env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"})
            self.children.append(proc)
            proc.stdin.write(raw)
            proc.stdin.close()
            result = self.event(proc)
            self.assertEqual(result["event"], "refused")
            self.assertTrue(result["preserveArtifacts"])
            self.assertNotIn("private-canary", json.dumps(result))
            proc.wait(timeout=2)

    def test_socketpair_owner_channel_is_explicitly_supported(self):
        left, right = socket.socketpair()
        try:
            proc, cfg = self.start(control=left.fileno())
            left.close()
            right.sendall(json.dumps(cfg).encode() + b"\n")
            ready = self.ready(proc)
            right.sendall(json.dumps({"op": "release", "generation": cfg["generation"], "nonce": cfg["nonce"]}).encode() + b"\n")
            self.assertEqual(self.event(proc)["event"], "executed")
            self.assertEqual(self.event(proc)["event"], "closed")
            proc.wait(timeout=2)
            self.assert_dead(ready["proof"])
        finally:
            left.close()
            right.close()

    def test_protocol_duplicate_keys_depth_bounds_and_invalid_release(self):
        for raw in (b'{"a":1,"a":2}', b'NaN', b'[]', b'{"secret":"' + b'x' * 8192 + b'"}', b'{"a":' * 10 + b'0' + b'}' * 10):
            with self.subTest(raw=raw[:20]):
                with self.assertRaises((helper.Refused, ValueError, TypeError)):
                    helper.bounded_json(raw)
        with self.assertRaises(helper.Refused):
            helper.release({"op": "release", "generation": "1" * 32, "nonce": "2" * 64, "script": "canary"}, "1" * 32, "2" * 64)

    def test_exact_proc_mount_policy_accepts_only_fixed_optional_ro_masks(self):
        base = ["/", "/usr/bin/python3.10", "/usr/lib/python3.10", "/usr/lib/x86_64-linux-gnu", "/usr/lib64", "/proc", "/dev", "/dev/null", "/dev/zero", "/dev/full", "/dev/random", "/dev/urandom", "/dev/tty", "/dev/pts", "/dev/shm", "/tmp", "/run", "/fixture/entry.py"]
        optional = ["/proc/sysrq-trigger", "/proc/irq", "/proc/bus"]
        def text(paths):
            return "\n".join("%d 1 0:1 / %s ro,nosuid,nodev,noexec - proc proc ro" % (i + 2, path) for i, path in enumerate(paths))
        # Test every permitted optional subset, never making a base entry optional.
        for mask in range(8):
            helper.validate_mounts(text(base + [p for i, p in enumerate(optional) if mask & (1 << i)]))
        for changed in (base + ["/proc/foreign"], base + ["/proc"], [p for p in base if p != "/fixture/entry.py"], [p for p in base if p != "/proc"], base + ["/usr/lib/wsl/drivers"]):
            with self.assertRaises(helper.Refused):
                helper.validate_mounts(text(changed))
        for target in ["/proc"] + optional:
            changed = text(base + optional).replace(" " + target + " ro,", " " + target + " rw,")
            with self.assertRaises(helper.Refused):
                helper.validate_mounts(changed)

    def test_proc_mount_policy_refuses_invalid_and_oversized_observations(self):
        for text in ("private-canary", "x" * 65537, "\n".join("invalid" for _ in range(65))):
            with self.assertRaises(helper.Refused):
                helper.validate_mounts(text)


if __name__ == "__main__":
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(HelperFixture)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    print(json.dumps({"tests": result.testsRun, "failures": len(result.failures), "errors": len(result.errors), "ownerUid": os.getuid(), "runtimeEnabled": False}), flush=True)
    sys.exit(0 if result.wasSuccessful() else 1)
