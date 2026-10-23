import { labOwnershipMarker } from "./ownership-marker.js";
import path from "node:path";
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { z } from "zod";
import type { LabManager } from "./lab.js";
import { LabRecordSchema, type LabRecord } from "./store.js";
import { ProjectConfigSchema } from "../projects/schema.js";
import { immediate, newId } from "../storage/db.js";
import { dirtyPaths, git } from "../workspaces/git.js";
import { substitute } from "./recipe.js";
import { allocatePorts, portAvailable } from "./ports.js";
import { labOwnedPath } from "./paths.js";
import { labEnvironment, labValues } from "./environment.js";
import { inspectLabListeners } from "./process-ownership.js";
import { LabCheckResultSchema, type LabCheckResult } from "./checks.js";
import { TaskLabPruneRefusal } from "./task-attempt-prune.js";
import { TaskAttemptProcesses } from "./task-attempt-processes.js";
import { TaskAttemptSource, taskCommonDirectory, assertRegisteredTaskWorktree, taskHash } from "./task-attempt-source.js";
import { TaskLabEvidenceSchema, type TaskAttemptRecord, type TaskLabRecord, type TaskLabEvidence } from "./task-attempt-schema.js";
/** Cleanup may recognize a persisted pre-rename branch, never an arbitrary legacy ref. */
export function taskLabBranchOwned(project: string, attemptId: string, alias: string, branch: string, target: string): boolean {
  const suffix = `task-lab-${taskHash(project).slice(0, 8)}-${attemptId.slice(-12)}-${taskHash(alias).slice(0, 8)}`;
  return target === branch && [`meritrouter/${suffix}`, `switchyard/${suffix}`].includes(branch);
}
export function taskLabUsesCapacity(manager: LabManager, lab: LabRecord): boolean {
  if (lab.state === "destroyed")
    return false;
  if (lab.kind === "retained")
    return true;
  const row = z.object({ phase: z.string() }).optional().parse(manager.options.db.prepare("SELECT phase FROM lab_task_attempts WHERE lab_id=?").get(lab.id));
  return !row || !["retained", "pruned"].includes(row.phase);
}
export class TaskAttemptRunner {
  constructor(readonly manager: LabManager, readonly source: TaskAttemptSource, readonly processes: TaskAttemptProcesses) {
  }
  private safeText(lab: LabRecord, attempt: TaskAttemptRecord, text: string): string {
    let safe = this.manager.redact(lab.project, lab.name, text);
    const paths = [lab.root, attempt.sourceWorktree, ...lab.repositories.flatMap(r => [r.source, r.worktree]), ...attempt.repositories.map(r => r.commonDirectory)].sort((a, b) => b.length - a.length);
    for (const directory of paths)
      for (const value of new Set([directory, directory.replaceAll("\\", "/"), directory.replaceAll("/", "\\")]))
        safe = safe.split(value).join("[host path]");
    return safe.slice(0, 65536);
  }
  private get store() {
    return this.source.store;
  }
  private async create(attempt: TaskAttemptRecord, request: TaskLabRecord): Promise<LabRecord> {
    this.source.identity(attempt);
    const writable = attempt.repositories.find(r => r.alias === attempt.writableAlias)!;
    if ((await git(writable.sourcePath, ["rev-parse", "--verify", "--end-of-options", `${attempt.submittedCommit}^{tree}`])).trim() !== attempt.submittedTree)
      throw new Error("persisted task commit/tree identity differs");
    const name = `task-${attempt.id.slice(-20)}`, now = Date.now(), root = labOwnedPath(this.manager.options.storageDir, path.join(this.manager.options.storageDir, "labs", attempt.project, name));
    const lab = LabRecordSchema.parse({ id: newId("lab"), project: attempt.project, name, state: "creating", kind: "task_attempt", root, recipe: request.recipe, repositories: [], ports: {}, env: {}, goal: "Task runtime verification", createdAt: now, updatedAt: now, lastActivity: now });
    immediate(this.store.db, () => {
      const all = this.manager.list().filter(item => taskLabUsesCapacity(this.manager, item)), limit = this.manager.services.config.max_active, project = ProjectConfigSchema.parse(this.manager.options.cfg.projects[attempt.project]);
      if (all.length >= limit || all.filter(l => l.project === attempt.project).length >= (project.labs.max_active ?? limit))
        throw new Error("task Lab active capacity reached");
      this.manager.store.insert(lab);
      request.labId = lab.id;
      request.phase = "creating";
      this.store.save(request);
    });
    if (existsSync(root))
      throw new Error("task Lab root exists; refusing adoption");
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, ".meritrouter-lab.json"), JSON.stringify({ id: lab.id, project: lab.project, name, attemptId: attempt.id }), { flag: "wx", mode: 0o600 });
    for (const name of ["home", "cache", ...lab.recipe.data])
      mkdirSync(path.join(root, "data", name), { recursive: true });
    mkdirSync(path.join(root, "logs"), { recursive: true });
    lab.ports = await allocatePorts(this.store.db, lab.id, lab.recipe.ports, this.manager.services.config.port_range);
    this.manager.store.save(lab);
    for (const repo of attempt.repositories) {
      const configured = this.manager.options.project(attempt.project).repositoryPaths[repo.alias];
      if (!configured || await taskCommonDirectory(configured.path) !== repo.commonDirectory)
        throw new Error("project repository scope changed before task Lab creation");
      if (await taskCommonDirectory(repo.sourcePath) !== repo.commonDirectory)
        throw new Error("task source physical repository changed");
      const head = repo.alias === attempt.writableAlias ? attempt.submittedCommit! : repo.head, branch = `meritrouter/task-lab-${taskHash(attempt.project).slice(0, 8)}-${attempt.id.slice(-12)}-${taskHash(repo.alias).slice(0, 8)}`, worktree = labOwnedPath(this.manager.options.storageDir, path.join(root, "repos", repo.alias));
      lab.repositories.push({ alias: repo.alias, source: repo.sourcePath, worktree, branch, target: branch, base: head });
      this.manager.store.save(lab);
      await git(repo.sourcePath, ["worktree", "add", "-b", branch, worktree, head]);
    }
    lab.env = labEnvironment(lab);
    this.manager.store.save(lab);
    return lab;
  }
  private async heads(lab: LabRecord, attempt: TaskAttemptRecord) {
    this.assertLab(lab, attempt);
    if (lab.repositories.length !== attempt.repositories.length)
      throw new Error("task Lab repository snapshot is incomplete");
    for (const service of this.manager.store.services(lab.id).filter(r => r.state === "running")) {
      if (!service.pid || !service.token)
        throw new Error("task service identity is missing");
      const process = this.processes.rows(lab.id).find(r => r.kind === "service" && r.logical_name === service.name);
      if (!process || existsSync(path.join(process.directory, "result.json")))
        throw new Error("task service exited before verification completed");
      const listeners = await inspectLabListeners(service.pid, service.token, Object.values(lab.ports)), ready = lab.recipe.services[service.name]!.ready;
      const expectedPort = ready && ("tcp" in ready ? lab.ports[ready.tcp] : Number(new URL(substitute(ready.http, labValues(lab))).port));
      if (expectedPort && !listeners.some(listener => listener.port === expectedPort))
        throw new Error("task service lost its owned readiness listener");
    }
    const heads: Record<string, string> = {};
    for (const repo of lab.repositories) {
      labOwnedPath(this.manager.options.storageDir, repo.worktree);
      await assertRegisteredTaskWorktree(repo.source, repo.worktree);
      if ((await dirtyPaths(repo.worktree)).length)
        throw new Error("task Lab repository is dirty");
      const head = (await git(repo.worktree, ["rev-parse", "HEAD"])).trim(), expected = repo.alias === attempt.writableAlias ? attempt.submittedCommit : attempt.repositories.find(r => r.alias === repo.alias)!.head;
      if (head !== expected || (await git(repo.worktree, ["symbolic-ref", "--quiet", "HEAD"])).trim() !== `refs/heads/${repo.branch}`)
        throw new Error("task Lab immutable head changed");
      heads[repo.alias] = head;
    }
    return heads;
  }
  async run(attempt: TaskAttemptRecord, signal: AbortSignal): Promise<TaskLabEvidence> {
    let request = this.store.lab(attempt.id)!, lab: LabRecord | undefined;
    const checks: LabCheckResult[] = [];
    let status: TaskLabEvidence["status"] = "environment_failure", error: string | null = null;
    try {
      this.source.identity(attempt);
      if (request.desiredState !== "running")
        throw new Error("task cancelled before allocation");
      lab = await this.create(attempt, request);
      await this.heads(lab, attempt);
      for (const [i, setup] of lab.recipe.setup.entries()) {
        const repo = typeof setup === "string" ? lab.repositories[0]! : lab.repositories.find(r => r.alias === setup.repo)!;
        const result = await this.processes.run(lab, attempt.id, "setup", String(i), substitute(typeof setup === "string" ? setup : setup.command, labValues(lab)), repo.worktree, labEnvironment(lab), signal, this.manager.services.config.setup_timeout_seconds * 1000);
        if (result.exitCode !== 0 || result.killed)
          throw new Error("task Lab setup failed");
      }
      await this.heads(lab, attempt);
      request.phase = "starting";
      this.store.save(request);
      lab.state = "starting";
      this.manager.store.save(lab);
      const started = new Set<string>();
      const start = async (name: string): Promise<void> => {
        if (started.has(name))
          return;
        for (const dep of lab!.recipe.services[name]!.after)
          await start(dep);
        await this.startService(lab!, attempt, name, signal);
        started.add(name);
      };
      for (const name of Object.keys(lab.recipe.services))
        await start(name);
      lab.state = "running";
      this.manager.store.save(lab);
      request.phase = "checking";
      this.store.save(request);
      for (const name of request.checks) {
        this.source.identity(attempt);
        if (signal.aborted)
          throw new Error("task cancelled");
        const spec = lab.recipe.checks[name]!;
        if (typeof spec !== "string" && !("command" in spec))
          throw new Error("browser task checks not enabled");
        const alias = typeof spec === "string" ? lab.repositories[0]!.alias : spec.repo ?? lab.repositories[0]!.alias, repo = lab.repositories.find(r => r.alias === alias)!;
        await this.heads(lab, attempt);
        const id = newId("lc"), result = await this.processes.run(lab, attempt.id, "check", name, substitute(typeof spec === "string" ? spec : spec.command, labValues(lab)), repo.worktree, labEnvironment(lab), signal, this.manager.services.config.check_timeout_seconds * 1000);
        const record = LabCheckResultSchema.parse({ id, name, repository: alias, revision: (await git(repo.worktree, ["rev-parse", "HEAD"])).trim(), ...result, createdAt: Date.now(), stdout: this.safeText(lab, attempt, result.stdout), stderr: this.safeText(lab, attempt, result.stderr) });
        await this.heads(lab, attempt);
        checks.push(record);
        this.store.db.prepare("INSERT INTO lab_checks(id,lab_id,name,repository,revision,result_json,created_at) VALUES(?,?,?,?,?,?,?)").run(id, lab.id, name, alias, record.revision, JSON.stringify(record), record.createdAt);
      }
      await this.heads(lab, attempt);
      status = checks.every(r => r.exitCode === 0 && !r.killed) ? "passed" : "failed";
    }
    catch (cause) {
      if (request.labId)
        this.manager.store.event(request.labId, "task_attempt_failed", { attemptId: attempt.id, error: this.manager.redact(attempt.project, this.manager.store.byId(request.labId)!.name, cause instanceof Error ? cause.message : "invalid runtime response").slice(0, 2000) });
      status = signal.aborted ? "cancelled" : "environment_failure";
      error = "Task Lab verification could not complete; private evidence retained";
    }
    const evidence: TaskLabEvidence = { schemaVersion: 1, attemptId: attempt.id, labId: lab?.id ?? this.store.lab(attempt.id)?.labId ?? "", heads: Object.fromEntries(attempt.repositories.map(r => [r.alias, r.alias === attempt.writableAlias ? attempt.submittedCommit! : r.head])), submittedCommit: attempt.submittedCommit!, submittedTree: attempt.submittedTree!, patchDigest: attempt.patchDigest, recipeDigest: request.recipeDigest, status, cleanup: "complete", checks, error };
    request = this.store.lab(attempt.id)!;
    request.result = evidence;
    request.desiredState = "stopped";
    this.store.save(request);
    return this.stop(attempt);
  }
  private async startService(lab: LabRecord, attempt: TaskAttemptRecord, name: string, signal: AbortSignal) {
    if (signal.aborted)
      throw new Error("task stopped");
    const spec = lab.recipe.services[name]!, repo = lab.repositories.find(r => r.alias === spec.repo)!;
    immediate(this.store.db, () => {
      const count = z.object({ n: z.number() }).parse(this.store.db.prepare("SELECT COUNT(*) n FROM lab_services WHERE state IN ('starting','running','backoff')").get());
      if (count.n >= this.manager.services.config.max_services)
        throw new Error("task service capacity reached");
      this.manager.store.saveService({ lab_id: lab.id, name, state: "starting", pid: null, token: null, log_path: path.join(lab.root, "logs", name + ".log"), restart_count: 0, next_restart: null, started_at: Date.now(), owner_id: this.manager.owner, owner_until: Date.now() + 30000 });
    });
    const process = await this.processes.spawn(lab, attempt.id, "service", name, substitute(spec.command, labValues(lab)), repo.worktree, labEnvironment(lab)), row = this.manager.store.service(lab.id, name)!;
    row.pid = process.pid;
    row.token = process.token;
    this.manager.store.saveService(row);
    const deadline = Date.now() + this.manager.services.config.service_ready_timeout_seconds * 1000;
    for (;;) {
      if (signal.aborted || Date.now() > deadline)
        throw new Error("task readiness cancelled or timed out");
      if (existsSync(path.join(process.directory, "result.json")))
        throw new Error("task service exited");
      const listeners = await inspectLabListeners(process.pid!, process.token, Object.values(lab.ports));
      let ready = !spec.ready;
      if (spec.ready && "http" in spec.ready) {
        const url = new URL(substitute(spec.ready.http, labValues(lab)));
        if (!listeners.some(l => l.port === Number(url.port)))
          ready = false;
        else
          try {
            const response = await fetch(url, { signal: AbortSignal.timeout(1000), redirect: "error" });
            await response.body?.cancel();
            ready = response.ok;
          }
          catch {
            ready = false;
          }
      }
      if (spec.ready && "tcp" in spec.ready) {
        const port = lab.ports[spec.ready.tcp];
        ready = listeners.some(l => l.port === port);
      }
      if (ready) {
        row.state = "running";
        row.owner_until = Date.now() + 30000;
        this.manager.store.saveService(row);
        return;
      }
      await new Promise(r => setTimeout(r, 100));
    }
  }
  assertLab(lab: LabRecord, attempt: TaskAttemptRecord) {
    if (lab.kind !== "task_attempt" || lab.project !== attempt.project || this.store.lab(attempt.id)?.labId !== lab.id)
      throw new Error("task Lab identity mismatch");
    const expectedName = `task-${attempt.id.slice(-20)}`;
    if (lab.name !== expectedName || path.resolve(lab.root) !== path.resolve(this.manager.options.storageDir, "labs", attempt.project, expectedName))
      throw new Error("task Lab root does not match exact attempt identity");
    labOwnedPath(this.manager.options.storageDir, lab.root);
    const aliases = new Set<string>();
    for (const repo of lab.repositories) {
      const source = attempt.repositories.find(r => r.alias === repo.alias);
      if (!source || aliases.has(repo.alias) || path.resolve(repo.source) !== path.resolve(source.sourcePath) || path.resolve(repo.worktree) !== path.resolve(lab.root, "repos", repo.alias) || !taskLabBranchOwned(attempt.project, attempt.id, repo.alias, repo.branch, repo.target) || repo.base !== (repo.alias === attempt.writableAlias ? attempt.submittedCommit : source.head))
        throw new Error("task Lab repository is outside exact attempt ownership");
      aliases.add(repo.alias);
      labOwnedPath(this.manager.options.storageDir, repo.worktree);
    }
    if (existsSync(lab.root))
      z.object({ id: z.literal(lab.id), project: z.literal(attempt.project), name: z.literal(lab.name), attemptId: z.literal(attempt.id) }).parse(JSON.parse(readFileSync(labOwnedPath(this.manager.options.storageDir, labOwnershipMarker(lab.root)), "utf8")));
  }
  async stop(attempt: TaskAttemptRecord): Promise<TaskLabEvidence> {
    const request = this.store.lab(attempt.id)!;
    request.desiredState = "stopped";
    request.phase = "stopping";
    this.store.save(request);
    let cleanup: TaskLabEvidence["cleanup"] = "complete";
    try {
      if (request.labId) {
        const lab = this.manager.store.byId(request.labId)!;
        this.assertLab(lab, attempt);
        await this.processes.stopAll(lab.id);
        for (const port of Object.values(lab.ports))
          if (!await portAvailable(port))
            throw new Error("task port remains bound");
        this.store.db.prepare("UPDATE lab_services SET state='stopped',pid=NULL,token=NULL,owner_id=NULL,owner_until=0 WHERE lab_id=?").run(lab.id);
        this.store.db.prepare("DELETE FROM lab_ports WHERE lab_id=?").run(lab.id);
        lab.state = "stopped";
        this.manager.store.save(lab);
      }
      request.phase = "retained";
      request.cleanupError = null;
    }
    catch {
      cleanup = "blocked";
      request.phase = "cleanup_blocked";
      request.cleanupError = "Task cleanup could not be proved; reservations and evidence retained";
    }
    const evidence = request.result ?? { schemaVersion: 1, attemptId: attempt.id, labId: request.labId ?? "", heads: Object.fromEntries(attempt.repositories.map(r => [r.alias, r.alias === attempt.writableAlias ? attempt.submittedCommit! : r.head])), submittedCommit: attempt.submittedCommit!, submittedTree: attempt.submittedTree!, patchDigest: attempt.patchDigest, recipeDigest: request.recipeDigest, status: "cancelled" as const, cleanup, checks: [], error: "Owner interrupted before durable task Lab completion" };
    evidence.cleanup = cleanup;
    if (cleanup === "blocked" && evidence.status === "passed")
      evidence.status = "environment_failure";
    request.result = TaskLabEvidenceSchema.parse(evidence);
    this.store.save(request);
    return request.result;
  }
  private assertPruneContents(lab: LabRecord): void {
    if (!existsSync(lab.root)) return;
    const expected = new Set(lab.repositories.map(r => path.resolve(r.worktree, ".git")));
    const pending = [{ directory: lab.root, depth: 0 }], deadline = Date.now() + 1000;
    let entries = 0;
    while (pending.length) {
      const { directory, depth } = pending.pop()!;
      if (depth > 64 || Date.now() > deadline)
        throw new TaskLabPruneRefusal("Prune blocked: inspect oversized/deep Lab contents manually before retry (scan limit: 20,000 entries, depth 64, one second)");
      // labOwnedPath rejects changed ancestor junctions; never follow entries that are links.
      labOwnedPath(this.manager.options.storageDir, directory);
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (++entries > 20000 || Date.now() > deadline)
          throw new TaskLabPruneRefusal("Prune blocked: inspect oversized Lab contents manually before retry (scan limit: 20,000 entries, depth 64, one second)");
        const target = path.join(directory, entry.name);
        if (entry.name.toLowerCase() === ".git") {
          if (expected.has(path.resolve(target)) && entry.isFile()) continue;
          throw new TaskLabPruneRefusal("Prune blocked: unexpected nested Git metadata; preserve or move the foreign repository/worktree before retry");
        }
        // Root-owned dependency links/junctions are unlinked by rmSync, never traversed.
        // Exact root/ancestor/expected worktree links are independently refused.
        if (entry.isSymbolicLink()) continue;
        if (!entry.isDirectory() && !entry.isFile())
          throw new TaskLabPruneRefusal("Prune blocked: special Lab resource; inspect and preserve its ownership before retry");
        if (entry.isDirectory()) pending.push({ directory: target, depth: depth + 1 });
      }
    }
  }
  private async assertPruneRegistrations(lab: LabRecord, attempt: TaskAttemptRecord, assert: () => void): Promise<void> {
    const expected = new Set(lab.repositories.map(r => path.resolve(r.worktree))), seen = new Set<string>();
    for (const repo of attempt.repositories) {
      if (seen.has(repo.commonDirectory)) continue;
      seen.add(repo.commonDirectory);
      if (await taskCommonDirectory(repo.sourcePath) !== repo.commonDirectory)
        throw new Error("task source common directory changed");
      assert();
      const registrations = await git(repo.sourcePath, ["worktree", "list", "--porcelain", "-z"]);
      assert();
      for (const field of registrations.split("\0")) {
        if (!field.startsWith("worktree ")) continue;
        const target = path.resolve(field.slice(9)), relative = path.relative(path.resolve(lab.root), target);
        if ((relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) && !expected.has(target))
          throw new TaskLabPruneRefusal("Prune blocked: unexpected nested registered Git worktree; preserve or move its registration and files before retry");
      }
    }
  }
  async prune(request: TaskLabRecord, attempt: TaskAttemptRecord, fence: { assert(): void; resume: boolean; verified(): void }) {
    const lab = this.manager.store.byId(request.labId!)!;
    fence.assert();
    this.assertLab(lab, attempt);
    if (lab.repositories.length !== attempt.repositories.length)
      throw new Error("incomplete task Lab repository identity");
    await this.assertPruneRegistrations(lab, attempt, fence.assert);
    // Prove every repository before the first removal. A durable verified intent is
    // required to accept resources missing after an interrupted removal.
    for (const repo of lab.repositories) {
      labOwnedPath(this.manager.options.storageDir, repo.worktree);
      if (await taskCommonDirectory(repo.source) !== attempt.repositories.find(r => r.alias === repo.alias)!.commonDirectory)
        throw new Error("task repository physical identity changed before prune");
      fence.assert();
      if (!existsSync(repo.worktree)) {
        if (!fence.resume) throw new Error("task worktree missing without removal proof");
        // A missing path with a lingering Git registration is ambiguous, retain it.
        const registered = await git(repo.source, ["worktree", "list", "--porcelain", "-z"]);
        fence.assert();
        if (registered.split("\0").some(part => part.startsWith("worktree ") && path.resolve(part.slice(9)) === path.resolve(repo.worktree)))
          throw new Error("missing task worktree still registered");
        continue;
      }
      await assertRegisteredTaskWorktree(repo.source, repo.worktree);
      fence.assert();
      if (await taskCommonDirectory(repo.worktree) !== attempt.repositories.find(r => r.alias === repo.alias)!.commonDirectory)
        throw new Error("task worktree physical identity changed");
      fence.assert();
      if ((await git(repo.worktree, ["symbolic-ref", "--quiet", "HEAD"])).trim() !== `refs/heads/${repo.branch}`)
        throw new Error("task worktree branch changed");
      fence.assert();
      if ((await git(repo.worktree, ["rev-parse", "HEAD"])).trim() !== repo.base)
        throw new Error("task worktree head changed");
      fence.assert();
      if ((await dirtyPaths(repo.worktree)).length) throw new Error("dirty task Lab retained");
      fence.assert();
    }
    this.assertPruneContents(lab);
    fence.verified();
    for (const repo of lab.repositories) {
      if (!existsSync(repo.worktree)) continue;
      // Recheck paths and registration immediately before each destructive action.
      labOwnedPath(this.manager.options.storageDir, repo.worktree);
      await assertRegisteredTaskWorktree(repo.source, repo.worktree);
      fence.assert();
      if (await taskCommonDirectory(repo.source) !== attempt.repositories.find(r => r.alias === repo.alias)!.commonDirectory
        || await taskCommonDirectory(repo.worktree) !== attempt.repositories.find(r => r.alias === repo.alias)!.commonDirectory
        || (await git(repo.worktree, ["symbolic-ref", "--quiet", "HEAD"])).trim() !== `refs/heads/${repo.branch}`
        || (await git(repo.worktree, ["rev-parse", "HEAD"])).trim() !== repo.base)
        throw new Error("task repository identity changed before removal");
      await this.assertPruneRegistrations(lab, attempt, fence.assert);
      this.assertPruneContents(lab);
      fence.assert();
      await git(repo.source, ["worktree", "remove", repo.worktree]);
      fence.assert();
    }
    await this.assertPruneRegistrations(lab, attempt, fence.assert);
    this.assertPruneContents(lab);
    fence.assert();
    rmSync(labOwnedPath(this.manager.options.storageDir, lab.root), { recursive: true, force: true });
    fence.assert();
    immediate(this.store.db, () => {
      fence.assert();
      lab.state = "destroyed";
      this.manager.store.save(lab);
      request.phase = "pruned";
      request.cleanupError = null;
      this.store.save(request);
    });
  }
}
