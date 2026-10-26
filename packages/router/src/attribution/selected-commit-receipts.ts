import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, open, opendir, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { git } from "../workspaces/git.js";
import type { GitIndexPublicationSnapshot } from "../workspaces/git-index-transaction.js";

export const CommitObjectSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const receiptId = z.string().regex(/^pc_[a-f0-9]{32}$/);
const Layout = z.object({ version: z.literal(2) }).strict();
export const SelectedCommitReceiptSchema = z.object({
  version: z.literal(2), id: receiptId, state: z.enum(["prepared", "head_published", "complete", "refused", "uncertain"]),
  head: CommitObjectSchema.nullable(), branch: z.string().max(4096).regex(/^refs\/heads\/[^\x00-\x20\x7f]+$/).nullable(),
  commit: CommitObjectSchema, tree: CommitObjectSchema,
  originalIndex: z.string().regex(/^[a-f0-9]{64}$/).nullable(), nextIndex: z.string().regex(/^[a-f0-9]{64}$/),
  backups: z.enum(["retained", "released"]),
}).strict().refine(record => record.backups === "retained" || ["complete", "refused"].includes(record.state), "Unresolved publication must retain index backups");
export type SelectedCommitReceipt = z.infer<typeof SelectedCommitReceiptSchema>;
export interface CommitReceiptHandle { directory: string; record: SelectedCommitReceipt; digest: string }
const digest = (data: Buffer) => createHash("sha256").update(data).digest("hex");

