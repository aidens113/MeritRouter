import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
const mock = vi.hoisted(() => ({ calls: [] as string[][], exists: false, running: false, foreign: false, failCreate: false, createdProof: false, spawnProof: false }));
vi.mock("node:child_process", async (original) => {
  const real = await original<typeof import("node:child_process")>();
  const execute = async (_executable: string, args: string[], options: {
    cwd: string;
  }) => {
    const command = args.slice(2);
    mock.calls.push(command);
    if (command[0] === "info")
      return { stdout: JSON.stringify({ ID: "engine", OSType: "linux", Architecture: "x86_64" }) };
    if (command[0] === "image")
      return { stdout: JSON.stringify([{ Id: `sha256:${"d".repeat(64)}`, RepoDigests: [command.at(-1)], Config: { Volumes: null } }]) };
    const file = path.join(options.cwd, "docker-browser-owner.json"), owner = JSON.parse(readFileSync(file, "utf8"));
    if (command[1] === "create") {
      mock.createdProof = owner.phase === "launch_intent" && owner.containerId === null;
      mock.exists = true;
      if (mock.failCreate)
        throw new Error("transport uncertain after daemon create");
      return { stdout: "e".repeat(64) };
    }
    if (command[1] === "inspect") {
      if (!mock.exists)
        throw new Error("missing container");
      const generation = mock.foreign ? "f".repeat(32) : owner.generation;
      // Persisted owner.commandDigest must match generated fixed bridge. Reconstruct argv
      // from the original create invocation rather than invent an available/accepted flag.
      const creation = mock.calls.find(call => call[1] === "create")!;
      return { stdout: JSON.stringify([{ Id: "e".repeat(64), Name: `/${owner.name}`, Image: owner.imageId, Config: { User: owner.config.user, Labels: { "meritrouter.kind": "browser-journey-v1", "meritrouter.project": owner.project, "meritrouter.lab": owner.labId, "meritrouter.check": owner.checkId, "meritrouter.generation": generation }, Entrypoint: [owner.config.node], Cmd: creation.slice(-2), OpenStdin: true, Tty: false }, HostConfig: { NetworkMode: "none", ReadonlyRootfs: true, Privileged: false, CapDrop: ["ALL"], CapAdd: null, SecurityOpt: ["no-new-privileges=true"], Binds: null, Mounts: [], Devices: [], PortBindings: {}, PublishAllPorts: false, PidMode: "", IpcMode: "private", UTSMode: "", CgroupnsMode: "private", UsernsMode: "", PidsLimit: 128, Memory: 1073741824, MemorySwap: 1073741824, NanoCpus: 1000000000, Tmpfs: { "/tmp": "rw,nosuid,nodev,noexec,size=268435456,mode=1777" }, RestartPolicy: { Name: "no" } }, Mounts: [], State: { Running: mock.running }, NetworkSettings: { Networks: { none: {} } } }]) };
    }
    if (command[1] === "stop") {
      mock.running = false;
      return { stdout: "e".repeat(64) };
    }
    if (command[1] === "rm") {
      mock.exists = false;
      return { stdout: "e".repeat(64) };
    }
    throw new Error("unexpected fake engine command");
  };
  const fakeExec = Object.assign(vi.fn(), { [Symbol.for("nodejs.util.promisify.custom")]: execute });
  const spawn = vi.fn((_exe: string, _args: string[], options: {
    cwd: string;
  }) => {
    const owner = JSON.parse(readFileSync(path.join(options.cwd, "docker-browser-owner.json"), "utf8"));
    mock.spawnProof = owner.phase === "created" && owner.containerId === "e".repeat(64);
    mock.running = true;
    return Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), pid: 777 });
  });
  return { ...real, execFile: fakeExec, spawn };
});
import { launchDockerBrowser, recoverDockerBrowser, type OwnedDockerBrowser } from "../src/labs/browser-docker.js";
import type { LabRecord } from "../src/labs/store.js";
let directory: string, lab: LabRecord, browser: OwnedDockerBrowser | undefined;
beforeEach(() => { Object.assign(mock, { calls: [], exists: false, running: false, foreign: false, failCreate: false, createdProof: false, spawnProof: false }); directory = mkdtempSync(path.join(tmpdir(), "mr-journey-owner-")); const root = path.join(directory, "labs", "alpha", "example"); mkdirSync(root, { recursive: true }); lab = { id: "lab", project: "alpha", name: "example", root } as LabRecord; });
afterEach(async () => {
  mock.foreign = false; if (browser)
    await browser.close().catch(() => { }); browser = undefined; rmSync(directory, { recursive: true, force: true });
});
const config = () => ({ backend: "docker_network_none_v1", executable: process.execPath, endpoint: "npipe:////./pipe/dockerDesktopLinuxEngine", image: `fixture/browser@sha256:${"a".repeat(64)}`, browser: "/usr/bin/chromium" });
const file = () => path.join(lab.root, "checks", "lc_fixture", "docker-browser-owner.json");
describe("Docker journey ownership state machine (fake engine, not platform certification)", () => {
  it("persists intent before create and exact created ownership before start; closes only its container", async () => {
    browser = await launchDockerBrowser(lab, "lc_fixture", config(), new AbortController().signal, 5000);
    expect(mock.createdProof).toBe(true);
    expect(mock.spawnProof).toBe(true);
    await browser.assertOwned(new AbortController().signal);
    await browser.close();
    expect(mock.exists).toBe(false);
    expect(JSON.parse(readFileSync(file(), "utf8")).phase).toBe("closed");
  });
  it("does not kill a foreign/rebound generation and retains private reconciliation proof", async () => {
    browser = await launchDockerBrowser(lab, "lc_fixture", config(), new AbortController().signal, 5000);
    mock.foreign = true;
    await expect(browser.close()).rejects.toThrow("owner_mismatch");
    expect(mock.calls.some(call => call[1] === "stop" || call[1] === "rm")).toBe(false);
    expect(JSON.parse(readFileSync(file(), "utf8")).phase).toBe("cleanup_blocked");
    expect(mock.running).toBe(true);
  });
  it("reconciles a daemon-created container after lost create response instead of duplicate create", async () => {
    mock.failCreate = true;
    await expect(launchDockerBrowser(lab, "lc_fixture", config(), new AbortController().signal, 5000)).rejects.toThrow();
    expect(mock.calls.filter(call => call[1] === "create")).toHaveLength(1);
    expect(mock.exists).toBe(false);
    expect(JSON.parse(readFileSync(file(), "utf8")).phase).toBe("closed");
  });
  it("defers another live bounded owner and recovers an expired exact generation", async () => {
    browser = await launchDockerBrowser(lab, "lc_fixture", config(), new AbortController().signal, 5000);
    const before = mock.calls.length;
    await recoverDockerBrowser(lab, "lc_fixture");
    expect(mock.calls).toHaveLength(before);
    const owner = JSON.parse(readFileSync(file(), "utf8"));
    owner.deadlineAt = owner.createdAt;
    writeFileSync(file(), JSON.stringify(owner));
    await recoverDockerBrowser(lab, "lc_fixture");
    expect(mock.running).toBe(false);
    expect(mock.exists).toBe(false);
    expect(JSON.parse(readFileSync(file(), "utf8")).phase).toBe("closed");
  });
});
