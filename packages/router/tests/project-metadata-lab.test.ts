import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { LabManager } from "../src/labs/lab.js";
import { ProjectRegistry } from "../src/projects/registry.js";
import { openDatabase, type Db } from "../src/storage/db.js";
import { commitSelectedApplication } from "../src/attribution/selected-commit.js";
import { readCommitReceipt } from "../src/attribution/selected-commit-receipts.js";
import { baseConfig, makeEnv, type Env } from "./helpers.js";
import { labEnvironment } from "../src/labs/environment.js";
import { randomBytes } from "node:crypto";
import { inspectServiceCommandProcess, releaseServiceCommandProcess, serviceJobObservation, startServiceCommandProcess, type ServiceJobBinding } from "../src/harness/service-command-process.js";
import { prepareRepositoryServiceCommand, repositoryServicePermit, startRepositoryServiceCommand, stopRepositoryServiceCommand, withRepositoryServiceStatus, type RepositoryServiceCommand } from "../src/workspaces/repository-command.js";
import { withRepositoryMutation } from "../src/workspaces/repository-mutation.js";

let env: Env | undefined, db: Db | undefined, manager: LabManager | undefined;
const serviceJobs: Array<{ binding: ServiceJobBinding; directory: string; released: boolean }> = [];
const repositoryServices: RepositoryServiceCommand[] = [];
afterEach(async () => { while (repositoryServices.length) { const command = repositoryServices[0]!; await stopRepositoryServiceCommand(command, repositoryServices.slice(1)); repositoryServices.shift(); } for (const job of serviceJobs.splice(0)) if (!job.released) { const proof = await inspectServiceCommandProcess(job.binding, job.directory, true); await releaseServiceCommandProcess(job.binding, job.directory, proof); } await manager?.close(); manager = undefined; db?.close(); db = undefined; env?.cleanup(); env = undefined; });
const native = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
function fixture(lab: Record<string, unknown> = {}) {
  env = makeEnv({ config: baseConfig({ repositories: {}, brain: { path: "brain", project: "alpha" }, projects: { alpha: { repositories: { app: { path: "repo" } }, lab } } }) });
  db = openDatabase(env.cfg.storageDir); const registry = new ProjectRegistry(env.cfg);
  manager = new LabManager({ db, cfg: env.cfg, storageDir: env.cfg.storageDir, project: slug => registry.context(slug)!, monitor: false });
  return manager;
}
async function pending(root: string) {
  const out = await commitSelectedApplication(root, { actor: { agent: "fixture", role: "implementer" }, message: "empty pending", paths: [], allowEmpty: true }, { refPublished: async () => { throw new Error("retain empty receipt"); } });
  if (out.kind !== "reconciliation_required") throw new Error("Expected real empty-publication pending receipt");
  expect(native(root, "status", "--porcelain")).toBe("");
  return readCommitReceipt(root, out.receiptId);
}
const bytes = (directory: string) => ["receipt.json", "original.index", "next.index"].map(name => readFileSync(path.join(directory, name)));
function snapshot(root: string) {
  return { head: native(root, "rev-parse", "HEAD"), index: readFileSync(path.resolve(root, native(root, "rev-parse", "--git-path", "index").trim())), refs: native(env!.repo, "show-ref"),
    tables: Object.fromEntries(["labs", "lab_ports", "lab_services", "lab_events", "lab_checks"].map(table => [table, db!.prepare(`SELECT * FROM ${table}`).all()])) };
}

