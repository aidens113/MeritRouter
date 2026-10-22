import { labOwnedPath } from "./paths.js";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import net from "node:net";
import { immediate } from "../storage/db.js";
import { LabNameSchema } from "./recipe.js";
import type { LabsConfig } from "./recipe.js";
import { substitute } from "./recipe.js";
import { labEnvironment, labValues } from "./environment.js";
import { LabsStore, type LabRecord, type LabServiceRecord } from "./store.js";
import { captureOwnedProcessTree, HOST_MARKER, inspectLabListeners, processOwnership, stopOwnedProcess } from "./process-ownership.js";
import { portAvailable } from "./ports.js";
// The independent wrapper survives its manager. Its random token is verified against the OS
// command line before another manager adopts or terminates it. Declared services run foreground.
const HOST_SOURCE = `// ${HOST_MARKER}
const{spawn}=require('node:child_process');
const cfg=JSON.parse(process.env.SWITCHYARD_LAB_COMMAND);
delete process.env.SWITCHYARD_LAB_COMMAND;
const child=spawn(cfg.command,[],{shell:true,cwd:cfg.cwd,env:process.env,stdio:'inherit',windowsHide:true});
child.on('error',e=>{console.error(e.message);process.exitCode=1});
child.on('close',code=>process.exit(code===null?1:code));
process.on('SIGTERM',()=>{try{child.kill('SIGTERM')}catch{};setTimeout(()=>process.exit(0),500)});
`;
const LEASE_MS = 60000;
export class LabServices {
  constructor(readonly store: LabsStore, readonly config: LabsConfig, readonly owner: string, readonly signal?: AbortSignal) {
  }
  private proofPath(lab: LabRecord, name: string): string {
    return labOwnedPath(path.resolve(lab.root, "../../.."), path.join(lab.root, "logs", `${name}.process-tree.json`));
  }
  private async stopProcess(lab: LabRecord, name: string, pid: number, token: string): Promise<void> {
    try {
      await stopOwnedProcess(pid, token, this.proofPath(lab, name));
    }
    catch (error) {
      const record = this.store.service(lab.id, name);
      if (record) {
        record.state = "failed";
        this.store.saveService(record);
      }
      this.store.event(lab.id, "cleanup_refused", { name, pid, error: (error as Error).message });
      throw error;
    }
  }
  async start(lab: LabRecord, name: string, restarting = false): Promise<LabServiceRecord> {
    LabNameSchema.parse(name);
    const recipe = lab.recipe.services[name];
    if (!Object.hasOwn(lab.recipe.services, name) || !recipe)
      throw new Error(`unknown lab service ${name}`);
    const repo = lab.repositories.find(r => r.alias === recipe.repo);
    if (!repo)
      throw new Error("service repository is not in the lab");
    let previous = this.store.service(lab.id, name);
    if (previous?.pid && previous.token) {
      const ownership = await processOwnership(previous.pid, previous.token);
      if (ownership === "owned") {
        if (previous.owner_id !== this.owner && previous.owner_until > Date.now())
          throw new Error("lab service is owned by another active manager");
        return this.adopt(lab, previous);
      }
      if (ownership === "missing")
        await this.stopProcess(lab, name, previous.pid, previous.token);
      if (ownership === "foreign")
        throw new Error("refused to adopt or replace an unverified recorded process");
    }
    immediate(this.store.db, () => {
      const running = this.store.db.prepare("SELECT COUNT(*) AS n FROM lab_services WHERE state IN ('starting','running','backoff') AND NOT(lab_id=? AND name=?)").get(lab.id, name) as {
        n: number;
      };
      if (running.n >= this.config.max_services)
        throw new Error("lab service limit reached");
      previous = this.store.service(lab.id, name);
      if (previous?.owner_id && previous.owner_id !== this.owner && previous.owner_until > Date.now())
        throw new Error("another manager is starting this service");
      this.store.saveService({ lab_id: lab.id, name, state: "starting", pid: null, token: null, log_path: path.join(lab.root, "logs", `${name}.log`), restart_count: restarting ? (previous?.restart_count ?? 0) : 0, next_restart: null, started_at: Date.now(), owner_id: this.owner, owner_until: Date.now() + LEASE_MS });
    });
    const token = randomBytes(24).toString("hex");
    const logPath = labOwnedPath(path.resolve(lab.root, "../../.."), path.join(lab.root, "logs", `${name}.log`));
    mkdirSync(path.dirname(logPath), { recursive: true });
    const fd = openSync(logPath, "a");
    const child = spawn(process.execPath, ["-e", HOST_SOURCE, "--", `--sy-lab-token=${token}`], { cwd: repo.worktree, env: { ...labEnvironment(lab), SWITCHYARD_LAB_COMMAND: JSON.stringify({ command: substitute(recipe.command, labValues(lab)), cwd: repo.worktree }) }, detached: true, windowsHide: true, stdio: ["ignore", fd, fd] });
    closeSync(fd);
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      if (!child.pid)
        throw new Error("service process did not start");
      const record = this.store.service(lab.id, name)!;
      record.pid = child.pid;
      record.token = token;
      this.store.saveService(record);
      child.unref();
      await this.ready(lab, name, child.pid, token);
      await captureOwnedProcessTree(child.pid, token, this.proofPath(lab, name));
      record.state = "running";
      record.owner_until = Date.now() + LEASE_MS;
      this.store.saveService(record);
      this.store.event(lab.id, "service_started", { name, pid: child.pid });
      return record;
    }
    catch (err) {
      let cleanupFailed = false;
      if (child.pid) {
        try {
          await this.stopProcess(lab, name, child.pid, token);
        }
        catch {
          cleanupFailed = true;
        }
      }
      const record = this.store.service(lab.id, name)!;
      record.state = "failed";
      if (!cleanupFailed) {
        record.pid = null;
        record.token = null;
      }
      this.store.saveService(record);
      this.store.event(lab.id, "service_failed", { name, error: (err as Error).message });
      throw err;
    }
  }
  private async ready(lab: LabRecord, name: string, pid: number, token: string): Promise<void> {
    const readiness = lab.recipe.services[name]!.ready;
    const deadline = Date.now() + this.config.service_ready_timeout_seconds * 1000;
    do {
      if (this.signal?.aborted)
        throw new Error("lab service start cancelled");
      let ready = !readiness;
      if (readiness && "http" in readiness) {
        try {
          const url = new URL(substitute(readiness.http, labValues(lab)));
          if (url.hostname !== "127.0.0.1" || url.protocol !== "http:" || url.username || url.password || !Object.values(lab.ports).includes(Number(url.port)))
            throw new Error("readiness must target this lab's allocated loopback ports");
          const r = await fetch(url, { signal: AbortSignal.timeout(1000), redirect: "error" });
          await r.body?.cancel();
          ready = r.ok;
        }
        catch {
        }
      }
      if (readiness && "tcp" in readiness)
        ready = await new Promise<boolean>(resolve => {
          const socket = net.connect({ host: "127.0.0.1", port: lab.ports[readiness.tcp]! });
          socket.setTimeout(500);
          const done = (v: boolean) => {
            socket.destroy();
            resolve(v);
          };
          socket.once("connect", () => done(true));
          socket.once("error", () => done(false));
          socket.once("timeout", () => done(false));
        });
      if (ready) {
        await inspectLabListeners(pid, token, Object.values(lab.ports));
        return;
      }
      if (await processOwnership(pid, token) !== "owned")
        throw new Error("service exited before readiness");
      this.store.db.prepare("UPDATE lab_services SET owner_until=? WHERE lab_id=? AND name=? AND owner_id=?").run(Date.now() + LEASE_MS, lab.id, name, this.owner);
      await new Promise(r => setTimeout(r, 100));
    } while (Date.now() < deadline);
    throw new Error(`service ${name} readiness timed out`);
  }
  async adopt(lab: LabRecord, s: LabServiceRecord): Promise<LabServiceRecord> {
    if (!s.pid || !s.token || await processOwnership(s.pid, s.token) !== "owned")
      throw new Error("cannot adopt unverified service process");
    const claimed = immediate(this.store.db, () => this.store.db.prepare("UPDATE lab_services SET owner_id=?,owner_until=? WHERE lab_id=? AND name=? AND (owner_id=? OR owner_until<=?)").run(this.owner, Date.now() + LEASE_MS, s.lab_id, s.name, this.owner, Date.now()).changes);
    if (!claimed)
      throw new Error("lab service has another live owner");
    await this.ready(lab, s.name, s.pid, s.token);
    await captureOwnedProcessTree(s.pid, s.token, this.proofPath(lab, s.name));
    s.owner_id = this.owner;
    s.owner_until = Date.now() + LEASE_MS;
    s.state = "running";
    this.store.saveService(s);
    this.store.event(lab.id, "service_adopted", { name: s.name, pid: s.pid });
    return s;
  }
  async stop(lab: LabRecord, name: string): Promise<void> {
    const s = this.store.service(lab.id, name);
    if (!s)
      return;
    if (s.owner_id !== this.owner && s.owner_until > Date.now())
      throw new Error("lab service has another active owner");
    if (s.pid && s.token)
      await this.stopProcess(lab, name, s.pid, s.token);
    s.state = "stopped";
    s.pid = null;
    s.token = null;
    s.owner_id = null;
    s.owner_until = 0;
    s.next_restart = null;
    this.store.saveService(s);
    this.store.event(lab.id, "service_stopped", { name });
  }
  async monitor(lab: LabRecord): Promise<void> {
    for (const s of this.store.services(lab.id)) {
      this.logs(lab, s.name, 1);
      if (s.owner_id !== this.owner) {
        if (s.owner_until > Date.now())
          continue;
        if (s.pid && s.token) {
          const ownership = await processOwnership(s.pid, s.token);
          if (ownership === "owned") {
            await this.adopt(lab, s).catch(err => this.store.event(lab.id, "adoption_refused", { name: s.name, error: (err as Error).message }));
            continue;
          }
          if (ownership === "foreign") {
            s.state = "failed";
            this.store.saveService(s);
            this.store.event(lab.id, "ownership_lost", { name: s.name });
            continue;
          }
        }
        if (s.pid && s.token)
          await this.stopProcess(lab, s.name, s.pid, s.token);
        if (["running", "starting", "backoff"].includes(s.state)) {
          const claimed = immediate(this.store.db, () => this.store.db.prepare("UPDATE lab_services SET owner_id=?,owner_until=? WHERE lab_id=? AND name=? AND owner_until<=?").run(this.owner, Date.now() + LEASE_MS, lab.id, s.name, Date.now()).changes);
          if (!claimed)
            continue;
          s.owner_id = this.owner;
          s.pid = null;
          s.token = null;
          s.restart_count++;
          s.state = s.restart_count > this.config.max_restarts ? "failed" : "backoff";
          s.next_restart = Date.now();
          this.store.saveService(s);
        }
        else
          continue;
      }
      s.owner_until = Date.now() + LEASE_MS;
      if (s.pid && s.token) {
        const ownership = await processOwnership(s.pid, s.token);
        if (ownership === "foreign") {
          s.state = "failed";
          s.owner_until = 0;
          this.store.saveService(s);
          this.store.event(lab.id, "ownership_lost", { name: s.name });
          continue;
        }
        if (ownership === "owned") {
          await inspectLabListeners(s.pid, s.token, Object.values(lab.ports)).catch(async (err) => {
            await this.stop(lab, s.name);
            throw err;
          });
          this.store.saveService(s);
          continue;
        }
        await this.stopProcess(lab, s.name, s.pid, s.token);
        s.pid = null;
        s.token = null;
        s.restart_count++;
        s.state = s.restart_count > this.config.max_restarts ? "failed" : "backoff";
        s.next_restart = Date.now() + Math.min(60000, this.config.restart_backoff_ms * 2 ** (s.restart_count - 1));
        this.store.event(lab.id, "service_crashed", { name: s.name, restarts: s.restart_count });
      }
      this.store.saveService(s);
      if (s.state === "backoff" && s.next_restart !== null && s.next_restart <= Date.now()) {
        await this.start(lab, s.name, true).catch(err => this.store.event(lab.id, "restart_failed", { name: s.name, error: (err as Error).message }));
      }
    }
  }
  logs(lab: LabRecord, name: string, tail = 200): string {
    if (!Object.hasOwn(lab.recipe.services, name))
      throw new Error("unknown lab service");
    const file = labOwnedPath(path.resolve(lab.root, "../../.."), path.join(lab.root, "logs", `${name}.log`));
    if (!existsSync(file))
      return "";
    const size = statSync(file).size;
    const length = Math.min(size, 1024 * 1024);
    const buffer = Buffer.alloc(length);
    const fd = openSync(file, "r");
    try {
      readSync(fd, buffer, 0, length, Math.max(0, size - length));
    }
    finally {
      closeSync(fd);
    }
    const text = buffer.toString("utf8");
    if (size > 10 * 1024 * 1024) {
      writeFileSync(file, text);
      this.store.event(lab.id, "log_rotated", { name, previousBytes: size });
    }
    return text.split(/\r?\n/).slice(-Math.max(1, Math.min(tail, 2000))).join("\n");
  }
}
