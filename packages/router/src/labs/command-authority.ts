import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { ProjectContext } from "../projects/context.js";
import { RepositoryMutationError } from "../workspaces/repository-mutation.js";
import { prepareRepositoryServiceCommand, recoverRepositoryServiceCommand, repositoryServiceAuditArchived, repositoryServicePermit, RepositoryServiceCommandSchema, RepositoryServiceDescriptorSchema,
  observeRepositoryServiceCommand, startRepositoryServiceCommand, stopRepositoryServiceCommand, type RepositoryCommandPermit, type RepositoryServiceCommand, type RepositoryServiceDescriptor } from "../workspaces/repository-command.js";
import type { ServiceCommandInput, ServiceJobBinding } from "../harness/service-command-process.js";
import { assertLabRepositoryOwners, withLabRepositoryStatus, type LabMutationRepository } from "./repository-mutation.js";
import { substitute } from "./recipe.js";
import { HOST_MARKER } from "./process-ownership.js";
import { assertLabEffect } from "./control-authority.js";
import { minimalEnv, type RunResult } from "../runners/coding/process.js";
import { labValues } from "./environment.js";
import { LabsStore, type LabRecord } from "./store.js";

export const LAB_SERVICE_COMMAND_HOST = `// ${HOST_MARKER}
const{spawn}=require('node:child_process');
const cfg=JSON.parse(process.env.MERITROUTER_LAB_COMMAND);
delete process.env.MERITROUTER_LAB_COMMAND;
const child=spawn(cfg.command,[],{shell:true,cwd:cfg.cwd,env:process.env,stdio:'inherit',windowsHide:true});
child.on('error',e=>{console.error(e.message);process.exitCode=1});
child.on('close',code=>process.exit(code===null?1:code));
process.on('SIGTERM',()=>{try{child.kill('SIGTERM')}catch{};setTimeout(()=>process.exit(0),500)});
`;

