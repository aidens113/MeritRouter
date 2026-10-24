import { afterEach, describe, expect, it } from "vitest";
import type { MeritRouter } from "../src/core/service.js";
import { baseConfig, endpoint, makeEnv, open, ScriptedClient, reply, type Env } from "./helpers.js";

let env: Env | undefined;
let router: MeritRouter | undefined;
afterEach(async () => { await router?.close(); router = undefined; env?.cleanup(); env = undefined; });

function setup(options: { strict?: boolean; endpoints?: unknown[] } = {}) {
  const config = baseConfig({ supervisor: { routing: {
    ...(options.strict ? { minimum_quality: "frontier_or_qualified_supervisor" } : {}), quality_evidence: [],
  } } });
  (config.profiles as Record<string, unknown>).supervise = {
    mode: "supervisor", tools: "supervisor", min_total_parameters_b: 100, max_model_requests: 600,
  };
  env = makeEnv({ config, ...(options.endpoints ? { endpoints: options.endpoints } : {}) });
  const client = new ScriptedClient(() => reply("must not call a provider during submission"));
  router = open(env, client, { worker: false });
  return { router, client };
}

describe("supervisor submission preflight", () => {
  it("returns a typed actionable strict-policy error without persisting a doomed job", async () => {
    const { router, client } = setup({ strict: true });
    await expect(router.startJob({ goal: "Build a working app", repositories: ["core"] }))
      .rejects.toMatchObject({ code: "supervisor_quality_unavailable", message: expect.stringContaining("Supervisor task was not submitted") });
    expect(router.listTasks()).toHaveLength(0);
    expect(client.requests).toHaveLength(0);
  });

  it("applies preflight to direct supervisor submissions and rolls back the entire batch", async () => {
    const { router, client } = setup({ strict: true });
    await expect(router.submitTasks([
      { profile: "inspect", goal: "Inspect source", repositoryAliases: ["core"], constraints: { acceptanceCriteria: ["Source inspected"] } },
      { profile: "supervise", goal: "Deliver an app", repositoryAliases: ["core"], constraints: { acceptanceCriteria: ["Working app delivered"] } },
    ])).rejects.toMatchObject({ code: "supervisor_quality_unavailable" });
    expect(router.listTasks()).toHaveLength(0);
    expect(client.requests).toHaveLength(0);
  });

  it("admits a usable default job with no quality evidence without spending requests", async () => {
    const { router, client } = setup();
    const job = await router.startJob({ goal: "Build a working app", repositories: ["core"], idempotencyKey: "startup-job" });
    expect(job).toMatchObject({ state: "queued", deduplicated: false });
    expect(router.listTasks()).toHaveLength(1);
    router.cfg.supervisor.routing.minimum_quality = "frontier_or_qualified_supervisor";
    await expect(router.startJob({ goal: "Build a working app", repositories: ["core"], idempotencyKey: "startup-job" }))
      .resolves.toMatchObject({ taskId: job.taskId, deduplicated: true });
    expect(client.requests).toHaveLength(0);
  });

  it("reports endpoint capability exclusions while keeping the failed job out of storage", async () => {
    const { router } = setup({ endpoints: [endpoint({ supportsTools: false })] });
    await expect(router.startJob({ goal: "Build a working app", repositories: ["core"] }))
      .rejects.toMatchObject({ message: expect.stringContaining("no tool calling") });
    expect(router.listTasks()).toHaveLength(0);
  });
});

