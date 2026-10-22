import { LabControl, type LabOperation, type LabOperationInput } from "./control.js";
import { labCoordination, type LabCoordination } from "./coordination.js";
import { LabPromotionResultSchema, promoteLab, type LabPromotionInput, type LabPromotionResult } from "./promotion.js";
import { labHttp, type LabHttpInput, type LabHttpResult } from "./http.js";
import { claimLabJob, bindLabTask, labTaskContext, labConfiguration, assertLabTaskBases, type LabRunContext } from "./binding.js";
import { redactLabText, publicLabStatus, type LabPublicStatus } from "./public-status.js";
import type { TaskStore } from "../storage/tasks.js";
import type { WorkerTask } from "../core/task.js";
import { worktreeHead } from "./revisions.js";
import { pruneTaskWorktrees, type LabRetentionResult } from "./retention.js";
import { SwitchyardError } from "../core/errors.js";
import path from "node:path";
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { ResolvedConfig } from "../config/load.js";
import type { ProjectContext } from "../projects/context.js";
import { ProjectConfigSchema } from "../projects/schema.js";
import { immediate, newId, type Db } from "../storage/db.js";
import { dirtyPaths, git } from "../workspaces/git.js";
import { runProcess } from "../runners/coding/process.js";
import { LabsConfigSchema, LabNameSchema, validateRecipe, substitute } from "./recipe.js";
import { LabsStore, type LabRecord, type LabServiceRecord } from "./store.js";
import { allocatePorts } from "./ports.js";
import { labOwnedPath } from "./paths.js";
import { labEnvironment, labValues } from "./environment.js";
import { LabServices } from "./services.js";
import { labChecks, runLabCheck, LabCheckResultSchema, type LabCheckResult } from "./checks.js";
export interface LabManagerOptions {
  db: Db;
  storageDir: string;
  cfg: ResolvedConfig;
  project: (slug: string) => ProjectContext;
  monitor?: boolean;
}
export interface LabStatus {
  lab: LabRecord;
  services: LabServiceRecord[];
  checks: LabCheckResult[];
  urls: Record<string, string>;
  heads: Record<string, string | null>;
}
export class LabManager {
  readonly store: LabsStore;
  readonly owner = randomBytes(24).toString("hex");
  readonly services: LabServices;
  readonly controls: LabControl;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private closed = false;
  private lastRetention = 0;
  private readonly abort = new AbortController();
  private readonly operations = new Set<Promise<unknown>>();
  private readonly busyLabs = new Set<string>();
  constructor(readonly options: LabManagerOptions) {
    this.store = new LabsStore(options.db);
    this.services = new LabServices(this.store, LabsConfigSchema.parse(options.cfg.labs), this.owner, this.abort.signal);
    this.controls = new LabControl(this.store, this.owner, (project, name, input) => this.executeControl(project, name, input), (project, name) => !this.busyLabs.has(`${project}/${name}`));
    if (options.monitor !== false) {
      this.timer = setInterval(() => {
        if (this.closed)
          return;
        // Lifecycle/check requests may outlast one tick; their services retain leases while awaited.
        this.options.db.prepare("UPDATE lab_services SET owner_until=? WHERE owner_id=? AND state IN ('running','starting','backoff')").run(Date.now() + 60000, this.owner);
        void this.tick().catch(() => undefined);
      }, 1000);
      this.timer.unref();
    }
  }
  private async track<T>(fn: () => Promise<T>, key: string): Promise<T> {
    if (this.closed)
      throw new SwitchyardError("lab_invalid_state", "lab manager is closed");
    if (this.busyLabs.has(key))
      throw new SwitchyardError("lab_invalid_state", "another operation is in progress for this lab");
    this.busyLabs.add(key);
    const operation = fn();
    this.operations.add(operation);
    try {
      return await operation;
    }
    finally {
      this.operations.delete(operation);
      this.busyLabs.delete(key);
    }
  }
  create(project: string, name: string, input: {
    goal?: string;
    targetBranches?: Record<string, string>;
  } = {}): Promise<LabStatus> {
    return this.track(() => this.createLab(project, name, input), `${project}/${name}`);
  }
  start(project: string, name: string): Promise<LabStatus> {
    return this.routedStatus(project, name, { kind: "start" }, () => this.startLab(project, name));
  }
  stop(project: string, name: string): Promise<LabStatus> {
    return this.routedStatus(project, name, { kind: "stop" }, () => this.stopLab(project, name));
  }
  restart(project: string, name: string, service?: string): Promise<LabStatus> {
    return this.routedStatus(project, name, { kind: "restart", ...(service ? { service } : {}) }, () => this.restartLab(project, name, service));
  }
  refresh(project: string, name: string): Promise<LabStatus> {
    return this.routedStatus(project, name, { kind: "refresh" }, () => this.refreshLab(project, name));
  }
  async check(project: string, name: string, check: string): Promise<LabCheckResult> {
    if (this.foreignOwner(project, name)) {
      const op = await this.control(project, name, { kind: "check", name: check });
      return LabCheckResultSchema.parse(op.result);
    }
    return this.track(() => this.checkLab(project, name, check), `${project}/${name}`);
  }
  async destroy(project: string, name: string): Promise<void> {
    if (this.foreignOwner(project, name)) {
      await this.control(project, name, { kind: "destroy" });
      return;
    }
    return this.track(() => this.destroyLab(project, name), `${project}/${name}`);
  }
  private foreignOwner(project: string, name: string): boolean {
    const lab = this.require(project, name);
    const owner = this.controls.activeOwner(lab.id);
    return !!owner && owner !== this.owner;
  }
  private async routedStatus(project: string, name: string, input: LabOperationInput, run: () => Promise<LabStatus>): Promise<LabStatus> {
    if (this.foreignOwner(project, name)) {
      await this.control(project, name, input);
      return this.status(project, name);
    }
    return this.track(run, `${project}/${name}`);
  }
  reloadConfig(): void {
    Object.assign(this.services.config, LabsConfigSchema.parse(this.options.cfg.labs));
  }
  requestControl(project: string, name: string, input: LabOperationInput, by = "human:cli"): LabOperation {
    this.options.project(project);
    return this.controls.submit(project, name, input, by);
  }
  operation(project: string, name: string, id: string): LabOperation | null {
    this.options.project(project);
    return this.controls.get(project, name, id);
  }
  waitOperation(project: string, name: string, id: string, options: {
    timeoutMs?: number;
    signal?: AbortSignal;
  } = {}): Promise<LabOperation> {
    this.options.project(project);
    return this.controls.wait(project, name, id, { signal: this.abort.signal, ...options });
  }
  async control(project: string, name: string, input: LabOperationInput, by = "controller", options: {
    timeoutMs?: number;
    signal?: AbortSignal;
  } = {}): Promise<LabOperation> {
    const op = this.requestControl(project, name, input, by);
    return this.waitOperation(project, name, op.id, options);
  }
  async processControls(): Promise<void> {
    if (this.closed)
      return;
    await this.controls.processAll();
  }
  private async executeControl(project: string, name: string, input: LabOperationInput): Promise<unknown> {
    return this.track(async () => {
      switch (input.kind) {
        case "create": {
          const { kind, ...value } = input;
          return publicLabStatus(await this.createLab(project, name, value));
        }
        case "start": return publicLabStatus(await this.startLab(project, name));
        case "stop": return publicLabStatus(await this.stopLab(project, name));
        case "restart": return publicLabStatus(await this.restartLab(project, name, input.service));
        case "refresh": return publicLabStatus(await this.refreshLab(project, name));
        case "destroy":
          await this.destroyLab(project, name);
          return { destroyed: true };
        case "check": return this.checkLab(project, name, input.name);
        case "after_integrate": return this.afterIntegrationLab(project, name, input.expectedHeads);
        case "promote": return this.promoteLab(project, name, { by: input.by, reason: input.reason });
      }
    }, `${project}/${name}`);
  }
  coordination(project: string, name: string): Promise<LabCoordination> {
    return labCoordination(this, project, name);
  }
  async promote(project: string, name: string, input: LabPromotionInput): Promise<LabPromotionResult> {
    if (this.foreignOwner(project, name)) {
      const op = await this.control(project, name, { kind: "promote", ...input });
      return LabPromotionResultSchema.parse(op.result);
    }
    return this.track(() => this.promoteLab(project, name, input), `${project}/${name}`);
  }
  private promoteLab(project: string, name: string, input: LabPromotionInput): Promise<LabPromotionResult> {
    return promoteLab(this, project, name, input, { refresh: () => this.refreshLab(project, name), start: () => this.startLab(project, name), check: check => this.checkLab(project, name, check) });
  }
  async afterIntegration(project: string, name: string, expectedHeads: Record<string, string>): Promise<LabCheckResult[]> {
    if (this.foreignOwner(project, name)) {
      const op = await this.control(project, name, { kind: "after_integrate", expectedHeads });
      return z.array(LabCheckResultSchema).parse(op.result);
    }
    return this.track(() => this.afterIntegrationLab(project, name, expectedHeads), `${project}/${name}`);
  }
  private async afterIntegrationLab(project: string, name: string, expectedHeads: Record<string, string>): Promise<LabCheckResult[]> {
    const before = this.status(project, name);
    const parsed = z.record(z.string(), z.string().regex(/^[a-f0-9]{40,64}$/)).parse(expectedHeads);
    for (const [alias, head] of Object.entries(parsed))
      if (before.heads[alias] !== head)
        throw new SwitchyardError("lab_revision_changed", "lab advanced before its integration hook could run");
    const order: string[] = [];
    const visit = (service: string) => {
      if (order.includes(service))
        return;
      for (const dep of before.lab.recipe.services[service]!.after)
        visit(dep);
      order.push(service);
    };
    for (const service of Object.keys(before.lab.recipe.services))
      visit(service);
    for (const service of order.filter(n => before.lab.recipe.services[n]!.restart_on_integrate))
      await this.restartLab(project, name, service);
    const out: LabCheckResult[] = [];
    for (const [nameOfCheck, check] of Object.entries(before.lab.recipe.checks))
      if (typeof check !== "string" && check.on_integrate)
        out.push(await this.checkLab(project, name, nameOfCheck));
    for (const [alias, head] of Object.entries(parsed))
      if (this.status(project, name).heads[alias] !== head)
        throw new SwitchyardError("lab_revision_changed", "lab advanced while its integration checks ran");
    return out;
  }
  claimJob(project: string, name: string, jobId: string, tasks: TaskStore): LabRunContext {
    return claimLabJob(this, project, name, jobId, tasks);
  }
  bindTask(project: string, taskId: string, spec: WorkerTask, tasks: TaskStore): LabRunContext | null {
    return bindLabTask(this, project, taskId, spec, tasks);
  }
  configuration(project: string, name: string): ResolvedConfig {
    return labConfiguration(this, project, name);
  }
  contextForTask(project: string, taskId: string, spec: WorkerTask, tasks: TaskStore): {
    binding: LabRunContext | null;
    cfg: ResolvedConfig;
  } {
    return labTaskContext(this, project, taskId, spec, tasks);
  }
  assertTaskBases(binding: LabRunContext, spec: WorkerTask, tasks: TaskStore): Promise<void> {
    return assertLabTaskBases(binding, spec, tasks);
  }
  publicStatus(project: string, name: string): LabPublicStatus & {
    ownership: "local" | "other" | null;
  } {
    const status = this.status(project, name);
    const owner = this.controls.activeOwner(status.lab.id);
    return { ...publicLabStatus(status), ownership: owner ? (owner === this.owner ? "local" : "other") : null };
  }
  private publicOperationResult(project: string, name: string, op: LabOperation): unknown {
    if (op.state !== "completed")
      return null;
    switch (op.input.kind) {
      case "destroy": return z.object({ destroyed: z.literal(true) }).parse(op.result);
      case "check": {
        const result = LabCheckResultSchema.parse(op.result);
        return { ...result, stdout: this.redact(project, name, result.stdout), stderr: this.redact(project, name, result.stderr) };
      }
      case "after_integrate": return z.array(LabCheckResultSchema).parse(op.result).map(result => ({ ...result, stdout: this.redact(project, name, result.stdout), stderr: this.redact(project, name, result.stderr) }));
      case "promote": {
        const result = LabPromotionResultSchema.parse(op.result);
        return { ...result, checks: result.checks.map(check => ({ ...check, stdout: this.redact(project, name, check.stdout), stderr: this.redact(project, name, check.stderr) })), error: result.error ? "Promotion did not complete; inspect local supervisor logs for details." : null };
      }
      default: return this.store.get(project, name)?.state === "destroyed" ? null : this.publicStatus(project, name);
    }
  }
  publicOperation(project: string, name: string, id: string) {
    const op = this.operation(project, name, id);
    if (!op)
      return null;
    return { id: op.id, result: this.publicOperationResult(project, name, op), kind: op.input.kind, ...(op.input.kind === "promote" && op.input.reason ? { promotionReason: this.redact(project, name, op.input.reason) } : {}), state: op.state, requestedBy: op.requestedBy, errorCode: op.errorCode, errorMessage: op.errorCode ? "Lab operation failed; inspect local supervisor logs for details." : null, createdAt: op.createdAt, updatedAt: op.updatedAt };
  }
  publicOperations(project: string, name: string, limit = 20) {
    this.options.project(project);
    const parsed = z.number().int().min(1).max(100).parse(limit);
    const rows = z.array(z.object({ id: z.string() })).parse(this.options.db.prepare("SELECT id FROM lab_operations WHERE project_id=? AND lab_name=? ORDER BY created_at DESC LIMIT ?").all(project, name, parsed));
    return rows.flatMap(row => this.publicOperation(project, name, row.id) ?? []);
  }
  redact(project: string, name: string, text: string): string {
    this.options.project(project);
    const lab = this.store.get(project, name);
    if (!lab)
      return text;
    return redactLabText({ lab, services: this.store.services(lab.id), checks: [], urls: {}, heads: {} }, text);
  }
  http(project: string, name: string, input: LabHttpInput): Promise<LabHttpResult> {
    return labHttp(this, project, name, input);
  }
  private require(project: string, name: string): LabRecord {
    z.string().regex(/^[a-z0-9][a-z0-9._-]*$/).parse(project);
    LabNameSchema.parse(name);
    this.options.project(project);
    const lab = this.store.get(project, name);
    if (!lab || lab.state === "destroyed")
      throw new SwitchyardError("not_found", `unknown lab ${project}/${name}`);
    const expected = path.resolve(this.options.storageDir, "labs", project, name);
    if (path.resolve(lab.root) !== expected)
      throw new Error("recorded lab root does not match its project and name");
    labOwnedPath(this.options.storageDir, lab.root);
    if (existsSync(lab.root)) {
      const marker = labOwnedPath(this.options.storageDir, path.join(lab.root, ".switchyard-lab.json"));
      const proof = z.object({ id: z.literal(lab.id), project: z.literal(project), name: z.literal(name) }).safeParse(JSON.parse(readFileSync(marker, "utf8")));
      if (!proof.success)
        throw new Error("lab directory ownership marker does not match persisted identity");
    }
    const ctx = this.options.project(project);
    for (const repo of lab.repositories) {
      if (!Object.hasOwn(ctx.repositoryPaths, repo.alias))
        throw new Error("lab repository is not configured in this project");
      if (path.resolve(repo.worktree) !== path.join(expected, "repos", repo.alias) || path.resolve(ctx.repositoryPaths[repo.alias]?.path ?? "") !== path.resolve(repo.source))
        throw new Error("lab repository ownership does not match project configuration");
      labOwnedPath(this.options.storageDir, repo.worktree);
    }
    return lab;
  }
  list(project?: string): LabRecord[] {
    if (project !== undefined)
      this.options.project(project);
    return this.store.list(project).filter(l => l.state !== "destroyed");
  }
  status(project: string, name: string): LabStatus {
    const lab = this.require(project, name);
    const urls: Record<string, string> = {};
    for (const [service, recipe] of Object.entries(lab.recipe.services)) {
      if (recipe.ready && "http" in recipe.ready)
        urls[service] = substitute(recipe.ready.http, labValues(lab));
    }
    return { lab, services: this.store.services(lab.id), checks: labChecks(this.store, lab.id), urls, heads: Object.fromEntries(lab.repositories.map(r => [r.alias, worktreeHead(r.worktree)])) };
  }
  touch(project: string, name: string): void {
    const lab = this.require(project, name);
    lab.lastActivity = Date.now();
    lab.updatedAt = Date.now();
    this.store.save(lab);
  }
  private async createLab(project: string, name: string, input: {
    goal?: string;
    targetBranches?: Record<string, string>;
  } = {}): Promise<LabStatus> {
    this.reloadConfig();
    input = z.object({ goal: z.string().max(16000).optional(), targetBranches: z.record(z.string().regex(/^[a-z][a-z0-9_-]*$/), z.string().min(1).max(300)).optional() }).strict().parse(input);
    LabNameSchema.parse(name);
    z.string().regex(/^[a-z0-9][a-z0-9._-]*$/).parse(project);
    const ctx = this.options.project(project);
    const projectConfig = ProjectConfigSchema.parse(this.options.cfg.projects[project] ?? {});
    if (!projectConfig.lab)
      throw new SwitchyardError("lab_not_configured", `project ${project} has no configured lab recipe`);
    for (const alias of Object.keys(input.targetBranches ?? {}))
      if (!Object.hasOwn(ctx.repositoryPaths, alias))
        throw new SwitchyardError("lab_invalid_input", `unknown target repository ${alias}`);
    const recipe = validateRecipe(projectConfig.lab, Object.keys(ctx.repositoryPaths));
    if (!Object.keys(ctx.repositoryPaths).length)
      throw new Error("a lab needs a project repository");
    const cfg = this.services.config;
    const root = labOwnedPath(this.options.storageDir, path.join(this.options.storageDir, "labs", project, name));
    if (existsSync(root))
      throw new Error("lab directory already exists; refusing to adopt its data during creation");
    const now = Date.now();
    let lab: LabRecord = { id: newId("lab"), project, name, state: "creating", root, recipe, repositories: [], ports: {}, env: {}, goal: z.string().max(16000).parse(input.goal ?? ""), createdAt: now, updatedAt: now, lastActivity: now };
    immediate(this.options.db, () => {
      const all = this.store.list().filter(l => l.state !== "destroyed");
      if (all.length >= cfg.max_active || all.filter(l => l.project === project).length >= (projectConfig.labs.max_active ?? cfg.max_active))
        throw new SwitchyardError("lab_limit_reached", "active lab limit reached");
      if (this.store.get(project, name))
        throw new SwitchyardError("lab_conflict", "lab name already exists; destroyed lab branches are preserved, choose a new name");
      this.store.insert(lab);
      this.options.db.prepare("UPDATE labs SET creation_owner=?,creation_until=? WHERE id=?").run(this.owner, Date.now() + 120000, lab.id);
    });
    const creationTimer = setInterval(() => this.options.db.prepare("UPDATE labs SET creation_until=? WHERE id=? AND creation_owner=?").run(Date.now() + 120000, lab.id, this.owner), 10000);
    creationTimer.unref();
    try {
      if (existsSync(root))
        throw new Error("lab directory already exists and is not adopted during creation");
      mkdirSync(path.dirname(root), { recursive: true });
      mkdirSync(root);
      writeFileSync(path.join(root, ".switchyard-lab.json"), JSON.stringify({ id: lab.id, project, name }), { flag: "wx" });
      mkdirSync(path.join(root, "logs"), { recursive: true });
      for (const data of [...recipe.data, "home", "cache"])
        mkdirSync(path.join(root, "data", data), { recursive: true });
      lab.ports = await allocatePorts(this.options.db, lab.id, recipe.ports, cfg.port_range);
      this.store.save(lab);
      for (const [alias, source] of Object.entries(ctx.repositoryPaths)) {
        const requested = input.targetBranches?.[alias];
        const target = requested ?? (await git(source.path, ["symbolic-ref", "--quiet", "--short", "HEAD"])).trim();
        if (!target || target.startsWith("-") || /[\0\r\n]/.test(target))
          throw new Error("lab target must be a branch name");
        await git(source.path, ["show-ref", "--verify", `refs/heads/${target}`]);
        const base = (await git(source.path, ["rev-parse", "--verify", "--end-of-options", `${target}^{commit}`])).trim();
        const projectPart = project.replace(/[^a-z0-9-]/g, "-");
        const branch = `switchyard/lab-${projectPart}-${name}-${lab.id.slice(-6)}`;
        const worktree = labOwnedPath(this.options.storageDir, path.join(root, "repos", alias));
        mkdirSync(path.dirname(worktree), { recursive: true });
        lab.repositories.push({ alias, source: source.path, worktree, branch, target, base });
        lab.updatedAt = Date.now();
        this.store.save(lab);
        await git(source.path, ["worktree", "add", "--quiet", "-b", branch, worktree, base]);
      }
      lab.env = labEnvironment(lab);
      this.store.save(lab);
      for (const setup of recipe.setup) {
        const repo = typeof setup === "string" ? lab.repositories[0] : lab.repositories.find(r => r.alias === setup.repo);
        if (!repo)
          throw new Error("setup repository unavailable");
        const result = await runProcess(substitute(typeof setup === "string" ? setup : setup.command, labValues(lab)), [], { cwd: repo.worktree, env: labEnvironment(lab), timeoutMs: cfg.setup_timeout_seconds * 1000, shell: true, signal: this.abort.signal });
        this.store.event(lab.id, "setup_finished", { repository: repo.alias, ...result });
        if (result.exitCode !== 0 || result.killed)
          throw new Error(`lab setup failed: ${result.stderr.slice(-1000)}`);
      }
      lab.state = "stopped";
      lab.updatedAt = Date.now();
      this.store.save(lab);
      return this.status(project, name);
    }
    catch (err) {
      lab.state = "failed";
      lab.updatedAt = Date.now();
      this.store.save(lab);
      this.store.event(lab.id, "creation_failed", { error: (err as Error).message });
      throw err;
    }
    finally {
      clearInterval(creationTimer);
      this.options.db.prepare("UPDATE labs SET creation_until=0 WHERE id=? AND creation_owner=?").run(lab.id, this.owner);
    }
  }
  private async startLab(project: string, name: string): Promise<LabStatus> {
    const lab = this.require(project, name);
    if (["creating", "starting"].includes(lab.state))
      throw new SwitchyardError("lab_invalid_state", "lab creation is incomplete");
    lab.state = "starting";
    lab.updatedAt = Date.now();
    this.store.save(lab);
    const started = new Set<string>();
    const visit = async (service: string): Promise<void> => {
      if (started.has(service))
        return;
      for (const dep of lab.recipe.services[service]!.after)
        await visit(dep);
      await this.services.start(lab, service);
      started.add(service);
    };
    try {
      for (const service of Object.keys(lab.recipe.services))
        await visit(service);
      lab.state = "running";
      lab.lastActivity = Date.now();
      lab.updatedAt = Date.now();
      this.store.save(lab);
      this.store.event(lab.id, "started", {});
      return this.status(project, name);
    }
    catch (err) {
      for (const service of [...started].reverse())
        await this.services.stop(lab, service).catch(() => undefined);
      lab.state = "failed";
      lab.updatedAt = Date.now();
      this.store.save(lab);
      throw err;
    }
  }
  private async stopLab(project: string, name: string): Promise<LabStatus> {
    const lab = this.require(project, name);
    if (["creating", "starting"].includes(lab.state))
      throw new SwitchyardError("lab_invalid_state", "lab operation is still in progress");
    for (const service of this.store.services(lab.id).reverse())
      await this.services.stop(lab, service.name);
    lab.state = "stopped";
    lab.updatedAt = Date.now();
    this.store.save(lab);
    this.store.event(lab.id, "stopped", {});
    return this.status(project, name);
  }
  private async restartLab(project: string, name: string, service?: string): Promise<LabStatus> {
    const lab = this.require(project, name);
    if (["creating", "starting"].includes(lab.state))
      throw new SwitchyardError("lab_invalid_state", "lab operation is still in progress");
    if (service) {
      if (!Object.hasOwn(lab.recipe.services, service))
        throw new Error("unknown lab service");
      await this.services.stop(lab, service);
      await this.services.start(lab, service);
      lab.lastActivity = Date.now();
      lab.updatedAt = Date.now();
      lab.state = "running";
      this.store.save(lab);
      return this.status(project, name);
    }
    await this.stopLab(project, name);
    return this.startLab(project, name);
  }
  logs(project: string, name: string, service: string, tail = 200): string {
    LabNameSchema.parse(service);
    z.number().int().min(1).max(2000).parse(tail);
    return redactLabText(this.status(project, name), this.services.logs(this.require(project, name), service, tail));
  }
  private async checkLab(project: string, name: string, check: string): Promise<LabCheckResult> {
    const lab = this.require(project, name);
    this.touch(project, name);
    return runLabCheck(this.store, lab, check, this.services.config.check_timeout_seconds, this.abort.signal);
  }
  private async refreshLab(project: string, name: string): Promise<LabStatus> {
    let lab = this.require(project, name);
    if (["creating", "starting"].includes(lab.state))
      throw new SwitchyardError("lab_invalid_state", "lab operation is still in progress");
    for (const repo of lab.repositories)
      if ((await dirtyPaths(repo.worktree)).length)
        throw new SwitchyardError("lab_dirty", "lab has uncommitted changes; commit them before refreshing");
    const running = lab.state === "running";
    if (running)
      await this.stopLab(project, name);
    lab = this.require(project, name);
    try {
      for (const repo of lab.repositories) {
        await git(repo.worktree, ["-c", "user.name=SwitchYard", "-c", "user.email=switchyard@localhost", "merge", "--no-edit", `refs/heads/${repo.target}`]);
        repo.base = (await git(repo.source, ["rev-parse", "--verify", "--end-of-options", `${repo.target}^{commit}`])).trim();
      }
      lab.state = "stopped";
      lab.updatedAt = Date.now();
      this.store.save(lab);
      this.store.event(lab.id, "refreshed", {});
      this.touch(project, name);
      if (running)
        return this.startLab(project, name);
      return this.status(project, name);
    }
    catch (err) {
      lab = this.require(project, name);
      lab.state = "failed";
      this.store.save(lab);
      this.store.event(lab.id, "refresh_conflict", { error: (err as Error).message });
      throw err;
    }
  }
  private async destroyLab(project: string, name: string): Promise<void> {
    const lab = this.require(project, name);
    if (["creating", "starting"].includes(lab.state))
      throw new SwitchyardError("lab_invalid_state", "lab operation is still in progress");
    for (const repo of lab.repositories)
      if (existsSync(repo.worktree) && (await dirtyPaths(repo.worktree)).length)
        throw new SwitchyardError("lab_dirty", "lab has uncommitted changes; commit them before destroying so the branch retains the work");
    await this.stopLab(project, name);
    for (const repo of lab.repositories) {
      labOwnedPath(this.options.storageDir, repo.worktree);
      if (existsSync(repo.worktree))
        await git(repo.source, ["worktree", "remove", repo.worktree]);
    }
    labOwnedPath(this.options.storageDir, lab.root);
    rmSync(lab.root, { recursive: true, force: true });
    this.options.db.prepare("DELETE FROM lab_ports WHERE lab_id=?").run(lab.id);
    lab.state = "destroyed";
    lab.updatedAt = Date.now();
    this.store.save(lab);
    this.store.event(lab.id, "destroyed", { branches: lab.repositories.map(r => r.branch) });
  }
  async recover(): Promise<void> {
    for (const entry of this.list()) {
      const lab = this.require(entry.project, entry.name);
      if (lab.state === "creating") {
        const lease = z.object({ creation_until: z.number() }).parse(this.options.db.prepare("SELECT creation_until FROM labs WHERE id=?").get(lab.id));
        if (lease.creation_until > Date.now())
          continue;
        lab.state = "failed";
        lab.updatedAt = Date.now();
        this.store.save(lab);
        this.store.event(lab.id, "creation_interrupted", {});
        continue;
      }
      if (["running", "starting"].includes(lab.state)) {
        await this.services.monitor(lab);
        const services = this.store.services(lab.id);
        if (services.length && services.every(s => s.state === "running")) {
          lab.state = "running";
          this.store.save(lab);
        }
      }
    }
  }
  async pruneTaskWorktrees(): Promise<LabRetentionResult> {
    return pruneTaskWorktrees(this.options.db, this.options.storageDir, this.services.config.keep_task_worktrees_days, this.options.project);
  }
  async tick(): Promise<void> {
    if (this.closed || this.ticking)
      return;
    this.ticking = true;
    try {
      this.reloadConfig();
      await this.processControls();
      this.options.db.prepare("UPDATE lab_services SET owner_until=? WHERE owner_id=? AND state IN ('running','starting','backoff')").run(Date.now() + 60000, this.owner);
      if (Date.now() - this.lastRetention > 3600000) {
        await this.pruneTaskWorktrees();
        this.lastRetention = Date.now();
      }
      for (const entry of this.list()) {
        if (entry.state !== "running")
          continue;
        const lab = this.require(entry.project, entry.name);
        const mine = this.store.services(lab.id).some(s => s.owner_id === this.owner);
        const activeTeam = this.options.db.prepare("SELECT t.state FROM lab_teams l JOIN tasks t ON t.id=l.root_job_id WHERE l.lab_id=? AND t.state IN ('running','cancel_requested')").get(lab.id);
        if (activeTeam) {
          lab.lastActivity = Date.now();
          this.store.save(lab);
        }
        if (mine && Date.now() - lab.lastActivity >= this.services.config.idle_stop_minutes * 60000) {
          await this.stop(lab.project, lab.name);
          this.store.event(lab.id, "idle_stopped", {});
          continue;
        }
        await this.services.monitor(lab);
      }
    }
    finally {
      this.ticking = false;
    }
  }
  async close(input: {
    stopServices?: boolean;
  } = {}): Promise<void> {
    if (this.timer)
      clearInterval(this.timer);
    this.timer = null;
    this.closed = true;
    this.abort.abort("lab manager closed");
    await Promise.allSettled([...this.operations]);
    while (this.ticking)
      await new Promise(r => setTimeout(r, 20));
    if (input.stopServices !== false) {
      for (const lab of this.list()) {
        if (this.store.services(lab.id).some(s => s.owner_id === this.owner))
          await this.stopLab(lab.project, lab.name);
      }
    }
    this.options.db.prepare("UPDATE lab_services SET owner_until=0 WHERE owner_id=?").run(this.owner);
  }
}
