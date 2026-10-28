import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import YAML from "yaml";
import { loadConfig, parseConfig, resolveConfigPath } from "../src/config/load.js";
import { initializeConfig } from "../src/cli/setup.js";
import { openDatabase } from "../src/storage/db.js";
import { openInstallationLayout } from "../src/core/project-runtime-host.js";
import { readStoreIdentity } from "../src/projects/store-identity.js";
import { baseConfig } from "./helpers.js";

let root: string | undefined;
afterEach(() => {
  vi.unstubAllEnvs();
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});
function fixture() {
  root = mkdtempSync(path.join(tmpdir(), "meritrouter-install-layout-"));
  vi.stubEnv("MERITROUTER_CONFIG", undefined);
  vi.stubEnv("MERITROUTER_HOME", path.join(root, "application"));
  const cwd = path.join(root, "repository", "nested");
  mkdirSync(cwd, { recursive: true });
  return { root, cwd };
}

describe("fresh installs default to split project storage with the renamed runtime folder", () => {
  it("setup writes storage.layout: split, storage.durability: full and the .MeritRouter spelling", () => {
    const { root, cwd } = fixture();
    const configPath = resolveConfigPath(undefined, cwd);
    initializeConfig({ configPath, project: "example", setup: true });
    const cfg = loadConfig(configPath);
    expect(cfg.storage.layout).toBe("split");
    expect(cfg.storage.durability).toBe("full");
    expect(cfg.storage.directory).toBe(".MeritRouter");
    expect(cfg.storageDir).toBe(path.join(root, "application", ".MeritRouter"));
    expect(cfg.brain.path).toBe(".MeritRouter/brain");
  });

  it("init writes storage.layout: split, storage.durability: full and a home-based .MeritRouter brain path", () => {
    const { cwd } = fixture();
    const dir = path.join(cwd, "install");
    mkdirSync(dir, { recursive: true });
    const configPath = path.join(dir, "meritrouter.config.yaml");
    initializeConfig({ configPath, project: "example" });
    const cfg = loadConfig(configPath);
    expect(cfg.storage.layout).toBe("split");
    expect(cfg.storage.durability).toBe("full");
    expect(cfg.storage.directory).toBe(".MeritRouter");
    expect(cfg.storageDir).toBe(path.join(dir, ".MeritRouter"));
    expect(cfg.brain.path).toBe("~/.MeritRouter/brain");
  });

  it("never rewrites an existing config", () => {
    const { cwd } = fixture();
    const dir = path.join(cwd, "install");
    mkdirSync(dir, { recursive: true });
    const configPath = path.join(dir, "meritrouter.config.yaml");
    initializeConfig({ configPath, project: "example" });
    const original = readFileSync(configPath, "utf8");
    const messages = initializeConfig({ configPath, project: "different" });
    expect(messages[0]).toBe(`kept existing ${configPath}`);
    expect(readFileSync(configPath, "utf8")).toBe(original);
  });
});

describe("storage.layout schema default and legacy configs", () => {
  it("defaults to legacy for a config that does not name a layout", () => {
    const cfg = parseConfig(baseConfig({ storage: { directory: ".meritrouter" } }), path.join(tmpdir(), "meritrouter.config.yaml"));
    expect(cfg.storage.layout).toBe("legacy");
  });

  it("keeps an existing config's explicit legacy layout and old-spelled directory untouched", () => {
    const { cwd } = fixture();
    const dir = path.join(cwd, "install");
    mkdirSync(dir, { recursive: true });
    const configPath = path.join(dir, "meritrouter.config.yaml");
    const text = YAML.stringify(baseConfig({ storage: { directory: ".meritrouter", layout: "legacy" } }));
    writeFileSync(configPath, text);
    const cfg = loadConfig(configPath);
    expect(cfg.storage.layout).toBe("legacy");
    expect(cfg.storage.directory).toBe(".meritrouter");
    // `init` never rewrites an existing config, so the explicit legacy layout survives untouched.
    initializeConfig({ configPath, project: "example" });
    expect(readFileSync(configPath, "utf8")).toBe(text);
  });
});

