import { afterEach, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { captureOwnedProcessTree, HOST_MARKER, processAlive, processOwnership, stopOwnedProcess, windowsCommandLine } from "../src/labs/process-ownership.js";

// Windows PowerShell 5.1 writes stdout in the OEM code page. A command line holding characters
// it cannot represent used to reach Node mangled (or as raw control bytes), both in the host-wide
// snapshot and in the single-PID ownership query. Both now travel as base64 of UTF-8.
const NON_ASCII = "✓|×|→|é中";
let child: ChildProcess | undefined;
let dir: string | undefined;
let token = "";
afterEach(async () => {
  if (child?.pid && processAlive(child.pid)) await stopOwnedProcess(child.pid, token).catch(() => child?.kill());
  child = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});
async function waitFor(check: () => Promise<boolean>, ms = 15000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("condition not met");
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
it.skipIf(process.platform !== "win32")("reads a non-ASCII command line exactly through both the single-PID query and the host snapshot", async () => {
  token = "d".repeat(48);
  child = spawn(process.execPath, ["-e", `// ${HOST_MARKER}\nsetInterval(()=>{},1000)`, "--", NON_ASCII, `--sy-lab-token=${token}`], { stdio: "ignore", windowsHide: true });
  const pid = child.pid!;
  await waitFor(async () => (await windowsCommandLine(pid))?.includes(`--sy-lab-token=${token}`) ?? false);
  // Single-PID path: the exact characters, not the OEM code page's replacements.
  const single = await windowsCommandLine(pid);
  expect(single).toContain(NON_ASCII);
  expect(await processOwnership(pid, token)).toBe("owned");
  expect(await processOwnership(pid, "e".repeat(48))).toBe("foreign");
  // Host snapshot path: the proof stores the same exact command line.
  dir = mkdtempSync(path.join(tmpdir(), "mr-proc-"));
  const proof = path.join(dir, "proof.json");
  await captureOwnedProcessTree(pid, token, proof);
  const saved = JSON.parse(readFileSync(proof, "utf8")) as { rows: Array<{ ProcessId: number; CommandLine: string | null }> };
  expect(saved.rows.find(row => row.ProcessId === pid)?.CommandLine).toBe(single);
  await stopOwnedProcess(pid, token, proof);
  expect(processAlive(pid)).toBe(false);
  expect(await processOwnership(pid, token)).toBe("missing");
}, 60000);
it.skipIf(process.platform !== "win32")("reports a missing process as having no command line", async () => {
  expect(await windowsCommandLine(2000000000)).toBeNull();
});
