import { afterEach, expect, it } from "vitest";
import { existsSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import YAML from "yaml";
import { MeritRouter } from "../src/core/service.js";
import { MeritRouterError } from "../src/core/errors.js";
import { loadConfig } from "../src/config/load.js";
import { databasePath, DB_FILE, LEGACY_DB_FILE, openDatabase } from "../src/storage/db.js";
import { backupStorage, restoreStorage } from "../src/operations/backup.js";
import { labOwnershipMarker } from "../src/labs/ownership-marker.js";
import { taskLabBranchOwned } from "../src/labs/task-attempt-runner.js";
import { taskHash } from "../src/labs/task-attempt-source.js";
import { HOST_MARKER, ownedWindowsProcessTree } from "../src/labs/process-ownership.js";
import { baseConfig } from "./helpers.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "meritrouter-rename-"));
  roots.push(root);
  return root;
}
function populate(storage: string, value: string) {
  const db = openDatabase(storage);
  try { db.exec("CREATE TABLE rename_probe(value TEXT NOT NULL)"); db.prepare("INSERT INTO rename_probe VALUES (?)").run(value); }
  finally { db.close(); }
}
function probe(storage: string) {
  const db = openDatabase(storage);
  try { return db.prepare("SELECT value FROM rename_probe").pluck().get(); }
  finally { db.close(); }
}

it("exports the canonical public service and error names", () => {
  expect(MeritRouter.name).toBe("MeritRouter");
  expect(new MeritRouterError("usage", "example").name).toBe("MeritRouterError");
});

it("opens explicit old config paths with their relative storage, brain, and branch settings intact", () => {
  const root = fixture(), config = path.join(root, "switchyard.config.yaml");
  writeFileSync(config, YAML.stringify(baseConfig({ storage: { directory: ".switchyard" }, brain: { path: "old-brain", project: "demo" }, supervisor: { branch_prefix: "switchyard/job-" } })));
  const cfg = loadConfig(config);
  expect(cfg.storageDir).toBe(path.join(root, ".switchyard"));
  expect(cfg.brain.path).toBe("old-brain");
  expect(cfg.supervisor.branch_prefix).toBe("switchyard/job-");
  populate(cfg.storageDir, "legacy");
  renameSync(path.join(cfg.storageDir, DB_FILE), path.join(cfg.storageDir, LEGACY_DB_FILE));
  expect(probe(cfg.storageDir)).toBe("legacy");
  expect(existsSync(path.join(cfg.storageDir, DB_FILE))).toBe(false);
});

it("prefers the new database when both generations exist without changing the old database", () => {
  const root = fixture();
  populate(root, "legacy");
  renameSync(path.join(root, DB_FILE), path.join(root, LEGACY_DB_FILE));
  const other = path.join(root, "new");
  populate(other, "canonical");
  renameSync(path.join(other, DB_FILE), path.join(root, DB_FILE));
  expect(databasePath(root)).toBe(path.join(root, DB_FILE));
  expect(probe(root)).toBe("canonical");
  expect(existsSync(path.join(root, LEGACY_DB_FILE))).toBe(true);
});

it("backs up a selected legacy database and preserves old state during explicit forced restore", async () => {
  const root = fixture(), storage = path.join(root, "store"), backup = path.join(root, "backup");
  populate(storage, "legacy");
  renameSync(path.join(storage, DB_FILE), path.join(storage, LEGACY_DB_FILE));
  await backupStorage({ storageDir: storage, targetDir: backup });
  expect(existsSync(path.join(backup, DB_FILE))).toBe(true);
  expect(() => restoreStorage({ storageDir: storage, backupDir: backup })).toThrow(/existing state/);
  const restored = restoreStorage({ storageDir: storage, backupDir: backup, force: true });
  expect(existsSync(path.join(restored.previousMovedTo!, LEGACY_DB_FILE))).toBe(true);
  expect(probe(storage)).toBe("legacy");
});

it("reads old Lab markers only when no canonical marker exists", () => {
  const root = fixture();
  writeFileSync(path.join(root, ".switchyard-lab.json"), "{}");
  expect(labOwnershipMarker(root)).toBe(path.join(root, ".switchyard-lab.json"));
  writeFileSync(path.join(root, ".meritrouter-lab.json"), "invalid");
  expect(labOwnershipMarker(root)).toBe(path.join(root, ".meritrouter-lab.json"));
});

it("requires exact ownership tokens for both persisted and canonical Lab process markers", () => {
  const token = "a".repeat(48);
  for (const marker of [HOST_MARKER, "SWITCHYARD_LAB_HOST_V1"]) {
    const rows = [{ ProcessId: 100, ParentProcessId: 1, CreatedTicks: "1000", CommandLine: `node ${marker} --sy-lab-token=${token}` }];
    expect(ownedWindowsProcessTree(rows, 100, token)).toHaveLength(1);
    expect(() => ownedWindowsProcessTree(rows, 100, "b".repeat(48))).toThrow(/ownership changed/);
  }
});

it("permits cleanup of only exact persisted task Lab branches in either namespace", () => {
  const project = "demo", attempt = "attempt-123456789012", alias = "core";
  const suffix = `task-lab-${taskHash(project).slice(0, 8)}-${attempt.slice(-12)}-${taskHash(alias).slice(0, 8)}`;
  for (const namespace of ["meritrouter", "switchyard"]) {
    const branch = `${namespace}/${suffix}`;
    expect(taskLabBranchOwned(project, attempt, alias, branch, branch)).toBe(true);
    expect(taskLabBranchOwned("foreign", attempt, alias, branch, branch)).toBe(false);
    expect(taskLabBranchOwned(project, attempt, "foreign", branch, branch)).toBe(false);
    expect(taskLabBranchOwned(project, attempt, alias, branch, "main")).toBe(false);
  }
});