describe("the .MeritRouter storage directory falls back to an existing .meritrouter directory", () => {
  it("resolves storageDir to an existing old-spelled directory when the new spelling is absent (case-sensitive filesystems)", () => {
    const base = mkdtempSync(path.join(tmpdir(), "meritrouter-fallback-"));
    root = base;
    mkdirSync(path.join(base, ".meritrouter"));
    const configPath = path.join(base, "meritrouter.config.yaml");
    const cfg = parseConfig(baseConfig({ storage: {} }), configPath);
    expect(cfg.storage.directory).toBe(".MeritRouter");
    if (process.platform === "win32" || process.platform === "darwin") {
      // Case-insensitive filesystem: the old-spelled directory already satisfies the new path, so
      // the fallback branch is never reached (it is exercised on Linux below).
      expect(cfg.storageDir).toBe(path.join(base, ".MeritRouter"));
    } else {
      expect(cfg.storageDir).toBe(path.join(base, ".meritrouter"));
    }
  });

  it.skipIf(process.platform !== "linux")("resolves storageDir to the new spelling once it exists, even alongside an old-spelled directory", () => {
    const base = mkdtempSync(path.join(tmpdir(), "meritrouter-fallback-"));
    root = base;
    mkdirSync(path.join(base, ".meritrouter"));
    mkdirSync(path.join(base, ".MeritRouter"));
    const configPath = path.join(base, "meritrouter.config.yaml");
    const cfg = parseConfig(baseConfig({ storage: {} }), configPath);
    expect(cfg.storageDir).toBe(path.join(base, ".MeritRouter"));
  });

  it("never falls back for a custom-named directory", () => {
    const base = mkdtempSync(path.join(tmpdir(), "meritrouter-fallback-"));
    root = base;
    const configPath = path.join(base, "meritrouter.config.yaml");
    const cfg = parseConfig(baseConfig({ storage: { directory: "mydata" } }), configPath);
    expect(cfg.storageDir).toBe(path.join(base, "mydata"));
  });
});

describe("openInstallationLayout decides from storage.layout, not durability", () => {
  function store(): { dir: string; db: ReturnType<typeof openDatabase> } {
    const dir = mkdtempSync(path.join(tmpdir(), "meritrouter-layout-"));
    root = dir;
    return { dir, db: openDatabase(dir) };
  }

  it("binds a fresh empty store as split coordination when layout is split", () => {
    const { db } = store();
    expect(openInstallationLayout(db, "split")).toBe("split");
    expect(readStoreIdentity(db)?.role).toBe("coordination");
    expect(db.pragma("synchronous", { simple: true })).toBe(2);
    db.close();
  });

  it("leaves a fresh empty store unbound when layout is legacy", () => {
    const { db } = store();
    expect(openInstallationLayout(db, "legacy")).toBe("legacy");
    expect(readStoreIdentity(db)).toBeNull();
    db.close();
  });

  it("refuses to switch a store already holding legacy rows to split", () => {
    const { db } = store();
    db.exec("INSERT INTO tasks(id,spec_hash,profile,spec_json,state,created_at,updated_at) VALUES('t1','h','summarize','{}','queued',0,0)");
    expect(() => openInstallationLayout(db, "split")).toThrow(/split_layout_unavailable|already holds data/);
    expect(openInstallationLayout(db, "legacy")).toBe("legacy");
    db.close();
  });

  it("keeps a store already bound and marked split, regardless of the current config", () => {
    const { db } = store();
    expect(openInstallationLayout(db, "split")).toBe("split");
    db.close();
    const reopened = openDatabase(root!);
    expect(openInstallationLayout(reopened, "legacy")).toBe("split");
    reopened.close();
  });
});
