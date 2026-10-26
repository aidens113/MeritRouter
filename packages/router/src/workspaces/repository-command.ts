import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, open, opendir, readFile, realpath, rename } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { RunResult } from "../runners/coding/process.js";
import { commandQuiescence, runCommandProcess, RepositoryCommandInputSchema, type RepositoryCommandInput } from "../harness/command-process.js";
import { git } from "./git.js";
import { RepositoryMutationError, withRepositoryMutation, type RepositoryMutationCapability } from "./repository-mutation.js";
import { inspectServiceCommandProcess, releaseServiceCommandProcess, serviceJobObservation, startServiceCommandProcess, ServiceJobBindingSchema, type ServiceCommandInput, type ServiceJobBinding } from "../harness/service-command-process.js";
export type { RepositoryCommandInput } from "../harness/command-process.js";

const idSchema = z.string().regex(/^rc_[a-f0-9]{32}$/), hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const RecordSchema = z.object({ version: z.literal(1), id: idSchema, nonce: hashSchema, descriptorSha256: hashSchema,
  state: z.enum(["prepared", "running", "quiescent", "unsent"]), ownerPid: z.number().int().positive(), helperPid: z.number().int().positive().optional(),
  createdAt: z.number().int().nonnegative(), outcomeSha256: hashSchema.optional() }).strict();
