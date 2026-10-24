import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { ConfigSchema } from "../src/config/schema.js";
import { initializeConfig } from "../src/cli/setup.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (!root.startsWith(path.resolve(import.meta.dirname) + path.sep)) throw new Error("fixture escaped tests directory");
    rmSync(root, { recursive: true, force: true });
  }
});
const policies = { T1: "on_free_exhaustion", T2: "on_free_exhaustion", T3: "on_free_exhaustion", T4: "never" };
const parse = (extra = {}) => ConfigSchema.parse({ version: 1, profiles: {}, ...extra });

describe("cost-first paid defaults", () => {
  it("initializes four worker and repository writer slots while retaining explicit limits", () => {
    expect(parse().execution).toMatchObject({ max_concurrent_tasks: 4, max_concurrent_writers_per_repository: 4 });
    expect(parse({ execution: { max_concurrent_tasks: 1, max_concurrent_writers_per_repository: 1 } }).execution)
      .toMatchObject({ max_concurrent_tasks: 1, max_concurrent_writers_per_repository: 1 });
    for (const preset of ["claude-code", "standalone-free", "standalone-hybrid", "standalone-paid"]) {
      const cfg = ConfigSchema.parse(YAML.parse(readFileSync(path.resolve(import.meta.dirname, `../examples/presets/${preset}.yaml`), "utf8")));
      expect(cfg.execution).toMatchObject({ max_concurrent_tasks: 4, max_concurrent_writers_per_repository: 4 });
    }
  });
  it("defaults to bounded paid routing, including the standalone supervisor", () => {
    const cfg = parse();
    expect(cfg.paid).toMatchObject({ enabled: true, budgets: { per_week_usd: 5 }, tiers: policies, providers: {}, models: [] });
    expect(cfg.supervisor.paid_policy).toBe("on_free_exhaustion");
    expect(parse({ paid: { budgets: {}, tiers: {} } }).paid).toEqual(cfg.paid);
  });
  it("preserves explicit disabled, zero and never choices", () => {
    const cfg = parse({ paid: { enabled: false, budgets: { per_week_usd: 0 }, tiers: { T1: "never", T2: "never", T3: "never", T4: "never" } }, supervisor: { paid_policy: "never" } });
    expect(cfg.paid.enabled).toBe(false);
    expect(cfg.paid.budgets.per_week_usd).toBe(0);
    expect(Object.values(cfg.paid.tiers)).toEqual(["never", "never", "never", "never"]);
    expect(cfg.supervisor.paid_policy).toBe("never");
  });
  it("rejects enabled zero budgets and invalid T4 policies", () => {
    expect(() => parse({ paid: { budgets: { per_week_usd: 0 } } })).toThrow(/weekly paid budget greater than 0/);
    expect(() => parse({ paid: { tiers: { T4: "on_free_exhaustion" } } })).toThrow(/T4 accepts only never or premium/);
  });
  it.each([false, true])("initializes bounded defaults for setup=%s without replacing existing choices", (setup) => {
    const root = mkdtempSync(path.join(import.meta.dirname, ".cost-defaults-"));
    roots.push(root);
    const configPath = path.join(root, "meritrouter.config.yaml");
    initializeConfig({ configPath, project: "demo", setup });
    const cfg = ConfigSchema.parse(YAML.parse(readFileSync(configPath, "utf8")));
    expect(cfg.paid).toMatchObject({ enabled: true, budgets: { per_week_usd: 5 }, tiers: policies });
    expect(cfg.supervisor.paid_policy).toBe("on_free_exhaustion");
    const explicit = YAML.stringify({ version: 1, paid: { enabled: false, budgets: { per_week_usd: 0 } } });
    writeFileSync(configPath, explicit);
    initializeConfig({ configPath, project: "demo", setup });
    expect(readFileSync(configPath, "utf8")).toBe(explicit);
  });
  it("keeps the free-only preset explicitly free-only", () => {
    const cfg = ConfigSchema.parse(YAML.parse(readFileSync(path.resolve(import.meta.dirname, "../examples/presets/standalone-free.yaml"), "utf8")));
    expect(cfg.paid.enabled).toBe(false);
    expect(cfg.paid.budgets.per_week_usd).toBe(0);
    expect(Object.values(cfg.paid.tiers)).toEqual(["never", "never", "never", "never"]);
    expect(cfg.supervisor.paid_policy).toBe("never");
  });
});
