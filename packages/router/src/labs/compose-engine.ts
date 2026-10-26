import path from "node:path";
import { composeMountPathAllowed } from "./compose-mount-policy.js";
import { z } from "zod";
import { composeCanonicalHash } from "./compose-recipe.js";
import { ComposeResourceApprovalSchema, ComposeResourceCreationReceiptSchema } from "./compose-ownership-schema.js";
import {
  ComposeEngineBuildInputSchema, ComposeEnginePlanSchema, ComposeEngineResponseSchema,
  type ComposeEnginePlan,
} from "./compose-engine-schema.js";

type Input = z.infer<typeof ComposeEngineBuildInputSchema>;
type Approval = z.infer<typeof ComposeResourceApprovalSchema>;
type Code = "invalid_input" | "identity_mismatch" | "approval_mismatch" |
  "profile_mismatch" | "unsupported_config" | "receipt_mismatch";
class Refused extends Error {
  constructor(readonly code: Code) { super(code); }
}
function refuse(code: Code): never { throw new Refused(code); }
const equal = (a: unknown, b: unknown) => composeCanonicalHash(a) === composeCanonicalHash(b);

/** Inspect own data descriptors before parsing/hashing. Nothing supplied may execute a getter. */
function bounded(raw: unknown): unknown {
  let bytes = 0, nodes = 0;
  const active = new Set<object>();
  const charge = (amount: number) => {
    bytes += amount;
    if (bytes > 4 * 1024 * 1024) refuse("invalid_input");
  };
  const visit = (value: unknown, depth: number): void => {
    if (++nodes > 75_000 || depth > 24) refuse("invalid_input");
    if (typeof value === "string") {
      if (value.length > 4 * 1024 * 1024 || value.includes("\0")) refuse("invalid_input");
      charge(Buffer.byteLength(value));
      return;
    }
    charge(8);
    if (value === null || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) return;
    if (typeof value !== "object" || !value || active.has(value)) refuse("invalid_input");
    if (Object.getPrototypeOf(value) !== (Array.isArray(value) ? Array.prototype : Object.prototype) &&
        Object.getPrototypeOf(value) !== null) refuse("invalid_input");
    const keys = Reflect.ownKeys(value);
    if (keys.length > 10_000) refuse("invalid_input");
    active.add(value);
    if (Array.isArray(value) && keys.length !== value.length + 1) refuse("invalid_input");
    for (const key of keys) {
      if (typeof key !== "string" || ["__proto__", "constructor", "prototype"].includes(key)) refuse("invalid_input");
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) refuse("invalid_input");
      if (Array.isArray(value) && key === "length") continue;
      if (!descriptor.enumerable) refuse("invalid_input");
      charge(Buffer.byteLength(key));
      visit(descriptor.value, depth + 1);
    }
    active.delete(value);
  };
  visit(raw, 0);
  return raw;
}

function creation(identity: Input["current"]) {
  const { fence: ignored, ...immutable } = identity;
  return immutable;
}
function resourceLabels(input: Input, kind: "network" | "container") {
  const id = input.original;
  return {
    "io.meritrouter.install": id.installId, "io.meritrouter.lab": id.labId,
    "io.meritrouter.run": id.runId, "io.meritrouter.generation": String(id.generation),
    "io.meritrouter.spec": id.specSha256, "io.meritrouter.nonce": id.nonceSha256,
    "io.meritrouter.request": id.requestSha256, "io.meritrouter.intent": id.intentId,
    "io.meritrouter.resource": kind, "com.docker.compose.project": input.approval.canonical.name,
  };
}

