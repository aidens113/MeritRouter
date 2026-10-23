#!/usr/bin/env node
// Run with: pnpm exec node scripts/packaging-smoke.mjs <tarball> <pnpm CLI .cjs> [existing smoke root]
// Only temporary config/data and an owned foreground panel process are used.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";

const tarball = path.resolve(process.argv[2] || "meritrouter-0.1.0.tgz");
assert(existsSync(tarball), `missing tarball ${tarball}`);
const manager = process.argv[3] || process.env.npm_execpath;
assert(manager && existsSync(manager), "pass the pnpm CLI script as the third argument, or run through a package script");
const reuse = process.argv[4];
const root = reuse ? path.resolve(reuse) : mkdtempSync(path.join(tmpdir(), "meritrouter-package-install-"));
assert(path.dirname(root) === path.resolve(tmpdir()) && path.basename(root).startsWith("meritrouter-package-install-"), "not an owned smoke install directory");
if (reuse) {
  const integrity = "sha512-" + createHash("sha512").update(readFileSync(tarball)).digest("base64");
  assert(readFileSync(path.join(root, "pnpm-lock.yaml"), "utf8").includes(integrity), "reuse install does not match this tarball");
}
const env = { ...process.env, MERITROUTER_HOME: path.join(root, "application"), MERITROUTER_PACKAGE_FORBID_ROOT: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..") };
const guard = path.join(root, "forbid-checkout.cjs");
writeFileSync(guard, `
  const fs = require("node:fs"), path = require("node:path"), url = require("node:url");
  const root = path.resolve(process.env.MERITROUTER_PACKAGE_FORBID_ROOT).toLowerCase();
  function check(value) {
    if (value instanceof URL && value.protocol === "file:") value = url.fileURLToPath(value);
    if (Buffer.isBuffer(value)) value = value.toString();
    if (typeof value !== "string") return;
    const target = path.resolve(value).toLowerCase();
    if (target === root || target.startsWith(root + path.sep)) {
      process.stderr.write("PACKAGING_CHECKOUT_ACCESS: " + target + "\\n");
      const error = new Error("checkout unavailable: " + target); error.code = "ENOENT"; throw error;
    }
  }
  for (const key of ["readFileSync", "openSync", "statSync", "lstatSync", "realpathSync", "readdirSync", "accessSync", "existsSync", "readFile", "open", "stat", "lstat", "realpath", "readdir", "access", "readlink", "readlinkSync", "createReadStream", "opendir", "opendirSync"]) {
    const original = fs[key];
    if (typeof original !== "function") continue;
    const wrapped = (...args) => { check(args[0]); return original(...args); };
    Object.assign(wrapped, original);
    if (original.native) wrapped.native = (...args) => { check(args[0]); return original.native(...args); };
    fs[key] = wrapped;
  }
  for (const key of ["readFile", "open", "stat", "lstat", "realpath", "readdir", "access", "readlink", "opendir"]) {
    const original = fs.promises[key];
    if (typeof original !== "function") continue;
    fs.promises[key] = (...args) => { check(args[0]); return original(...args); };
  }
  require("node:module").syncBuiltinESMExports();
`);
for (const key of ["MERITROUTER_CONFIG", "MERITROUTER_PANEL_DIR", "MERITROUTER_PROJECT", "NODE_PATH", "NODE_OPTIONS"]) delete env[key];
writeFileSync(path.join(root, "package.json"), JSON.stringify({ private: true, dependencies: { "meritrouter": `file:${tarball.replaceAll("\\", "/")}` }, pnpm: { onlyBuiltDependencies: ["better-sqlite3"] } }, null, 2));
console.log(`Temporary install: ${root}`);
// pnpm's default store is drive-local on Windows; reuse this checkout's cache across drives.
const storeDirectory = path.dirname(execFileSync(process.execPath, [manager, "store", "path"], { env, encoding: "utf8" }).trim());
if (!reuse) execFileSync(process.execPath, [manager, "install", "--offline", "--prod", "--store-dir", storeDirectory], { cwd: root, env, stdio: "inherit" });
const installed = realpathSync(path.join(root, "node_modules", "meritrouter"));
assert(installed.startsWith(root + path.sep), "package resolves outside the temporary install");
const requireInstalled = createRequire(path.join(installed, "package.json"));
const sqlite = requireInstalled("better-sqlite3");
const db = new sqlite(":memory:");
assert.equal(db.prepare("select 1 as value").get().value, 1);
db.close();
for (const rel of ["charters/supervisor.md", "examples/presets/claude-code.yaml", "evals/suite.json", "panel/.next/BUILD_ID", "panel/next.config.mjs"]) assert(existsSync(path.join(installed, rel)), `missing runtime asset ${rel}`);
const cli = path.join(installed, "dist", "cli.js");
const run = (...args) => execFileSync(process.execPath, ["--require", guard, cli, ...args], { cwd: root, env, encoding: "utf8", timeout: 30_000 });
assert.match(run("--help"), /setup \[dir\]/);
run("init", path.join(root, "local-init"));
assert(existsSync(path.join(root, "local-init", "meritrouter.config.yaml")));
const listener = net.createServer();
await new Promise(resolve => listener.listen(0, "127.0.0.1", resolve));
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
run("setup", "--no-panel", "--port", String(port), "--project", "package-smoke");
const cfg = path.join(env.MERITROUTER_HOME, "meritrouter.config.yaml");
const yaml = requireInstalled("yaml");
const raw = yaml.parse(readFileSync(cfg, "utf8"));
raw.panel.auto_start = false;
raw.panel.port = port;
raw.discovery.interval_minutes = 0;
writeFileSync(cfg, yaml.stringify(raw));
assert.match(run("projects", "list"), /package-smoke/);
const { Client } = await import(pathToFileURL(requireInstalled.resolve("@modelcontextprotocol/sdk/client/index.js")));
const { StdioClientTransport } = await import(pathToFileURL(requireInstalled.resolve("@modelcontextprotocol/sdk/client/stdio.js")));
const client = new Client({ name: "package-smoke", version: "1" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ["--require", guard, cli, "mcp", "--no-worker"], cwd: root, env: Object.fromEntries(Object.entries(env).filter(([, v]) => typeof v === "string")) }));
try {
  const tools = (await client.listTools()).tools.map(t => t.name);
  assert(tools.includes("submit_tasks") && tools.includes("budget_requests"));
  assert(!(await client.callTool({ name: "usage_summary", arguments: {} })).isError);
  console.log(`Installed MCP: ${tools.length} tools; usage_summary passed`);
} finally { await client.close(); }
const { findPanelApp } = await import(pathToFileURL(path.join(installed, "dist", "operations", "panel.js")));
const app = findPanelApp();
assert(!("problem" in app), app.problem);
assert.equal(realpathSync(app.dir), path.join(realpathSync(installed), "panel"));
const panel = spawn(process.execPath, ["--require", guard, app.nextBin, "start", "-H", "127.0.0.1", "-p", String(port)], { cwd: app.dir, env: { ...env, MERITROUTER_CONFIG: cfg, ...(app.runtimeModules ? { NODE_PATH: app.runtimeModules } : {}) }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
let output = "";
panel.stdout.on("data", chunk => { output += chunk; });
panel.stderr.on("data", chunk => { output += chunk; });
const url = `http://127.0.0.1:${port}`;
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (panel.exitCode !== null) throw new Error(`panel exited ${panel.exitCode}: ${output}`);
    try { ready = (await fetch(url, { signal: AbortSignal.timeout(1000) })).status === 200; } catch {}
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert(ready, `panel did not become ready: ${output}`);
  for (const route of ["/", "/all", "/all/models", "/all/settings", "/p/package-smoke", "/api/projects", "/api/sessions", "/all/qualification"]) {
    const response = await fetch(url + route);
    assert.equal(response.status, 200, `${route}: ${await response.text()}`);
  }
  const html = await (await fetch(url)).text();
  const asset = /href="([^"]+\.css(?:\?[^"]*)?)"/.exec(html)?.[1];
  assert(asset, "no stylesheet in panel response");
  assert.equal((await fetch(new URL(asset.replaceAll("&amp;", "&"), url))).status, 200);
  assert.match(run("setup"), /the panel is running at/);
  assert(!output.includes("PACKAGING_CHECKOUT_ACCESS"), output);
  console.log(`Installed panel: ${url}; 8 pages/API routes and stylesheet passed; setup reused the panel`);
} finally {
  // This exact foreground child was started above; no PID from external state is trusted.
  panel.kill();
  if (panel.exitCode === null) await new Promise(resolve => panel.once("exit", resolve));
}
// Finally exercise the actual one-command detached launcher, then stop only this fixture panel.
env.NODE_OPTIONS = `--require "${guard.replaceAll("\\", "/")}"`;
let launched = false;
try {
  const result = run("setup");
  assert.match(result, /started the panel at/);
  launched = true;
  const response = await fetch(url + "/api/projects");
  assert.equal(response.status, 200);
  assert.match(await response.text(), /package-smoke/);
  assert(!readFileSync(path.join(env.MERITROUTER_HOME, ".meritrouter", "logs", "panel.log"), "utf8").includes("PACKAGING_CHECKOUT_ACCESS"));
  console.log(`Installed setup launched the bundled panel at ${url}`);
} finally {
  if (launched) {
    const stopped = await fetch(url + "/api/panel/stop", { method: "POST", headers: { origin: url } });
    assert.equal(stopped.status, 200);
    let closed = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { await fetch(url, { signal: AbortSignal.timeout(300) }); } catch { closed = true; break; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert(closed, "fixture panel did not stop");
  }
}
console.log(JSON.stringify({ root, tarball, native: true, cli: true, mcp: true, panel: true, setup: true, closed: true }));
