import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, readdirSync, readlinkSync, existsSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
const exec = promisify(execFile);
export const HOST_MARKER = "MERITROUTER_LAB_HOST_V1";
// Persisted live-process protocol: keep exact token verification for both generations.
const LEGACY_HOST_MARKER = "SWITCHYARD_LAB_HOST_V1";
function isOwnedCommand(command: string | null | undefined, token: string): boolean {
  return !!command && (command.includes(HOST_MARKER) || command.includes(LEGACY_HOST_MARKER)) && command.includes(`--sy-lab-token=${token}`);
}
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
    return isOwnedCommand(command, token) ? "owned" : "foreign";
  }
  catch {
    return processAlive(pid) ? "foreign" : "missing";
  }
}
export const WindowsProcessSnapshotSchema = z.array(z.object({ ProcessId: z.number().int().nonnegative(), ParentProcessId: z.number().int().nonnegative(), CreatedTicks: z.string().regex(/^[0-9]+$/), CommandLine: z.string().nullable() }).strict());
export type WindowsProcessSnapshot = z.infer<typeof WindowsProcessSnapshotSchema>;
/** A reused parent PID does not prove ancestry: every edge must follow creation time. */
export function ownedWindowsProcessTree(raw: unknown, pid: number, token: string): WindowsProcessSnapshot {
  const rows = WindowsProcessSnapshotSchema.parse(raw);
  const root = rows.find(row => row.ProcessId === pid);
  if (!root || !isOwnedCommand(root.CommandLine, token))
    throw new Error("root process snapshot ownership changed");
  if (new Set(rows.map(row => row.ProcessId)).size !== rows.length)
    throw new Error("ambiguous process snapshot");
  const tree = [root], seen = new Set([pid]);
  for (let i = 0; i < tree.length; i++)
    for (const row of rows) {
      const parent = tree[i]!;
      if (row.ParentProcessId === parent.ProcessId && !seen.has(row.ProcessId) && BigInt(row.CreatedTicks) >= BigInt(parent.CreatedTicks)) {
        if (row.CommandLine === null)
          throw new Error("descendant command identity is unavailable");
        seen.add(row.ProcessId);
        tree.push(row);
      }
    }
  return tree;
}
async function windowsProcessTree(pid: number, token: string): Promise<WindowsProcessSnapshot> {
  const command = "@(Get-CimInstance Win32_Process | ForEach-Object { [PSCustomObject]@{ ProcessId=[int]$_.ProcessId; ParentProcessId=[int]$_.ParentProcessId; CreatedTicks=$_.CreationDate.ToUniversalTime().Ticks.ToString(); CommandLine=$_.CommandLine } }) | ConvertTo-Json -Compress";
  const raw = (await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", command], { windowsHide: true, timeout: 10000 })).stdout;
  return ownedWindowsProcessTree(JSON.parse(raw), pid, token);
}
function readWindowsProof(pid: number, token: string, proofPath: string): WindowsProcessSnapshot | undefined {
  if (!existsSync(proofPath))
    return undefined;
  const saved = z.object({ pid: z.literal(pid), token: z.literal(token), rows: WindowsProcessSnapshotSchema }).parse(JSON.parse(readFileSync(proofPath, "utf8")));
  const root = saved.rows.find(row => row.ProcessId === pid && isOwnedCommand(row.CommandLine, token));
  if (!root)
    throw new Error("stored root identity does not match process proof");
  return saved.rows;
}
function mergeWindowsProof(prior: WindowsProcessSnapshot | undefined, current: WindowsProcessSnapshot): WindowsProcessSnapshot {
  const rows = new Map<string, WindowsProcessSnapshot[number]>();
  for (const row of [...prior ?? [], ...current]) {
    const key = `${row.ProcessId}:${row.CreatedTicks}`;
    const existing = rows.get(key);
    if (existing && existing.CommandLine !== row.CommandLine)
      throw new Error("stored process command identity changed");
    rows.set(key, row);
  }
  return [...rows.values()];
}
function saveWindowsProof(pid: number, token: string, rows: WindowsProcessSnapshot, proofPath: string): void {
  writeFileSync(proofPath + ".tmp", JSON.stringify({ pid, token, rows }), { encoding: "utf8", mode: 0o600 });
  renameSync(proofPath + ".tmp", proofPath);
}
/** Durable snapshot retained on ambiguous cleanup; never infer success from a missing wrapper alone. */
export async function captureOwnedProcessTree(pid: number, token: string, proofPath: string): Promise<void> {
  if (process.platform !== "win32")
    return;
  const rows = await windowsProcessTree(pid, token);
  saveWindowsProof(pid, token, mergeWindowsProof(readWindowsProof(pid, token, proofPath), rows), proofPath);
}
async function assertWindowsTargetsGone(tree: WindowsProcessSnapshot): Promise<void> {
  const payload = JSON.stringify(tree).replace(/'/g, "''");
  const script = `$targets=ConvertFrom-Json '${payload}'; $alive=@(foreach($target in $targets){$current=Get-CimInstance Win32_Process -Filter ('ProcessId = '+$target.ProcessId); if($null -ne $current -and $current.CreationDate.ToUniversalTime().Ticks.ToString() -eq $target.CreatedTicks){[int]$target.ProcessId}}); ConvertTo-Json -InputObject $alive -Compress`;
  const deadline = Date.now() + 2000;
  for (;;) {
    const output = (await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script], { windowsHide: true, timeout: 10000 })).stdout;
    const alive = z.array(z.number().int().positive()).parse(JSON.parse(output));
    if (!alive.length)
      return;
    if (Date.now() >= deadline)
      throw new Error(`verified lab process tree still has live processes (${alive.join(",")}); ownership evidence retained; refusing cleanup`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
export async function stopOwnedProcess(pid: number, token: string, proofPath?: string): Promise<void> {
  let proof: WindowsProcessSnapshot | undefined;
  if (process.platform === "win32" && proofPath)
    proof = readWindowsProof(pid, token, proofPath);
  const ownership = await processOwnership(pid, token);
  if (ownership === "missing") {
    if (proof) {
      await assertWindowsTargetsGone(proof);
      if (proofPath)
        unlinkSync(proofPath);
    }
    return;
  }
  if (ownership !== "owned")
    throw new Error(`refused to stop PID ${pid}: lab process ownership could not be verified`);
  if (process.platform === "win32") {
    const tree = await windowsProcessTree(pid, token);
    const known = mergeWindowsProof(proof, tree);
    if (proofPath)
      saveWindowsProof(pid, token, known, proofPath);
    const payload = JSON.stringify([...tree].reverse()).replace(/'/g, "''");
    // Re-query creation time and command identity immediately before each individual kill.
    // Never ask taskkill /T to reconstruct a PID-only tree.
    const script = `$ErrorActionPreference='Stop'; $targets=ConvertFrom-Json '${payload}'; foreach($target in $targets){ $root=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if($null -eq $root){ continue }; if($root.CreationDate.ToUniversalTime().Ticks.ToString() -ne '${tree[0]!.CreatedTicks}' -or ($root.CommandLine -notlike '*${HOST_MARKER}*' -and $root.CommandLine -notlike '*${LEGACY_HOST_MARKER}*') -or $root.CommandLine -notlike '*--sy-lab-token=${token}*'){ continue }; $current=Get-CimInstance Win32_Process -Filter ('ProcessId = '+$target.ProcessId); if($null -eq $current){continue}; if($current.CreationDate.ToUniversalTime().Ticks.ToString() -ne $target.CreatedTicks -or $current.CommandLine -cne $target.CommandLine){continue}; try { Stop-Process -Id $target.ProcessId -Force -ErrorAction Stop } catch { continue } }; '[]'`;
    const result = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script], { windowsHide: true, timeout: 15000 });
    z.array(z.never()).parse(JSON.parse(result.stdout.trim()));
    await assertWindowsTargetsGone(known);
    if (proofPath && existsSync(proofPath))
      unlinkSync(proofPath);
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  }
  catch {
  }
  const deadline = Date.now() + 2000;
  while (processAlive(pid) && Date.now() < deadline)
    await new Promise(r => setTimeout(r, 50));
  try {
    process.kill(-pid, "SIGKILL");
  }
  catch {
  }
}
/** Inspect only descendants of the verified wrapper; reject public or undeclared listeners. */
export interface LabListener {
  pid: number;
  port: number;
  address: string;
}
export async function inspectLabListeners(pid: number, token: string, ports: number[]): Promise<LabListener[]> {
  const found: LabListener[] = [];
  if (await processOwnership(pid, token) !== "owned")
    throw new Error("lab service exited or ownership changed before readiness");
  const processes = new Set<number>([pid]);
  if (process.platform === "win32") {
    const tree = await windowsProcessTree(pid, token);
    for (const row of tree)
      processes.add(row.ProcessId);
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
      found.push({ pid: owner, port, address });
    }
    return found;
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
      catch {
      }
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
        catch {
        }
      }
    }
    catch {
    }
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
      found.push({ pid, port, address: address! });
    }
  }
  return found;
}