function validateApproval(input: Input) {
  const { approval, original, current, profile } = input;
  const { authority, canonical, images } = approval;
  if (!equal(creation(original), creation(current)) || current.fence < original.fence) refuse("identity_mismatch");
  if (!equal(profile.baseline, approval.engineBaseline) || profile.appArmorProfile !== approval.appArmorProfile) {
    refuse("profile_mismatch");
  }
  const services = Object.keys(canonical.services).sort();
  if (composeCanonicalHash(approval) !== original.specSha256 || canonical.name !== authority.projectName ||
      !equal(services, Object.keys(authority.services).sort()) || !equal(services, Object.keys(images).sort()) ||
      (canonical.networks.default.name ?? `${canonical.name}_default`) !== `${canonical.name}_default`) {
    refuse("approval_mismatch");
  }
  const inside = (root: string, value: string) => {
    const rel = path.relative(path.resolve(root), path.resolve(value));
    return rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel);
  };
  if (path.resolve(authority.worktree) === path.resolve(authority.labRoot) ||
      !inside(authority.labRoot, authority.worktree) ||
      authority.dataRoots.some(root => path.resolve(root) === path.resolve(authority.labRoot) || !inside(authority.labRoot, root))) {
    refuse("approval_mismatch");
  }
  const published = new Set<number>();
  for (const name of services) {
    const spec = canonical.services[name]!, auth = authority.services[name]!, image = images[name]!;
    if (spec.image !== auth.image || !equal(spec.environment, auth.environment) ||
        !equal(spec.ports.map(p => ({ target: p.target, published: p.published })), auth.ports) ||
        !equal(spec.volumes.map(m => ({ source: m.source, target: m.target, readOnly: m.read_only })), auth.mounts)) {
      refuse("approval_mismatch");
    }
    if (!image.RepoDigests.includes(spec.image) ||
        Object.keys(image.Config.ExposedPorts ?? {}).some(key => !key.endsWith("/tcp"))) refuse("unsupported_config");
    const targets = new Set<number>();
    for (const port of spec.ports) {
      if (published.has(port.published) || targets.has(port.target)) refuse("unsupported_config");
      published.add(port.published);
      targets.add(port.target);
    }
    const mounts = new Set<string>();
    for (const mount of spec.volumes) {
      if (mounts.has(mount.target) || !composeMountPathAllowed(authority, mount.source, mount.target) ||
        path.resolve(mount.source) === path.resolve(authority.worktree) ||
        path.resolve(mount.source) === path.resolve(authority.labRoot) ||
        ![authority.worktree, ...authority.dataRoots].some(root => inside(root, mount.source))) refuse("approval_mismatch");
      mounts.add(mount.target);
    }
    // Validate the FULL approval, including unselected services, before returning any plan.
    effectiveConfig(approval, name);
  }
}

function effectiveConfig(approval: Approval, name: string) {
  const spec = approval.canonical.services[name]!, image = approval.images[name]!;
  const env: Record<string, string> = Object.create(null);
  for (const item of image.Config.Env ?? []) {
    const split = item.indexOf("=");
    const key = item.slice(0, split);
    if (split < 1 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || Object.hasOwn(env, key)) refuse("unsupported_config");
    env[key] = item.slice(split + 1);
  }
  Object.assign(env, spec.environment);
  const entry = spec.entrypoint ?? image.Config.Entrypoint ?? [];
  const cmd = spec.command ?? (spec.entrypoint !== undefined ? [] : image.Config.Cmd ?? []);
  if (![...entry, ...cmd].length || [...entry, ...cmd].some(arg => arg.includes("\0")) ||
      entry.some(arg => arg === "")) refuse("unsupported_config");
  // Engine merges image labels: omitting a reserved image label would NOT erase it.
  const labels = image.Config.Labels ?? {};
  if (Object.keys(labels).some(key => key.startsWith("io.meritrouter.") || key.startsWith("com.docker.compose."))) {
    refuse("unsupported_config");
  }
  // Empty Entrypoint requests inherit image defaults; [""] explicitly clears them in Engine API.
  return { entry: entry.length ? entry : [""], cmd, env, labels };
}

function networkRequest(input: Input): ComposeEnginePlan["request"] {
  return {
    operation: "create_network", method: "POST", path: "/v1.51/networks/create", query: {},
    body: {
      Name: `${input.approval.canonical.name}_default`, Driver: "bridge", Scope: "local",
      Internal: false, Attachable: false, Ingress: false, EnableIPv6: false,
      Labels: { ...resourceLabels(input, "network"), "com.docker.compose.network": "default" },
      Options: {}, IPAM: { Driver: "default", Options: {} },
    },
  };
}

function seal(input: Input, operationId: string, service: string | null, request: ComposeEnginePlan["request"]) {
  // Fence binds execution plan, but NOT the original immutable create request digest.
  // A renewed owner can recompute the same original receipt digest.
  const digest = { version: 1, operationId, service, original: input.original, profile: input.profile, request,
    expectedImageConfigId: service ? input.approval.images[service]!.Id : null };
  bounded(digest);
  return composeCanonicalHash(digest);
}

