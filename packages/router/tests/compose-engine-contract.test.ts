import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { composeCanonicalHash } from "../src/labs/compose-recipe.js";
import { ComposeResourceApprovalSchema, ComposeResourceCreationReceiptSchema } from "../src/labs/compose-ownership-schema.js";
import { ComposeEngineBuildInputSchema, ComposeEnginePlanSchema } from "../src/labs/compose-engine-schema.js";
import { buildComposeEnginePlan, inspectComposeEngineResponse } from "../src/labs/compose-engine.js";

const sha = (char: string) => char.repeat(64);
type Input = z.infer<typeof ComposeEngineBuildInputSchema>;
function fixture(): Input {
  const root = path.resolve("engine-private-fixture"), worktree = path.join(root, "worktree"), data = path.join(root, "data");
  const image = `fixture/app@sha256:${sha("a")}`;
  const baseline = {
    Runtime: "runc", IpcMode: "private", CgroupnsMode: "private", ShmSize: 67108864,
    LogConfig: { Type: "json-file", Config: {} }, MaskedPaths: ["/proc/kcore"], ReadonlyPaths: ["/proc/sys"],
    MemorySwappiness: null, PidsLimit: null,
  };
  const approval = ComposeResourceApprovalSchema.parse({
    authority: {
      labRoot: root, worktree, dataRoots: [data], manifest: path.join(worktree, "compose.yaml"),
      manifestSha256: sha("b"), projectName: "sy-private-fixture",
      services: { web: { image, environment: { PRIVATE: "secret-canary=$value\nnext=line" },
        ports: [{ published: 57001, target: 8080 }], mounts: [{ source: data, target: "/data", readOnly: false }] } },
    },
    canonical: {
      name: "sy-private-fixture", networks: { default: { driver: "bridge" } },
      services: { web: { image, command: ["serve", "$literal", "multi\nline"], environment: { PRIVATE: "secret-canary=$value\nnext=line" },
        read_only: true, cap_drop: ["ALL"], security_opt: ["no-new-privileges:true"], restart: "no",
        ports: [{ host_ip: "127.0.0.1", target: 8080, published: 57001, protocol: "tcp" }],
        volumes: [{ type: "bind", source: data, target: "/data", read_only: false, bind: { create_host_path: false } }],
        networks: { default: null } } },
    },
    images: { web: { Id: `sha256:${sha("c")}`, RepoDigests: [image], Config: {
      Env: ["PATH=/bin", "PRIVATE=image-default"], Cmd: ["image-cmd"], Entrypoint: ["/entry"],
      User: "1000", WorkingDir: "/app", Volumes: null, Labels: { "fixture.label": "preserved" }, ExposedPorts: null,
    } } }, engineBaseline: baseline, appArmorProfile: "docker-default",
  });
  const original = { installId: "fixture", labId: "private-lab", runId: "d".repeat(32), generation: 2, fence: 3,
    specSha256: composeCanonicalHash(approval), nonceSha256: sha("e"), requestSha256: sha("f"), intentId: "original-intent" };
  return ComposeEngineBuildInputSchema.parse({ approval, original, current: { ...original },
    profile: { version: 1, apiVersion: "1.51", profileSha256: sha("1"), platform: "linux/amd64",
      engine: { trustedLocalEngine: true, osType: "linux", engineIdentity: "private-engine", composeConfigJson: true,
        imageInspectJson: true, endpoint: "unix:///private/docker.sock" }, baseline, appArmorProfile: "docker-default" },
    effect: { kind: "create_network", operationId: "network-original" } });
}
function plan(input: unknown) {
  const result = buildComposeEnginePlan(input);
  if (result.state !== "planned") throw new Error(result.code);
  return result.plan;
}
function reseal(input: Input) {
  input.approval = ComposeResourceApprovalSchema.parse(input.approval);
  input.original.specSha256 = composeCanonicalHash(input.approval);
  input.current.specSha256 = input.original.specSha256;
}
function networkReceipt(input: Input) {
  const network = plan({ ...input, effect: { kind: "create_network", operationId: "network-original" } });
  const { fence: ignored, ...creation } = input.original;
  return ComposeResourceCreationReceiptSchema.parse({ state: "committed", operationId: network.operationId,
    requestSha256: network.planSha256, creation, engine: input.profile.engine,
    kind: "network", service: null, resourceId: sha("2") });
}
function container(input = fixture()) {
  input.effect = { kind: "create_container", operationId: "container-original", service: "web", network: networkReceipt(input) };
  return { input, output: plan(input) };
}
function response(input: Input, output: ReturnType<typeof plan>, status: number, body: unknown) {
  return { state: "http", operationId: output.operationId, planSha256: output.planSha256,
    engine: input.profile.engine, sameConnection: true, status, body };
}