export const TASK_LAB_COMMAND_HOST = `// ${HOST_MARKER}
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

const Owner = z.object({ id: z.string(), project_id: z.string(), lab_id: z.string(), kind: RepositoryServiceDescriptorSchema.shape.kind,
  logical_name: z.string(), token: z.string().regex(/^[a-f0-9]{48}$/), command_digest: z.string().regex(/^[a-f0-9]{64}$/), worktree_path: z.string(),
  process_id: z.string().nullable(), handle_json: z.string(), phase: z.enum(["prepared", "running"]), created_at: z.number(), updated_at: z.number() }).strict();
export type LabCommandKind = RepositoryServiceDescriptor["kind"];
export interface LabCommandReference { kind: LabCommandKind; name: string; token: string; processId?: string }
const key = (value: string) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Only trusted Lab DB/command metadata callbacks receive own-command admission; never a Git cap. */
export class LabRepositoryCommands {
  private readonly handles = new Map<string, RepositoryServiceCommand>();
  constructor(readonly store: LabsStore, readonly project: (slug: string) => ProjectContext, readonly ownedPath: (lab: LabRecord, target: string) => string) {}
  private group(lab: LabRecord) { return `lab:${lab.project}:${lab.id}`; }
  private assertLab(lab: LabRecord) {
    const persisted = this.store.byId(lab.id);
    const immutable = (record: LabRecord) => ({ id: record.id, project: record.project, name: record.name, kind: record.kind, root: record.root, recipe: record.recipe, repositories: record.repositories });
    if (!persisted || JSON.stringify(immutable(persisted)) !== JSON.stringify(immutable(lab))) throw new RepositoryMutationError("ownership_changed", "Lab command immutable ownership differs from its persisted identity");
    this.ownedPath(lab, lab.root);
  }
  private binding(lab: LabRecord, ref: LabCommandReference) {
    this.assertLab(lab); z.string().regex(/^[a-f0-9]{48}$/).parse(ref.token);
    if ((ref.kind.startsWith("task-") ? "task_attempt" : "retained") !== lab.kind) throw new RepositoryMutationError("ownership_changed", "Lab command kind belongs to another lifecycle");
    let alias: string | undefined, command: string;
    if (ref.kind.endsWith("service")) {
      const service = lab.recipe.services[ref.name]; if (!service) throw new RepositoryMutationError("ownership_changed", "Lab command names an undeclared service"); alias = service.repo; command = service.command;
    } else if (ref.kind.endsWith("setup")) {
      if (!/^(0|[1-9]\d?)$/.test(ref.name)) throw new RepositoryMutationError("ownership_changed", "Lab setup command index is invalid");
      const setup = lab.recipe.setup[Number(ref.name)]; if (!setup) throw new RepositoryMutationError("ownership_changed", "Lab setup command is unavailable");
      alias = typeof setup === "string" ? lab.repositories[0]?.alias : setup.repo; command = typeof setup === "string" ? setup : setup.command;
    } else {
      const check = lab.recipe.checks[ref.name]; if (!check || typeof check !== "string" && !("command" in check)) throw new RepositoryMutationError("ownership_changed", "Lab command names an undeclared shell check");
      alias = typeof check === "string" ? lab.repositories[0]?.alias : check.repo ?? lab.repositories[0]?.alias; command = typeof check === "string" ? check : check.command;
    }
    const repo = lab.repositories.find(candidate => candidate.alias === alias); if (!repo) throw new RepositoryMutationError("ownership_changed", "Lab command repository is unavailable");
    const cwd = this.ownedPath(lab, repo.worktree), rendered = substitute(command, labValues(lab));
    const descriptor = RepositoryServiceDescriptorSchema.parse({ group: this.group(lab), member: ref.token, kind: ref.kind, commandSha256: digest({ name: ref.name, cwd, command: rendered }) });
    const sidecar = ref.processId
      ? this.ownedPath(lab, path.join(lab.root, "processes", z.string().regex(/^tap_[a-z0-9]+$/).parse(ref.processId), "repository-command.json"))
      : this.ownedPath(lab, path.join(lab.root, "commands", `${ref.kind}-${ref.name}-${ref.token}`, "owner.json"));
    return { repo, cwd, command: rendered, descriptor, sidecar };
  }
  private read(lab: LabRecord, ref: LabCommandReference, raw: z.infer<typeof Owner>) {
    const binding = this.binding(lab, ref), handle = RepositoryServiceCommandSchema.parse(JSON.parse(raw.handle_json));
    if (raw.project_id !== lab.project || raw.lab_id !== lab.id || raw.kind !== ref.kind || raw.logical_name !== ref.name || raw.token !== ref.token
      || raw.command_digest !== binding.descriptor.commandSha256 || key(raw.worktree_path) !== key(binding.cwd) || raw.process_id !== (ref.processId ?? null)
      || raw.id !== handle.id || JSON.stringify(handle.descriptor) !== JSON.stringify(binding.descriptor) || key(handle.repo) !== key(realpathSync(binding.cwd)))
      throw new RepositoryMutationError("ownership_changed", "Lab command DB token/recipe/cwd does not match its receipt");
    if (ref.kind === "lab-service") {
      const service = this.store.service(lab.id, ref.name);
      if (!service || service.token !== ref.token) throw new RepositoryMutationError("ownership_changed", "Lab service DB token changed independently of its command owner");
    } else if (ref.processId) {
      const process = z.object({ lab_id: z.string(), logical_name: z.string(), token: z.string() }).optional().parse(this.store.db.prepare("SELECT lab_id,logical_name,token FROM lab_attempt_processes WHERE id=?").get(ref.processId));
      if (!process || process.lab_id !== lab.id || process.logical_name !== ref.name || process.token !== ref.token) throw new RepositoryMutationError("ownership_changed", "Task process DB identity changed independently of its command owner");
    }
    const file = this.ownedPath(lab, binding.sidecar), stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 8192) throw new RepositoryMutationError("ownership_changed", "Lab command sidecar was redirected or hard-linked");
    if (JSON.stringify(RepositoryServiceCommandSchema.parse(JSON.parse(readFileSync(file, "utf8")))) !== JSON.stringify(handle)) throw new RepositoryMutationError("ownership_changed", "Lab command sidecar differs from its exact DB identity");
    return { binding, handle };
  }
  private rows(lab: LabRecord) { return z.array(Owner).parse(this.store.db.prepare("SELECT * FROM lab_command_owners WHERE lab_id=?").all(lab.id)); }
  private ref(row: z.infer<typeof Owner>): LabCommandReference { return { kind: row.kind, name: row.logical_name, token: row.token, ...(row.process_id ? { processId: row.process_id } : {}) }; }
  private async load(lab: LabRecord, row: z.infer<typeof Owner>): Promise<RepositoryServiceCommand | null> {
    const { handle, binding } = this.read(lab, this.ref(row), row);
    if (await repositoryServiceAuditArchived(handle)) { this.handles.delete(row.token); return null; }
    const cached = this.handles.get(row.token);
    if (cached) { repositoryServicePermit(cached, this.group(lab)); return cached; }
    const recovered = await recoverRepositoryServiceCommand(handle, binding.descriptor); this.handles.set(row.token, recovered); return recovered;
  }
  async active(lab: LabRecord): Promise<RepositoryServiceCommand[]> {
    this.assertLab(lab);
    const out: RepositoryServiceCommand[] = [];
    for (const row of this.rows(lab)) { const handle = await this.load(lab, row); if (handle) out.push(handle); }
    return out;
  }
  /**
   * Admission permits for this retained Lab's own live `lab-service` commands whose declared
   * repository is one of `aliases`. Each handle is re-verified against its DB row, sidecar,
   * receipt and native Job (`load`). Setup, check and task-attempt commands are never included,
   * so a caller can admit a mutation of these worktrees only past the Lab's persistent services.
   */
  async servicePermits(lab: LabRecord, aliases: readonly string[]): Promise<RepositoryCommandPermit[]> {
    this.assertLab(lab);
    if (lab.kind !== "retained") throw new RepositoryMutationError("ownership_changed", "Only retained Lab services issue integration permits");
    const out: RepositoryCommandPermit[] = [];
    for (const row of this.rows(lab)) {
      if (row.kind !== "lab-service" || !aliases.includes(lab.recipe.services[row.logical_name]?.repo ?? "")) continue;
      const handle = await this.load(lab, row);
      if (handle) out.push(repositoryServicePermit(handle, this.group(lab)));
    }
    return out;
  }
  async status<T>(lab: LabRecord, action: () => Promise<T>, extra: readonly RepositoryServiceCommand[] = [], repositories: LabMutationRepository[] = []): Promise<T> {
    const handles = [...await this.active(lab), ...extra], permits = [...new Set(handles)].map(handle => repositoryServicePermit(handle, this.group(lab)));
    const scope = [...lab.repositories, ...repositories];
    if (!scope.length) scope.push(...Object.entries(this.project(lab.project).repositoryPaths).map(([alias, repo]) => ({ alias, source: repo.path })));
    return withLabRepositoryStatus(this.project(lab.project), scope, permits, async () => {
      // An archived audit may settle only this exact stale metadata row. It issues no OS/Git cap.
      for (const row of this.rows(lab)) {
        const { handle } = this.read(lab, this.ref(row), row);
        if (await repositoryServiceAuditArchived(handle)) this.store.db.prepare("DELETE FROM lab_command_owners WHERE id=? AND token=? AND handle_json=?").run(row.id, row.token, row.handle_json);
      }
      return action();
    });
  }
  async prepare(lab: LabRecord, ref: LabCommandReference, persistIntent: () => void): Promise<RepositoryServiceCommand> {
    const binding = this.binding(lab, ref);
    await assertLabRepositoryOwners(this.project(lab.project), lab.repositories);
    const siblings = await this.active(lab), handle = await prepareRepositoryServiceCommand(binding.cwd, binding.descriptor, siblings); this.handles.set(ref.token, handle);
    await this.status(lab, async () => {
      const sidecar = this.ownedPath(lab, binding.sidecar); mkdirSync(this.ownedPath(lab, path.dirname(sidecar)), { recursive: true });
      if (existsSync(sidecar)) throw new RepositoryMutationError("ownership_changed", "Lab command sidecar already exists; previous ownership is retained");
      writeFileSync(sidecar, JSON.stringify(handle), { flag: "wx", mode: 0o600 });
      persistIntent();
      const now = Date.now(); this.store.db.prepare("INSERT INTO lab_command_owners(id,project_id,lab_id,kind,logical_name,token,command_digest,worktree_path,process_id,handle_json,phase,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,'prepared',?,?)")
        .run(handle.id, lab.project, lab.id, ref.kind, ref.name, ref.token, binding.descriptor.commandSha256, binding.cwd, ref.processId ?? null, JSON.stringify(handle), now, now);
    }, [handle]);
    return handle;
  }
  async start(lab: LabRecord, ref: LabCommandReference, handle: RepositoryServiceCommand, input: ServiceCommandInput, beforeGrant: (binding: ServiceJobBinding) => Promise<void>, logPath?: string): Promise<ServiceJobBinding> {
    const expected = this.binding(lab, ref);
    if (key(input.cwd) !== key(expected.cwd)) throw new RepositoryMutationError("ownership_changed", "Lab command launch cwd changed");
    const host = ref.kind === "lab-service" ? LAB_SERVICE_COMMAND_HOST : TASK_LAB_COMMAND_HOST;
    if (JSON.stringify(input.args) !== JSON.stringify(["-e", host, "--", `--sy-lab-token=${ref.token}`])) throw new RepositoryMutationError("ownership_changed", "Lab command launch differs from its trusted host protocol");
    if (ref.kind === "lab-service") z.object({ command: z.literal(expected.command), cwd: z.literal(expected.cwd) }).strict().parse(JSON.parse(input.env.MERITROUTER_LAB_COMMAND ?? "null"));
    else {
      const payload = z.object({ command: z.literal(expected.command), cwd: z.literal(expected.cwd), grant: z.string(), result: z.string() }).strict().parse(JSON.parse(input.env.MERITROUTER_TASK_COMMAND ?? "null"));
      const directory = path.dirname(expected.sidecar);
      if (key(this.ownedPath(lab, payload.grant)) !== key(path.join(directory, "grant")) || key(this.ownedPath(lab, payload.result)) !== key(path.join(directory, "result.json"))) throw new RepositoryMutationError("ownership_changed", "Lab command host files differ from its immutable owner directory");
    }
    if (logPath) {
      this.ownedPath(lab, logPath);
      if (existsSync(logPath)) { const stat = lstatSync(logPath); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new RepositoryMutationError("ownership_changed", "Lab command log was redirected or hard-linked"); }
    }
    const siblings = (await this.active(lab)).filter(other => other !== handle);
    return startRepositoryServiceCommand(handle, input, async binding => {
      await this.status(lab, async () => {
        const updated = this.store.db.prepare("UPDATE lab_command_owners SET phase='running',updated_at=? WHERE id=? AND token=? AND command_digest=?").run(Date.now(), handle.id, ref.token, expected.descriptor.commandSha256);
        if (!updated.changes) throw new RepositoryMutationError("ownership_changed", "Lab command registration token changed before execution grant");
      });
      await beforeGrant(binding);
    }, siblings, logPath);
  }
  private row(lab: LabRecord, ref: LabCommandReference) {
    const row = Owner.optional().parse(this.store.db.prepare("SELECT * FROM lab_command_owners WHERE lab_id=? AND kind=? AND logical_name=? AND token=?").get(lab.id, ref.kind, ref.name, ref.token));
    if (!row) throw new RepositoryMutationError("command_uncertain", "Lab process has no durable repository command owner; migration/recovery is required"); return row;
  }
  async retired(lab: LabRecord, ref: LabCommandReference): Promise<boolean> {
    const expected = this.binding(lab, ref), file = this.ownedPath(lab, expected.sidecar), stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 8192) throw new RepositoryMutationError("ownership_changed", "Retired command sidecar ownership is invalid");
    const handle = RepositoryServiceCommandSchema.parse(JSON.parse(readFileSync(file, "utf8")));
    if (JSON.stringify(handle.descriptor) !== JSON.stringify(expected.descriptor) || key(handle.repo) !== key(realpathSync(expected.cwd))) throw new RepositoryMutationError("ownership_changed", "Retired command audit belongs to another immutable command");
    return repositoryServiceAuditArchived(handle);
  }
  async observe(lab: LabRecord, ref: LabCommandReference) {
    const row = this.row(lab, ref), handle = await this.load(lab, row);
    if (!handle) return null; return observeRepositoryServiceCommand(handle);
  }
  async stop(lab: LabRecord, ref: LabCommandReference): Promise<void> {
    await assertLabRepositoryOwners(this.project(lab.project), lab.repositories);
    const row = this.row(lab, ref), handle = await this.load(lab, row);
    if (handle) {
      const observed = await observeRepositoryServiceCommand(handle);
      const recordedPid = ref.processId
        ? z.object({ pid: z.number().nullable() }).parse(this.store.db.prepare("SELECT pid FROM lab_attempt_processes WHERE id=?").get(ref.processId)).pid
        : ref.kind === "lab-service" ? this.store.service(lab.id, ref.name)!.pid : null;
      if (recordedPid !== null && recordedPid !== observed.pid) throw new RepositoryMutationError("ownership_changed", "Lab process PID differs from its original native Job binding");
      const siblings = (await this.active(lab)).filter(other => other !== handle); await stopRepositoryServiceCommand(handle, siblings); this.handles.delete(ref.token);
    }
    await this.status(lab, async () => {
      if (!await repositoryServiceAuditArchived(RepositoryServiceCommandSchema.parse(JSON.parse(row.handle_json)))) throw new RepositoryMutationError("command_uncertain", "Lab command has no verified retired audit; owner row retained");
      this.store.db.prepare("DELETE FROM lab_command_owners WHERE id=? AND token=? AND handle_json=?").run(row.id, row.token, row.handle_json);
    });
  }
  async stopTransient(lab: LabRecord): Promise<void> {
    for (const row of this.rows(lab)) if (row.kind === "lab-setup" || row.kind === "lab-check") await this.stop(lab, this.ref(row));
  }
  async run(lab: LabRecord, kind: "lab-setup" | "lab-check", name: string, env: Record<string, string>, timeoutMs: number, signal?: AbortSignal): Promise<RunResult> {
    const ref = { kind, name, token: randomBytes(24).toString("hex") }, binding = this.binding(lab, ref), command = await this.prepare(lab, ref, () => { assertLabEffect(); });
    const directory = path.dirname(binding.sidecar), resultPath = this.ownedPath(lab, path.join(directory, "result.json")), grantPath = this.ownedPath(lab, path.join(directory, "grant"));
    let started = Date.now(), inspectedAt = started;
    try {
    await this.start(lab, ref, command, { file: process.execPath, args: ["-e", TASK_LAB_COMMAND_HOST, "--", `--sy-lab-token=${ref.token}`], cwd: binding.cwd,
      env: minimalEnv({ ...env, MERITROUTER_TASK_COMMAND: JSON.stringify({ command: binding.command, cwd: binding.cwd, grant: grantPath, result: resultPath }) }), timeoutMs }, async () => {
      await this.status(lab, async () => { assertLabEffect(); if (signal?.aborted) throw new Error("Lab command cancelled before execution grant"); writeFileSync(grantPath, "registered", { flag: "wx", mode: 0o600 }); });
    }, this.ownedPath(lab, path.join(directory, "host.log")));
    started = Date.now(); inspectedAt = started;
      while (!existsSync(resultPath)) {
        if (signal?.aborted || Date.now() - started >= timeoutMs) return { exitCode: null, stdout: "", stderr: "Lab command stopped", killed: signal?.aborted ? "cancelled" : "timeout", durationMs: Date.now() - started };
        assertLabEffect();
        if (Date.now() - inspectedAt >= 1000) {
          const actual = await this.observe(lab, ref); inspectedAt = Date.now();
          if (!actual) throw new RepositoryMutationError("command_uncertain", "Lab command ownership changed before its result");
          if (actual.activeProcesses === 0) return { exitCode: null, stdout: "", stderr: "Lab command ended without a result", killed: Date.now() - started >= timeoutMs ? "timeout" : "process_failed", durationMs: Date.now() - started };
        }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      const stat = lstatSync(this.ownedPath(lab, resultPath));
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1024 * 1024) throw new RepositoryMutationError("ownership_changed", "Lab command result file is unsafe");
      const result = z.object({ exitCode: z.number().int().nullable(), stdout: z.string().max(65536), stderr: z.string().max(65536) }).strict().parse(JSON.parse(readFileSync(resultPath, "utf8")));
      assertLabEffect(); return { ...result, killed: null, durationMs: Date.now() - started };
    } finally { await this.stop(lab, ref); }
  }
}