function validateReceipt(input: Input, receipt: z.infer<typeof ComposeResourceCreationReceiptSchema>) {
  if (receipt.state !== "committed" || !equal(receipt.creation, creation(input.original)) ||
      !equal(receipt.engine, input.profile.engine) ||
      (receipt.kind === "network" ? receipt.service !== null : !receipt.service || !Object.hasOwn(input.approval.canonical.services, receipt.service))) {
    refuse("receipt_mismatch");
  }
}

function containerRequest(input: Input, service: string, networkId: string): ComposeEnginePlan["request"] {
  const spec = input.approval.canonical.services[service] ?? refuse("unsupported_config");
  const image = input.approval.images[service]!, effective = effectiveConfig(input.approval, service);
  const bindings = Object.fromEntries(spec.ports.map(port => [`${port.target}/tcp`, [{ HostIp: "127.0.0.1" as const, HostPort: String(port.published) }]]));
  return {
    operation: "create_container", method: "POST", path: "/v1.51/containers/create",
    query: { name: `${input.approval.canonical.name}-${service}-1`, platform: input.profile.platform },
    body: {
      Image: spec.image, Entrypoint: effective.entry, Cmd: effective.cmd,
      Env: Object.keys(effective.env).sort().map(key => `${key}=${effective.env[key]}`),
      User: spec.user ?? image.Config.User, WorkingDir: spec.working_dir ?? image.Config.WorkingDir,
      Labels: { ...effective.labels, ...resourceLabels(input, "container"), "com.docker.compose.service": service },
      ExposedPorts: { ...(image.Config.ExposedPorts ?? {}), ...Object.fromEntries(spec.ports.map(port => [`${port.target}/tcp`, {}])) },
      Volumes: {}, Tty: false, OpenStdin: false, StdinOnce: false,
      AttachStdin: false, AttachStdout: false, AttachStderr: false, Domainname: "",
      StopSignal: image.Config.StopSignal ?? "",
      HostConfig: {
        ...input.approval.engineBaseline,
        Privileged: false, ReadonlyRootfs: true, PublishAllPorts: false, AutoRemove: false,
        CapAdd: null, CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges:true"],
        PidMode: "", UTSMode: "", UsernsMode: "", NetworkMode: networkId,
        RestartPolicy: { Name: "no", MaximumRetryCount: 0 }, Binds: null,
        Mounts: spec.volumes.map(m => ({ Type: "bind", Source: m.source, Target: m.target, ReadOnly: m.read_only,
          BindOptions: { Propagation: "rprivate", CreateMountpoint: false } })), PortBindings: bindings,
        Tmpfs: null, VolumesFrom: null, VolumeDriver: "", Links: null,
        Devices: [], DeviceRequests: null, DeviceCgroupRules: null, Dns: [], DnsOptions: [], DnsSearch: [],
        ExtraHosts: null, GroupAdd: null, Ulimits: null, Sysctls: null, StorageOpt: null,
        Cgroup: "", CgroupParent: "", ContainerIDFile: "", CpuShares: 0, Memory: 0, NanoCpus: 0,
        MemoryReservation: 0, MemorySwap: 0, CpuPeriod: 0, CpuQuota: 0,
        CpuRealtimePeriod: 0, CpuRealtimeRuntime: 0, CpusetCpus: "", CpusetMems: "", BlkioWeight: 0,
        BlkioWeightDevice: [], BlkioDeviceReadBps: [], BlkioDeviceWriteBps: [],
        BlkioDeviceReadIOps: [], BlkioDeviceWriteIOps: [], OomKillDisable: false,
        OomScoreAdj: 0, Isolation: "", ConsoleSize: [0, 0],
      },
    },
  };
}

/** Private plan only: caller must persist original intent BEFORE issuing any effect.
 * No transport, durable receipt, live ownership proof or mutation permission is implemented here.
 */
