import { randomBytes } from "node:crypto";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { newId } from "../storage/db.js";
import type { Db } from "../storage/db.js";
import type { LabRecord } from "./store.js";
import { labOwnedPath } from "./paths.js";
import { captureOwnedProcessTree } from "./process-ownership.js";
import { minimalEnv } from "../runners/coding/process.js";
import { TASK_LAB_COMMAND_HOST } from "./command-authority.js";
import type { LabRepositoryCommands, LabCommandReference } from "./command-authority.js";
import { RepositoryMutationError } from "../workspaces/repository-mutation.js";
const Row = z.object({ id: z.string().regex(/^tap_[a-z0-9]+$/), lab_id: z.string(), attempt_id: z.string(), kind: z.enum(["service", "setup", "check"]), logical_name: z.string(), token: z.string().regex(/^[a-f0-9]{48}$/), pid: z.number().int().positive().nullable(), directory: z.string(), state: z.enum(["intent", "registered", "running", "stopped"]), created_at: z.number(), updated_at: z.number() });
export type TaskProcessRecord = z.infer<typeof Row>;
const Result = z.object({ exitCode: z.number().int().nullable(), stdout: z.string().max(65536), stderr: z.string().max(65536) }).strict();
// Dormant until the parent durably saves identity and publishes the private grant file.
// The wrapper stays alive after child exit, so recovery can still prove its process tree.
export class TaskAttemptProcesses {
  constructor(readonly db: Db, readonly storageDir: string, readonly barrier?: (phase: string, row: TaskProcessRecord) => Promise<void>, readonly authorize?: (attemptId: string) => void, readonly storageForLab?: (project: string, name: string, root: string) => string, readonly commands?: LabRepositoryCommands) {
  }
  private commandAuthority(): LabRepositoryCommands { if (!this.commands) throw new RepositoryMutationError("command_uncertain", "Task process has no verified repository command authority"); return this.commands; }
  private reference(row: TaskProcessRecord): LabCommandReference { return { kind: row.kind === "service" ? "task-service" : row.kind === "setup" ? "task-setup" : "task-check", name: row.logical_name, token: row.token, processId: row.id }; }
  rows(labId: string): TaskProcessRecord[] {
    return this.db.prepare("SELECT * FROM lab_attempt_processes WHERE lab_id=? AND state!='stopped' ORDER BY created_at DESC").all(labId).map(r => Row.parse(r));
  }
  async spawn(lab: LabRecord, attemptId: string, kind: TaskProcessRecord["kind"], name: string, command: string, cwd: string, env: Record<string, string>, timeoutMs: number | null = null): Promise<TaskProcessRecord> {
    this.authorize?.(attemptId);
    const id = newId("tap"), token = randomBytes(24).toString("hex"), now = Date.now();
    const directory = labOwnedPath(this.storageForLab?.(lab.project, lab.name, lab.root) ?? this.storageDir, path.join(lab.root, "processes", id));
    const row: TaskProcessRecord = { id, lab_id: lab.id, attempt_id: attemptId, kind, logical_name: name, token, pid: null, directory, state: "intent", created_at: now, updated_at: now };
    const authority = this.commandAuthority(), ref = this.reference(row);
    const admitted = await authority.prepare(lab, ref, () => {
      this.authorize?.(attemptId); mkdirSync(directory, { recursive: true });
      this.db.prepare("INSERT INTO lab_attempt_processes(id,lab_id,attempt_id,kind,logical_name,token,pid,directory,state,created_at,updated_at) VALUES(?,?,?,?,?,?,NULL,?,'intent',?,?)").run(id, lab.id, attemptId, kind, name, token, directory, now, now);
    });
    await authority.start(lab, ref, admitted, { file: process.execPath, args: ["-e", TASK_LAB_COMMAND_HOST, "--", `--sy-lab-token=${token}`], cwd, env: minimalEnv({ ...env, MERITROUTER_TASK_COMMAND: JSON.stringify({ command, cwd, grant: path.join(directory, "grant"), result: path.join(directory, "result.json") }) }), timeoutMs }, async binding => {
    // Fault barriers run before PID persistence; the durable nonce must recover this window.
    await this.barrier?.("spawn_before_registration", row);
    row.pid = binding.pid;
    await captureOwnedProcessTree(row.pid, token, path.join(directory, "proof.json"));
    await authority.status(lab, async () => { this.db.prepare("UPDATE lab_attempt_processes SET pid=?,state='registered',updated_at=? WHERE id=? AND state='intent'").run(row.pid, Date.now(), id); });
    row.state = "registered";
    await this.barrier?.("registered_before_grant", row);
    this.authorize?.(attemptId);
    await authority.status(lab, async () => {
      this.authorize?.(attemptId); writeFileSync(path.join(directory, "grant"), "registered", { flag: "wx", mode: 0o600 });
      this.db.prepare("UPDATE lab_attempt_processes SET state='running',updated_at=? WHERE id=?").run(Date.now(), id);
    });
    row.state = "running";
    });
    await this.barrier?.("granted", row);
    return row;
  }
  async stop(row: TaskProcessRecord): Promise<void> {
    Row.parse(row);
    const current = Row.parse(this.db.prepare("SELECT * FROM lab_attempt_processes WHERE id=?").get(row.id));
    if (current.lab_id !== row.lab_id || current.attempt_id !== row.attempt_id || current.token !== row.token || current.directory !== row.directory || current.logical_name !== row.logical_name || current.kind !== row.kind) throw new RepositoryMutationError("ownership_changed", "Task process immutable identity changed before stop");
    row = current;
    const lab = z.object({ root: z.string(), project_id: z.string(), name: z.string(), kind: z.literal("task_attempt"), attempt_id: z.literal(row.attempt_id) }).parse(this.db.prepare("SELECT l.root,l.project_id,l.name,l.kind,a.attempt_id FROM labs l JOIN lab_task_attempts a ON a.lab_id=l.id WHERE l.id=?").get(row.lab_id));
    const storage = this.storageForLab?.(lab.project_id, lab.name, lab.root) ?? this.storageDir;
    if (path.resolve(lab.root) !== path.resolve(storage, "labs", lab.project_id, lab.name) || path.resolve(row.directory) !== path.resolve(lab.root, "processes", row.id))
      throw new Error("process directory is outside exact task attempt ownership");
    labOwnedPath(storage, row.directory);
    const authority = this.commandAuthority(), record = authority.store.byId(row.lab_id)!;
    if (row.state === "stopped" && await authority.retired(record, this.reference(row))) return;
    await authority.stop(record, this.reference(row));
    await authority.status(record, async () => { this.db.prepare("UPDATE lab_attempt_processes SET state='stopped',updated_at=? WHERE id=? AND token=?").run(Date.now(), row.id, row.token); });
  }
  async stopAll(labId: string): Promise<void> {
    for (const row of this.rows(labId))
      await this.stop(row);
  }
  async run(lab: LabRecord, attemptId: string, kind: "setup" | "check", name: string, command: string, cwd: string, env: Record<string, string>, signal: AbortSignal, timeoutMs: number) {
    const row = await this.spawn(lab, attemptId, kind, name, command, cwd, env, timeoutMs);
    const started = Date.now(); let inspectedAt = started;
    const file = path.join(row.directory, "result.json");
    try {
      while (!existsSync(file)) {
        if (signal.aborted || Date.now() - started >= timeoutMs)
          return { exitCode: null, stdout: "", stderr: "task lab command stopped", killed: signal.aborted ? "cancelled" : "timeout", durationMs: Date.now() - started };
        if (Date.now() - inspectedAt >= 1000) {
          const actual = await this.commandAuthority().observe(lab, this.reference(row)); inspectedAt = Date.now();
          if (!actual) throw new RepositoryMutationError("command_uncertain", "Task command native Job authority was retired before its result");
          if (actual.activeProcesses === 0 && !existsSync(file)) return { exitCode: null, stdout: "", stderr: "task command ended without a result", killed: Date.now() - started >= timeoutMs ? "timeout" : "process_failed", durationMs: Date.now() - started };
        }
        await new Promise(r => setTimeout(r, 50));
      }
      if (signal.aborted || Date.now() - started >= timeoutMs)
        return { exitCode: null, stdout: "", stderr: "task lab command stopped", killed: signal.aborted ? "cancelled" : "timeout", durationMs: Date.now() - started };
      // The wrapper caps output; bound the file before reading even if the worktree command tampers with it.
      const { lstatSync } = await import("node:fs");
      const stat = lstatSync(labOwnedPath(this.storageForLab?.(lab.project, lab.name, lab.root) ?? this.storageDir, file));
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1024 * 1024)
        throw new Error("task process result exceeded limit");
      this.authorize?.(attemptId);
      const result = Result.parse(JSON.parse(readFileSync(file, "utf8")));
      return { ...result, killed: null, durationMs: Date.now() - started };
    }
    finally {
      await this.stop(row);
    }
  }
}
