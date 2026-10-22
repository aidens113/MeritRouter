import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, readdirSync, readlinkSync } from "node:fs";
const exec = promisify(execFile);
export const HOST_MARKER = "SWITCHYARD_LAB_HOST_V1";
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  }
  catch {
    return false;
  }
}
export async function processOwnership(pid: number, token: string): Promise<"owned" | "missing" | "foreign"> {
  if (!Number.isSafeInteger(pid) || pid < 1 || !/^[a-f0-9]{48}$/.test(token))
    return "foreign";
  if (!processAlive(pid))
    return "missing";
  try {
    let command: string;
    if (process.platform === "win32")
      command = (await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').CommandLine`], { windowsHide: true, timeout: 10000 })).stdout;
    else if (process.platform === "linux")
      command = readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
    else
      command = (await exec("ps", ["-p", String(pid), "-o", "command="], { timeout: 10000 })).stdout;
    return command.includes(HOST_MARKER) && command.includes(`--sy-lab-token=${token}`) ? "owned" : "foreign";
  }
  catch {
    return processAlive(pid) ? "foreign" : "missing";
  }
}
export async function stopOwnedProcess(pid: number, token: string): Promise<void> {
  const ownership = await processOwnership(pid, token);
  if (ownership === "missing")
    return;
  if (ownership !== "owned")
    throw new Error(`refused to stop PID ${pid}: lab process ownership could not be verified`);
  if (process.platform === "win32") {
    await exec("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 15000 });
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  }
  catch { }
  const deadline = Date.now() + 2000;
  while (processAlive(pid) && Date.now() < deadline)
    await new Promise(r => setTimeout(r, 50));
  try {
    process.kill(-pid, "SIGKILL");
  }
  catch { }
}
/** Inspect only descendants of the verified wrapper; reject public or undeclared listeners. */
export async function inspectLabListeners(pid: number, token: string, ports: number[]): Promise<void> {
  if (await processOwnership(pid, token) !== "owned")
    throw new Error("lab service exited or ownership changed before readiness");
  const processes = new Set<number>([pid]);
  if (process.platform === "win32") {
    const raw = (await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress"], { windowsHide: true, timeout: 10000 })).stdout;
    const rows: unknown = JSON.parse(raw);
    if (!Array.isArray(rows))
      throw new Error("could not inspect service process tree");
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of rows) {
        const r = row as {
          ProcessId?: unknown;
          ParentProcessId?: unknown;
        };
        if (typeof r.ProcessId === "number" && typeof r.ParentProcessId === "number" && processes.has(r.ParentProcessId) && !processes.has(r.ProcessId)) {
          processes.add(r.ProcessId);
          changed = true;
        }
      }
    }
    const listeners = (await exec("netstat.exe", ["-ano"], { windowsHide: true, timeout: 10000 })).stdout;
    for (const line of listeners.split(/\r?\n/)) {
      const c = line.trim().split(/\s+/);
      const protocol = c[0];
      const owner = Number(c.at(-1));
      if (!processes.has(owner) || !(protocol === "UDP" || (protocol === "TCP" && c[3] === "LISTENING")))
        continue;
      const local = c[1]!;
      const split = local.lastIndexOf(":");
      const address = local.slice(0, split);
      const port = Number(local.slice(split + 1));
      if (!["127.0.0.1", "[::1]"].includes(address) || !ports.includes(port))
        throw new Error(`lab service opened forbidden listener ${local}; only allocated loopback ports are allowed`);
    }
    return;
  }
  if (process.platform !== "linux")
    throw new Error("listener ownership inspection is unsupported on this platform");
  let changed = true;
  const pids = readdirSync("/proc").filter(x => /^\d+$/.test(x));
  while (changed) {
    changed = false;
    for (const p of pids) {
      try {
        const raw = readFileSync(`/proc/${p}/stat`, "utf8");
        const parent = Number(raw.slice(raw.lastIndexOf(")") + 2).split(" ")[1]);
        if (processes.has(parent) && !processes.has(Number(p))) {
          processes.add(Number(p));
          changed = true;
        }
      }
      catch { }
    }
  }
  const inodes = new Set<string>();
  for (const p of processes) {
    try {
      for (const fd of readdirSync(`/proc/${p}/fd`)) {
        try {
          const match = /^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/${p}/fd/${fd}`));
          if (match)
            inodes.add(match[1]!);
        }
        catch { }
      }
    }
    catch { }
  }
  for (const table of ["tcp", "tcp6", "udp", "udp6"]) {
    for (const line of readFileSync(`/proc/net/${table}`, "utf8").trim().split("\n").slice(1)) {
      const c = line.trim().split(/\s+/);
      if (!inodes.has(c[9]!) || (!table.startsWith("udp") && c[3] !== "0A"))
        continue;
      const [address, portHex] = c[1]!.split(":");
      const port = parseInt(portHex!, 16);
      if (!["0100007F", "00000000000000000000000001000000"].includes(address!) || !ports.includes(port))
        throw new Error(`lab service opened forbidden listener ${c[1]}`);
    }
  }
}
