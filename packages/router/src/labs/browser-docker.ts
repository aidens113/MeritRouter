import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { DockerBrowserConfigSchema, type DockerBrowserConfig } from "./browser-journey-schema.js";
import { browserCheckDirectory } from "./browser-artifacts.js";
import type { LabRecord } from "./store.js";
import { assertLabEffect } from "./control-authority.js";
import { productDigest } from "../verification/product-spec.js";
import { runProcess } from "../runners/coding/process.js";
const exec = promisify(execFile);
const ID = z.string().regex(/^[a-f0-9]{64}$/), ImageID = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const Engine = z.object({ ID: z.string().min(1).max(200), OSType: z.literal("linux"), Architecture: z.string().min(1).max(100) });
const Image = z.array(z.object({ Id: ImageID, RepoDigests: z.array(z.string()), Config: z.object({ Volumes: z.record(z.string(), z.unknown()).nullable().optional() }) })).length(1);
const Owner = z.object({ version: z.literal(1), project: z.string(), labId: z.string(), checkId: z.string(), generation: z.string().regex(/^[a-f0-9]{32}$/), name: z.string().regex(/^mr-browser-[a-f0-9]{32}$/), engineId: z.string().min(1), imageId: ImageID, commandDigest: z.string().regex(/^[a-f0-9]{64}$/), config: DockerBrowserConfigSchema, containerId: ID.nullable(), phase: z.enum(["launch_intent", "created", "running", "closed", "cleanup_blocked"]), createdAt: z.number().int(), deadlineAt: z.number().int(), updatedAt: z.number().int() }).strict().refine(value => value.deadlineAt >= value.createdAt && value.deadlineAt <= value.createdAt + 90000, "Browser owner deadline must be bounded");
type Owner = z.infer<typeof Owner>;
/** Docker daemon/executable/image are trusted human configuration; no registry pull or host mount occurs. */
export class DockerBrowserError extends Error {
  constructor(readonly code: string) { super(code); this.name = "DockerBrowserError"; }
}
function environment(directory: string): Record<string, string> { return { PATH: process.env.PATH ?? "", ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), HOME: directory, USERPROFILE: directory, DOCKER_CONFIG: directory }; }
async function command(config: DockerBrowserConfig, args: string[], directory: string, signal?: AbortSignal): Promise<string> {
  try {
    return (await exec(config.executable, ["--host", config.endpoint, ...args], { cwd: directory, env: environment(directory), windowsHide: true, shell: false, maxBuffer: 2 * 1024 * 1024, timeout: 30000, ...(signal ? { signal } : {}) })).stdout;
  }
  catch {
    throw new DockerBrowserError(signal?.aborted ? "browser_docker_cancelled" : "browser_docker_command_failed");
  }
}
export async function probeDockerBrowser(configInput: unknown, directory: string, signal?: AbortSignal) {
  const config = DockerBrowserConfigSchema.parse(configInput);
  if (!existsSync(config.executable))
    throw new DockerBrowserError("browser_docker_executable_unavailable");
  const engine = Engine.parse(JSON.parse(await command(config, ["info", "--format", "{{json .}}"], directory, signal)));
  const image = Image.parse(JSON.parse(await command(config, ["image", "inspect", config.image], directory, signal)))[0]!;
  if (!image.RepoDigests.includes(config.image) || Object.keys(image.Config.Volumes ?? {}).length)
    throw new DockerBrowserError("browser_docker_image_unapproved");
  return { status: "eligible" as const, engineId: engine.ID, imageId: image.Id, architecture: engine.Architecture, config };
}
function labels(owner: Pick<Owner, "project" | "labId" | "checkId" | "generation">) { return { "meritrouter.kind": "browser-journey-v1", "meritrouter.project": owner.project, "meritrouter.lab": owner.labId, "meritrouter.check": owner.checkId, "meritrouter.generation": owner.generation }; }
function save(file: string, owner: Owner) { Owner.parse(owner); writeFileSync(file + ".tmp", JSON.stringify({ ...owner, updatedAt: Date.now() }), { mode: 0o600 }); renameSync(file + ".tmp", file); }
/** Strict inspection verifies actual daemon state, never a serialized 'available' flag. */
export function verifyDockerBrowserInspection(raw: unknown, ownerInput: unknown): {
  id: string;
  running: boolean;
} {
  const owner = Owner.parse(ownerInput);
  const record = z.array(z.object({ Id: ID, Name: z.string(), Image: ImageID, Config: z.object({ User: z.string(), Labels: z.record(z.string(), z.string()), Entrypoint: z.array(z.string()).nullable(), Cmd: z.array(z.string()).nullable(), OpenStdin: z.boolean(), Tty: z.boolean() }), HostConfig: z.object({ NetworkMode: z.literal("none"), ReadonlyRootfs: z.literal(true), Privileged: z.literal(false), CapDrop: z.array(z.string()), CapAdd: z.array(z.string()).nullable(), SecurityOpt: z.array(z.string()), Binds: z.array(z.string()).nullable(), Mounts: z.array(z.unknown()).nullable().optional(), Devices: z.array(z.unknown()).nullable(), PortBindings: z.record(z.string(), z.unknown()).nullable(), PublishAllPorts: z.literal(false), PidMode: z.string(), IpcMode: z.string(), UTSMode: z.string(), CgroupnsMode: z.literal("private"), UsernsMode: z.literal(""), PidsLimit: z.number(), Memory: z.number(), MemorySwap: z.number(), NanoCpus: z.number(), Tmpfs: z.record(z.string(), z.string()), RestartPolicy: z.object({ Name: z.literal("no") }) }), Mounts: z.array(z.object({ Type: z.string(), Destination: z.string() })), State: z.object({ Running: z.boolean() }), NetworkSettings: z.object({ Networks: z.record(z.string(), z.unknown()) }) })).length(1).parse(raw)[0]!;
  if (record.Name !== `/${owner.name}` || owner.containerId && record.Id !== owner.containerId || record.Image !== owner.imageId || record.Config.User !== owner.config.user || !record.Config.OpenStdin || record.Config.Tty || record.Config.Entrypoint?.join("\0") !== owner.config.node || !record.Config.Cmd || productDigest(record.Config.Cmd) !== owner.commandDigest)
    throw new DockerBrowserError("browser_docker_identity_mismatch");
  for (const [key, value] of Object.entries(labels(owner)))
    if (record.Config.Labels[key] !== value)
      throw new DockerBrowserError("browser_docker_owner_mismatch");
  const host = record.HostConfig;
  const tmpfs = host.Tmpfs["/tmp"]?.split(",") ?? [];
  if (!["rw", "nosuid", "nodev", "noexec", "size=268435456", "mode=1777"].every(flag => tmpfs.includes(flag)) || tmpfs.length !== 6)
    throw new DockerBrowserError("browser_docker_tmpfs_mismatch");
  if (host.CapDrop.length !== 1 || host.CapDrop[0] !== "ALL" || host.CapAdd?.length || host.Binds?.length || host.Mounts?.length || host.Devices?.length || Object.keys(host.PortBindings ?? {}).length || host.PidMode !== "" || !["private", ""].includes(host.IpcMode) || host.UTSMode !== "" || host.PidsLimit !== 128 || host.Memory !== 1073741824 || host.MemorySwap !== 1073741824 || host.NanoCpus !== 1000000000 || Object.keys(host.Tmpfs).join() !== "/tmp" || !host.SecurityOpt.some(value => /^no-new-privileges(?::true|=true)?$/.test(value)) || host.SecurityOpt.some(value => /unconfined|privileged/.test(value)) || record.Mounts.some(mount => mount.Type !== "tmpfs" || !["/tmp", "/dev/shm"].includes(mount.Destination)) || Object.keys(record.NetworkSettings.Networks).some(network => network !== "none"))
    throw new DockerBrowserError("browser_docker_containment_mismatch");
  return { id: record.Id, running: record.State.Running };
}
/** Trusted fixed bridge: Chrome receives only CDP bytes, no model JavaScript or host path. */
function bridge(browser: string, deadlineMs: number): string { return `const{spawn}=require('node:child_process');const child=spawn(${JSON.stringify(browser)},['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-extensions','--disable-background-networking','--disable-component-update','--disable-sync','--disable-quic','--disable-breakpad','--no-pings','--disable-dev-shm-usage','--user-data-dir=/tmp/profile','--remote-debugging-pipe','about:blank'],{stdio:['ignore','ignore','inherit','pipe','pipe'],env:{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:'/tmp',TMPDIR:'/tmp',LANG:'C.UTF-8'}});process.stdin.pipe(child.stdio[3]);child.stdio[4].pipe(process.stdout);process.stdin.on('end',()=>process.exit(125));process.stdout.on('error',()=>process.exit(125));child.on('error',()=>process.exit(126));child.on('exit',code=>process.exit(code??127));setTimeout(()=>process.exit(124),${deadlineMs}).unref();`; }
export function dockerBrowserBridgeDigest(configInput: unknown, deadlineMs: number): string {
  const config = DockerBrowserConfigSchema.parse(configInput);
  z.number().int().min(1000).max(90000).parse(deadlineMs);
  return productDigest(["-e", bridge(config.browser, deadlineMs)]);
}
export function dockerBrowserCreateArgs(ownerInput: unknown, deadlineMs: number): string[] {
  const owner = Owner.parse(ownerInput);
  if (!Number.isInteger(deadlineMs) || deadlineMs < 1000 || deadlineMs > 90000)
    throw new DockerBrowserError("browser_docker_deadline_invalid");
  const args = ["container", "create", "--pull=never", "--name", owner.name, "--interactive", "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges=true", "--pids-limit", "128", "--memory", "1073741824", "--memory-swap", "1073741824", "--cpus", "1", "--ipc", "private", "--cgroupns", "private", "--restart", "no", "--no-healthcheck", "--init", "--log-driver", "none", "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=268435456,mode=1777", "--user", owner.config.user, "--workdir", "/tmp", ...Object.entries(labels(owner)).flatMap(([key, value]) => ["--label", `${key}=${value}`]), "--entrypoint", owner.config.node, owner.config.image, "-e", bridge(owner.config.browser, deadlineMs)];
  if (productDigest(args.slice(-2)) !== owner.commandDigest)
    throw new DockerBrowserError("browser_docker_bridge_mismatch");
  return args;
}
async function inspect(owner: Owner, directory: string, signal?: AbortSignal) {
  const engine = Engine.parse(JSON.parse(await command(owner.config, ["info", "--format", "{{json .}}"], directory, signal)));
  if (engine.ID !== owner.engineId)
    throw new DockerBrowserError("browser_docker_engine_changed");
  return verifyDockerBrowserInspection(JSON.parse(await command(owner.config, ["container", "inspect", owner.containerId ?? owner.name], directory, signal)), owner);
}
async function closeOwner(owner: Owner, file: string): Promise<void> {
  if (owner.phase === "closed")
    return;
  const persisted = Owner.parse(JSON.parse(readFileSync(file, "utf8")));
  if (persisted.generation !== owner.generation || persisted.engineId !== owner.engineId || persisted.imageId !== owner.imageId)
    throw new DockerBrowserError("browser_docker_owner_changed");
  if (persisted.phase === "closed") {
    owner.phase = "closed";
    return;
  }
  try {
    const current = await inspect(owner, path.dirname(file));
    owner.containerId = current.id;
    if (current.running)
      await command(owner.config, ["container", "stop", "--time", "2", current.id], path.dirname(file));
    if ((await inspect(owner, path.dirname(file))).running)
      throw new DockerBrowserError("browser_docker_stop_unconfirmed");
    await command(owner.config, ["container", "rm", current.id], path.dirname(file));
    owner.phase = "closed";
    save(file, owner);
  }
  catch (error) {
    owner.phase = "cleanup_blocked";
    save(file, owner);
    throw error;
  }
}
export interface OwnedDockerBrowser {
  readonly backend: "docker_network_none_v1";
  readonly generation: string;
  readonly engineId: string;
  readonly imageId: string;
  readonly input: ChildProcessWithoutNullStreams["stdin"];
  readonly output: ChildProcessWithoutNullStreams["stdout"];
  assertOwned(signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
  installFixture(name: string, bytes: Buffer, signal: AbortSignal): Promise<string>;
}
/** Ownership intent is durable before create; exact actual containment is verified before start. */
export async function launchDockerBrowser(lab: LabRecord, checkId: string, configInput: unknown, signal: AbortSignal, deadlineMs: number): Promise<OwnedDockerBrowser> {
  z.number().int().min(1000).max(90000).parse(deadlineMs);
  const directory = browserCheckDirectory(lab, checkId);
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, "docker-browser-owner.json");
  if (existsSync(file))
    throw new DockerBrowserError("browser_docker_generation_exists");
  const candidate = await probeDockerBrowser(configInput, directory, signal), generation = randomBytes(16).toString("hex");
  const createdAt = Date.now();
  const owner: Owner = { version: 1, project: lab.project, labId: lab.id, checkId, generation, name: `mr-browser-${generation}`, engineId: candidate.engineId, imageId: candidate.imageId, commandDigest: dockerBrowserBridgeDigest(candidate.config, deadlineMs), config: candidate.config, containerId: null, phase: "launch_intent", createdAt, deadlineAt: createdAt + deadlineMs, updatedAt: createdAt };
  writeFileSync(file, JSON.stringify(owner), { flag: "wx", mode: 0o600 });
  let attached: ChildProcessWithoutNullStreams | undefined;
  let createIssued = false;
  const close = async () => {
    try {
      await closeOwner(owner, file);
    }
    finally {
      attached?.stdin.destroy();
      attached?.stdout.destroy();
      attached?.stderr.destroy();
    }
  };
  try {
    signal.throwIfAborted();
    assertLabEffect();
    // Do not abort a mutating daemon request mid-transport and pretend its effects vanished.
    createIssued = true;
    owner.containerId = ID.parse((await command(owner.config, dockerBrowserCreateArgs(owner, deadlineMs), directory)).trim());
    owner.phase = "created";
    save(file, owner);
    await inspect(owner, directory, signal);
    signal.throwIfAborted();
    assertLabEffect();
    attached = spawn(owner.config.executable, ["--host", owner.config.endpoint, "container", "start", "--attach", "--interactive", owner.containerId], { cwd: directory, env: environment(directory), windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"] });
    attached.on("error", () => { });
    let diagnostics = 0;
    attached.stderr.on("data", chunk => {
      diagnostics += chunk.length; if (diagnostics > 65536)
        attached?.stdin.destroy();
    });
    owner.phase = "running";
    save(file, owner);
    return {
      backend: "docker_network_none_v1", generation, engineId: owner.engineId, imageId: owner.imageId, input: attached.stdin, output: attached.stdout,
      async assertOwned(active) {
        const current = await inspect(owner, directory, active); if (!current.running)
          throw new DockerBrowserError("browser_docker_not_running");
      },
      async installFixture(name, bytes, active) {
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/.test(name) || bytes.length > 1024 * 1024)
          throw new DockerBrowserError("browser_docker_upload_invalid");
        await inspect(owner, directory, active);
        assertLabEffect();
        const script = "const fs=require('node:fs');let input='';process.stdin.on('data',chunk=>{input+=chunk;if(input.length>1398104)process.exit(2)});process.stdin.on('end',()=>{fs.mkdirSync('/tmp/uploads',{recursive:true});fs.writeFileSync('/tmp/uploads/'+process.argv[1],Buffer.from(input,'base64'),{mode:384,flag:'wx'})});";
        const result = await runProcess(owner.config.executable, ["--host", owner.config.endpoint, "container", "exec", "--interactive", "--user", owner.config.user, owner.containerId!, owner.config.node, "-e", script, name], { cwd: directory, env: environment(directory), timeoutMs: 30000, signal: active, stdin: bytes.toString("base64") });
        if (result.killed || result.exitCode !== 0)
          throw new DockerBrowserError("browser_docker_upload_failed");
        await inspect(owner, directory, active);
        return `/tmp/uploads/${name}`;
      }, close
    };
  }
  catch (error) {
    if (!createIssued) {
      owner.phase = "closed";
      save(file, owner);
    }
    else
      try {
        await close();
      }
      catch {
        throw new DockerBrowserError("browser_docker_cleanup_unverified");
      }
    throw error;
  }
}
/** Recover only private exact generations. Ambiguous/absent mutation outcomes retain proof. */
export async function recoverDockerBrowser(lab: LabRecord, checkId: string): Promise<void> {
  const file = path.join(browserCheckDirectory(lab, checkId), "docker-browser-owner.json");
  if (!existsSync(file))
    return;
  const owner = Owner.parse(JSON.parse(readFileSync(file, "utf8")));
  if (owner.project !== lab.project || owner.labId !== lab.id || owner.checkId !== checkId)
    throw new DockerBrowserError("browser_docker_recovery_scope_denied");
  // A second manager must not kill another live manager's bounded generation.
  if (owner.phase !== "closed" && Date.now() < owner.deadlineAt)
    return;
  await closeOwner(owner, file);
}
