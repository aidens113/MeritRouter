import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { newId } from "../storage/db.js";
import type { Db } from "../storage/db.js";
import type { LabRecord } from "./store.js";
import { labOwnedPath } from "./paths.js";
import { HOST_MARKER, captureOwnedProcessTree, stopOwnedProcess, processOwnership } from "./process-ownership.js";
import { minimalEnv } from "../runners/coding/process.js";
const exec = promisify(execFile);
const Row = z.object({ id: z.string().regex(/^tap_[a-z0-9]+$/), lab_id: z.string(), attempt_id: z.string(), kind: z.enum(["service", "setup", "check"]), logical_name: z.string(), token: z.string().regex(/^[a-f0-9]{48}$/), pid: z.number().int().positive().nullable(), directory: z.string(), state: z.enum(["intent", "registered", "running", "stopped"]), created_at: z.number(), updated_at: z.number() });
export type TaskProcessRecord = z.infer<typeof Row>;
const Result = z.object({ exitCode: z.number().int().nullable(), stdout: z.string().max(65536), stderr: z.string().max(65536) }).strict();
// Dormant until the parent durably saves identity and publishes the private grant file.
// The wrapper stays alive after child exit, so recovery can still prove its process tree.
const HOST = `// ${HOST_MARKER}
const fs=require('node:fs');const{spawn}=require('node:child_process');
const cfg=JSON.parse(process.env.MERITROUTER_TASK_COMMAND);delete process.env.MERITROUTER_TASK_COMMAND;
let started=false;let child;let out='';let err='';
const timer=setInterval(()=>{if(started||!fs.existsSync(cfg.grant))return;started=true;
child=spawn(cfg.command,[],{shell:true,cwd:cfg.cwd,env:process.env,windowsHide:true,stdio:['ignore','pipe','pipe']});
const append=(name,data)=>{if(name==='out')out=(out+String(data)).slice(-65536);else err=(err+String(data)).slice(-65536);};
child.stdout.on('data',d=>append('out',d));child.stderr.on('data',d=>append('err',d));
const done=code=>{fs.writeFileSync(cfg.result+'.tmp',JSON.stringify({exitCode:code,stdout:out,stderr:err}),{mode:384});fs.renameSync(cfg.result+'.tmp',cfg.result)};
child.on('error',e=>{err=String(e.message).slice(0,65536);done(1)});child.on('close',code=>done(code));
},30);
`;
export class TaskAttemptProcesses {
  constructor(readonly db: Db, readonly storageDir: string, readonly barrier?: (phase: string, row: TaskProcessRecord) => Promise<void>, readonly authorize?: (attemptId: string) => void) {
  }
  rows(labId: string): TaskProcessRecord[] {
    return this.db.prepare("SELECT * FROM lab_attempt_processes WHERE lab_id=? AND state!='stopped' ORDER BY created_at DESC").all(labId).map(r => Row.parse(r));
  }
  async spawn(lab: LabRecord, attemptId: string, kind: TaskProcessRecord["kind"], name: string, command: string, cwd: string, env: Record<string, string>): Promise<TaskProcessRecord> {
    this.authorize?.(attemptId);
    const id = newId("tap"), token = randomBytes(24).toString("hex"), now = Date.now();
    const directory = labOwnedPath(this.storageDir, path.join(lab.root, "processes", id));
    mkdirSync(directory, { recursive: true });
    const row: TaskProcessRecord = { id, lab_id: lab.id, attempt_id: attemptId, kind, logical_name: name, token, pid: null, directory, state: "intent", created_at: now, updated_at: now };
    this.db.prepare("INSERT INTO lab_attempt_processes(id,lab_id,attempt_id,kind,logical_name,token,pid,directory,state,created_at,updated_at) VALUES(?,?,?,?,?,?,NULL,?,'intent',?,?)").run(id, lab.id, attemptId, kind, name, token, directory, now, now);
    const child = spawn(process.execPath, ["-e", HOST, "--", `--sy-lab-token=${token}`], { cwd, env: minimalEnv({ ...env, MERITROUTER_TASK_COMMAND: JSON.stringify({ command, cwd, grant: path.join(directory, "grant"), result: path.join(directory, "result.json") }) }), detached: true, windowsHide: true, stdio: "ignore" });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    child.unref();
    if (!child.pid)
      throw new Error("task process wrapper did not start");
    // Fault barriers run before PID persistence; the durable nonce must recover this window.
    await this.barrier?.("spawn_before_registration", row);
    row.pid = child.pid;
    await captureOwnedProcessTree(row.pid, token, path.join(directory, "proof.json"));
    this.db.prepare("UPDATE lab_attempt_processes SET pid=?,state='registered',updated_at=? WHERE id=? AND state='intent'").run(row.pid, Date.now(), id);
    row.state = "registered";
    await this.barrier?.("registered_before_grant", row);
    this.authorize?.(attemptId);
    writeFileSync(path.join(directory, "grant"), "registered", { flag: "wx", mode: 0o600 });
    this.db.prepare("UPDATE lab_attempt_processes SET state='running',updated_at=? WHERE id=?").run(Date.now(), id);
    row.state = "running";
    await this.barrier?.("granted", row);
    return row;
  }
  private async discover(row: TaskProcessRecord): Promise<number | null> {
    const needle = `--sy-lab-token=${row.token}`;
    let found: number[] = [];
    if (process.platform === "win32") {
      const script = "@(Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine) | ConvertTo-Json -Compress";
      const raw = JSON.parse((await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script], { windowsHide: true, timeout: 10000, maxBuffer: 8 * 1024 * 1024 })).stdout);
      const rows = z.array(z.object({ ProcessId: z.number().int().nonnegative(), CommandLine: z.string().nullable() })).parse(raw);
      found = rows.filter(r => r.CommandLine?.includes(HOST_MARKER) && r.CommandLine.includes(needle)).map(r => r.ProcessId);
    }
    else if (process.platform === "linux") {
      for (const name of readdirSync("/proc").filter(n => /^\d+$/.test(n))) {
        try {
          const command = readFileSync(`/proc/${name}/cmdline`, "utf8");
          if (command.includes(HOST_MARKER) && command.includes(needle))
            found.push(Number(name));
        }
        catch {
        }
      }
    }
    else
      throw new Error("task process discovery is unsupported on this operating system");
    if (found.length > 1)
      throw new Error("ambiguous task process spawn intent; evidence retained");
    return found[0] ?? null;
  }
  async stop(row: TaskProcessRecord): Promise<void> {
    Row.parse(row);
    const lab = z.object({ root: z.string(), project_id: z.string(), name: z.string(), kind: z.literal("task_attempt"), attempt_id: z.literal(row.attempt_id) }).parse(this.db.prepare("SELECT l.root,l.project_id,l.name,l.kind,a.attempt_id FROM labs l JOIN lab_task_attempts a ON a.lab_id=l.id WHERE l.id=?").get(row.lab_id));
    if (path.resolve(lab.root) !== path.resolve(this.storageDir, "labs", lab.project_id, lab.name) || path.resolve(row.directory) !== path.resolve(lab.root, "processes", row.id))
      throw new Error("process directory is outside exact task attempt ownership");
    labOwnedPath(this.storageDir, row.directory);
    const pid = row.pid ?? await this.discover(row);
    if (pid) {
      this.db.prepare("UPDATE lab_attempt_processes SET pid=?,updated_at=? WHERE id=? AND pid IS NULL").run(pid, Date.now(), row.id);
      if (await processOwnership(pid, row.token) === "owned")
        await captureOwnedProcessTree(pid, row.token, path.join(row.directory, "proof.json"));
      await stopOwnedProcess(pid, row.token, path.join(row.directory, "proof.json"));
    }
    this.db.prepare("UPDATE lab_attempt_processes SET state='stopped',updated_at=? WHERE id=?").run(Date.now(), row.id);
  }
  async stopAll(labId: string): Promise<void> {
    for (const row of this.rows(labId))
      await this.stop(row);
  }
  async run(lab: LabRecord, attemptId: string, kind: "setup" | "check", name: string, command: string, cwd: string, env: Record<string, string>, signal: AbortSignal, timeoutMs: number) {
    const started = Date.now();
    const row = await this.spawn(lab, attemptId, kind, name, command, cwd, env);
    const file = path.join(row.directory, "result.json");
    try {
      while (!existsSync(file)) {
        if (signal.aborted || Date.now() - started >= timeoutMs)
          return { exitCode: null, stdout: "", stderr: "task lab command stopped", killed: signal.aborted ? "cancelled" : "timeout", durationMs: Date.now() - started };
        if (await processOwnership(row.pid!, row.token) !== "owned")
          throw new Error("task command process identity lost");
        await new Promise(r => setTimeout(r, 50));
      }
      if (signal.aborted || Date.now() - started >= timeoutMs)
        return { exitCode: null, stdout: "", stderr: "task lab command stopped", killed: signal.aborted ? "cancelled" : "timeout", durationMs: Date.now() - started };
      // The wrapper caps output; bound the file before reading even if the worktree command tampers with it.
      const { statSync } = await import("node:fs");
      if (statSync(file).size > 1024 * 1024)
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
