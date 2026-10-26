import { describe, expect, it } from "vitest";
import path from "node:path";
import { tmpdir } from "node:os";
import { parseConfig } from "../src/config/load.js";
import { ProjectRegistry } from "../src/projects/registry.js";
import { baseConfig } from "./helpers.js";

const configPath = path.join(tmpdir(), "meritrouter-directory-contract", "config.yaml");
const baseDir = path.dirname(configPath);
const multi = (projects: Record<string, unknown>) => ({ ...baseConfig(), repositories: {}, projects });

describe("project owner directory configuration (metadata only)", () => {
  it("resolves explicit multi-repository ownership against config, exposes it without changing storage", () => {
    const cfg = parseConfig(multi({ alpha: { directory: "projects/alpha", repositories: { app: { path: "code/app" }, lib: { path: "code/lib" } } } }), configPath);
    const ctx = new ProjectRegistry(cfg).require("alpha");
    expect(ctx.projectDirectory).toBe(path.resolve(baseDir, "projects/alpha"));
    expect(ctx.storageDir).toBe(cfg.storageDir);
    expect(ctx.repositoryPaths.app!.path).toBe(path.resolve(baseDir, "code/app"));
  });

  it("defaults a single distinct repository even with two aliases", () => {
    const cfg = parseConfig(multi({ alpha: { repositories: { app: { path: "code" }, duplicate: { path: "./code" } } } }), configPath);
    expect(new ProjectRegistry(cfg).require("alpha").projectDirectory).toBe(path.resolve(baseDir, "code"));
  });

  it("keeps ambiguous multi-repository and empty legacy ownership null", () => {
    const cfg = parseConfig(multi({ alpha: { repositories: { app: { path: "a" }, lib: { path: "b" } } }, beta: {} }), configPath);
    const reg = new ProjectRegistry(cfg);
    expect(reg.require("alpha").projectDirectory).toBeNull();
    expect(reg.require("beta").projectDirectory).toBeNull();
    const legacy = parseConfig({ ...baseConfig(), repositories: {} }, configPath);
    expect(new ProjectRegistry(legacy).primary.projectDirectory).toBeNull();
  });

  it("infers legacy single-repository owner and preserves existing project identity shape", () => {
    const cfg = parseConfig({ ...baseConfig(), repositories: { app: { path: "code" } } }, configPath);
    const ctx = new ProjectRegistry(cfg).primary;
    expect(ctx.projectDirectory).toBe(path.resolve(baseDir, "code"));
    expect(ctx.project).toEqual({ slug: "demo", name: "demo", legacy: true });
  });

  it.each(["", "   ", "bad\u0000directory", "bad\ndirectory"])("rejects invalid explicit owner %j", (directory) => {
    expect(() => parseConfig(multi({ alpha: { directory } }), configPath)).toThrow(/directory/);
  });

  it.each(["project", "project/child", "."])("rejects conflicting explicit owners: %s", (other) => {
    expect(() => parseConfig(multi({ alpha: { directory: "project" }, beta: { directory: other } }), configPath)).toThrow(/ownership overlaps/);
  });

  it("rejects explicit overlap with an inferred owner but keeps existing inferred ambiguity compatible", () => {
    expect(() => parseConfig(multi({ alpha: { directory: "project" }, beta: { repositories: { app: { path: "project/nested" } } } }), configPath)).toThrow(/ownership overlaps/);
    expect(() => parseConfig(multi({ alpha: { repositories: { app: { path: "shared" } } }, beta: { repositories: { app: { path: "shared" } } } }), configPath)).not.toThrow();
  });

  it("retains context identity on refresh and qualification has no project owner", () => {
    const cfg = parseConfig(multi({ alpha: { directory: "alpha" } }), configPath);
    const reg = new ProjectRegistry(cfg);
    const ctx = reg.require("alpha");
    reg.refresh();
    expect(reg.require("alpha")).toBe(ctx);
    expect(ctx.projectDirectory).toBe(path.resolve(baseDir, "alpha"));
    expect(reg.qualification.projectDirectory).toBeNull();
  });

  it("keeps per-project ownership separate and applies metadata refresh without relocating storage", () => {
    const cfg = parseConfig(multi({ alpha: { directory: "alpha" }, beta: { directory: "beta" } }), configPath);
    const reg = new ProjectRegistry(cfg);
    const alpha = reg.require("alpha");
    const beta = reg.require("beta");
    cfg.projectResolution.projects.find((p) => p.slug === "alpha")!.directory = path.resolve(baseDir, "renamed-alpha");
    reg.refresh();
    expect(alpha.projectDirectory).toBe(path.resolve(baseDir, "renamed-alpha"));
    expect(beta.projectDirectory).toBe(path.resolve(baseDir, "beta"));
    expect(reg.qualification.projectDirectory).toBeNull();
    expect(alpha.storageDir).toBe(cfg.storageDir);
  });
});
