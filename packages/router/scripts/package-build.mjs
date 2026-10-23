#!/usr/bin/env node
// Produce the package's runtime panel, without copying platform-specific node_modules.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.resolve(pkg, "../..");
const app = path.join(root, "apps", "panel");
const target = path.join(pkg, "panel");
const dependencies = JSON.parse(readFileSync(path.join(pkg, "package.json"), "utf8")).dependencies;
const requireApp = createRequire(path.join(app, "package.json"));
for (const name of ["next", "react", "react-dom"]) {
  const version = requireApp(`${name}/package.json`).version;
  if (dependencies[name] !== version) throw new Error(`Pin router ${name} to the panel build's ${version} before packaging`);
}
const run = (args) => execFileSync(process.platform === "win32" ? "pnpm.cmd" : "pnpm", args, { cwd: root, stdio: "inherit", ...(process.platform === "win32" ? { shell: true } : {}) });
run(["--filter", "switchyard-router", "build"]);
const { routerBuildFingerprint, PANEL_ROUTER_FINGERPRINT, PANEL_ROUTER_FINGERPRINT_ALGORITHM } = await import(pathToFileURL(path.join(pkg, "dist", "operations", "panel.js")).href);
const routerFingerprint = routerBuildFingerprint(path.join(pkg, "dist"));
run(["--filter", "switchyard-panel", "build"]);
const afterPanelBuild = routerBuildFingerprint(path.join(pkg, "dist"));
if (routerFingerprint.digest !== afterPanelBuild.digest || routerFingerprint.files !== afterPanelBuild.files) throw new Error("Router content changed while building the panel; rebuild a stable source tree");
// This target is a fixed generated directory inside this package, never a configured user path.
if (path.dirname(target) !== pkg || path.basename(target) !== "panel") throw new Error("invalid panel staging directory");
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(path.join(app, ".next"), path.join(target, ".next"), {
  recursive: true,
  filter: (src) => !["cache", "dev", "types", "node_modules"].includes(path.relative(path.join(app, ".next"), src).split(path.sep)[0]),
});
// Turbopack externalizes native modules through hashed links in .next/node_modules.
// npm never ships node_modules folders. Replace those host-specific links with portable,
// ordinary CommonJS forwarding packages, reached through the launcher's NODE_PATH.
const externals = path.join(app, ".next", "node_modules");
if (existsSync(externals)) {
  for (const alias of readdirSync(externals)) {
    const external = JSON.parse(readFileSync(path.join(externals, alias, "package.json"), "utf8"));
    if (!Object.hasOwn(dependencies, external.name)) throw new Error(`Undeclared panel external ${alias}: ${external.name}`);
    const dir = path.join(target, "runtime-modules", alias);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: alias, version: "1.0.0", main: "index.cjs", private: true }) + "\n");
    writeFileSync(path.join(dir, "index.cjs"), `module.exports = require(${JSON.stringify(external.name)});\n`);
    console.log(`Portable panel external: ${alias} -> ${external.name}`);
  }
}
if (existsSync(path.join(app, "public"))) cpSync(path.join(app, "public"), path.join(target, "public"), { recursive: true });
const manifest = JSON.parse(readFileSync(path.join(app, "package.json"), "utf8"));
writeFileSync(path.join(target, "package.json"), JSON.stringify({ name: manifest.name, version: manifest.version, private: true, type: "module" }, null, 2) + "\n");
// Use the build's effective configuration but keep deployment paths relative to its installed home.
const built = JSON.parse(readFileSync(path.join(app, ".next", "required-server-files.json"), "utf8")).config;
delete built.outputFileTracingRoot;
if (built.experimental) delete built.experimental.turbopackRoot;
if (built.turbopack) delete built.turbopack.root;
built.distDir = ".next";
writeFileSync(path.join(target, "next.config.mjs"), `export default ${JSON.stringify(built, null, 2)};\n`);
const buildIdText = readFileSync(path.join(target, ".next", "BUILD_ID"), "utf8");
const buildId = buildIdText.trim();
if (!buildId || buildId.length > 200 || Buffer.byteLength(buildIdText) > 4096) throw new Error("Invalid panel BUILD_ID for package fingerprint");
writeFileSync(path.join(target, ".next", PANEL_ROUTER_FINGERPRINT), JSON.stringify({ version: 1, algorithm: PANEL_ROUTER_FINGERPRINT_ALGORITHM, buildId, ...routerFingerprint }, null, 2) + "\n");
console.log(`Packaged production panel at ${target} (router ${routerFingerprint.digest})`);
