import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import YAML from "yaml";
import { randomBytes } from "node:crypto";
import { HOST_MARKER, stopOwnedProcess } from "./process-ownership.js";
import { ComposeAuthoritySchema, ComposeCapabilitiesSchema, ComposeValidationPlanSchema, composeCanonicalHash, composeHash, composeOwnedPath, validateComposeAuthored, validateComposeCanonical } from "./compose-recipe.js";

const OptionsSchema = z.object({
  executable: z.string().refine(v => path.isAbsolute(v)),
  // Trusted injection seam for a fake executable, not model/config tool input.
  launcherArgs: z.array(z.string().max(8192)).max(4).default([]),
  timeoutMs: z.number().int().min(10).max(120000).default(30000),
  maxBytes: z.number().int().min(128).max(2 * 1024 * 1024).default(1024 * 1024),
}).strict();
export type ComposeClientOptions = z.input<typeof OptionsSchema>;
const ImageInspectSchema = z.array(z.object({
  Id: z.string().regex(/^sha256:[a-f0-9]{64}$/), RepoDigests: z.array(z.string().max(500)),
  Config: z.object({ Volumes: z.record(z.string(), z.unknown()).nullable().optional() }),
})).length(1);
const CLI_WRAPPER = `// ${HOST_MARKER}
const{spawn}=require('node:child_process');
const{executable,args}=JSON.parse(process.env.MERITROUTER_COMPOSE_READONLY);
delete process.env.MERITROUTER_COMPOSE_READONLY;
const child=spawn(executable,args,{shell:false,windowsHide:true,stdio:'inherit',env:process.env});
let exitCode=1;
child.on('error',()=>{if(process.send)process.send({finished:true})});
child.on('close',code=>{exitCode=code===null?1:code;if(process.send)process.send({finished:true})});
process.on('message',m=>{if(m&&m.release)process.exit(exitCode)});`;

/** Errors intentionally omit argv, manifests, stdout/stderr and configured private values. */
export class ComposeValidationError extends Error {
  constructor(readonly code: string) { super(code); this.name = "ComposeValidationError"; }
}

const abortedCode = (signal?: AbortSignal) => signal?.reason?.name === "TimeoutError" ? "compose_timeout" : "compose_cancelled";
async function readonlyCommand(options: z.infer<typeof OptionsSchema>, args: string[], cwd: string, budget: { remaining: number }, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) throw new ComposeValidationError(abortedCode(signal));
  return new Promise((resolve, reject) => {
    // No shell, inherited COMPOSE/DOCKER settings or registry credential directory.
    const token = randomBytes(24).toString("hex");
    const child = spawn(process.execPath, ["-e", CLI_WRAPPER, "--", `--sy-lab-token=${token}`], {
      cwd, windowsHide: true, shell: false, detached: process.platform !== "win32",
      env: { PATH: process.env.PATH ?? "", ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), HOME: cwd, USERPROFILE: cwd, DOCKER_CONFIG: cwd,
        MERITROUTER_COMPOSE_READONLY: JSON.stringify({ executable: options.executable, args: [...options.launcherArgs, ...args] }) },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    let stdout = "", bytes = 0, failure: string | undefined, stopping: Promise<void> | undefined;
    const stop = (code: string) => {
      failure ??= code;
      // Shared positive wrapper/token + process birth proof, including plugin descendants.
      if (!stopping && child.pid) stopping = stopOwnedProcess(child.pid, token, path.join(cwd, "cli-process.json")).catch(() => {
        failure = "compose_cleanup_unverified";
        cleanup();
        child.stdout?.destroy(); child.stderr?.destroy();
        if (child.connected) child.disconnect();
        child.unref();
        reject(new ComposeValidationError(failure));
      });
    };
    const timer = setTimeout(() => stop("compose_timeout"), options.timeoutMs);
    const abort = () => stop(abortedCode(signal));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout!.on("data", chunk => { bytes += chunk.length; budget.remaining -= chunk.length; if (bytes > options.maxBytes || budget.remaining < 0) stop("compose_output_limit"); else stdout += chunk.toString("utf8"); });
    child.stderr!.on("data", chunk => { bytes += chunk.length; budget.remaining -= chunk.length; if (bytes > options.maxBytes || budget.remaining < 0) stop("compose_output_limit"); });
    child.on("message", async () => {
      // Keep the ownership wrapper alive until output-limit/cancellation cleanup completes.
      await new Promise(resolve => setTimeout(resolve, 20));
      await stopping;
      if (child.connected) child.send({ release: true }, () => {});
    });
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
    child.once("error", () => { cleanup(); reject(new ComposeValidationError("compose_cli_unavailable")); });
    child.once("close", async code => { cleanup(); await stopping; if (failure) reject(new ComposeValidationError(failure)); else if (code !== 0) reject(new ComposeValidationError("compose_cli_failed")); else resolve(stdout); });
  });
}

