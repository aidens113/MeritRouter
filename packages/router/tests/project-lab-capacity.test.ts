import { afterEach, expect, it } from "vitest";
import { randomBytes, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeEnv, type Env } from "./helpers.js";
import { immediate, openDatabase, type Db } from "../src/storage/db.js";
import { initializeStoreRole } from "../src/storage/store-role.js";
import { createCoordinationStoreIdentity, createProjectStoreIdentity, registerProjectStore } from "../src/projects/store-identity.js";
import { LabsStore, type LabRecord } from "../src/labs/store.js";
import { LabRecipeSchema } from "../src/labs/recipe.js";
import { ProjectLabCapacity } from "../src/labs/project-capacity.js";
import { abandonPreparedRepositoryServiceCommand, prepareRepositoryServiceCommand, repositoryServiceRetirement, startRepositoryServiceCommand, stopRepositoryServiceCommand, type RepositoryServiceCommand } from "../src/workspaces/repository-command.js";

const envs: Env[] = [], dbs: Db[] = [], commands: Array<{ command: RepositoryServiceCommand; started: boolean; retired: boolean }> = [];
afterEach(async () => {
  for (const item of commands.splice(0).reverse()) if (!item.retired) {
    if (item.started) await stopRepositoryServiceCommand(item.command);
    else await abandonPreparedRepositoryServiceCommand(item.command);
  }
  for (const db of dbs.splice(0)) if (db.open) db.close();
  for (const env of envs.splice(0)) env.cleanup();
});
const native = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
function fixture(maxActive = 2, maxServices = 1) {
  const env = makeEnv(); envs.push(env);
  const global = openDatabase(path.join(env.dir, "coordination"), { durability: "full" }); dbs.push(global);
  const installation = createCoordinationStoreIdentity(); initializeStoreRole(global, installation);
  const local = (slug: string) => {
    const root = path.join(env.dir, slug), repo = path.join(root, "repo"); mkdirSync(repo, { recursive: true });
    native(repo, "init", "-q"); writeFileSync(path.join(repo, "fixture.txt"), "private application"); native(repo, "add", "."); native(repo, "commit", "-qm", "fixture");
    const head = native(repo, "rev-parse", "HEAD").trim(), db = openDatabase(path.join(root, ".MeritRouter", "state"), { durability: "full" }); dbs.push(db);
    const identity = createProjectStoreIdentity(installation.installationId, slug); initializeStoreRole(db, identity); registerProjectStore(global, identity, root);
    const store = new LabsStore(db), lab: LabRecord = { id: "secret-lab", project: slug, name: "private-name", state: "creating", kind: "retained", root: path.join(root, ".MeritRouter", "labs", "private-name"),
      recipe: LabRecipeSchema.parse({ services: { worker: { repo: "app", command: `${JSON.stringify(process.execPath)} -e "setInterval(()=>{},1000)"` } } }),
      repositories: [{ alias: "app", source: repo, worktree: repo, branch: "fixture", target: "fixture", base: head }], ports: {}, env: {}, goal: "private-goal", createdAt: 1, updatedAt: 1, lastActivity: 1 };
    store.insert(lab);
    const cap = () => new ProjectLabCapacity(global, db, identity, { assertCurrent() {}, assertPinned() {} }, () => ({ max_active: maxActive, max_services: maxServices }));
    return { db, identity, repo, store, lab, capacity: cap(), reopen: cap };
  };
  return { global, a: local("alpha"), b: local("beta"), changeLimits: (active: number, services: number) => { maxActive = active; maxServices = services; } };
}
type Local = ReturnType<typeof fixture>["a"];
async function prepare(owner: Local) {
  const token = randomBytes(24).toString("hex"), descriptor = { group: `lab:${owner.lab.project}:${owner.lab.id}`, member: token, kind: "lab-service" as const, commandSha256: createHash("sha256").update(JSON.stringify({ name: "worker", cwd: owner.repo, command: owner.lab.recipe.services.worker!.command })).digest("hex") };
  owner.store.saveService({ lab_id: owner.lab.id, name: "worker", state: "starting", pid: null, token, log_path: path.join(owner.lab.root, "worker.log"), restart_count: 0, next_restart: null, started_at: Date.now(), owner_id: "fixture-manager", owner_until: Date.now() + 60000 });
  const command = await prepareRepositoryServiceCommand(owner.repo, descriptor), item = { command, started: false, retired: false }; commands.push(item);
  owner.db.prepare("INSERT INTO lab_command_owners(id,project_id,lab_id,kind,logical_name,token,command_digest,worktree_path,process_id,handle_json,phase,created_at,updated_at) VALUES(?,?,?,'lab-service','worker',?,?,?,NULL,?,'prepared',1,1)").run(command.id, owner.lab.project, owner.lab.id, token, descriptor.commandSha256, owner.repo, JSON.stringify(command));
  return item;
}
async function start(item: typeof commands[number]) {
  item.started = true;
  await startRepositoryServiceCommand(item.command, { file: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], cwd: item.command.repo, env: {}, timeoutMs: null }, async () => undefined);
}
async function stop(owner: Local, item: typeof commands[number]) {
  if (item.started) await stopRepositoryServiceCommand(item.command); else await abandonPreparedRepositoryServiceCommand(item.command);
  item.retired = true;
  owner.db.prepare("DELETE FROM lab_command_owners WHERE id=?").run(item.command.id);
  owner.db.prepare("UPDATE lab_services SET state='stopped',pid=NULL,token=NULL,owner_id=NULL,owner_until=0 WHERE lab_id=? AND name='worker'").run(owner.lab.id);
}
const count = (global: Db, kind: "lab" | "service") => (global.prepare("SELECT count(*) n FROM project_lab_capacity WHERE kind=?").get(kind) as { n: number }).n;