type CommandRecord = z.infer<typeof RecordSchema>;
declare const commandBrand: unique symbol;
export interface RepositoryCommandPermit { readonly [commandBrand]: true }
export type RepositoryCommandPermits = RepositoryCommandPermit | readonly RepositoryCommandPermit[];
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
function commandPermits(input?: RepositoryCommandPermits): readonly RepositoryCommandPermit[] { return input === undefined ? [] : Array.isArray(input) ? input : [input as RepositoryCommandPermit]; }
/** Mutation admission can skip only its exact active host-owned receipt, never all commands. */
export async function assertRepositoryCommandPermitScope(gitDirectories: string[], input?: RepositoryCommandPermits): Promise<void> {
  for (const permit of commandPermits(input)) {
    const lease = permitLease(permit);
    if (!gitDirectories.some(directory => key(directory) === key(lease.gitDirectory))) throw new RepositoryMutationError("invalid_capability", "Command permit is outside the requested worktree scope");
    await safeDirectory(lease.directory);
    if (hash(await bytes(path.join(lease.directory, "receipt.json"))) !== lease.digest) throw new RepositoryMutationError("invalid_capability", "Command permit receipt changed or disappeared");
  }
}
export async function assertNoActiveRepositoryCommand(repo: string, permit?: RepositoryCommandPermits): Promise<void> {
  const owner = await gitDirectory(repo), active = path.join(owner, "meritrouter-commands", "active");
  const leases = commandPermits(permit).map(permitLease);
  if (permit !== undefined && !Array.isArray(permit) && key(leases[0]!.gitDirectory) !== key(owner)) throw new RepositoryMutationError("invalid_capability", "Command permit belongs to another worktree");
  try { await safeDirectory(active); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  let count = 0;
  for await (const entry of await opendir(active)) {
    if (++count > 4096) throw new RepositoryMutationError("active_command", "Repository command journal exceeds its bounded scan; inspect retained receipts");
    idSchema.parse(entry.name); const directory = path.join(active, entry.name); await safeDirectory(directory);
    const content = await bytes(path.join(directory, "receipt.json")), record = RecordSchema.parse(JSON.parse(content.toString("utf8")));
    if (record.id !== entry.name) throw new RepositoryMutationError("active_command", "Repository command receipt identity changed");
    if (leases.some(lease => key(lease.gitDirectory) === key(owner) && record.id === lease.record.id && record.nonce === lease.record.nonce && key(directory) === key(lease.directory) && hash(content) === lease.digest)) continue;
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

export const RepositoryServiceDescriptorSchema = z.object({ group: z.string().min(1).max(256), member: z.string().regex(/^[a-f0-9]{48}$/),
  kind: z.enum(["lab-service", "lab-setup", "lab-check", "task-service", "task-setup", "task-check"]), commandSha256: hashSchema }).strict();
export type RepositoryServiceDescriptor = z.infer<typeof RepositoryServiceDescriptorSchema>;
export const RepositoryServiceCommandSchema = z.object({ repo: z.string().min(1).max(4096), id: idSchema, nonce: hashSchema, descriptor: RepositoryServiceDescriptorSchema }).strict();
export type RepositoryServiceCommand = z.infer<typeof RepositoryServiceCommandSchema>;
function immutableServiceCommand(command: RepositoryServiceCommand): RepositoryServiceCommand { Object.freeze(command.descriptor); return Object.freeze(command); }
interface ServiceLease { lease: CommandLease; permit: RepositoryCommandPermit; binding?: ServiceJobBinding }
const serviceLeases = new WeakMap<object, ServiceLease>();
function serviceLease(command: RepositoryServiceCommand): ServiceLease {
  const current = command && typeof command === "object" ? serviceLeases.get(command) : undefined;
  if (!current?.lease.active) throw new RepositoryMutationError("invalid_capability", "Service command metadata requires a current verified host handle");
  return current;
}
function sameDescriptor(a: RepositoryServiceDescriptor, b: RepositoryServiceDescriptor): boolean { return JSON.stringify(RepositoryServiceDescriptorSchema.parse(a)) === JSON.stringify(RepositoryServiceDescriptorSchema.parse(b)); }
function ownPermits(command: RepositoryServiceCommand, siblings: readonly RepositoryServiceCommand[] = []): RepositoryCommandPermit[] {
  return [command, ...siblings].flatMap(handle => {
    if (handle.descriptor.group !== command.descriptor.group) throw new RepositoryMutationError("invalid_capability", "Service metadata permits cannot widen their Lab group");
    const current = serviceLease(handle);
    return key(current.lease.gitDirectory) === key(serviceLease(command).lease.gitDirectory) ? [current.permit] : [];
  });
}
export function repositoryServicePermit(command: RepositoryServiceCommand, group: string): RepositoryCommandPermit {
  if (command.descriptor.group !== group) throw new RepositoryMutationError("invalid_capability", "Service permit belongs to another Lab group"); return serviceLease(command).permit;
}
/** Audit lookup permits only replay of already-retired DB metadata cleanup, never OS/Git authority. */
export async function repositoryServiceAuditArchived(input: RepositoryServiceCommand): Promise<boolean> {
  const command = RepositoryServiceCommandSchema.parse(input), owner = await gitDirectory(command.repo);
  try { await lstat(path.join(owner, "meritrouter-commands", "active", command.id)); return false; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const directory = path.join(owner, "meritrouter-commands", "archive", command.id.slice(3, 5), command.id);
  try {
    await safeDirectory(directory); const record = RecordSchema.parse(JSON.parse((await bytes(path.join(directory, "receipt.json"))).toString("utf8")));
    return record.id === command.id && record.nonce === command.nonce && record.descriptorSha256 === hash(JSON.stringify(command.descriptor)) && record.state === "quiescent" && !!record.outcomeSha256;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
/** Reserve before the native suspended process exists. No service lifetime holds this scope. */
export async function prepareRepositoryServiceCommand(root: string, descriptor: RepositoryServiceDescriptor, siblings: readonly RepositoryServiceCommand[] = []): Promise<RepositoryServiceCommand> {
  const parsed = RepositoryServiceDescriptorSchema.parse(descriptor), repo = await realpath(root), owner = await gitDirectory(repo);
  const commands = siblings.flatMap(handle => {
    if (handle.descriptor.group !== parsed.group) throw new RepositoryMutationError("invalid_capability", "Service admission belongs to another Lab group");
    const current = serviceLease(handle); return key(current.lease.gitDirectory) === key(owner) ? [current.permit] : [];
  });
  const lease = await withRepositoryMutation([repo], async () => {
    const rootDirectory = path.join(owner, "meritrouter-commands"), active = path.join(rootDirectory, "active"); await ensureDirectory(rootDirectory); await ensureDirectory(active);
    const id = `rc_${randomBytes(16).toString("hex")}`, directory = path.join(active, id); await ensureDirectory(directory);
    const record = RecordSchema.parse({ version: 1, id, nonce: randomBytes(32).toString("hex"), descriptorSha256: hash(JSON.stringify(parsed)), state: "prepared", ownerPid: process.pid, createdAt: Date.now() });
    const content = Buffer.from(JSON.stringify(record)); await syncFile(path.join(directory, "receipt.json"), content);
    return { active: true, gitDirectory: owner, directory, record, digest: hash(content) } satisfies CommandLease;
  }, { command: commands });
  const handle = immutableServiceCommand(RepositoryServiceCommandSchema.parse({ repo, id: lease.record.id, nonce: lease.record.nonce, descriptor: parsed })), permit = Object.freeze({}) as RepositoryCommandPermit;
  permits.set(permit, lease); serviceLeases.set(handle, { lease, permit }); return handle;
}
/** The caller persists its exact Lab PID/token identity before the native execution grant. */
export async function startRepositoryServiceCommand(command: RepositoryServiceCommand, input: ServiceCommandInput, beforeGrant: (binding: ServiceJobBinding) => Promise<void>, siblings: readonly RepositoryServiceCommand[] = [], logPath?: string): Promise<ServiceJobBinding> {
  const current = serviceLease(command);
  try {
    if (key(await gitDirectory(await realpath(input.cwd))) !== key(current.lease.gitDirectory)) throw new Error("Service cwd changed worktree owner");
    return await startServiceCommandProcess(input, { id: command.id, nonce: command.nonce, directory: current.lease.directory, ...(logPath ? { logPath } : {}) }, async binding => {
      await withRepositoryMutation([command.repo], async () => {
        await syncFile(path.join(current.lease.directory, "service.json"), Buffer.from(JSON.stringify({ descriptor: command.descriptor, binding })));
        await replaceRecord(current.lease, RecordSchema.parse({ ...current.lease.record, state: "running", helperPid: binding.helperPid })); current.binding = binding;
      }, { command: ownPermits(command, siblings) });
      await beforeGrant(binding);
    });
  } catch (error) {
    if (error instanceof RepositoryMutationError) throw error;
    throw new RepositoryMutationError("command_uncertain", `Service command ${command.id} execution grant or Job identity is unverified; receipt retained`);
  }
}
/** Reconstruct metadata authority only after exact native helper/Job proof, never JSON alone. */
export async function recoverRepositoryServiceCommand(input: RepositoryServiceCommand, expected: RepositoryServiceDescriptor): Promise<RepositoryServiceCommand> {
  const command = immutableServiceCommand(RepositoryServiceCommandSchema.parse(input));
  if (!sameDescriptor(command.descriptor, expected)) throw new RepositoryMutationError("ownership_changed", "Service receipt belongs to a different Lab command identity");
  const owner = await gitDirectory(command.repo), directory = path.join(owner, "meritrouter-commands", "active", command.id);
  try {
    await safeDirectory(directory); const content = await bytes(path.join(directory, "receipt.json")), record = RecordSchema.parse(JSON.parse(content.toString("utf8")));
    if (record.id !== command.id || record.nonce !== command.nonce || record.state !== "running" || record.descriptorSha256 !== hash(JSON.stringify(command.descriptor))) throw new Error("Service admission identity changed");
    const saved = z.object({ descriptor: RepositoryServiceDescriptorSchema, binding: ServiceJobBindingSchema }).strict().parse(JSON.parse((await bytes(path.join(directory, "service.json"))).toString("utf8")));
    if (!sameDescriptor(saved.descriptor, expected) || saved.binding.id !== command.id || saved.binding.nonce !== command.nonce || saved.binding.helperPid !== record.helperPid) throw new Error("Service Job binding changed");
    const observation = serviceJobObservation(await inspectServiceCommandProcess(saved.binding, directory));
    if (observation.id !== command.id || observation.nonce !== command.nonce) throw new Error("Service Job observation changed");
    const lease: CommandLease = { active: true, gitDirectory: owner, directory, record, digest: hash(content) }, permit = Object.freeze({}) as RepositoryCommandPermit;
    permits.set(permit, lease); serviceLeases.set(command, { lease, permit, binding: saved.binding }); return command;
  } catch (error) {
    if (error instanceof RepositoryMutationError) throw error;
    throw new RepositoryMutationError("command_uncertain", `Original service command ${command.id} cannot be verified by its native Job; receipt retained`);
  }
}
export async function observeRepositoryServiceCommand(command: RepositoryServiceCommand) {
  const current = serviceLease(command); if (!current.binding) throw new RepositoryMutationError("command_uncertain", "Service command has no durable suspended-assignment binding");
  try { return serviceJobObservation(await inspectServiceCommandProcess(current.binding, current.lease.directory)); }
  catch (error) { if (error instanceof RepositoryMutationError) throw error; throw new RepositoryMutationError("command_uncertain", `Service command ${command.id} native Job observation is unverified; receipt retained`); }
}
/** Own DB/command metadata only: no capability is exposed and no service lifetime is awaited. */
export async function withRepositoryServiceStatus<T>(roots: string[], commands: readonly RepositoryServiceCommand[], group: string, action: () => Promise<T>): Promise<T> {
  const allowed = commands.map(command => { if (command.descriptor.group !== group) throw new RepositoryMutationError("invalid_capability", "Service status scope belongs to another Lab"); return serviceLease(command).permit; });
  return withRepositoryMutation(roots, () => action(), { command: allowed });
}
/** Kernel-zero proof is mandatory; parent exit/CIM snapshots never retire a marker. */
export async function stopRepositoryServiceCommand(command: RepositoryServiceCommand, siblings: readonly RepositoryServiceCommand[] = []): Promise<void> {
  const current = serviceLease(command);
  if (!current.binding) throw new RepositoryMutationError("command_uncertain", "Service command has no durable native Job identity; receipt retained");
  try {
    const proof = await inspectServiceCommandProcess(current.binding, current.lease.directory, true), observed = serviceJobObservation(proof);
    if (observed.activeProcesses !== 0 || observed.id !== command.id || observed.nonce !== command.nonce) throw new Error("Service Job quiescence identity differs");
    await releaseServiceCommandProcess(current.binding, current.lease.directory, proof);
    await withRepositoryMutation([command.repo], async () => {
      await replaceRecord(current.lease, RecordSchema.parse({ ...current.lease.record, state: "quiescent", outcomeSha256: hash(JSON.stringify(observed)) }));
      const archive = path.join(path.dirname(path.dirname(current.lease.directory)), "archive"), shard = path.join(archive, command.id.slice(3, 5));
      await ensureDirectory(archive); await ensureDirectory(shard); await rename(current.lease.directory, path.join(shard, command.id));
    }, { command: ownPermits(command, siblings) });
    current.lease.active = false;
  } catch (error) {
    if (error instanceof RepositoryMutationError) throw error;
    throw new RepositoryMutationError("command_uncertain", `Service command ${command.id} quiescence or retirement is unverified; receipt retained`);
  }
}