export function buildComposeEnginePlan(raw: unknown):
  { state: "planned"; plan: ComposeEnginePlan } | { state: "refused"; code: Code; authority: "none"; runtimeEnabled: false } {
  try {
    const input = ComposeEngineBuildInputSchema.parse(bounded(raw));
    validateApproval(input);
    const { effect } = input;
    let request: ComposeEnginePlan["request"], service: string | null = null;
    if (effect.kind === "create_network") request = networkRequest(input);
    else if (effect.kind === "create_container") {
      validateReceipt(input, effect.network);
      if (effect.network.kind !== "network" || effect.network.state !== "committed" ||
          effect.network.operationId === effect.operationId ||
          effect.network.requestSha256 !== seal(input, effect.network.operationId, null, networkRequest(input))) refuse("receipt_mismatch");
      service = effect.service;
      request = containerRequest(input, effect.service, effect.network.resourceId);
    } else {
      validateReceipt(input, effect.resource);
      if (effect.resource.state !== "committed") refuse("receipt_mismatch");
      const resourceKind = effect.resource.kind, resourceId = effect.resource.resourceId;
      if (resourceKind === "network" && ["start", "stop"].includes(effect.kind)) refuse("unsupported_config");
      // Original container body digest also needs its committed network; exact-ID plans preserve
      // receipt identity but deliberately do NOT claim to authenticate its stored request body.
      if (resourceKind === "network" && effect.resource.requestSha256 !==
          seal(input, effect.resource.operationId, null, networkRequest(input))) refuse("receipt_mismatch");
      service = effect.resource.service;
      const base = `/v1.51/${resourceKind === "network" ? "networks" : "containers"}/${resourceId}`;
      request = {
        operation: effect.kind, resourceKind, resourceId,
        method: effect.kind === "inspect" ? "GET" : effect.kind === "remove" ? "DELETE" : "POST",
        path: base + (effect.kind === "inspect" && resourceKind === "container" ? "/json" :
          ["start", "stop"].includes(effect.kind) ? `/${effect.kind}` : ""),
        query: effect.kind === "stop" ? { t: 10 } : effect.kind === "remove" && resourceKind === "container" ? { force: false, v: false } : {},
        body: null,
      };
    }
    const plan = ComposeEnginePlanSchema.parse({ version: 1, authority: "none", runtimeEnabled: false,
      operationId: effect.operationId, original: input.original, current: input.current,
      profile: input.profile, service, request,
      expectedImageConfigId: service ? input.approval.images[service]!.Id : null,
      planSha256: seal(input, effect.operationId, service, request) });
    bounded(plan);
    const freeze = (value: object): void => {
      for (const child of Object.values(value)) if (typeof child === "object" && child) freeze(child);
      Object.freeze(value);
    };
    freeze(plan);
    return { state: "planned", plan };
  } catch (error) {
    return { state: "refused", code: error instanceof Refused ? error.code : "invalid_input", authority: "none", runtimeEnabled: false };
  }
}

/** Safe fixed diagnostics; private response bodies never escape this projection. */
export function inspectComposeEngineResponse(planRaw: unknown, raw: unknown) {
  const result = (code: "created_observation" | "inspect_observation" | "effect_observation" |
    "same_engine_404" | "transport_unknown" | "response_refused") =>
    ({ code, authority: "none" as const, runtimeEnabled: false as const, durableReceipt: false as const });
  try {
    const plan = ComposeEnginePlanSchema.parse(bounded(planRaw));
    if (plan.planSha256 !== composeCanonicalHash({ version: 1, operationId: plan.operationId,
      service: plan.service, original: plan.original, profile: plan.profile, request: plan.request,
      expectedImageConfigId: plan.expectedImageConfigId })) return result("response_refused");
    const response = ComposeEngineResponseSchema.parse(bounded(raw));
    if (response.operationId !== plan.operationId || response.planSha256 !== plan.planSha256) return result("response_refused");
    if (response.state === "unknown") return result("transport_unknown");
    if (!equal(response.engine, plan.profile.engine)) return result("response_refused");
    const request = plan.request;
    if (response.status === 404 && "resourceId" in request && response.body === null) return result("same_engine_404");
    if (request.operation.startsWith("create_")) {
      if (response.status !== 201 || !response.body || !("Id" in response.body)) return result("response_refused");
      const key = request.operation === "create_network" ? "Warning" : "Warnings";
      return result(key in response.body && Object.keys(response.body).length === 2 ? "created_observation" : "response_refused");
    }
    if (request.operation === "inspect" && "resourceId" in request) {
      return result(response.status === 200 && response.body && "Id" in response.body &&
        response.body.Id === request.resourceId && (request.resourceKind === "container" ? "HostConfig" in response.body : "IPAM" in response.body)
        ? "inspect_observation" : "response_refused");
    }
    return result([204, ...(request.operation === "remove" ? [] : [304])].includes(response.status) && response.body === null
      ? "effect_observation" : "response_refused");
  } catch { return result("response_refused"); }
}