/** C1 validates only. There is deliberately no create/start/stop/down execution method. */
export async function validateComposePlan(authorityInput: unknown, capabilitiesInput: unknown, optionsInput: ComposeClientOptions, signal?: AbortSignal) {
  let scratch: string | undefined;
  try {
    const authority = ComposeAuthoritySchema.parse(authorityInput);
    const capabilities = ComposeCapabilitiesSchema.parse(capabilitiesInput);
    const options = OptionsSchema.parse(optionsInput);
    const deadline = AbortSignal.timeout(options.timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const budget = { remaining: options.maxBytes };
    if (path.resolve(authority.labRoot) === path.resolve(authority.worktree) || authority.dataRoots.some(root => path.resolve(root) === path.resolve(authority.labRoot))) throw new ComposeValidationError("compose_path_denied");
    composeOwnedPath(authority.labRoot, authority.worktree);
    for (const root of authority.dataRoots) composeOwnedPath(authority.labRoot, root);
    const manifest = composeOwnedPath(authority.worktree, authority.manifest);
    if (!statSync(manifest).isFile() || statSync(manifest).size > 1024 * 1024) throw new ComposeValidationError("compose_manifest_invalid");
    const bytes = readFileSync(manifest);
    if (composeHash(bytes) !== authority.manifestSha256) throw new ComposeValidationError("compose_manifest_changed");
    validateComposeAuthored(bytes.toString("utf8"));
    const authored = z.object({ services: z.record(z.string(), z.object({ environment: z.record(z.string(), z.string()).optional() }).passthrough()) }).passthrough().parse(YAML.parse(bytes.toString("utf8")));
    if (Object.keys(authored.services).sort().join("\0") !== Object.keys(authority.services).sort().join("\0")) throw new ComposeValidationError("compose_authority_mismatch");
    for (const [name, service] of Object.entries(authored.services)) {
      if (Object.keys(service.environment ?? {}).length) throw new ComposeValidationError("compose_authored_environment_denied");
      // Private human config stays out of the model-readable source manifest.
      service.environment = authority.services[name]!.environment;
    }
    authored.name = authority.projectName;
    // Reject image/mount/port authority violations before even the read-only subprocess.
    validateComposeCanonical(authored, authority);
    for (const service of Object.values(authored.services)) service.environment = Object.fromEntries(Object.entries(service.environment ?? {}).map(([key, value]) => [key, value.replaceAll("$", () => "$$")]));
    const privateSnapshot = JSON.stringify(authored);
    if (Buffer.byteLength(privateSnapshot) > 1024 * 1024) throw new ComposeValidationError("compose_private_snapshot_limit");
    scratch = mkdtempSync(path.join(authority.labRoot, ".compose-validation-"));
    const snapshot = path.join(scratch, "compose.yaml"), envFile = path.join(scratch, "empty.env");
    writeFileSync(snapshot, privateSnapshot, { mode: 0o600, flag: "wx" });
    writeFileSync(envFile, "", { mode: 0o600, flag: "wx" });
    const raw = await readonlyCommand(options, ["--host", capabilities.endpoint, "compose", "--project-name", authority.projectName, "--project-directory", scratch, "--env-file", envFile, "-f", snapshot, "config", "--format", "json"], scratch, budget, requestSignal);
    let canonical: unknown;
    try { canonical = JSON.parse(raw); } catch { throw new ComposeValidationError("compose_response_invalid"); }
    const validated = validateComposeCanonical(canonical, authority);
    for (const image of new Set(Object.values(validated.services).map(s => s.image))) {
      const output = await readonlyCommand(options, ["--host", capabilities.endpoint, "inspect", "--type", "image", image], scratch, budget, requestSignal);
      let parsed: unknown; try { parsed = JSON.parse(output); } catch { throw new ComposeValidationError("compose_response_invalid"); }
      const inspection = ImageInspectSchema.parse(parsed)[0]!;
      if (!inspection.RepoDigests.includes(image) || Object.keys(inspection.Config.Volumes ?? {}).length) throw new ComposeValidationError("compose_image_unapproved");
    }
    if (requestSignal.aborted) throw new ComposeValidationError(abortedCode(requestSignal));
    return ComposeValidationPlanSchema.parse({ version: 1, projectName: authority.projectName, engineIdentity: capabilities.engineIdentity,
      manifestSha256: authority.manifestSha256, canonicalSha256: composeCanonicalHash(validated), runtimeEnabled: false,
      services: Object.entries(validated.services).sort(([a], [b]) => a.localeCompare(b)).map(([name, service]) => ({ name, image: service.image, publishedPorts: service.ports.map(p => p.published), mountCount: service.volumes.length })),
    });
  } catch (error) {
    // Preserve private evidence if positive process cleanup could not be established.
    if (error instanceof ComposeValidationError && error.code === "compose_cleanup_unverified") scratch = undefined;
    if (error instanceof ComposeValidationError) throw error;
    throw new ComposeValidationError("compose_validation_failed");
  } finally {
    if (scratch) {
      try { rmSync(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
      catch { throw new ComposeValidationError("compose_scratch_cleanup_failed"); }
    }
  }
}