it("preserves installation Lab caps across duplicate private identities, replay and lowered trusted limits", () => {
  const { global, a, b, changeLimits } = fixture(1);
  a.capacity.reserveLab(a.lab.id); a.reopen().reserveLab(a.lab.id);
  expect(count(global, "lab")).toBe(1); expect(() => b.capacity.reserveLab(b.lab.id)).toThrow(/capacity reached/);
  a.db.prepare("UPDATE labs SET state='stopped'").run(); expect(() => a.capacity.releaseLab(a.lab.id)).toThrow(/terminal lifecycle/);
  changeLimits(0, 1); expect(() => a.capacity.reserveLab(a.lab.id)).toThrow(); changeLimits(1, 1);
  const shared = JSON.stringify(global.prepare("SELECT * FROM project_lab_capacity").all());
  for (const secret of ["secret-lab", "private-name", "private-goal", a.repo]) expect(shared).not.toContain(secret);
  expect(global.prepare("SELECT count(*) n FROM labs").get()).toEqual({ n: 0 });
  a.db.prepare("UPDATE labs SET state='destroyed'").run(); a.capacity.releaseLab(a.lab.id); b.capacity.reserveLab(b.lab.id); expect(count(global, "lab")).toBe(1);
});

it("overholds after local rollback and refuses stale generations without age reclamation", () => {
  const { global, a, b } = fixture(1);
  expect(() => immediate(a.db, () => { a.capacity.reserveLab(a.lab.id); throw Error("local rollback"); })).toThrow(/local rollback/);
  expect(count(global, "lab")).toBe(1); a.capacity.reserveLab(a.lab.id);
  global.prepare("UPDATE project_lab_capacity SET created_at=0").run(); expect(() => b.capacity.reserveLab(b.lab.id)).toThrow(/capacity reached/);
  global.prepare("UPDATE project_store_registrations SET generation=2 WHERE project_uuid=?").run(a.identity.projectId);
  a.db.prepare("UPDATE labs SET state='destroyed'").run(); expect(() => a.capacity.releaseLab(a.lab.id)).toThrow(/generation/); expect(count(global, "lab")).toBe(1);
});