async function directoryChain(directory: string): Promise<void> {
  const absolute = path.resolve(directory), root = path.parse(absolute).root;
  let current = root;
  for (const component of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component); const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Publication receipt directory has an unsafe ancestor");
  }
}
async function ownedFile(file: string, max: number): Promise<Buffer> {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > max) throw new Error("Publication receipt file is unsafe or oversized");
  return readFile(file);
}
async function syncFile(file: string, content: Buffer): Promise<void> {
  const handle = await open(file, "wx", 0o600);
  try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
}
async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}
async function ensureDirectory(directory: string): Promise<void> {
  await mkdir(directory, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
  await directoryChain(directory);
}
export async function publicationDirectory(repo: string): Promise<string> {
  const gitDir = path.resolve((await git(repo, ["rev-parse", "--absolute-git-dir"])).trim());
  await directoryChain(gitDir);
  return path.join(gitDir, "meritrouter-publications");
}
async function layoutRoot(root: string, create = false): Promise<boolean> {
  try { await directoryChain(root); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; if (!create) return false; await ensureDirectory(root); }
  const file = path.join(root, "layout.json");
  try { Layout.parse(JSON.parse((await ownedFile(file, 1024)).toString("utf8"))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !create) throw new Error("Legacy/incomplete publication layout requires explicit reconciliation");
    for await (const entry of await opendir(root)) { void entry; throw new Error("Unknown publication history cannot be replaced"); }
    await syncFile(file, Buffer.from(JSON.stringify({ version: 2 }))); await syncDirectory(root);
  }
  return true;
}
async function readAt(directory: string, id: string, backups = true): Promise<CommitReceiptHandle> {
  await directoryChain(directory);
  const content = await ownedFile(path.join(directory, "receipt.json"), 16384);
  const record = SelectedCommitReceiptSchema.parse(JSON.parse(content.toString("utf8")));
  if (record.id !== id) throw new Error("Publication receipt identity mismatch");
  if (backups && record.backups === "retained") {
    if (record.originalIndex && digest(await ownedFile(path.join(directory, "original.index"), 32 * 1024 * 1024)) !== record.originalIndex) throw new Error("Original index backup differs from publication receipt");
    if (digest(await ownedFile(path.join(directory, "next.index"), 32 * 1024 * 1024)) !== record.nextIndex) throw new Error("Next index backup differs from publication receipt");
  }
  return { directory, record, digest: digest(content) };
}

/** Only pending journals participate in admission; completed archive history is never scanned. */
export async function assertNoPendingCommitPublication(repo: string, options: { archiveTerminal?: boolean } = {}): Promise<void> {
  const root = await publicationDirectory(repo);
  if (!await layoutRoot(root)) return;
  const pending = path.join(root, "pending");
  try { await directoryChain(pending); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  let count = 0;
  for await (const entry of await opendir(pending)) {
    if (++count > 64) throw new Error("Pending publication set exceeds supported bound; reconcile it explicitly");
    receiptId.parse(entry.name);
    const handle = await readAt(path.join(pending, entry.name), entry.name, false);
    if (!["complete", "refused"].includes(handle.record.state)) {
      await readAt(handle.directory, entry.name);
      throw new Error(`Publication ${entry.name} requires explicit reconciliation`);
    }
    if (options.archiveTerminal) await archiveCommitReceipt(handle);
  }
}

export async function createCommitReceipt<T>(snapshot: GitIndexPublicationSnapshot<T>, commit: string, tree: string): Promise<CommitReceiptHandle> {
  await directoryChain(snapshot.gitDirectory);
  const root = path.join(snapshot.gitDirectory, "meritrouter-publications");
  await layoutRoot(root, true);
  const pending = path.join(root, "pending"); await ensureDirectory(pending);
  const id = `pc_${randomBytes(16).toString("hex")}`, directory = path.join(pending, id);
  await mkdir(directory, { mode: 0o700 });
  if (snapshot.originalIndex) await syncFile(path.join(directory, "original.index"), snapshot.originalIndex);
  await syncFile(path.join(directory, "next.index"), snapshot.nextIndex);
  const record = SelectedCommitReceiptSchema.parse({ version: 2, id, state: "prepared", head: snapshot.head || null, branch: snapshot.branch || null,
    commit, tree, originalIndex: snapshot.originalIndex ? digest(snapshot.originalIndex) : null, nextIndex: digest(snapshot.nextIndex), backups: "retained" });
  const content = Buffer.from(JSON.stringify(record)); await syncFile(path.join(directory, "receipt.json"), content);
  await syncDirectory(directory); await syncDirectory(pending);
  return { directory, record, digest: digest(content) };
}

async function replaceRecord(handle: CommitReceiptHandle, record: SelectedCommitReceipt): Promise<void> {
  await directoryChain(handle.directory);
  const file = path.join(handle.directory, "receipt.json");
  if (digest(await ownedFile(file, 16384)) !== handle.digest) throw new Error("Publication receipt changed concurrently");
  const content = Buffer.from(JSON.stringify(SelectedCommitReceiptSchema.parse(record))), lock = `${file}.lock`;
  await syncFile(lock, content); await rename(lock, file); await syncDirectory(handle.directory);
  handle.record = record; handle.digest = digest(content);
}
export async function updateCommitReceipt(handle: CommitReceiptHandle, state: SelectedCommitReceipt["state"]): Promise<void> {
  if (["complete", "refused"].includes(handle.record.state) && handle.record.state !== state) throw new Error("Terminal publication history cannot be downgraded");
  await replaceRecord(handle, SelectedCommitReceiptSchema.parse({ ...handle.record, state }));
}

/** Archive durable terminal audit first; only then retire its own validated full-index backups. */
export async function archiveCommitReceipt(handle: CommitReceiptHandle): Promise<void> {
  if (!["complete", "refused"].includes(handle.record.state)) throw new Error("Unresolved publication cannot be archived");
  const verified = await readAt(handle.directory, handle.record.id);
  if (verified.digest !== handle.digest) throw new Error("Publication changed before archival");
  const allowed = new Set(["receipt.json", "next.index", ...(handle.record.originalIndex ? ["original.index"] : [])]);
  for await (const entry of await opendir(handle.directory)) if (!allowed.has(entry.name)) throw new Error("Unknown publication files/locks are preserved; explicit reconciliation required");
  if (path.basename(path.dirname(handle.directory)) === "pending") {
    const root = path.dirname(path.dirname(handle.directory)), archive = path.join(root, "archive"), shard = path.join(archive, handle.record.id.slice(3, 5));
    await ensureDirectory(archive); await ensureDirectory(shard);
    const destination = path.join(shard, handle.record.id);
    try { await lstat(destination); throw new Error("Publication archive identity already exists"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const pending = path.dirname(handle.directory);
    await rename(handle.directory, destination); handle.directory = destination;
    await syncDirectory(pending); await syncDirectory(shard);
  }
  if (handle.record.backups === "retained") await replaceRecord(handle, SelectedCommitReceiptSchema.parse({ ...handle.record, backups: "released" }));
  for (const [name, hash] of [["original.index", handle.record.originalIndex], ["next.index", handle.record.nextIndex]] as const) {
    if (!hash) continue;
    const file = path.join(handle.directory, name);
    try { if (digest(await ownedFile(file, 32 * 1024 * 1024)) !== hash) throw new Error("Index backup changed before retirement"); await unlink(file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  await syncDirectory(handle.directory);
}

export async function readCommitReceipt(repo: string, id: string): Promise<CommitReceiptHandle> {
  receiptId.parse(id);
  const root = await publicationDirectory(repo); if (!await layoutRoot(root)) throw new Error("Publication receipt layout is missing");
  const pending = path.join(root, "pending", id);
  try { await lstat(pending); return await readAt(pending, id); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return readAt(path.join(root, "archive", id.slice(3, 5), id), id);
}

/** History and current observation remain separate; no index/ref is restored automatically. */
export async function inspectSelectedCommitPublication(repo: string, id: string): Promise<{ receipt: SelectedCommitReceipt; historical: "complete" | "refused" | null; observed: "complete" | "historical_complete" | "head_published_index_pending" | "not_currently_published" | "uncertain" }> {
  const { record } = await readCommitReceipt(repo, id);
  const historical = record.state === "complete" ? "complete" : record.state === "refused" ? "refused" : null;
  const head = (await git(repo, ["rev-parse", "--verify", "-q", "HEAD"], { allowExit: [1] })).trim();
  const branch = (await git(repo, ["symbolic-ref", "-q", "HEAD"], { allowExit: [1] })).trim();
  if (head !== record.commit || (branch || null) !== record.branch) return { receipt: record, historical, observed: historical === "complete" ? "historical_complete" : head === (record.head ?? "") && (branch || null) === record.branch ? "not_currently_published" : "uncertain" };
  const index = path.resolve(repo, (await git(repo, ["rev-parse", "--git-path", "index"])).trim());
  let matches = false;
  try { matches = digest(await ownedFile(index, 32 * 1024 * 1024)) === record.nextIndex; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return { receipt: record, historical, observed: matches ? "complete" : historical === "complete" ? "historical_complete" : "head_published_index_pending" };
}
