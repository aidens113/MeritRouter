import { afterEach, expect, it } from "vitest";
import type { MeritRouter } from "../src/core/service.js";
import { WorkerTaskSchema } from "../src/core/task.js";
import { taskUsage, usageSummary } from "../src/storage/usage.js";
import { globalDashboard } from "../src/admin/dashboards.js";
import { makeEnv, open, reply, ScriptedClient, summarizeTask, type Env } from "./helpers.js";

let env: Env | undefined, sy: MeritRouter | undefined;
afterEach(async () => { await sy?.close(); sy = undefined; env?.cleanup(); env = undefined; });

function setup() {
  env = makeEnv(); sy = open(env, new ScriptedClient(() => reply("unused")), { worker: false });
  sy.tasks.submit([WorkerTaskSchema.parse(summarizeTask({ id: "a" })), WorkerTaskSchema.parse(summarizeTask({ id: "b" }))], { project: "demo" });
  sy.db.prepare("INSERT INTO executions(id,kind,profile,status,created_at) VALUES ('cache-exec','task','summarize','completed',1)").run();
  return (id: string, cached: number | null, tasks = ["a"], status = "succeeded") => {
    sy!.db.prepare("INSERT INTO model_requests(id,execution_id,purpose,gateway_model,status,reserved_at,est_input_tokens,reserved_output_tokens,project_id,input_tokens,output_tokens,cached_input_tokens,usage_basis) VALUES (?,'cache-exec','completion','fixture/model',?,?,100,10,'demo',100,10,?,'provider_reported')").run(id, status, Date.now(), cached);
    for (const task of tasks) sy!.db.prepare("INSERT INTO request_charges(request_id,task_id,input_tokens,output_tokens,tokens_exact) VALUES (?,?,?,10,1)").run(id, task, 100 / tasks.length);
  };
}

it("keeps mixed known and unknown cache totals explicitly partial instead of reporting zero", async () => {
  const add = setup(); add("unknown", null); add("known", 80);
  expect(taskUsage(sy!.db, sy!.catalog, "a").usage).toMatchObject({ inputTokens: 200, cachedInputTokens: null, uncachedInputTokens: null });
  const summary = usageSummary(sy!.db, 0, Date.now() + 1000, "demo");
  expect(summary).toMatchObject({ inputTokens: 200, cachedInputTokens: 80, uncachedInputTokens: 120, cacheUsageKnown: false, requestsWithUnknownCacheUsage: 1 });
  expect(summary.byEndpoint[0]).toMatchObject({ cacheUsageKnown: false, requestsWithUnknownCacheUsage: 1 });
  const dashboard = await globalDashboard(sy!);
  expect(dashboard.totals.usage24h).toMatchObject({ cacheUsageKnown: false, requestsWithUnknownCacheUsage: 1, cachedInputTokens: 80 });
});

it("distinguishes measured zero and reconciles fully reported cache usage", () => {
  const add = setup(); add("zero", 0); add("cached", 80);
  const usage = taskUsage(sy!.db, sy!.catalog, "a").usage;
  expect(usage).toMatchObject({ inputTokens: 200, cachedInputTokens: 80, uncachedInputTokens: 120 });
  expect(usage.inputTokens).toBe(usage.cachedInputTokens! + usage.uncachedInputTokens!);
  expect(usageSummary(sy!.db, 0, Date.now() + 1000)).toMatchObject({ cacheUsageKnown: true, requestsWithUnknownCacheUsage: 0 });
});

it("does not assign a physical batch cache total to each participant", () => {
  const add = setup(); add("batch", 80, ["a", "b"]);
  expect(taskUsage(sy!.db, sy!.catalog, "a").usage).toMatchObject({ inputTokens: 50, cachedInputTokens: null, uncachedInputTokens: null });
  expect(usageSummary(sy!.db, 0, Date.now() + 1000)).toMatchObject({ inputTokens: 100, cachedInputTokens: 80, uncachedInputTokens: 20, cacheUsageKnown: true });
});

it("counts failed requests with unknown cache data as unknown and keeps empty windows exact", () => {
  const add = setup(); add("failed", null, ["a"], "failed");
  expect(usageSummary(sy!.db, 0, Date.now() + 1000)).toMatchObject({ failedRequests: 1, cacheUsageKnown: false, requestsWithUnknownCacheUsage: 1 });
  expect(usageSummary(sy!.db, Date.now() + 10000, Date.now() + 20000)).toMatchObject({ modelRequests: 0, cacheUsageKnown: true, requestsWithUnknownCacheUsage: 0 });
});
