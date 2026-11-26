import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
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
    const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;
    const script = `$ErrorActionPreference='Stop'; Add-Type -Path ${quote(source)} -OutputAssembly ${quote(candidate)} -OutputType ConsoleApplication -ReferencedAssemblies System.Web.Extensions,System.Core`;
    await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script], { windowsHide: true, timeout: 60000, maxBuffer: 65536, env: minimalEnv({}) });
    const bytes = await fileBytes(candidate, 1024 * 1024);
    // Installation is serialized by an exclusive manifest claim. A competitor's valid cache wins.
    let claim: Awaited<ReturnType<typeof open>>;
    try { claim = await open(`${manifest}.lock`, "wx", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      for (let i = 0; i < 100; i++) { const installed = await inspect(); if (installed) return installed; await new Promise(resolve => setTimeout(resolve, 25)); }
      throw new Error("Command helper cache installation is busy; existing lock retained");
    }
    try {
      const installed = await inspect(); if (installed) return installed;
      // Retain each remnant of the incomplete cache for inspection; none of it is ever executed.
      // The manifest moves first so no reader pairs the old record with the new executable.
      for (const remnant of [manifest, executable]) await rename(remnant, path.join(root, `unverified-${token}-${path.basename(remnant)}`)).catch(absent);
      await rename(candidate, executable);
      const record = Buffer.from(JSON.stringify(Cache.parse({ version: 1, source: sourceHash, executable: hash(bytes) })));
      const final = await open(manifest, "wx", 0o600); try { await final.writeFile(record); await final.sync(); } finally { await final.close(); }
    } finally { await claim.close(); await unlink(`${manifest}.lock`); }
    const installed = await inspect(); if (installed) return installed;
    throw new Error("Command helper cache did not verify after installation");
  } finally { await unlink(source).catch(() => {}); await unlink(candidate).catch(() => {}); }
}
