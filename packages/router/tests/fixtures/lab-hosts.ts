import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { HOST_MARKER } from "../../src/labs/process-ownership.js";

const exec = promisify(execFile);

/**
 * Leak checks for Lab tests on Windows: a Lab service or command runs as
 * `job.exe` (its native Job helper) -> node host (`HOST_MARKER --sy-lab-token=<token>`) -> the
 * declared command. A test records the tokens its own Labs used, observes the matching hosts and
 * their Job helpers while they run, and after teardown asserts that none of those exact processes
 * (same PID and creation time) is still alive. Other agents' or tests' processes are never matched.
 */
const Row = z.object({ pid: z.number().int(), parent: z.number().int(), created: z.string(), command: z.string().nullable() }).strict();
type Row = z.infer<typeof Row>;
export interface LabProcess { pid: number; created: string; role: "host" | "job-helper" | "descendant" }

async function snapshot(filter: string): Promise<Row[]> {
  const listing = `@(Get-CimInstance Win32_Process -Filter "${filter}" | ForEach-Object { [PSCustomObject]@{ pid=[int]$_.ProcessId; parent=[int]$_.ParentProcessId; created=$_.CreationDate.ToUniversalTime().Ticks.ToString(); command=$_.CommandLine } }) | ConvertTo-Json -Compress`;
  const script = `$ErrorActionPreference='Stop'; $json = ${listing}; if ($null -eq $json) { $json = '[]' }; [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$json))`;
  const encoded = (await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script], { windowsHide: true, timeout: 30000, maxBuffer: 16 * 1024 * 1024 })).stdout.trim();
  if (!encoded) return [];
  const parsed = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as unknown;
  return z.array(Row).parse(Array.isArray(parsed) ? parsed : [parsed]);
}

/** Every Lab command token a Lab store has recorded (services and command owners). */
export function labTokens(db: { prepare(sql: string): { all(): unknown[] } }): string[] {
  const rows = [...db.prepare("SELECT token FROM lab_services WHERE token IS NOT NULL").all(), ...db.prepare("SELECT token FROM lab_command_owners").all()];
  return z.array(z.object({ token: z.string() })).parse(rows).map(row => row.token);
}

/** The live Lab hosts carrying any of `tokens`, the Job helper each runs under, and their descendants. */
export async function observeLabProcesses(tokens: Iterable<string>): Promise<LabProcess[]> {
  if (process.platform !== "win32") return [];
  const wanted = [...new Set(tokens)];
  if (!wanted.length) return [];
  const all = await snapshot("ProcessId > 0");
  const hosts = all.filter(row => row.command?.includes(HOST_MARKER) && wanted.some(token => row.command!.includes(`--sy-lab-token=${token}`)));
  const out = new Map<number, LabProcess>();
  for (const host of hosts) {
    out.set(host.pid, { pid: host.pid, created: host.created, role: "host" });
    const parent = all.find(row => row.pid === host.parent);
    if (parent && /[\\/]job\.exe"?$/i.test(parent.command?.trim() ?? "") && BigInt(parent.created) <= BigInt(host.created)) out.set(parent.pid, { pid: parent.pid, created: parent.created, role: "job-helper" });
    const tree = [host];
    for (let i = 0; i < tree.length; i++)
      for (const row of all)
        if (row.parent === tree[i]!.pid && BigInt(row.created) >= BigInt(tree[i]!.created) && !out.has(row.pid)) { tree.push(row); out.set(row.pid, { pid: row.pid, created: row.created, role: "descendant" }); }
  }
  return [...out.values()];
}

/** Which of `observed` are still alive as the same process (PID and creation time). */
export async function survivingLabProcesses(observed: readonly LabProcess[]): Promise<LabProcess[]> {
  const out: LabProcess[] = [];
  for (const item of observed) {
    const [row] = await snapshot(`ProcessId = ${item.pid}`);
    if (row && row.created === item.created) out.push(item);
  }
  return out;
}