describe("Lab short repository mutation scopes", () => {
  it("retires an assigned but ungranted cancelled check only after real kernel zero", async () => {
    const node = JSON.stringify(process.execPath), labs = fixture({ checks: { cancel: `${node} -e "console.log('must-not-execute')"` } });
    const created = await labs.create("alpha", "cancel"), signal = new AbortController(); signal.abort("fixture cancellation");
    await expect(labs.commands.run(created.lab, "lab-check", "cancel", labEnvironment(created.lab), 1500, signal.signal)).rejects.toMatchObject({ detail: { kind: "command_uncertain" } });
    expect(db!.prepare("SELECT * FROM lab_command_owners WHERE lab_id=?").all(created.lab.id)).toEqual([]);
    await withRepositoryMutation([created.lab.repositories[0]!.worktree], async () => undefined);
  });
  it("runs declared setup and shell checks through real Job receipts and retires exact command owners", async () => {
    const node = JSON.stringify(process.execPath), labs = fixture({ setup: [`${node} -e "console.log('setup-native')"`], checks: { smoke: `${node} -e "console.log('check-native')"` } });
    const created = await labs.create("alpha", "commands");
    expect(db!.prepare("SELECT 1 FROM lab_events WHERE lab_id=? AND type='setup_finished'").get(created.lab.id)).toBeTruthy();
    const result = await labs.check("alpha", "commands", "smoke");
    expect(result.exitCode).toBe(0); expect(result.killed).toBe(null); expect(result.stdout).toContain("check-native");
    expect(db!.prepare("SELECT * FROM lab_command_owners WHERE lab_id=?").all(created.lab.id)).toEqual([]);
    await withRepositoryMutation([created.lab.repositories[0]!.worktree], async () => undefined);
  });
  it("recovers a retained service with a new manager using its actual kernel Job and blocks Git until stop", async () => {
    const node = JSON.stringify(process.execPath), labs = fixture({ services: { worker: { repo: "app", command: `${node} -e "setInterval(()=>{},1000)"` } } });
    const created = await labs.create("alpha", "restart");
    await labs.start("alpha", "restart");
    const original = labs.store.service(created.lab.id, "worker")!;
    expect(original.pid).toBeTruthy();
    await expect(withRepositoryMutation([created.lab.repositories[0]!.worktree], async () => undefined)).rejects.toMatchObject({ detail: { kind: "active_command" } });
    await labs.close({ stopServices: false });
    const registry = new ProjectRegistry(env!.cfg);
    manager = new LabManager({ db: db!, cfg: env!.cfg, storageDir: env!.cfg.storageDir, project: slug => registry.context(slug)!, monitor: false });
    await manager.start("alpha", "restart");
    expect(manager.store.service(created.lab.id, "worker")!.pid).toBe(original.pid);
    await manager.stop("alpha", "restart");
    expect(db!.prepare("SELECT * FROM lab_command_owners WHERE lab_id=?").all(created.lab.id)).toEqual([]);
    await withRepositoryMutation([created.lab.repositories[0]!.worktree], async () => undefined);
  });
  it("refuses creation from a clean source with retained empty-publication receipt before Lab rows or worktrees", async () => {
    const labs = fixture(), receipt = await pending(env!.repo), before = snapshot(env!.repo), proof = bytes(receipt.directory);
    await expect(labs.create("alpha", "pending")).rejects.toMatchObject({ detail: { kind: "pending_publication" } });
    expect(snapshot(env!.repo)).toEqual(before); expect(bytes(receipt.directory)).toEqual(proof);
  });

  it.each(["refresh", "destroy", "start"] as const)("refuses %s with a clean retained Lab pending receipt before state or source effects", async operation => {
    const labs = fixture(), status = await labs.create("alpha", "pending"), root = status.lab.repositories[0]!.worktree;
    const receipt = await pending(root), before = snapshot(root), proof = bytes(receipt.directory);
    await expect(labs[operation]("alpha", "pending")).rejects.toMatchObject({ detail: { kind: "pending_publication" } });
    expect(snapshot(root)).toEqual(before); expect(bytes(receipt.directory)).toEqual(proof);
  });

  it("rejects a forged Lab source owner before creating its mutation lock", async () => {
    const labs = fixture(), status = await labs.create("alpha", "forged"), foreign = path.join(env!.dir, "foreign");
    mkdirSync(foreign); native(foreign, "init", "-q"); writeFileSync(path.join(foreign, "x"), "x"); native(foreign, "add", "."); native(foreign, "commit", "-qm", "foreign");
    status.lab.repositories[0]!.source = foreign; labs.store.save(status.lab); const before = snapshot(status.lab.repositories[0]!.worktree);
    await expect(labs.destroy("alpha", "forged")).rejects.toMatchObject({ detail: { kind: "ownership_changed" } });
    expect(snapshot(status.lab.repositories[0]!.worktree)).toEqual(before); expect(existsSync(path.join(foreign, ".git", "meritrouter-mutation.lock"))).toBe(false);
  });

  it("preserves ordinary empty-service creation, start, refresh and branch-preserving destruction", async () => {
    const labs = fixture(), created = await labs.create("alpha", "ordinary"), repo = created.lab.repositories[0]!;
    expect((await labs.start("alpha", "ordinary")).lab.state).toBe("running");
    expect((await labs.refresh("alpha", "ordinary")).lab.state).toBe("running");
    await labs.destroy("alpha", "ordinary");
    expect(labs.store.byId(created.lab.id)?.state).toBe("destroyed"); expect(existsSync(repo.worktree)).toBe(false);
    expect(native(env!.repo, "show-ref", "--verify", `refs/heads/${repo.branch}`)).toBeTruthy();
  });
});

