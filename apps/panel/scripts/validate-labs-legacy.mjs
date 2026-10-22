#!/usr/bin/env node
// Actual production API regression for an explicit legacy-project recipe save, demo data only.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import YAML from "yaml";
import { loadConfig, Switchyard, LabSupervisorLease } from "switchyard-router";
const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const demo = path.join(app, ".demo");
const raw = YAML.parse(readFileSync(path.join(demo, "switchyard.config.yaml"), "utf8"));
raw.repositories = raw.projects.demo.repositories; delete raw.projects;
raw.storage = { ...raw.storage, directory: ".switchyard-legacy-panel" };
raw.brain = { ...raw.brain, project: "demo", path: "brain-legacy-panel" };
const configPath = path.join(demo, "legacy-labs.config.yaml");
writeFileSync(configPath, YAML.stringify(raw));
const sy = new Switchyard(loadConfig(configPath), { worker: false });
const beforeRow = sy.projects.rows().find(p => p.id === "demo");
const paths = structuredClone(sy.projects.primary.repositoryPaths);
const port = Number(process.argv[2] ?? 4498); assert(port >= 1024 && port !== 4477);
const base = `http://127.0.0.1:${port}`;
const require = createRequire(import.meta.url);
let server;
const exited = child => child.exitCode !== null || child.signalCode !== null;
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(fn) { const end = Date.now() + 60000; while (Date.now() < end) { if (await fn()) return; await delay(100); } throw new Error("Legacy panel timeout"); }
async function request(method, body, status = 200) {
  const r = await fetch(base + "/api/labs/recipe?project=demo", { method, ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) });
  const text = await r.text(); assert.equal(r.status, status, text.slice(0, 800)); return JSON.parse(text);
}
try {
  server = spawn(process.execPath, [require.resolve("next/dist/bin/next"), "start", "-H", "127.0.0.1", "-p", String(port)], { cwd: app, env: { ...process.env, SWITCHYARD_CONFIG: configPath, SWITCHYARD_PANEL_TOKEN: "", SWITCHYARD_PROJECT: "" }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; server.stdout.on("data", d => output += d); server.stderr.on("data", d => output += d);
  await until(async () => { if (exited(server)) throw new Error(output); try { return (await fetch(base + "/api/labs/recipe?project=demo")).ok; } catch { return false; } });
  const before = await request("GET"); assert(before.legacy && !before.readOnly && !before.configured);
  const page = await fetch(base + "/p/demo/settings?tab=labs"); assert.equal(page.status, 200); assert((await page.text()).includes("Saving a recipe enables Labs for this project"));
  const snapshot = readFileSync(configPath, "utf8");
  await request("PUT", { recipe: { services: { bad: { repo: "foreign", command: "node --version" } } }, promotion: "manual", maxActive: 2 }, 400);
  assert.equal(readFileSync(configPath, "utf8"), snapshot, "Invalid recipe must not partially migrate config");
  await request("PUT", { recipe: { checks: { smoke: { repo: "core", command: "node --version" } } }, promotion: "manual", maxActive: 2 });
  const after = await request("GET"); assert(!after.legacy && after.configured && !after.readOnly && after.maxActive === 2);
  const changed = YAML.parse(readFileSync(configPath, "utf8"));
  assert.deepEqual(changed.projects.demo.repositories, raw.repositories);
  const { repositories: removed, ...globalBefore } = raw;
  const { projects: added, ...globalAfter } = changed;
  assert.deepEqual(globalAfter, globalBefore); assert.deepEqual(Object.keys(changed.projects), ["demo"]);
  sy.reloadIfChanged(); assert.equal(sy.projects.primary.project.slug, "demo"); assert.deepEqual(sy.projects.primary.repositoryPaths, paths);
  assert.deepEqual(sy.projects.rows().find(p => p.id === "demo"), beforeRow);
  assert.equal(new LabSupervisorLease(sy.db, configPath).read(), null, "Saving a recipe must not launch supervision");
  assert.equal(sy.db.prepare("SELECT COUNT(*) AS n FROM model_requests").get().n, 0);
  console.log(JSON.stringify({ ok: true, port, panelPid: server.pid, configPath, legacy: "validated before mutation; same project identity/rows/paths; globals unchanged; no model/supervisor start" }, null, 2));
} finally {
  if (server && !exited(server)) { server.kill(); await until(() => exited(server)); }
  await sy.close();
  for (const target of [configPath, configPath + ".bak", path.join(demo, ".switchyard-legacy-panel"), path.join(demo, "brain-legacy-panel")]) {
    assert(path.resolve(target).startsWith(path.resolve(demo) + path.sep));
    rmSync(target, { force: true, recursive: true, maxRetries: 3, retryDelay: 200 });
  }
}
