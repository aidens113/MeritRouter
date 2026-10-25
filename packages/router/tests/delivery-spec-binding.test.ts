import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { deliveryTools } from "../src/harness/delivery-tools.js";
import type { HarnessEnv } from "../src/harness/tools.js";
import type { RunContext } from "../src/runners/types.js";
import { ProductDeliveries } from "../src/verification/product-delivery.js";
import { DeliverySpecSchema, deliverySpecDigest } from "../src/verification/product-spec.js";
import { baseConfig, makeEnv, open, reply, ScriptedClient, servedFor, type Env } from "./helpers.js";
import type { MeritRouter } from "../src/core/service.js";

let env: Env | undefined, sy: MeritRouter | undefined;
afterEach(async () => { await sy?.close(); env?.cleanup(); sy = undefined; env = undefined; });
const goal = `Deliver the complete requested interface. ${"Preserve the user's original requirements and test actual behavior. ".repeat(80)}End of authoritative instruction.`;
const specInput = { schemaVersion: 1, id: "bound-spec", revision: 1, ownerId: "initiator", users: ["operator"], platforms: ["browser"], workflows: ["open product"], dataInvariants: [], interfaceContracts: [], visualRequirements: [], failureStates: [], securityRequirements: [], exclusions: [], setupRecipeRefs: [], criteria: [{ id: "open", priority: "required", behavior: "Product opens", applicability: { status: "applicable" }, requiredEvidence: ["journey"] }] };

async function fixture() {
  const base = baseConfig();
  env = makeEnv({ config: { ...base, profiles: { ...base.profiles, supervise: { mode: "supervisor", tools: "supervisor", min_total_parameters_b: 100, max_model_requests: 30, classify: "never", min_tier: "T3" } } } });
  sy = open(env, new ScriptedClient(() => reply("{}")));
  const [task] = await sy.submitTasks([{ profile: "supervise", goal, repositoryAliases: ["core"], deliveryVersion: 2, constraints: { acceptanceCriteria: ["Product opens"] } }]);
  const ctx = { taskId: task!.taskId, spec: sy.tasks.get(task!.taskId)!.spec, tasks: sy.tasks, cfg: sy.cfg } as RunContext;
  const tool = deliveryTools([]).find(tool => tool.def.function.name === "set_delivery_spec")!;
  const run = (input: unknown, expectedDigest?: string) => tool.run({ spec: input, ...(expectedDigest ? { expectedDigest } : {}) }, { ctx } as HarnessEnv);
  const status = () => new ProductDeliveries(sy!.db).status(ctx.taskId, "demo");
  return { ctx, tool, run, status };
}

describe("service-owned delivery specification goal binding", () => {
  it("advertises optional canonical fields and persists a complete strict specification", async () => {
    const { ctx, tool, run, status } = await fixture();
    const json = tool.def.function.parameters as { properties: { spec: { required: string[] } } };
    expect(json.properties.spec.required).not.toContain("source");
    expect(json.properties.spec.required).not.toContain("originalInstruction");
    expect(json.properties.spec.required).toContain("criteria");
    expect(tool.def.function.description).toContain("runtime binds the exact task goal");
    await run(specInput);
    const stored = status()!.spec;
    expect(stored.originalInstruction).toBe(goal);
    expect(stored.source).toEqual({ ref: `task:${ctx.taskId}:goal`, digest: createHash("sha256").update(goal, "utf8").digest("hex") });
    expect(DeliverySpecSchema.parse(stored)).toEqual(stored);
  });

  it("retains explicit source validation and rejects any explicit changed original goal", async () => {
    const { run, status } = await fixture();
    await expect(run({ ...specInput, originalInstruction: "An easier replacement goal" })).rejects.toThrow(/original task instruction exactly/);
    expect(status()).toBeNull();
    for (const source of [{ ref: "authored", digest: "not-a-hash" }, { ref: "authored", digest: "a".repeat(64), extra: "unexpected" }, null]) {
      await expect(run({ ...specInput, source })).rejects.toThrow();
      expect(status()).toBeNull();
    }
    const source = { ref: "brain:authored-spec.md", digest: "b".repeat(64) };
    await run({ ...specInput, originalInstruction: goal, source });
    expect(status()!.spec.source).toEqual(source);
  });

  it("preserves CAS revisions and required criterion protections for canonical inputs", async () => {
    const { run, status } = await fixture();
    await run(specInput);
    const first = status()!.spec;
    await expect(run({ ...specInput, revision: 2 })).rejects.toThrow(/conflict/);
    await expect(run({ ...specInput, revision: 2 }, "wrong-digest")).rejects.toThrow(/conflict/);
    await expect(run({ ...specInput, revision: 2, criteria: [{ ...specInput.criteria[0], behavior: "Weaker replacement" }] }, deliverySpecDigest(first))).rejects.toThrow(/removed or weakened/);
    await run({ ...specInput, revision: 2 }, deliverySpecDigest(first));
    expect(status()!.spec).toMatchObject({ revision: 2, originalInstruction: goal, source: first.source });
  });
});

it("binds omitted fields during an actual supervisor tool request without model hashing or goal echo", async () => {
  const base = baseConfig();
  env = makeEnv({ config: { ...base, client_supervision: {}, profiles: { ...base.profiles, supervise: { mode: "supervisor", tools: "supervisor", min_total_parameters_b: 100, max_model_requests: 30, classify: "never", min_tier: "T3" } } } });
  let turn = 0;
  const client = new ScriptedClient(req => {
    const name = turn++ === 0 ? "set_delivery_spec" : "finish_job";
    const args = name === "set_delivery_spec" ? { spec: specInput } : { status: "blocked", summary: "Spec-binding fixture only", verified: [], not_verified: ["Product implementation"], follow_up: "Continue implementation" };
    return reply(null, { ...servedFor(sy!, req), toolCalls: [{ id: name, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
  });
  sy = open(env, client, { worker: true });
  const submitted = await sy.startJob({ goal, repositories: ["core"] });
  const result = (await sy.awaitResults([submitted.taskId], { timeoutSeconds: 40 })).completed[0];
  expect(result).toMatchObject({ stopReason: "supervisor_blocked" });
  expect(turn).toBe(2);
  const stored = new ProductDeliveries(sy.db).status(submitted.taskId, "demo")!;
  expect(stored.spec.originalInstruction).toBe(goal);
  expect(stored.spec.source.digest).toBe(createHash("sha256").update(goal, "utf8").digest("hex"));
  expect(client.requests.at(-1)!.messages.filter(message => message.role === "tool").map(message => message.content)).not.toEqual(expect.arrayContaining([expect.stringContaining("error:")]));
}, 50_000);
