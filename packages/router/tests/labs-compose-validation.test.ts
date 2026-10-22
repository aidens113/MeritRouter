import { afterEach, describe, expect, it } from "vitest";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateComposePlan } from "../src/labs/compose-client.js";
import { composeHash, validateComposeCanonical, ComposeCapabilitiesSchema } from "../src/labs/compose-recipe.js";
import { LabRecipeSchema } from "../src/labs/recipe.js";

let root: string | undefined;
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); root = undefined; });
function fixture() {
  root = mkdtempSync(path.join(tmpdir(), "sy-compose fixture-"));
  const labRoot = path.join(root, "lab"), worktree = path.join(labRoot, "worktree"), data = path.join(labRoot, "data");
  for (const dir of [labRoot, worktree, data, path.join(worktree, "src")]) mkdirSync(dir, { recursive: true });
  const image = "fixture/app@sha256:" + "a".repeat(64);
  const canonical = { name: "sy-fixture-g1", services: { app: { image, command: ["node", "app.js"], environment: { SECRET: "private-value" }, read_only: true, cap_drop: ["ALL"], security_opt: ["no-new-privileges:true"], restart: "no", ports: [{ host_ip: "127.0.0.1", target: 8080, published: "56222", protocol: "tcp", mode: "ingress" }], volumes: [{ type: "bind", source: path.join(worktree, "src"), target: "/app", read_only: true, bind: { create_host_path: false } }], networks: { default: null } } }, networks: { default: { name: "sy-fixture-g1_default", driver: "bridge" } } };
  const manifest = path.join(worktree, "compose.json");
  const source = structuredClone(canonical); source.services.app.environment = {} as typeof source.services.app.environment;
  const text = JSON.stringify(source); writeFileSync(manifest, text);
  const authority = { labRoot, worktree, dataRoots: [data], manifest, manifestSha256: composeHash(text), projectName: canonical.name, services: { app: { image, environment: { SECRET: "private-value" }, ports: [{ published: 56222, target: 8080 }], mounts: [{ source: path.join(worktree, "src"), target: "/app", readOnly: true }] } } };
  const executable = path.join(root, "fake cli & $literal.cjs");
  copyFileSync(fileURLToPath(new URL("./fixtures/compose/fake-cli.cjs", import.meta.url)), executable);
  const save = () => writeFileSync(path.join(root!, "canonical.json"), JSON.stringify(canonical)); save();
  writeFileSync(path.join(root, "mode"), "safe");
  const capabilities = { trustedLocalEngine: true, osType: "linux", engineIdentity: "fixture-engine", composeConfigJson: true, imageInspectJson: true, endpoint: process.platform === "win32" ? "npipe:////./pipe/docker_engine" : "unix:///tmp/fixture-docker.sock" };
  const options = { executable: process.execPath, launcherArgs: [executable], timeoutMs: 10000, maxBytes: 10000 };
  const run = (signal?: AbortSignal) => validateComposePlan(authority, capabilities, options, signal);
  const calls = () => existsSync(path.join(root!, "calls.jsonl")) ? readFileSync(path.join(root!, "calls.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line) as {args:string[]; env:string[]}) : [];
  const authored = (value: unknown) => { const text = JSON.stringify(value); writeFileSync(manifest, text); authority.manifestSha256 = composeHash(text); };
  return { authority, capabilities, options, canonical, run, calls, save, authored, labRoot };
}

describe("Compose read-only validation prerequisite", () => {
  it("validates deterministic private snapshots using only fixed read-only verbs and returns no secrets", async () => {
    const f = fixture(); const one = await f.run(), two = await f.run();
    expect(one).toEqual(two); expect(one).toMatchObject({ runtimeEnabled: false, services: [{ name: "app", mountCount: 1, publishedPorts: [56222] }] });
    expect(JSON.stringify(one)).not.toContain("private-value"); expect(JSON.stringify(one)).not.toContain(f.authority.worktree);
    expect(f.calls()).toHaveLength(4);
    for (const call of f.calls()) { expect(call.args.some(a => ["up", "down", "create", "start", "stop", "rm", "build", "pull", "prune"].includes(a))).toBe(false); expect(call.env).not.toContain("COMPOSE_FILE"); }
    expect(readFileSync(path.join(root!, "snapshot-seen"), "utf8")).toContain("private-value");
    expect(readFileSync(f.authority.manifest, "utf8")).not.toContain("private-value");
    expect(existsSync(readFileSync(path.join(root!, "scratch-seen"), "utf8"))).toBe(false);
    expect(readdirSync(f.labRoot).some(n => n.startsWith(".compose-validation-"))).toBe(false);
    expect(f.calls()[0]!.args).toContain(f.authority.projectName);
    expect(LabRecipeSchema.parse({ services: { app: { repo: "core", command: "node app.js" } } }).services.app).toHaveProperty("command", "node app.js");
  });
  it("rejects imports and unknown security features before any executable invocation", async () => {
    const f = fixture();
    for (const property of ["include", "extends", "env_file", "build", "privileged", "network_mode", "volumes_from", "secrets", "devices", "post_start", "provider"]) {
      const doc = structuredClone(f.canonical) as unknown as Record<string, unknown>;
      if (property === "include") doc.include = "../private.yaml";
      else ((doc.services as Record<string, Record<string, unknown>>).app!)[property] = true;
      f.authored(doc); await expect(f.run()).rejects.toMatchObject({ code: "compose_validation_failed" });
    }
    expect(f.calls()).toHaveLength(0);
  });
  it("escapes private human dollar values without ambient interpolation", async () => {
    const f = fixture(); f.authority.services.app.environment.SECRET = "private-$HOME"; f.canonical.services.app.environment.SECRET = "private-$HOME"; f.save();
    const plan = await f.run();
    expect(readFileSync(path.join(root!, "snapshot-seen"), "utf8")).toContain("private-$$HOME");
    expect(JSON.stringify(plan)).not.toContain("private-");
  });
  it("bounds environment counts, aggregate authority and expanded private snapshot before CLI", async () => {
    const f = fixture(); const original = structuredClone(f.authority.services.app.environment);
    Object.assign(f.authority.services.app.environment, Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`ENV_${i}`, "private-value"])));
    await expect(f.run()).rejects.toMatchObject({ code: "compose_validation_failed" });
    for (const key of Object.keys(f.authority.services.app.environment)) delete (f.authority.services.app.environment as Record<string, string>)[key];
    Object.assign(f.authority.services.app.environment, Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`ENV_${i}`, "x".repeat(65536)])));
    await expect(f.run()).rejects.toMatchObject({ code: "compose_validation_failed" });
    for (const key of Object.keys(f.authority.services.app.environment)) delete (f.authority.services.app.environment as Record<string, string>)[key];
    Object.assign(f.authority.services.app.environment, original, Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`ENV_${i}`, "$".repeat(65536)])));
    await expect(f.run()).rejects.toMatchObject({ code: "compose_private_snapshot_limit" });
    expect(f.calls()).toHaveLength(0); expect(readdirSync(f.labRoot).some(n => n.startsWith(".compose-validation-"))).toBe(false);
  });
  it("rejects authored image, mount and port authority mismatches before config execution", async () => {
    const f = fixture(); const original = structuredClone(f.canonical); original.services.app.environment = {} as typeof original.services.app.environment;
    for (const change of [(v: typeof original) => { v.services.app.image = "other@sha256:" + "a".repeat(64); }, (v: typeof original) => { v.services.app.ports[0]!.published = "56223"; }, (v: typeof original) => { v.services.app.volumes[0]!.source = root!; }]) {
      const source = structuredClone(original); change(source); f.authored(source); await expect(f.run()).rejects.toMatchObject({ code: "compose_validation_failed" });
    }
    expect(f.calls()).toHaveLength(0);
  });
  it("rejects public ports, foreign mounts, unapproved env/image and malformed canonical fields", async () => {
    const f = fixture(); const original = structuredClone(f.canonical);
    for (const change of [(v: typeof original) => { v.services.app.ports[0]!.host_ip = "0.0.0.0"; }, (v: typeof original) => { v.services.app.volumes[0]!.source = root!; }, (v: typeof original) => { v.services.app.environment.SECRET = "other"; }, (v: typeof original) => { v.services.app.image = "other@sha256:" + "a".repeat(64); }]) {
      Object.assign(f.canonical, structuredClone(original)); change(f.canonical); f.save(); await expect(f.run()).rejects.toMatchObject({ code: "compose_validation_failed" });
    }
    expect(f.calls().every(c => c.args.includes("config"))).toBe(true);
  });
  it("rejects approved-but-foreign/symlink mounts, changed source and incompatible prerequisite DTOs", async () => {
    const f = fixture(); f.authority.services.app.mounts[0]!.source = root!; f.canonical.services.app.volumes[0]!.source = root!; f.save();
    await expect(f.run()).rejects.toMatchObject({ code: "compose_validation_failed" });
    const link = path.join(f.authority.worktree, "link"); symlinkSync(root!, link, process.platform === "win32" ? "junction" : "dir");
    f.authority.services.app.mounts[0]!.source = link; f.canonical.services.app.volumes[0]!.source = link; f.save();
    await expect(f.run()).rejects.toMatchObject({ code: "compose_validation_failed" });
    writeFileSync(f.authority.manifest, "changed"); await expect(f.run()).rejects.toMatchObject({ code: "compose_manifest_changed" });
    expect(() => ComposeCapabilitiesSchema.parse({ ...f.capabilities, osType: "windows" })).toThrow();
    expect(() => ComposeCapabilitiesSchema.parse({ ...f.capabilities, endpoint: "tcp://foreign:2375" })).toThrow();
    expect(() => ComposeCapabilitiesSchema.parse({ ...f.capabilities, endpoint: "npipe:////foreign/pipe/docker_engine" })).toThrow();
    expect(() => ComposeCapabilitiesSchema.parse({ ...f.capabilities, endpoint: "unix:///" + "x".repeat(8192) })).toThrow();
  });
  it("rejects image VOLUME, malformed output and bounded output without exposing raw errors", async () => {
    const f = fixture();
    for (const [mode, code] of [["volume", "compose_image_unapproved"], ["invalid", "compose_response_invalid"], ["oversize", "compose_output_limit"], ["fail", "compose_cli_failed"]]) {
      writeFileSync(path.join(root!, "mode"), mode!);
      await expect(f.run()).rejects.toMatchObject({ code });
      expect(readdirSync(f.labRoot).some(n => n.startsWith(".compose-validation-"))).toBe(false);
    }
  }, 30000);
  it("cancels owned fake CLI including its descendant and cleans scratch", async () => {
    const f = fixture(); writeFileSync(path.join(root!, "mode"), "hang"); const abort = new AbortController();
    const pending = f.run(abort.signal);
    const childFile = path.join(root!, "child-pid");
    for (let i = 0; i < 200 && !existsSync(childFile); i++) await new Promise(r => setTimeout(r, 20));
    expect(existsSync(childFile)).toBe(true); const pid = Number(readFileSync(childFile, "utf8"));
    const rejected = expect(pending).rejects.toMatchObject({ code: "compose_cancelled" }); abort.abort(); await rejected;
    expect(() => process.kill(pid, 0)).toThrow();
    expect(readdirSync(f.labRoot).some(n => n.startsWith(".compose-validation-"))).toBe(false);
    const already = new AbortController(); already.abort(); await expect(f.run(already.signal)).rejects.toMatchObject({ code: "compose_cancelled" });
  }, 30000);
  it("bounds time and rejects private authored environment before execution", async () => {
    const f = fixture(); f.authored(f.canonical);
    await expect(f.run()).rejects.toMatchObject({ code: "compose_authored_environment_denied" }); expect(f.calls()).toHaveLength(0);
    const source = structuredClone(f.canonical); source.services.app.environment = {} as typeof source.services.app.environment; f.authored(source);
    writeFileSync(path.join(root!, "mode"), "hang"); f.options.timeoutMs = 300;
    await expect(f.run()).rejects.toMatchObject({ code: "compose_timeout" });
    const childFile = path.join(root!, "child-pid");
    if (existsSync(childFile)) expect(() => process.kill(Number(readFileSync(childFile, "utf8")), 0)).toThrow();
    expect(readdirSync(f.labRoot).some(n => n.startsWith(".compose-validation-"))).toBe(false);
  }, 30000);
});
