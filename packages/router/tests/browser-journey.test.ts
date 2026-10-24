import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BrowserJourneyCheckSchema, DockerBrowserConfigSchema } from "../src/labs/browser-journey-schema.js";
import { executeJourneyStep, type JourneyProtocol } from "../src/labs/browser-journey-dom.js";
import { BrowserCheckSchema } from "../src/labs/browser-schema.js";
import { probeDockerBrowser, dockerBrowserCreateArgs, dockerBrowserBridgeDigest, verifyDockerBrowserInspection } from "../src/labs/browser-docker.js";
import { makeEnv, baseConfig, type Env } from "./helpers.js";
import { openDatabase, type Db } from "../src/storage/db.js";
import { ProjectRegistry } from "../src/projects/registry.js";
import { LabManager } from "../src/labs/lab.js";
import { journeyFixtureDigest, journeySourceSnapshot } from "../src/labs/browser-journey-evidence.js";
import { productDigest } from "../src/verification/product-spec.js";
import { labCheckMatchesHeads } from "../src/labs/checks.js";
let env: Env | undefined, db: Db | undefined, manager: LabManager | undefined;
afterEach(async () => { await manager?.close(); manager = undefined; db?.close(); db = undefined; env?.cleanup(); env = undefined; });
const config = () => ({ backend: "docker_network_none_v1", executable: process.execPath, endpoint: "npipe:////./pipe/dockerDesktopLinuxEngine", image: `fixture/browser@sha256:${"a".repeat(64)}`, browser: "/usr/bin/chromium" });
const journey = (over: Record<string, unknown> = {}) => ({ kind: "browser", mode: "interactive", service: "web", isolation: config(), specDigest: "b".repeat(64), steps: [{ id: "ready", criterionIds: ["primary"], action: "wait_for", assertion: { kind: "exists", selector: "#ready" } }], ...over });
function owner() { const trusted = DockerBrowserConfigSchema.parse(config()); return { version: 1, project: "alpha", labId: "lab", checkId: "lc_fixture", generation: "c".repeat(32), name: `mr-browser-${"c".repeat(32)}`, engineId: "engine", imageId: `sha256:${"d".repeat(64)}`, commandDigest: dockerBrowserBridgeDigest(trusted, 5000), config: trusted, containerId: "e".repeat(64), phase: "running", createdAt: 0, deadlineAt: 5000, updatedAt: 0 }; }
function inspection() { const own = owner(), args = dockerBrowserCreateArgs(own, 5000); return [{ Id: own.containerId, Name: `/${own.name}`, Image: own.imageId, Config: { User: own.config.user, Labels: { "meritrouter.kind": "browser-journey-v1", "meritrouter.project": "alpha", "meritrouter.lab": "lab", "meritrouter.check": "lc_fixture", "meritrouter.generation": own.generation }, Entrypoint: [own.config.node], Cmd: args.slice(-2), OpenStdin: true, Tty: false }, HostConfig: { NetworkMode: "none", ReadonlyRootfs: true, Privileged: false, CapDrop: ["ALL"], CapAdd: null, SecurityOpt: ["no-new-privileges=true"], Binds: null, Mounts: [], Devices: [], PortBindings: {}, PublishAllPorts: false, PidMode: "", IpcMode: "private", UTSMode: "", CgroupnsMode: "private", UsernsMode: "", PidsLimit: 128, Memory: 1073741824, MemorySwap: 1073741824, NanoCpus: 1000000000, Tmpfs: { "/tmp": "rw,nosuid,nodev,noexec,size=268435456,mode=1777" }, RestartPolicy: { Name: "no" } }, Mounts: [], State: { Running: true }, NetworkSettings: { Networks: { none: {} } } }]; }
describe("Interactive journey contract and negative controls", () => {
  it("requires actual inputs/observable criterion assertions and rejects script/URL/host authority expansion", () => {
    expect(BrowserJourneyCheckSchema.parse(journey()).mode).toBe("interactive");
    for (const over of [{ evaluate: "arbitrary()" }, { path: "//foreign/" }, { steps: [{ id: "click", criterionIds: ["primary"], action: "click", selector: "button" }] }, { isolation: { ...config(), image: "browser:latest" } }, { isolation: { ...config(), endpoint: "tcp://foreign:2375" } }, { isolation: { ...config(), user: "0:0" } }, { steps: [{ id: "fake", criterionIds: ["primary"], action: "evaluate", script: "true" }] }])
      expect(() => BrowserJourneyCheckSchema.parse(journey(over))).toThrow();
    expect(() => BrowserCheckSchema.parse({ ...journey(), mode: "static" })).toThrow();
  });
  it("uses actual input events and an inert control fails its observable postcondition", async () => {
    const methods: string[] = [], state = { hydrated: true, value: "", message: "empty" };
    const client: JourneyProtocol = {
      async call(method, args) {
        methods.push(method); if (method === "DOM.getDocument")
          return { root: { nodeId: 1 } }; if (method === "DOM.querySelector")
          return { nodeId: 2 }; if (method === "DOM.getBoxModel")
          return { model: { content: [0, 0, 100, 0, 100, 40, 0, 40] } }; if (method === "Input.insertText")
          state.value = String(args!.text); if (method === "Input.dispatchMouseEvent" && args!.type === "mouseReleased" && state.hydrated)
          state.message = state.value; if (method === "DOM.describeNode")
          return { node: { nodeType: 1, nodeValue: "", children: [{ nodeType: 3, nodeValue: state.message }] } }; return {};
      }
    };
    const signal = new AbortController().signal;
    await executeJourneyStep(client, "page", { id: "fill", criterionIds: ["primary"], action: "fill", selector: "input", text: "changed" }, "http://127.0.0.1:5100", signal);
    await executeJourneyStep(client, "page", { id: "click", criterionIds: ["primary"], action: "click", selector: "button" }, "http://127.0.0.1:5100", signal);
    const assertion = { id: "assert", criterionIds: ["primary"], action: "assert" as const, assertion: { kind: "text_contains" as const, selector: "#message", text: "changed" } };
    await expect(executeJourneyStep(client, "page", assertion, "http://127.0.0.1:5100", signal)).resolves.toBeUndefined();
    state.hydrated = false;
    state.message = "empty";
    await executeJourneyStep(client, "page", { id: "click", criterionIds: ["primary"], action: "click", selector: "button" }, "http://127.0.0.1:5100", signal);
    await expect(executeJourneyStep(client, "page", assertion, "http://127.0.0.1:5100", signal)).rejects.toThrow("assertion_failed");
    expect(methods).toContain("Input.insertText");
    expect(methods).not.toContain("Runtime.evaluate");
    await expect(executeJourneyStep(client, "page", { id: "escape", criterionIds: ["primary"], action: "navigate", path: "//foreign/" }, "http://127.0.0.1:5100", signal)).rejects.toThrow("scope_denied");
  });
  it("generates shell-free immutable no-network/no-host-mount launch and rejects tampered actual inspection", () => {
    const own = owner(), args = dockerBrowserCreateArgs(own, 5000);
    expect(args).toContain("--pull=never");
    expect(args).toContain("--read-only");
    expect(args).not.toContain("--no-sandbox");
    expect(args).not.toContain("--mount");
    expect(verifyDockerBrowserInspection(inspection(), own)).toEqual({ id: own.containerId, running: true });
    for (const mutate of [(value: any) => value[0].HostConfig.NetworkMode = "host", (value: any) => value[0].HostConfig.Binds = ["/:/host"], (value: any) => value[0].HostConfig.CapAdd = ["SYS_ADMIN"], (value: any) => value[0].Config.Labels["meritrouter.generation"] = "f".repeat(32), (value: any) => value[0].Config.Cmd = ["-e", "arbitrary"], (value: any) => value[0].Image = `sha256:${"f".repeat(64)}`]) {
      const actual = inspection();
      mutate(actual);
      expect(() => verifyDockerBrowserInspection(actual, own)).toThrow();
    }
  });
  it("does not turn an absent Docker executable into an available browser", async () => {
    env = makeEnv();
    await expect(probeDockerBrowser({ ...config(), executable: path.join(env.dir, "missing-docker.exe") }, env.dir)).rejects.toThrow("executable_unavailable");
  });
  it("runs through real Lab check dispatch and persists unavailable evidence without launching host Chrome", async () => {
    const appConfig = baseConfig({
      repositories: {}, brain: { path: "brain", project: "alpha" },
      projects: {
        alpha: {
          repositories: { app: { path: "repo" } }, lab: {
            ports: ["web"], env: { PORT: "{port.web}" },
            services: { web: { repo: "app", command: `"${process.execPath}" server.cjs`, ready: { http: "http://127.0.0.1:{port.web}/" } } },
            checks: { journey: journey({ isolation: { ...config(), executable: path.join(process.cwd(), "missing-docker.exe") } }) }
          }
        }
      }
    });
    env = makeEnv({ config: appConfig, files: { "server.cjs": "require('node:http').createServer((req,res)=>res.end('<h1 id=ready>fixture</h1>')).listen(Number(process.env.PORT),'127.0.0.1');" } });
    db = openDatabase(env.cfg.storageDir);
    const registry = new ProjectRegistry(env.cfg);
    manager = new LabManager({ db, cfg: env.cfg, storageDir: env.cfg.storageDir, project: slug => registry.require(slug), monitor: false });
    await manager.create("alpha", "journey");
    await manager.start("alpha", "journey");
    const result = await manager.check("alpha", "journey", "journey");
    expect(result.exitCode).toBe(1);
    expect(result.journey).toMatchObject({ status: "unavailable", scriptsEnabled: false, isolation: null, cleanup: "complete" });
    expect(result.browser).toBeUndefined();
    expect(result.journey!.heads.app).toBe(result.revision);
    expect(labCheckMatchesHeads(result, { app: result.revision })).toBe(true);
    expect(labCheckMatchesHeads(result, { app: "0".repeat(40) })).toBe(false);
    const lab = manager.status("alpha", "journey").lab, snapshot = await journeySourceSnapshot(lab, new AbortController().signal);
    expect(snapshot.trees.app).toMatch(/^[a-f0-9]{40}$/);
    mkdirSync(path.join(lab.root, "data", "fixture"), { recursive: true });
    lab.recipe.data = ["fixture"];
    writeFileSync(path.join(lab.root, "data", "fixture", "state"), "one");
    const before = await journeyFixtureDigest(lab, new AbortController().signal);
    writeFileSync(path.join(lab.root, "data", "fixture", "state"), "two");
    expect(await journeyFixtureDigest(lab, new AbortController().signal)).not.toBe(before);
    expect(before).not.toBe(productDigest({}));
    expect(existsSync(path.join(lab.root, "checks", result.id, "profile"))).toBe(false);
  }, 20000);
});
