import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { ensurePanel } from "../src/operations/panel.js";
import YAML from "yaml";
import { defaultConfigDirectory, loadConfig, resolveConfigPath } from "../src/config/load.js";
import { initializeConfig } from "../src/cli/setup.js";

let root: string | undefined;
afterEach(() => {
  vi.unstubAllEnvs();
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});
function fixture() {
  root = mkdtempSync(path.join(tmpdir(), "meritrouter-packaging-"));
  vi.stubEnv("MERITROUTER_CONFIG", undefined);
  vi.stubEnv("MERITROUTER_HOME", path.join(root, "application"));
  const cwd = path.join(root, "repository", "nested");
  mkdirSync(cwd, { recursive: true });
  return { root, cwd };
}
describe("installed setup and config discovery", () => {
  it("uses explicit/env config, nearest ancestor, then the user directory without creating files", () => {
    const { root, cwd } = fixture();
    const global = path.join(root, "application", "meritrouter.config.yaml");
    expect(resolveConfigPath(undefined, cwd)).toBe(global);
    expect(existsSync(path.dirname(global))).toBe(false);
    const parent = path.join(root, "repository", "meritrouter.config.yaml");
    writeFileSync(parent, "version: 1");
    expect(resolveConfigPath(undefined, cwd)).toBe(parent);
    const nearest = path.join(cwd, "meritrouter.config.yaml");
    writeFileSync(nearest, "version: 1");
    expect(resolveConfigPath(undefined, cwd)).toBe(nearest);
    vi.stubEnv("MERITROUTER_CONFIG", "env.yaml");
    expect(resolveConfigPath(undefined, cwd)).toBe(path.join(cwd, "env.yaml"));
    expect(resolveConfigPath("explicit.yaml", cwd)).toBe(path.join(cwd, "explicit.yaml"));
  });
  it("chooses stable per-platform default application directories", () => {
    expect(defaultConfigDirectory({ LOCALAPPDATA: "/local" }, "/home", "win32")).toBe(path.resolve("/local", "MeritRouter"));
    expect(defaultConfigDirectory({}, "/home", "darwin")).toBe(path.resolve("/home", "Library", "Application Support", "MeritRouter"));
    expect(defaultConfigDirectory({ XDG_CONFIG_HOME: "/xdg" }, "/home", "linux")).toBe(path.resolve("/xdg", "meritrouter"));
    expect(defaultConfigDirectory({}, "/home", "linux")).toBe(path.resolve("/home", ".config", "meritrouter"));
  });
  it("creates a valid isolated setup with no placeholder repos and never replaces existing settings", () => {
    const { root, cwd } = fixture();
    const configPath = resolveConfigPath(undefined, cwd);
    const opts = { configPath, project: "example", setup: true, port: 4598 };
    expect(initializeConfig(opts)).toHaveLength(2);
    const cfg = loadConfig(configPath);
    expect(cfg.projects.example).toMatchObject({ repositories: {} });
    expect(cfg.brain.path).toBe(".meritrouter/brain");
    expect(cfg.storageDir).toBe(path.join(root, "application", ".meritrouter"));
    expect(cfg.panel.port).toBe(4598);
    expect(cfg.paid).toMatchObject({ enabled: true, budgets: { per_week_usd: 5 }, tiers: { T1: "on_free_exhaustion", T2: "on_free_exhaustion", T3: "on_free_exhaustion", T4: "never" } });
    expect(cfg.supervisor.paid_policy).toBe("on_free_exhaustion");
    const original = readFileSync(configPath, "utf8");
    expect(initializeConfig({ ...opts, project: "different" })).toEqual([`kept existing ${configPath}`, `kept existing ${path.join(path.dirname(configPath), "models.yaml")}`]);
    expect(readFileSync(configPath, "utf8")).toBe(original);
    expect(YAML.parse(readFileSync(path.join(path.dirname(configPath), "models.yaml"), "utf8"))).toHaveProperty("version", 1);
  });
  it("launches a packaged panel with its portable native-module alias directory", async () => {
    const { root, cwd } = fixture();
    const configPath = resolveConfigPath(undefined, cwd);
    initializeConfig({ configPath, project: "example", setup: true });
    const cfg = loadConfig(configPath);
    const listener = net.createServer();
    await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
    cfg.panel.port = (listener.address() as net.AddressInfo).port;
    await new Promise<void>(resolve => listener.close(() => resolve()));
    const app = path.join(root, "installed", "bundled-panel");
    const bin = path.join(app, "node_modules", "next", "dist", "bin");
    const aliases = path.join(app, "runtime-modules");
    const native = path.join(aliases, "native-test-alias");
    mkdirSync(bin, { recursive: true });
    mkdirSync(native, { recursive: true });
    mkdirSync(path.join(app, ".next"), { recursive: true });
    writeFileSync(path.join(app, "package.json"), "{}");
    writeFileSync(path.join(app, ".next", "BUILD_ID"), "packaged-test");
    writeFileSync(path.join(native, "index.js"), 'module.exports = require("node:os");');
    writeFileSync(path.join(bin, "next"), `
      const fs = require("node:fs"), net = require("node:net");
      const native = require("native-test-alias");
      fs.writeFileSync("loaded.json", JSON.stringify({ platform: native.platform(), paths: process.env.NODE_PATH }));
      const port = Number(process.argv[process.argv.indexOf("-p") + 1]);
      const server = net.createServer(s => s.end());
      server.listen(port, "127.0.0.1");
      setTimeout(() => server.close(), 1000);
    `);
    vi.stubEnv("MERITROUTER_PANEL_DIR", app);
    try {
      expect((await ensurePanel(cfg, { force: true, waitMs: 2000 })).state).toBe("started");
      const loaded = JSON.parse(readFileSync(path.join(app, "loaded.json"), "utf8"));
      expect(loaded).toMatchObject({ platform: process.platform });
      expect(loaded.paths.split(path.delimiter)[0]).toBe(aliases);
    } finally {
      // The fixture child closes its own server; let it release log handles before cleanup.
      await new Promise(resolve => setTimeout(resolve, 1200));
    }
  });

});