describe.skipIf(process.platform !== "win32")("native named service Job proof", () => {
  async function launch(script: string, timeoutMs: number | null = null, before?: (binding: ServiceJobBinding) => Promise<void>) {
    const directory = path.join(env!.dir, `service-${randomBytes(8).toString("hex")}`); mkdirSync(directory);
    const control = { id: `rc_${randomBytes(16).toString("hex")}`, nonce: randomBytes(32).toString("hex"), directory };
    let job!: typeof serviceJobs[number];
    const binding = await startServiceCommandProcess({ file: process.execPath, args: ["-e", script], cwd: env!.repo, env: {}, timeoutMs }, control, async binding => {
      job = { binding, directory, released: false }; serviceJobs.push(job); await before?.(binding);
    });
    return { binding, directory, control, job };
  }
  async function waitFor(test: () => boolean) { const until = Date.now() + 10000; while (!test()) { if (Date.now() > until) throw new Error("service fixture deadline"); await new Promise(resolve => setTimeout(resolve, 20)); } }
  async function finish(job: Awaited<ReturnType<typeof launch>>) { const proof = await inspectServiceCommandProcess(job.binding, job.directory, true); expect(serviceJobObservation(proof).activeProcesses).toBe(0); await releaseServiceCommandProcess(job.binding, job.directory, proof); job.job.released = true; }

  it("persists assigned suspended identity before app grant and supports fresh-manager kernel adoption", async () => {
    fixture(); const marker = path.join(env!.dir, "started");
    const job = await launch(`require('fs').writeFileSync(${JSON.stringify(marker)},'yes');setInterval(()=>{},1000)`, 86400000, async binding => {
      expect(existsSync(marker)).toBe(false); expect(binding.pid).toBeGreaterThan(0);
    });
    await waitFor(() => existsSync(marker));
    const restartedBinding = JSON.parse(JSON.stringify(job.binding));
    const proof = serviceJobObservation(await inspectServiceCommandProcess(restartedBinding, job.directory));
    expect(proof.primaryMember).toBe(true); expect(proof.activeProcesses).toBeGreaterThan(0); await finish(job);
  });
  it("does not equate parent exit with a detached descendant's kernel quiescence", async () => {
    fixture(); const marker = path.join(env!.dir, "orphan");
    const child = `require('fs').writeFileSync(${JSON.stringify(marker)},'yes');setInterval(()=>{},1000)`;
    const job = await launch(`const c=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{detached:true,stdio:'ignore',windowsHide:true});c.unref();`);
    await waitFor(() => existsSync(marker));
    let proof = serviceJobObservation(await inspectServiceCommandProcess(job.binding, job.directory));
    for (let i = 0; i < 30 && proof.primaryMember; i++) { await new Promise(resolve => setTimeout(resolve, 20)); proof = serviceJobObservation(await inspectServiceCommandProcess(job.binding, job.directory)); }
    expect(proof.primaryMember).toBe(false); expect(proof.activeProcesses).toBeGreaterThan(0); await finish(job);
  });
  it("rejects changed helper creation identity and serialized zero-count assertions", async () => {
    fixture(); const job = await launch("setInterval(()=>{},1000)");
    await expect(inspectServiceCommandProcess({ ...job.binding, helperCreated: "1" }, job.directory, true)).rejects.toThrow();
    expect(() => serviceJobObservation({ activeProcesses: 0 } as never)).toThrow("Forged");
    expect(serviceJobObservation(await inspectServiceCommandProcess(job.binding, job.directory)).activeProcesses).toBeGreaterThan(0); await finish(job);
  });
});

