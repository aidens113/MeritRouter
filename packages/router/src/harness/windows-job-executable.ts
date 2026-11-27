import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdir, open, readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { minimalEnv } from "../runners/coding/process.js";

const exec = promisify(execFile);
/**
 * Compile only trusted static native source; verify its OS-temp cache on every execution.
 *
 * The cache lives in OS temp, which the operating system legitimately prunes (Storage Sense,
 * Disk Cleanup) file by file: a sweep can remove manifest.json while keeping job.exe, or the
 * reverse. A cache missing either half is incomplete, not tampered: nothing in it is executed,
 * its remnants are retained beside it as unverified-*, and a freshly compiled helper is
 * installed under the exclusive claim. A complete cache whose bytes disagree with its manifest
 * is still refused.
 */
const Cache = z.object({ version: z.literal(1), source: z.string().regex(/^[a-f0-9]{64}$/), executable: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const absent = (error: unknown): null => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; };
const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;
async function fileBytes(file: string, limit: number): Promise<Buffer> {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > limit) throw new Error("Unsafe command helper cache file");
  return readFile(file);
}
export function createWindowsJobExecutable(sourceText: string, kind: "command" | "service"): () => Promise<string> {
  // Concurrent callers share one verification; every later call verifies (and if needed repairs) afresh,
  // so a long-running process recovers when the cache is pruned underneath it.
  let pending: Promise<string> | undefined;
  return function executableForStaticSource(): Promise<string> {
    return pending ??= prepareExecutable(sourceText, kind).finally(() => { pending = undefined; });
  };
}
async function prepareExecutable(sourceText: string, kind: "command" | "service"): Promise<string> {
  if (process.platform !== "win32") throw new Error("Verified command containment is currently supported only on Windows");
  const sourceHash = hash(sourceText), root = path.join(tmpdir(), `meritrouter-${kind}-job-${sourceHash.slice(0, 20)}`);
  await mkdir(root, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
  const stat = await lstat(root); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe command helper cache directory");
  const executable = path.join(root, "job.exe"), manifest = path.join(root, "manifest.json");
  /** The verified executable, null for an incomplete cache, or a throw for an unsafe or altered one. */
  const inspect = async (): Promise<string | null> => {
    const recordBytes = await fileBytes(manifest, 2048).catch(absent);
    if (!recordBytes) return null;
    let record: z.infer<typeof Cache>;
    // An empty or truncated manifest is an interrupted installation, never a basis for execution.
    try { record = Cache.parse(JSON.parse(recordBytes.toString("utf8"))); } catch { return null; }
    if (record.source !== sourceHash) throw new Error("Command helper cache identity changed");
    const bytes = await fileBytes(executable, 1024 * 1024).catch(absent);
    if (!bytes) return null;
    if (hash(bytes) !== record.executable) {
      // A record replaced while it was read belongs to a concurrent installation, not to this executable.
      const current = await fileBytes(manifest, 2048).catch(absent);
      if (!current || !current.equals(recordBytes)) return null;
      throw new Error("Command helper cache identity changed");
    }
    return executable;
  };
  const ready = await inspect(); if (ready) return ready;
  const token = randomBytes(8).toString("hex"), source = path.join(root, `source-${token}.cs`), candidate = path.join(root, `job-${token}.exe`);
  const handle = await open(source, "wx", 0o600); try { await handle.writeFile(sourceText); await handle.sync(); } finally { await handle.close(); }
  try {
    const script = `$ErrorActionPreference='Stop'; Add-Type -Path ${quote(source)} -OutputAssembly ${quote(candidate)} -OutputType ConsoleApplication -ReferencedAssemblies System.Web.Extensions,System.Core`;
    await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script], { windowsHide: true, timeout: 60000, maxBuffer: 65536, env: minimalEnv({}) });
    const bytes = await fileBytes(candidate, 1024 * 1024);
    const record = JSON.stringify(Cache.parse({ version: 1, source: sourceHash, executable: hash(bytes) }));
    // Windows releases an abandoned kernel mutex automatically. The old empty .lock files are
    // deliberately ignored and retained: PID/age-based unlink recovery can steal a new owner's
    // claim when several processes recover at once. Use a global name for cross-session callers.
    const mutex = `Global\\MeritRouter-helper-${hash(root.toLowerCase())}`;
    const installation = `$ErrorActionPreference='Stop'; $mutex=New-Object System.Threading.Mutex($false,${quote(mutex)}); $owned=$false; try {
      try { $owned=$mutex.WaitOne(10000) } catch [System.Threading.AbandonedMutexException] { $owned=$true }
      if (-not $owned) { throw 'Command helper cache installation is busy' }
      [Console]::Out.WriteLine('locked'); [Console]::Out.Flush()
      if ([Console]::In.ReadLine() -eq 'install') {
        ${[manifest, executable].map(remnant => `if ([System.IO.File]::Exists(${quote(remnant)})) { [System.IO.File]::Move(${quote(remnant)},${quote(path.join(root, `unverified-${token}-${path.basename(remnant)}`))}) }`).join("\n")}
        [System.IO.File]::Move(${quote(candidate)},${quote(executable)})
        $file=[System.IO.File]::Open(${quote(manifest)},[System.IO.FileMode]::CreateNew,[System.IO.FileAccess]::Write,[System.IO.FileShare]::None)
        try { $record=[System.Text.Encoding]::UTF8.GetBytes(${quote(record)}); $file.Write($record,0,$record.Length); $file.Flush($true) } finally { $file.Dispose() }
      }
    } finally { if ($owned) { $mutex.ReleaseMutex() }; $mutex.Dispose() }`;
    await new Promise<void>((resolve, reject) => {
      let inspection: Promise<void> | undefined;
      const child = execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", installation], { windowsHide: true, timeout: 30000, maxBuffer: 65536, env: minimalEnv({}) }, error => {
        void (inspection ?? Promise.resolve()).then(() => error ? reject(error) : resolve(), reject);
      });
      // Validation runs while the mutex is held, but all mutations run in its owning process.
      // If either process dies, EOF or abandonment releases the claim without an orphan installer.
      child.stdin!.on("error", () => {});
      child.stdout!.once("data", () => {
        inspection = (async () => {
          try { child.stdin!.end(await inspect() ? "ready\n" : "install\n"); }
          catch (error) { child.stdin!.end(); throw error; }
        })();
        void inspection.catch(() => {});
      });
    });
    const installed = await inspect(); if (installed) return installed;
    throw new Error("Command helper cache did not verify after installation");
  } finally { await unlink(source).catch(() => {}); await unlink(candidate).catch(() => {}); }
}
