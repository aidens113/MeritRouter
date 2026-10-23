import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import YAML from "yaml";
import type { MeritRouter } from "../src/core/service.js";
import { brainWrite, inspectRepositoryPath } from "../src/admin/insights.js";
import { backupStorage, restoreStorage } from "../src/operations/backup.js";
import { BRAIN_BUNDLE } from "../src/operations/brain-backup.js";
import { DB_FILE } from "../src/storage/db.js";
import { commitAll, makeEnv, open, reply, ScriptedClient, type Env } from "./helpers.js";
import { patchPreparedConfig, readConfigText, writePreparedConfigText } from "../src/admin/config-edit.js";

const faults = vi.hoisted(() => ({ brain: "", store: "" }));
vi.mock("node:fs", async original => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, renameSync: (from: import("node:fs").PathLike, to: import("node:fs").PathLike) => {
    if ((faults.brain && String(to) === faults.brain && String(from).startsWith(`${faults.brain}.restore-`)) || (faults.store && String(to) === faults.store && String(from).includes(".meritrouter-restore-"))) throw new Error("simulated final swap failure");
    return fs.renameSync(from, to);
  } };
});

let env: Env | undefined;
let sy: MeritRouter | undefined;
afterEach(async () => { faults.brain = ""; faults.store = ""; await sy?.close(); sy = undefined; env?.cleanup(); env = undefined; });

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
function marker(storage: string) {
  const db = new Database(path.join(storage, DB_FILE), { readonly: true });
  try { return (db.prepare("SELECT value FROM meta WHERE key = 'restore-probe'").get() as { value: string }).value; }
  finally { db.close(); }
}

async function snapshot() {
  env = makeEnv();
  sy = open(env, new ScriptedClient(() => reply("{}")));
  const brain = sy.brain.root;
  const document = "projects/demo/facts/probe.md";
  await brainWrite(sy, document, "# Backup version\n");
  sy.db.prepare("INSERT INTO meta (key, value) VALUES ('restore-probe', 'backup')").run();
  const backup = path.join(env.dir, "backup");
  await backupStorage({ storageDir: env.cfg.storageDir, targetDir: backup, brainPath: brain });
  sy.db.prepare("UPDATE meta SET value = 'current' WHERE key = 'restore-probe'").run();
  await brainWrite(sy, document, "# Current version\n");
  const head = git(brain, "rev-parse", "HEAD");
  await sy.close(); sy = undefined;
  return { brain, document, backup, storage: env.cfg.storageDir, head };
}

describe("project recovery correctness", () => {
  it.each(["brain", "store"])("rolls both original halves back after a final %s swap fails", async phase => {
    const fixture = await snapshot();
    if (phase === "brain") faults.brain = fixture.brain;
    else faults.store = path.join(fixture.storage, DB_FILE);
    expect(() => restoreStorage({ backupDir: fixture.backup, storageDir: fixture.storage, brainPath: fixture.brain, force: true })).toThrow(/swap failure/);
    expect(marker(fixture.storage)).toBe("current");
    expect(git(fixture.brain, "rev-parse", "HEAD")).toBe(fixture.head);
    expect(readFileSync(path.join(fixture.brain, fixture.document), "utf8")).toContain("Current version");
  });

  it.each(["replace", "create"])("preserves the original store and brain when brain %s fails", async action => {
    const fixture = await snapshot();
    writeFileSync(path.join(fixture.backup, BRAIN_BUNDLE), "not a valid Git bundle\n");
    const target = action === "replace" ? fixture.brain : path.join(env!.dir, "new-brain");
    expect(() => restoreStorage({ backupDir: fixture.backup, storageDir: fixture.storage, brainPath: target, force: true })).toThrow();
    expect(marker(fixture.storage)).toBe("current");
    expect(git(fixture.brain, "rev-parse", "HEAD")).toBe(fixture.head);
    expect(readFileSync(path.join(fixture.brain, fixture.document), "utf8")).toContain("Current version");
    if (action === "create") expect(existsSync(target)).toBe(false);
  });

  it("reports tracked monorepo subfolders as refusals before save", () => {
    env = makeEnv();
    sy = open(env, new ScriptedClient(() => reply("{}")));
    const nested = path.join(env.repo, "nested");
    mkdirSync(nested);
    writeFileSync(path.join(nested, "tracked.txt"), "tracked by enclosing repository\n");
    commitAll(env.repo);
    const check = inspectRepositoryPath(sy, nested);
    expect(check.problem).toMatch(/tracked|enclosing|inside.*repository/);
    expect(check.hint).toBeNull();
    expect(existsSync(path.join(nested, ".git"))).toBe(false);
  });

  it.each(["structured", "raw"])("prepares changed repository paths before acknowledging a %s generic save", async mode => {
    env = makeEnv();
    sy = open(env, new ScriptedClient(() => reply("{}")));
    const raw = YAML.parse(readConfigText(sy));
    raw.repositories.core.path = "new-repository";
    const result = mode === "raw" ? await writePreparedConfigText(sy, YAML.stringify(raw)) : await patchPreparedConfig(sy, [{ path: ["repositories", "core", "path"], value: "new-repository" }]);
    expect(result).toEqual({ ok: true });
    const target = path.join(env.dir, "new-repository");
    expect(existsSync(path.join(target, ".git"))).toBe(true);
    expect(git(target, "rev-parse", "--verify", "HEAD")).toMatch(/^[a-f0-9]{40}$/);
    expect(YAML.parse(readConfigText(sy)).repositories.core.path).toBe("new-repository");
  });

  it("keeps config unchanged when generic path preparation refuses tracked content", async () => {
    env = makeEnv();
    sy = open(env, new ScriptedClient(() => reply("{}")));
    const before = readConfigText(sy);
    const result = await patchPreparedConfig(sy, [{ path: ["repositories", "core", "path"], value: "repo/src" }]);
    expect(result).toMatchObject({ ok: false, errors: [expect.stringMatching(/tracked/)] });
    expect(readConfigText(sy)).toBe(before);
    expect(existsSync(path.join(env.repo, "src", ".git"))).toBe(false);
  });
});
