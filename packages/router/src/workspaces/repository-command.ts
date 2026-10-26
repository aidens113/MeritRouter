import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, open, opendir, readFile, realpath, rename } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { RunResult } from "../runners/coding/process.js";
import { commandQuiescence, runCommandProcess, RepositoryCommandInputSchema, type RepositoryCommandInput } from "../harness/command-process.js";
import { git } from "./git.js";
import { RepositoryMutationError, withRepositoryMutation, type RepositoryMutationCapability } from "./repository-mutation.js";
export type { RepositoryCommandInput } from "../harness/command-process.js";

const idSchema = z.string().regex(/^rc_[a-f0-9]{32}$/), hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const RecordSchema = z.object({ version: z.literal(1), id: idSchema, nonce: hashSchema, descriptorSha256: hashSchema,
  state: z.enum(["prepared", "running", "quiescent", "unsent"]), ownerPid: z.number().int().positive(), helperPid: z.number().int().positive().optional(),
  createdAt: z.number().int().nonnegative(), outcomeSha256: hashSchema.optional() }).strict();
type CommandRecord = z.infer<typeof RecordSchema>;
declare const commandBrand: unique symbol;
export interface RepositoryCommandPermit { readonly [commandBrand]: true }
interface CommandLease { active: boolean; gitDirectory: string; directory: string; record: CommandRecord; digest: string }
const permits = new WeakMap<object, CommandLease>();
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const key = (value: string) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
async function safeDirectory(directory: string): Promise<void> {
  const target = path.resolve(directory), root = path.parse(target).root; let current = root;
  for (const part of target.slice(root.length).split(path.sep).filter(Boolean)) { current = path.join(current, part); const stat = await lstat(current); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe repository command metadata ancestor"); }
}
async function ensureDirectory(directory: string): Promise<void> {
  await mkdir(directory, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
  await safeDirectory(directory);
}
async function bytes(file: string): Promise<Buffer> {
  const stat = await lstat(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 8192) throw new Error("Unsafe repository command receipt"); return readFile(file);
}
async function gitDirectory(repo: string): Promise<string> {
  const directory = path.resolve((await git(repo, ["rev-parse", "--absolute-git-dir"])).trim()); await safeDirectory(directory); return directory;
}
async function syncFile(file: string, value: Buffer): Promise<void> { const handle = await open(file, "wx", 0o600); try { await handle.writeFile(value); await handle.sync(); } finally { await handle.close(); } }
function permitLease(permit: RepositoryCommandPermit): CommandLease {
  const lease = permit && typeof permit === "object" ? permits.get(permit) : undefined;
  if (!lease?.active) throw new RepositoryMutationError("invalid_capability", "Inactive or forged repository command retirement permit"); return lease;
}
/** Mutation admission can skip only its exact active host-owned receipt, never all commands. */
export async function assertNoActiveRepositoryCommand(repo: string, permit?: RepositoryCommandPermit): Promise<void> {
  const owner = await gitDirectory(repo), active = path.join(owner, "meritrouter-commands", "active");
  const lease = permit === undefined ? undefined : permitLease(permit);
  if (lease && key(lease.gitDirectory) !== key(owner)) throw new RepositoryMutationError("invalid_capability", "Command permit belongs to another worktree");
  try { await safeDirectory(active); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  let count = 0;
  for await (const entry of await opendir(active)) {
    if (++count > 4096) throw new RepositoryMutationError("active_command", "Repository command journal exceeds its bounded scan; inspect retained receipts");
    idSchema.parse(entry.name); const directory = path.join(active, entry.name); await safeDirectory(directory);
    const content = await bytes(path.join(directory, "receipt.json")), record = RecordSchema.parse(JSON.parse(content.toString("utf8")));
    if (record.id !== entry.name) throw new RepositoryMutationError("active_command", "Repository command receipt identity changed");
    if (lease && record.id === lease.record.id && record.nonce === lease.record.nonce && key(directory) === key(lease.directory) && hash(content) === lease.digest) continue;
    throw new RepositoryMutationError("active_command", `Repository command ${record.id} is active or lacks verified process quiescence; receipt retained`);
  }
}
async function replaceRecord(lease: CommandLease, record: CommandRecord): Promise<void> {
  await safeDirectory(lease.directory);
  const file = path.join(lease.directory, "receipt.json");
  if (hash(await bytes(file)) !== lease.digest) throw new Error("Repository command receipt changed concurrently");
  const value = Buffer.from(JSON.stringify(RecordSchema.parse(record))), lock = `${file}.lock`;
  await syncFile(lock, value); await rename(lock, file); lease.record = record; lease.digest = hash(value);
}
export interface RepositoryCommandControl { assertAuthority?: () => void | Promise<void>; started?: (pid: number) => void }
export interface RepositoryEffects {
  withWrite<T>(action: (capability: RepositoryMutationCapability) => T | Promise<T>, mutation?: RepositoryMutationCapability): Promise<T>;
  runCommand(input: RepositoryCommandInput, control?: RepositoryCommandControl): Promise<RunResult>;
}
export function createRepositoryEffects(root: string): RepositoryEffects {
  return {
    withWrite: (action, mutation) => withRepositoryMutation([root], capability => Promise.resolve(action(capability)), mutation === undefined ? {} : { capability: mutation }),
    runCommand: (input, control) => runRepositoryCommand(root, input, control),
  };
}
/** Durable admission is short; no common Git lease is held during compilation/process execution. */
export async function runRepositoryCommand(root: string, input: RepositoryCommandInput, control: RepositoryCommandControl = {}): Promise<RunResult> {
  const { signal, ...raw } = input, parsed = RepositoryCommandInputSchema.parse(raw), repo = await realpath(root), cwd = await realpath(parsed.cwd);
  const owner = await gitDirectory(repo);
  if (key(await gitDirectory(cwd)) !== key(owner)) throw new RepositoryMutationError("ownership_changed", "Command cwd is not the bound worktree");
  const permit = Object.freeze({}) as RepositoryCommandPermit;
  const lease: CommandLease = await withRepositoryMutation([repo], async () => {
    await control.assertAuthority?.();
    if (signal?.aborted) throw new RepositoryMutationError("ownership_changed", "Command authority ended before admission");
    if (key(await gitDirectory(cwd)) !== key(owner)) throw new RepositoryMutationError("ownership_changed", "Command worktree changed before admission");
    const rootDirectory = path.join(owner, "meritrouter-commands"), active = path.join(rootDirectory, "active"); await ensureDirectory(rootDirectory); await ensureDirectory(active);
    const id = `rc_${randomBytes(16).toString("hex")}`, directory = path.join(active, id); await ensureDirectory(directory);
    const record = RecordSchema.parse({ version: 1, id, nonce: randomBytes(32).toString("hex"), descriptorSha256: hash(JSON.stringify(parsed)), state: "prepared", ownerPid: process.pid, createdAt: Date.now() });
    const value = Buffer.from(JSON.stringify(record)); await syncFile(path.join(directory, "receipt.json"), value);
    return { active: true, gitDirectory: owner, directory, record, digest: hash(value) } satisfies CommandLease;
  });
  permits.set(permit, lease);
  try {
    const completed = await runCommandProcess({ ...parsed, signal }, { id: lease.record.id, nonce: lease.record.nonce, proofPath: path.join(lease.directory, "completion.json"), cancelPath: path.join(lease.directory, "cancel"),
      started: async pid => {
        await withRepositoryMutation([repo], async () => { await control.assertAuthority?.(); await replaceRecord(lease, RecordSchema.parse({ ...lease.record, state: "running", helperPid: pid })); }, { command: permit });
        control.started?.(pid);
      } });
    const proof = commandQuiescence(completed.proof);
    if (proof.id !== lease.record.id || proof.nonce !== lease.record.nonce) throw new Error("Command quiescence proof belongs to another admission");
    await withRepositoryMutation([repo], async () => {
      await replaceRecord(lease, RecordSchema.parse({ ...lease.record, state: proof.phase, outcomeSha256: hash(JSON.stringify(proof)) }));
      // Terminal audit is small; archive history never participates in active admission scans.
      const rootDirectory = path.dirname(path.dirname(lease.directory)), archive = path.join(rootDirectory, "archive"), shard = path.join(archive, lease.record.id.slice(3, 5));
      await ensureDirectory(archive); await ensureDirectory(shard); await rename(lease.directory, path.join(shard, lease.record.id));
    }, { command: permit });
    return completed.result;
  } catch (error) {
    if (error instanceof RepositoryMutationError && error.detail.kind === "command_uncertain") throw error;
    throw new RepositoryMutationError("command_uncertain", `Command ${lease.record.id} completion or receipt retirement is unverified; guard retained`);
  } finally { lease.active = false; }
}
