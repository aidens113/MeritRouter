import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, open, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { minimalEnv, type RunResult } from "../runners/coding/process.js";
import { windowsCommandJobExecutable } from "./windows-command-job.js";

export interface RepositoryCommandInput { command: string; cwd: string; env: Record<string, string>; timeoutMs: number; signal?: AbortSignal }
export const RepositoryCommandInputSchema = z.object({ command: z.string().min(1).max(16000).refine(value => !value.includes("\0")),
  cwd: z.string().min(1).max(4096).refine(value => path.isAbsolute(value) && !value.includes("\0")),
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(200), z.string().max(65536).refine(value => !value.includes("\0")))
    .refine(value => Object.keys(value).length <= 200 && Buffer.byteLength(JSON.stringify(value)) <= 512 * 1024),
  timeoutMs: z.number().int().positive().max(300000) }).strict();
const Control = z.object({ id: z.string().regex(/^rc_[a-f0-9]{32}$/), nonce: z.string().regex(/^[a-f0-9]{64}$/),
  proofPath: z.string().min(1).max(4096), cancelPath: z.string().min(1).max(4096) }).strict();
const Proof = z.object({ version: z.literal(1), id: z.string().regex(/^rc_[a-f0-9]{32}$/), nonce: z.string().regex(/^[a-f0-9]{64}$/), backend: z.literal("windows-job-v1"),
  phase: z.enum(["quiescent", "unsent"]), activeProcesses: z.literal(0), exitCode: z.number().int().nullable(), killed: z.enum(["timeout", "cancelled", "spawn_failed", "containment_unavailable"]).nullable() }).strict();
declare const proofBrand: unique symbol;
export interface CommandQuiescenceProof { readonly [proofBrand]: true }
const proofs = new WeakMap<object, z.infer<typeof Proof>>();
export function commandQuiescence(proof: CommandQuiescenceProof): z.infer<typeof Proof> {
  const value = proof && typeof proof === "object" ? proofs.get(proof) : undefined;
  if (!value) throw new Error("Forged or missing command quiescence proof");
  return Proof.parse(value);
}
export class CommandProcessUncertainError extends Error { constructor(reason: string) { super(reason); this.name = "CommandProcessUncertainError"; } }
interface ProcessControl extends z.infer<typeof Control> { started?: (pid: number) => Promise<void> }
const CAP = 4 * 1024 * 1024;
export async function runCommandProcess(input: RepositoryCommandInput, host: ProcessControl): Promise<{ result: RunResult; proof: CommandQuiescenceProof }> {
  const { signal, ...raw } = input, parsed = RepositoryCommandInputSchema.parse(raw), control = Control.parse({ id: host.id, nonce: host.nonce, proofPath: host.proofPath, cancelPath: host.cancelPath });
  const started = Date.now();
  const unsent = (killed: "cancelled" | "containment_unavailable", reason = "") => {
    const proof = Object.freeze({}) as CommandQuiescenceProof;
    proofs.set(proof, Proof.parse({ version: 1, id: control.id, nonce: control.nonce, backend: "windows-job-v1", phase: "unsent", activeProcesses: 0, exitCode: null, killed }));
    return { result: { exitCode: null, stdout: "", stderr: reason, killed, durationMs: Date.now() - started }, proof };
  };
  if (process.platform !== "win32") throw new CommandProcessUncertainError("Verified command process containment is unavailable on this platform; active receipt retained");
  if (signal?.aborted) return unsent("cancelled");
  let executable: string;
  try { executable = await windowsCommandJobExecutable(); }
  catch { return unsent("containment_unavailable", "Verified command helper could not initialize; reviewed command was not started"); }
  if (signal?.aborted) return unsent("cancelled");
  const key = randomBytes(32);
  const shell = process.env.COMSPEC ?? process.env.ComSpec ?? path.join(process.env.SystemRoot ?? "C:/Windows", "System32", "cmd.exe");
  const config = { ...control, proofKey: key.toString("base64"), shell, command: parsed.command, cwd: parsed.cwd, environment: parsed.env, timeoutMs: parsed.timeoutMs };
  const child = spawn(executable, [], { cwd: parsed.cwd, env: minimalEnv({}), windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let bytesOut = 0, bytesErr = 0, stdout = "", stderr = "", spawned = false, payloadSent = false, forced = false;
  let initialization: Promise<void> = Promise.resolve();
  child.stdin.on("error", () => {});
  child.stdout.on("data", (chunk: Buffer) => { const take = chunk.subarray(0, Math.max(0, CAP - bytesOut)); bytesOut += take.length; stdout += take.toString("utf8"); });
  child.stderr.on("data", (chunk: Buffer) => { const take = chunk.subarray(0, Math.max(0, CAP - bytesErr)); bytesErr += take.length; stderr += take.toString("utf8"); });
  let cancelWrite: Promise<void> | undefined;
  const cancel = () => cancelWrite ??= (async () => {
    const file = await open(control.cancelPath, "wx", 0o600).catch(error => { if ((error as NodeJS.ErrnoException).code === "EEXIST") return null; throw error; });
    if (file) try { await file.writeFile("cancelled"); await file.sync(); } finally { await file.close(); }
  })().catch(() => { forced = true; child.kill(); });
  signal?.addEventListener("abort", cancel);
  if (signal?.aborted) void cancel();
  child.on("spawn", () => {
    spawned = true;
    initialization = (async () => { await host.started?.(child.pid!); payloadSent = true; child.stdin.end(JSON.stringify(config)); })().catch(() => { child.stdin.destroy(); child.kill(); });
  });
  let spawnError = false;
  child.on("error", () => { spawnError = !spawned && child.pid === undefined; });
  const hardStop = setTimeout(() => { forced = true; child.kill(); }, parsed.timeoutMs + 20000);
  try {
    const code = await new Promise<number | null>(resolve => child.on("close", resolve));
    await initialization; await cancelWrite;
    if (spawnError || !payloadSent) return unsent("containment_unavailable", "Reviewed command was not sent to the verified helper");
    if (forced || code !== 0) throw new CommandProcessUncertainError("Command helper ended without verified job quiescence; active receipt retained");
    const stat = await lstat(control.proofPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 8192) throw new CommandProcessUncertainError("Command completion proof is unsafe; active receipt retained");
    const envelope = z.object({ payload: z.string().max(8192), signature: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(JSON.parse((await readFile(control.proofPath)).toString("utf8")));
    const payload = Buffer.from(envelope.payload, "base64"), signature = Buffer.from(envelope.signature, "hex");
    if (!timingSafeEqual(signature, createHmac("sha256", key).update(payload).digest())) throw new CommandProcessUncertainError("Command completion authentication failed; active receipt retained");
    const observed = Proof.parse(JSON.parse(payload.toString("utf8")));
    if (observed.id !== control.id || observed.nonce !== control.nonce) throw new CommandProcessUncertainError("Command completion identity changed; active receipt retained");
    const proof = Object.freeze({}) as CommandQuiescenceProof; proofs.set(proof, observed);
    return { result: { exitCode: observed.exitCode, stdout, stderr, killed: observed.killed, durationMs: Date.now() - started }, proof };
  } catch (error) {
    if (error instanceof CommandProcessUncertainError) throw error;
    throw new CommandProcessUncertainError("Command completion could not be verified; active receipt retained");
  } finally { clearTimeout(hardStop); signal?.removeEventListener("abort", cancel); key.fill(0); }
}