describe.skipIf(process.platform !== "win32")("opaque own-service metadata admission", () => {
  it("allows two own services' status/stop but blocks forged/group/scope permits and nested publication", async () => {
    fixture(); const group = "lab:fixture";
    for (let i = 0; i < 2; i++) {
      const command = await prepareRepositoryServiceCommand(env!.repo, { group, member: randomBytes(24).toString("hex"), kind: "lab-service", commandSha256: randomBytes(32).toString("hex") }, repositoryServices);
      expect(Object.isFrozen(command)).toBe(true); expect(Object.isFrozen(command.descriptor)).toBe(true);
      expect(() => { command.descriptor.group = "other-lab"; }).toThrow();
      expect(() => { command.repo = path.join(env!.dir, "foreign"); }).toThrow();
      repositoryServices.push(command);
      await startRepositoryServiceCommand(command, { file: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], cwd: env!.repo, env: {}, timeoutMs: null }, async () => undefined, repositoryServices.filter(other => other !== command));
    }
    let writes = 0;
    await withRepositoryServiceStatus([env!.repo], repositoryServices, group, async (...args) => { expect(args).toHaveLength(0); writes++; }); expect(writes).toBe(1);
    await expect(withRepositoryMutation([env!.repo], async () => undefined)).rejects.toMatchObject({ detail: { kind: "active_command" } });
    const permits = repositoryServices.map(command => repositoryServicePermit(command, group));
    await withRepositoryMutation([env!.repo], async mutation => {
      await expect(commitSelectedApplication(env!.repo, { actor: { agent: "fixture", role: "implementer" }, message: "must refuse", paths: [], allowEmpty: true }, { mutation })).rejects.toMatchObject({ detail: { kind: "active_command" } });
    }, { command: permits });
    await expect(withRepositoryMutation([env!.repo], async () => { writes++; }, { command: [JSON.parse(JSON.stringify(permits[0]))] })).rejects.toMatchObject({ detail: { kind: "invalid_capability" } });
    await expect(withRepositoryServiceStatus([env!.repo], repositoryServices, "other-lab", async () => { writes++; })).rejects.toMatchObject({ detail: { kind: "invalid_capability" } });
    const other = path.join(env!.dir, "other-worktree"); native(env!.repo, "worktree", "add", "--detach", other, "HEAD");
    await expect(withRepositoryMutation([other], async () => { writes++; }, { command: permits })).rejects.toMatchObject({ detail: { kind: "invalid_capability" } }); expect(writes).toBe(1);
    await stopRepositoryServiceCommand(repositoryServices[0]!, repositoryServices.slice(1)); repositoryServices.shift();
    await withRepositoryServiceStatus([env!.repo], repositoryServices, group, async () => { writes++; }); expect(writes).toBe(2);
  });
});