it("never reads local SQL inside global coordination and rejects wrong stores and unadmitted existing Labs", () => {
  const { global, a, b } = fixture();
  expect(() => new ProjectLabCapacity(global, b.db, a.identity, { assertCurrent() {}, assertPinned() {} }, () => ({ max_active: 2, max_services: 1 }))).toThrow(/exact separate/);
  const original = a.db.prepare.bind(a.db);
  a.db.prepare = ((sql: string) => { expect(global.inTransaction).toBe(false); return original(sql); }) as Db["prepare"];
  a.capacity.reserveLab(a.lab.id); a.db.prepare("UPDATE labs SET state='destroyed'").run(); a.capacity.releaseLab(a.lab.id);
  b.db.prepare("UPDATE labs SET state='running'").run(); expect(() => b.capacity.reserveLab(b.lab.id)).toThrow(/creating intent/);
});

it.skipIf(process.platform !== "win32")("counts services independently across projects and releases only exact native retirement", async () => {
  const { global, a, b } = fixture(); a.capacity.reserveLab(a.lab.id); b.capacity.reserveLab(b.lab.id);
  const first = await prepare(a), second = await prepare(b); await a.capacity.reserveService(a.lab.id, "worker"); await a.reopen().reserveService(a.lab.id, "worker");
  expect(count(global, "service")).toBe(1); await expect(b.capacity.reserveService(b.lab.id, "worker")).rejects.toThrow(/capacity reached/);
  await start(first); await expect(abandonPreparedRepositoryServiceCommand(first.command)).rejects.toMatchObject({ detail: { kind: "command_uncertain" } });
  // Forged stopped rows and missing ordinary owner row still cannot substitute for kernel proof.
  a.db.prepare("DELETE FROM lab_command_owners WHERE id=?").run(first.command.id);
  a.db.prepare("UPDATE lab_services SET state='stopped',pid=NULL,token=NULL,owner_id=NULL,owner_until=0 WHERE lab_id=?").run(a.lab.id);
  await expect(a.capacity.releaseService(a.lab.id, "worker")).rejects.toThrow(/retirement evidence/); expect(count(global, "service")).toBe(1);
  await stop(a, first); expect(await repositoryServiceRetirement(first.command)).toBe("quiescent"); await a.capacity.releaseService(a.lab.id, "worker");
  expect(count(global, "lab")).toBe(2); expect(count(global, "service")).toBe(0);
  await b.capacity.reserveService(b.lab.id, "worker"); await stop(b, second); expect(await repositoryServiceRetirement(second.command)).toBe("unsent"); await b.capacity.releaseService(b.lab.id, "worker");
  expect(count(global, "service")).toBe(0); expect(a.db.prepare("SELECT * FROM lab_capacity_owners").all()).toEqual([]);
});

it.skipIf(process.platform !== "win32")("retains a service slot after local capture rollback and recovers the same binding", async () => {
  const { global, a } = fixture(); a.capacity.reserveLab(a.lab.id); const item = await prepare(a); let pending: Promise<void> | undefined;
  expect(() => immediate(a.db, () => { pending = a.capacity.reserveService(a.lab.id, "worker"); throw Error("local capture rollback"); })).toThrow(/local capture rollback/);
  await pending; expect(count(global, "service")).toBe(1); expect(a.db.prepare("SELECT * FROM lab_capacity_owners").all()).toEqual([]);
  await a.capacity.reserveService(a.lab.id, "worker"); expect(a.db.prepare("SELECT * FROM lab_capacity_owners").all()).toHaveLength(1);
  await stop(a, item); await a.capacity.releaseService(a.lab.id, "worker"); expect(count(global, "service")).toBe(0);
});

it.skipIf(process.platform !== "win32")("rejects serialized unsent authority and closes an abandon/start race before transport", async () => {
  const { a } = fixture(); const item = await prepare(a);
  await expect(abandonPreparedRepositoryServiceCommand(JSON.parse(JSON.stringify(item.command)))).rejects.toMatchObject({ detail: { kind: "invalid_capability" } });
  expect(await repositoryServiceRetirement(item.command)).toBe(null);
  const retiring = abandonPreparedRepositoryServiceCommand(item.command);
  await expect(startRepositoryServiceCommand(item.command, { file: process.execPath, args: ["-e", "throw Error('must not execute')"], cwd: a.repo, env: {}, timeoutMs: 1500 }, async () => undefined)).rejects.toMatchObject({ detail: { kind: "invalid_capability" } });
  await retiring; item.retired = true; expect(await repositoryServiceRetirement(item.command)).toBe("unsent");
});