describe("pure private Compose Engine plans", () => {
  it("builds the exact closed bridge request and immutable creation labels", () => {
    const input = fixture(), output = plan(input);
    expect(output.request).toEqual({ operation: "create_network", method: "POST", path: "/v1.51/networks/create", query: {}, body: {
      Name: "sy-private-fixture_default", Driver: "bridge", Scope: "local", Internal: false, Attachable: false,
      Ingress: false, EnableIPv6: false, Options: {}, IPAM: { Driver: "default", Options: {} },
      Labels: {
        "io.meritrouter.install": "fixture", "io.meritrouter.lab": "private-lab", "io.meritrouter.run": input.original.runId,
        "io.meritrouter.generation": "2", "io.meritrouter.spec": input.original.specSha256,
        "io.meritrouter.nonce": input.original.nonceSha256, "io.meritrouter.request": input.original.requestSha256,
        "io.meritrouter.intent": "original-intent", "io.meritrouter.resource": "network",
        "com.docker.compose.project": "sy-private-fixture", "com.docker.compose.network": "default",
      },
    } });
    expect(output).toMatchObject({ authority: "none", runtimeEnabled: false });
    expect(Object.isFrozen(output.request)).toBe(true);
    expect(Object.isFrozen(output.profile.baseline.MaskedPaths)).toBe(true);
    expect(() => { output.current.fence++; }).toThrow();
  });

  it("preserves literal argv, env, image digest, mounts, publication and hardening", () => {
    const { input, output } = container();
    if (output.request.operation !== "create_container") throw new Error("fixture");
    const body = output.request.body;
    expect(output.request.query).toEqual({ name: "sy-private-fixture-web-1", platform: "linux/amd64" });
    expect(body.Image).toBe(input.approval.canonical.services.web!.image);
    expect(body.Image).not.toBe(input.approval.images.web!.Id);
    expect(output.expectedImageConfigId).toBe(input.approval.images.web!.Id);
    expect(body.Entrypoint).toEqual(["/entry"]);
    expect(body.Cmd).toEqual(["serve", "$literal", "multi\nline"]);
    expect(body.Env).toEqual(["PATH=/bin", "PRIVATE=secret-canary=$value\nnext=line"]);
    expect(body.Labels["fixture.label"]).toBe("preserved");
    expect(body.HostConfig).toEqual({ ...input.approval.engineBaseline,
      Privileged: false, ReadonlyRootfs: true, PublishAllPorts: false, AutoRemove: false,
      CapAdd: null, CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges:true"],
      PidMode: "", UTSMode: "", UsernsMode: "", NetworkMode: sha("2"),
      RestartPolicy: { Name: "no", MaximumRetryCount: 0 }, Binds: null,
      Mounts: [{ Type: "bind", Source: input.approval.authority.dataRoots[0], Target: "/data", ReadOnly: false,
        BindOptions: { Propagation: "rprivate", CreateMountpoint: false } }],
      PortBindings: { "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "57001" }] },
      Tmpfs: null, VolumesFrom: null, VolumeDriver: "", Links: null, Devices: [], DeviceRequests: null,
      DeviceCgroupRules: null, Dns: [], DnsOptions: [], DnsSearch: [], ExtraHosts: null, GroupAdd: null,
      Ulimits: null, Sysctls: null, StorageOpt: null, Cgroup: "", CgroupParent: "", ContainerIDFile: "",
      CpuShares: 0, Memory: 0, NanoCpus: 0, MemoryReservation: 0, MemorySwap: 0, CpuPeriod: 0, CpuQuota: 0,
      CpuRealtimePeriod: 0, CpuRealtimeRuntime: 0, CpusetCpus: "", CpusetMems: "", BlkioWeight: 0,
      BlkioWeightDevice: [], BlkioDeviceReadBps: [], BlkioDeviceWriteBps: [], BlkioDeviceReadIOps: [],
      BlkioDeviceWriteIOps: [], OomKillDisable: false, OomScoreAdj: 0, Isolation: "", ConsoleSize: [0, 0],
    });
  });

  it.each(["default", "explicit-entry", "clear-entry", "clear-cmd"])("preserves %s command semantics", kind => {
    const input = fixture(), spec = input.approval.canonical.services.web!;
    if (kind === "clear-cmd") spec.command = [];
    else delete spec.command;
    if (kind === "explicit-entry") spec.entrypoint = ["/override"];
    if (kind === "clear-entry") spec.entrypoint = [];
    reseal(input);
    if (kind === "clear-entry") {
      expect(buildComposeEnginePlan(input)).toMatchObject({ state: "refused", code: "unsupported_config" });
      input.approval.canonical.services.web!.command = ["/literal"];
      reseal(input);
    }
    const output = container(input).output;
    if (output.request.operation !== "create_container") throw new Error("fixture");
    expect(output.request.body.Entrypoint).toEqual(kind === "clear-entry" ? [""] : kind === "explicit-entry" ? ["/override"] : ["/entry"]);
    expect(output.request.body.Cmd).toEqual(kind === "default" ? ["image-cmd"] : kind === "clear-entry" ? ["/literal"] : []);
  });

  it("keeps original create digest stable across current owner-fence renewal", () => {
    const input = fixture(), receipt = networkReceipt(input), before = plan(input);
    input.current.fence++;
    expect(plan(input).planSha256).toBe(before.planSha256);
    input.effect = { kind: "create_container", operationId: "container-original", service: "web", network: receipt };
    expect(buildComposeEnginePlan(input).state).toBe("planned");
  });

  it("clears absent image entrypoint without losing image default CMD", () => {
    const input = fixture();
    delete input.approval.canonical.services.web!.command;
    input.approval.images.web!.Config.Entrypoint = null;
    reseal(input);
    const request = container(input).output.request;
    if (request.operation !== "create_container") throw new Error("fixture");
    expect(request.body.Entrypoint).toEqual([""]);
    expect(request.body.Cmd).toEqual(["image-cmd"]);
  });

  it("refuses changed original identity and backward current fence", () => {
    const input = fixture();
    input.current.fence--;
    expect(buildComposeEnginePlan(input)).toMatchObject({ code: "identity_mismatch" });
    input.current = { ...input.original, nonceSha256: sha("9") };
    expect(buildComposeEnginePlan(input)).toMatchObject({ code: "identity_mismatch" });
  });

  it.each(["issued", "digest", "engine", "identity", "operation", "kind"])("refuses %s network receipt", kind => {
    const { input } = container();
    if (input.effect.kind !== "create_container") throw new Error("fixture");
    const receipt = input.effect.network;
    if (kind === "issued") Object.assign(receipt, { state: "issued", resourceId: null });
    if (kind === "digest") receipt.requestSha256 = sha("9");
    if (kind === "engine") receipt.engine.engineIdentity = "foreign";
    if (kind === "identity") receipt.creation.nonceSha256 = sha("9");
    if (kind === "operation") receipt.operationId = input.effect.operationId;
    if (kind === "kind") Object.assign(receipt, { kind: "container", service: "web" });
    expect(buildComposeEnginePlan(input)).toMatchObject({ state: "refused", code: "receipt_mismatch" });
  });

  it.each(["seal", "current", "profile", "subset", "image", "ports", "mount", "reserved-label", "udp"])("refuses %s mismatch", kind => {
    const input = fixture();
    if (kind === "seal") input.approval.canonical.services.web!.command = ["foreign"];
    if (kind === "current") input.current.runId = "9".repeat(32);
    if (kind === "profile") input.profile.appArmorProfile = "unconfined";
    if (kind === "subset") input.approval.authority.services.extra = structuredClone(input.approval.authority.services.web!);
    if (kind === "image") input.approval.images.web!.RepoDigests = [];
    if (kind === "ports") {
      input.approval.canonical.services.web!.ports.push({ host_ip: "127.0.0.1", target: 8080, published: 57002, protocol: "tcp" });
      input.approval.authority.services.web!.ports.push({ target: 8080, published: 57002 });
    }
    if (kind === "mount") {
      input.approval.authority.services.web!.mounts[0]!.source = path.resolve("foreign-secret");
      input.approval.canonical.services.web!.volumes[0]!.source = path.resolve("foreign-secret");
    }
    if (kind === "reserved-label") input.approval.images.web!.Config.Labels = { "io.meritrouter.forged": "secret-canary" };
    if (kind === "udp") input.approval.images.web!.Config.ExposedPorts = { "53/udp": {} };
    if (!["seal", "current", "profile"].includes(kind)) reseal(input);
    expect(buildComposeEnginePlan(input).state).toBe("refused");
  });

  it("validates all services rather than only selected container", () => {
    const input = fixture();
    input.approval.canonical.services.worker = structuredClone(input.approval.canonical.services.web!);
    input.approval.canonical.services.worker.ports = [];
    input.approval.authority.services.worker = structuredClone(input.approval.authority.services.web!);
    input.approval.authority.services.worker.ports = [];
    input.approval.images.worker = structuredClone(input.approval.images.web!);
    input.approval.images.worker.Config.Env = ["DUP=a", "DUP=b"];
    reseal(input);
    expect(buildComposeEnginePlan(input)).toMatchObject({ code: "unsupported_config" });
  });

  it.each(["inspect", "start", "stop", "remove"] as const)("builds exact-ID %s only", operation => {
    const { input, output } = container();
    const { fence: ignored, ...creation } = input.original;
    input.effect = { kind: operation, operationId: `effect-${operation}`, resource: {
      state: "committed", resourceId: sha("3"), kind: "container", service: "web", creation,
      engine: input.profile.engine, requestSha256: output.planSha256, operationId: "container-original" } };
    const request = plan(input).request;
    expect(request.path).toBe(`/v1.51/containers/${sha("3")}${operation === "inspect" ? "/json" : operation === "remove" ? "" : `/${operation}`}`);
    expect(request.query).toEqual(operation === "stop" ? { t: 10 } : operation === "remove" ? { force: false, v: false } : {});
    expect(ComposeEnginePlanSchema.safeParse({ ...plan(input), request: { ...request, path: "/v1.51/containers/prune" } }).success).toBe(false);
  });

  it("refuses arbitrary operations/endpoints/unknown fields without echoing secrets", () => {
    for (const change of [
      { effect: { kind: "exec", operationId: "secret-canary" } },
      { profile: { ...fixture().profile, engine: { ...fixture().profile.engine, endpoint: "tcp://secret-canary:2375" } } },
      { arbitrary: "secret-canary" },
    ]) {
      const result = buildComposeEnginePlan({ ...fixture(), ...change });
      expect(result.state).toBe("refused");
      expect(JSON.stringify(result)).not.toContain("secret-canary");
    }
  });

  it("refuses network start/stop and missing original committed receipt", () => {
    const input = fixture();
    for (const kind of ["start", "stop"] as const) {
      input.effect = { kind, operationId: "exact-effect", resource: networkReceipt(input) };
      expect(buildComposeEnginePlan(input)).toMatchObject({ code: "unsupported_config" });
    }
    expect(buildComposeEnginePlan({ ...input, effect: { kind: "create_container", operationId: "container-original", service: "web" } }).state).toBe("refused");
  });

  it("rejects accessors/cycles/depth/size/non-JSON inputs before hashing", () => {
    let called = false;
    const accessor = Object.defineProperty({}, "approval", { enumerable: true, get() { called = true; throw new Error("secret-canary"); } });
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    let deep: unknown = {}; for (let i = 0; i < 40; i++) deep = { next: deep };
    for (const raw of [accessor, cycle, deep, { secret: "secret-canary".repeat(400_000) },
      new Date(), [,,], { hidden: undefined }, { value: "nul\0secret-canary" }]) {
      expect(buildComposeEnginePlan(raw)).toEqual({ state: "refused", code: "invalid_input", authority: "none", runtimeEnabled: false });
    }
    expect(called).toBe(false);
  });
});

describe("private engine observations and safe diagnostics", () => {
  it("reports create observation without manufacturing a durable receipt", () => {
    const input = fixture(), output = plan(input);
    expect(inspectComposeEngineResponse(output, response(input, output, 201, { Id: sha("2"), Warning: "" })))
      .toEqual({ code: "created_observation", authority: "none", runtimeEnabled: false, durableReceipt: false });
    expect(inspectComposeEngineResponse(output, response(input, output, 201, { Id: sha("2"), Warning: "secret-canary" })).code).toBe("response_refused");
  });
  it("does not convert unknown transport/create404 into absence or retry authority", () => {
    const input = fixture(), output = plan(input);
    expect(inspectComposeEngineResponse(output, { state: "unknown", operationId: output.operationId,
      planSha256: output.planSha256, code: "transport_unknown" }).code).toBe("transport_unknown");
    expect(inspectComposeEngineResponse(output, response(input, output, 404, null)).code).toBe("response_refused");
  });
  it("handles original container create response with bounded empty/null warnings", () => {
    const { input, output } = container();
    for (const Warnings of [null, []]) {
      expect(inspectComposeEngineResponse(output, response(input, output, 201, { Id: sha("3"), Warnings })).code).toBe("created_observation");
    }
    expect(inspectComposeEngineResponse(output, response(input, output, 201, { Id: sha("3"), Warnings: ["secret-canary"] })).code).toBe("response_refused");
  });
  it("reports exact network inspect observation without granting resource proof", () => {
    const input = fixture();
    input.effect = { kind: "inspect", operationId: "inspect-original", resource: networkReceipt(input) };
    const output = plan(input);
    const body = { Id: sha("2"), Name: "sy-private-fixture_default", Driver: "bridge", Scope: "local",
      Internal: false, Attachable: false, Ingress: false, EnableIPv6: false, Labels: {}, Options: {},
      IPAM: { Driver: "default", Options: null, Config: [] }, Containers: {} };
    expect(inspectComposeEngineResponse(output, response(input, output, 200, body)))
      .toEqual({ code: "inspect_observation", authority: "none", runtimeEnabled: false, durableReceipt: false });
    expect(inspectComposeEngineResponse(output, response(input, output, 200, { ...body, Id: sha("9") })).code).toBe("response_refused");
  });
  it("requires same engine and exact response identity for 404 observations", () => {
    const input = fixture();
    input.effect = { kind: "inspect", operationId: "inspect-original", resource: networkReceipt(input) };
    const output = plan(input), valid = response(input, output, 404, null);
    expect(inspectComposeEngineResponse(output, valid).code).toBe("same_engine_404");
    for (const patch of [{ sameConnection: false }, { operationId: "foreign" }, { planSha256: sha("9") },
      { engine: { ...input.profile.engine, engineIdentity: "foreign" } }, { body: { message: "secret-canary" } }, { status: 500 }]) {
      const safe = inspectComposeEngineResponse(output, { ...valid, ...patch });
      expect(safe.code).toBe("response_refused");
      expect(JSON.stringify(safe)).not.toContain("secret-canary");
    }
  });
  it("refuses tampered request-body digest and arbitrary serialized request paths", () => {
    const input = fixture(), output = structuredClone(plan(input));
    if (output.request.operation !== "create_network") throw new Error("fixture");
    output.request.body.Name = "secret-canary";
    expect(inspectComposeEngineResponse(output, response(input, output, 201, { Id: sha("2"), Warning: "" })).code).toBe("response_refused");
  });
});
