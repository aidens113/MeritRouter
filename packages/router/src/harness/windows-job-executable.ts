import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { minimalEnv } from "../runners/coding/process.js";

const exec = promisify(execFile);
/** Compile only trusted static native source; verify its OS-temp cache on every execution. */
const Cache = z.object({ version: z.literal(1), source: z.string().regex(/^[a-f0-9]{64}$/), executable: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
async function fileBytes(file: string, limit: number): Promise<Buffer> {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > limit) throw new Error("Unsafe command helper cache file");
  return readFile(file);
}
export function createWindowsJobExecutable(sourceText: string, kind: "command" | "service"): () => Promise<string> {
 let cached: Promise<string> | undefined;
 return function executableForStaticSource(): Promise<string> {
  const executable = cached ??= prepareExecutable(sourceText, kind).catch(error => { cached = undefined; throw error; });
  return executable.then(async file => {
    const root = path.dirname(file), stat = await lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe command helper cache directory");
    const record = Cache.parse(JSON.parse((await fileBytes(path.join(root, "manifest.json"), 2048)).toString("utf8")));
    if (record.source !== hash(sourceText) || record.executable !== hash(await fileBytes(file, 1024 * 1024))) throw new Error("Command helper cache identity changed");
    return file;
  });
}
}
async function prepareExecutable(sourceText: string, kind: "command" | "service"): Promise<string> {
  if (process.platform !== "win32") throw new Error("Verified command containment is currently supported only on Windows");
  const sourceHash = hash(sourceText), root = path.join(tmpdir(), `meritrouter-${kind}-job-${sourceHash.slice(0, 20)}`);
  await mkdir(root, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
  const stat = await lstat(root); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe command helper cache directory");
  const executable = path.join(root, "job.exe"), manifest = path.join(root, "manifest.json");
  const inspect = async () => { const record = Cache.parse(JSON.parse((await fileBytes(manifest, 2048)).toString("utf8"))); if (record.source !== sourceHash || hash(await fileBytes(executable, 1024 * 1024)) !== record.executable) throw new Error("Command helper cache identity changed"); return executable; };
  try { return await inspect(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
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
      for (let i = 0; i < 100; i++) { try { return await inspect(); } catch (failure) { if ((failure as NodeJS.ErrnoException).code !== "ENOENT") throw failure; await new Promise(resolve => setTimeout(resolve, 25)); } }
      throw new Error("Command helper cache installation is busy; existing lock retained");
    }
    try {
      try { return await inspect(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      try { await lstat(executable); throw new Error("Incomplete command helper cache is retained for inspection"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      await rename(candidate, executable);
      const record = Buffer.from(JSON.stringify(Cache.parse({ version: 1, source: sourceHash, executable: hash(bytes) })));
      const final = await open(manifest, "wx", 0o600); try { await final.writeFile(record); await final.sync(); } finally { await final.close(); }
    } finally { await claim.close(); await unlink(`${manifest}.lock`); }
    return inspect();
  } finally { await unlink(source).catch(() => {}); await unlink(candidate).catch(() => {}); }
}
