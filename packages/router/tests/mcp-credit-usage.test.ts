import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import YAML from "yaml";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ConfigSchema, SupervisorConfigSchema } from "../src/config/schema.js";
import { loadConfig } from "../src/config/load.js";
import { openDatabase, type Db } from "../src/storage/db.js";
import { TaskStore } from "../src/storage/tasks.js";
import { WorkerTaskSchema } from "../src/core/task.js";
import type { MeritRouter } from "../src/core/service.js";
import type { ProjectRuntimeStore } from "../src/projects/runtime-store.js";
import { creditUsageFeedback, jobCreditUsage } from "../src/mcp/credit-usage.js";
import { buildMcpServer } from "../src/mcp/tools.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function fixture(supervisor: Record<string, unknown> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "mr-credit-usage-"));
  const configPath = path.join(dir, "config.yaml");
  writeFileSync(configPath, YAML.stringify({ version: 1, storage: { directory: "store" }, brain: { project: "alpha", path: "brain" },
    panel: { auto_start: false, port: 9 }, discovery: { interval_minutes: 0 }, projects: { alpha: {}, beta: {} },
    supervisor, profiles: { supervise: { mode: "supervisor", tools: "supervisor", classify: "never" } } }));
  let cfg = loadConfig(configPath);
  const db = openDatabase(path.join(dir, "db")), tasks = new TaskStore(db);
  cleanups.push(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const store = (project: string) => ({ project, db, tasks } as unknown as ProjectRuntimeStore);
  const sy = { get cfg() { return cfg; }, db, tasks, reloadIfChanged() { cfg = loadConfig(configPath); },
    projectContext(project: string) { if (!["alpha", "beta"].includes(project)) throw new Error("unknown project"); return cfg; },
    projectStores: store, projects: { require(project: string) { if (!["alpha", "beta"].includes(project)) throw new Error("unknown project"); return { project: { slug: project } }; } },
    brainFor: (project: string) => ({ project }), brainAccessFor: () => ({}),
    collectResults: () => { throw new Error("synthetic unavailable result"); } } as unknown as MeritRouter;
  function task(id: string, parent?: string, project = "alpha", cap: number | null = 500, profile = "supervise") {
    tasks.submit([WorkerTaskSchema.parse({ id, profile, goal: "Synthetic fixture", parentTaskId: parent,
      constraints: { acceptanceCriteria: ["Fixture only"] }, ...(cap === null ? {} : { budget: { maxPaidUsd: cap } }) })], { project });
    return id;
  }
  return { db, sy, cfg, store, task };
}

function request(db: Db, id: string, tasks: string[], amount: number | null, options: {
  project?: string; status?: string; legacy?: boolean; projected?: boolean; unsettled?: boolean; basis?: string;
} = {}) {
  const project = options.project ?? "alpha", status = options.status ?? "succeeded";
  db.prepare("INSERT INTO executions(id,kind,profile,status,created_at) VALUES(?,'batch','supervise','completed',1)").run(`e-${id}`);
  db.prepare(`INSERT INTO model_requests(id,execution_id,purpose,gateway_model,status,reserved_at,est_input_tokens,reserved_output_tokens,project_id,estimated_cost_usd)
    VALUES(?,?,'execution','fixture',?,1,1,1,?,?)`).run(id, `e-${id}`, status, project, amount);
  for (const task of tasks) {
    db.prepare("INSERT INTO request_charges(request_id,task_id,input_tokens,output_tokens) VALUES(?,?,1,1)").run(id, task);
    if (options.projected) db.prepare(`INSERT INTO project_request_spend(request_id,task_id,project_id,lease_incarnation,run_count,reserved_usd,liability_usd,actual_usd)
      VALUES(?,?,?,'fixture',1,?,?,?)`).run(id, task, project, (amount ?? 0) / tasks.length, (amount ?? 0) / tasks.length, options.unsettled ? null : (amount ?? 0) / tasks.length);
  }
  if (options.legacy) db.prepare("INSERT INTO paid_spend(request_id,key_ref,provider,endpoint_id,reserved_usd,actual_usd,cost_basis,created_at) VALUES(?,'fixture','fixture','fixture',?,?,?,1)")
    .run(id, amount ?? 0, options.unsettled ? null : amount, options.basis ?? "computed");
}

describe("default supervisor paid budget and FINAL usage feedback", () => {
  it("defaults to500 and preserves explicit finite caps, including zero", () => {
    expect(SupervisorConfigSchema.parse({}).default_max_paid_usd).toBe(500);
    for (const value of [0, 7, 900]) expect(SupervisorConfigSchema.parse({ default_max_paid_usd: value }).default_max_paid_usd).toBe(value);
    for (const value of [-1, Infinity, NaN, "500"]) expect(SupervisorConfigSchema.safeParse({ default_max_paid_usd: value }).success).toBe(false);
    expect(ConfigSchema.parse({ version: 1, profiles: {} }).supervisor.credit_usage_alerts).toEqual({ enabled: true,
      usd_thresholds: [10, 25, 50, 100, 250, 500], cap_fraction_thresholds: [0.5, 0.8, 0.95] });
    for (const settings of [{ usd_thresholds: [20, 10] }, { usd_thresholds: [10, 10] }, { cap_fraction_thresholds: [0] }, { cap_fraction_thresholds: [1.1] }]) {
      expect(SupervisorConfigSchema.safeParse({ credit_usage_alerts: settings }).success).toBe(false);
    }
  });

  it("counts recursive projected, legacy and fallback shares once, without foreign projects", () => {
    const f = fixture(); f.task("root"); f.task("sub", "root"); f.task("worker", "sub", "alpha", null, "inspect"); f.task("foreign", "root", "beta");
    request(f.db, "projected", ["root", "sub", "worker"], 12, { projected: true, legacy: true });
    request(f.db, "legacy", ["sub", "worker"], 3, { legacy: true });
    request(f.db, "fallback", ["worker"], 2);
    request(f.db, "foreign", ["foreign"], 99, { project: "beta" });
    expect(jobCreditUsage(f.store("alpha"), "alpha", "root")).toMatchObject({ settledUsd: 17, outstandingUsd: 0, exposureUsd: 17, unpricedRequests: 0 });
    expect(jobCreditUsage(f.store("beta"), "beta", "root")).toBeNull();
    expect(() => jobCreditUsage(f.store("alpha"), "beta", "root")).toThrow(/project_mismatch/);
  });

  it("separates outstanding projected/legacy uncertainty and unknown prices", () => {
    const f = fixture(); f.task("root"); f.task("worker", "root", "alpha", null, "inspect");
    request(f.db, "settled", ["root"], 10, { projected: true });
    request(f.db, "reserved", ["worker"], 4, { projected: true, unsettled: true, status: "reserved" });
    request(f.db, "uncertain", ["root"], 3, { legacy: true, basis: "uncertain", status: "uncertain" });
    request(f.db, "unknown", ["worker"], null);
    expect(jobCreditUsage(f.store("alpha"), "alpha", "root")).toMatchObject({ settledUsd: 10, outstandingUsd: 7, exposureUsd: 17, unpricedRequests: 1 });
    expect(creditUsageFeedback(f.sy)("alpha").join(" ")).toMatch(/1 requests have unknown prices[\s\S]*balance is not established/);
  });

  it.each(["", "beta"])("retains owned exposure when descriptive request project labels are stale: %s", label => {
    const f = fixture(); f.task("root"); f.task("foreign", undefined, "beta");
    request(f.db, "owned", ["root"], 12, { projected: true, unsettled: true });
    request(f.db, "unrelated", ["foreign"], 99, { project: "beta", projected: true });
    f.db.prepare("UPDATE model_requests SET project_id=? WHERE id='owned'").run(label);
    f.db.prepare("UPDATE project_request_spend SET project_id=? WHERE request_id='owned'").run(label);
    expect(jobCreditUsage(f.store("alpha"), "alpha", "root")).toMatchObject({ settledUsd: 0, outstandingUsd: 12, exposureUsd: 12 });
    expect(creditUsageFeedback(f.sy)("alpha")[0]).toContain("$12.0000 measured job-tree exposure");
  });

  it("counts an unbound active preparation without double-counting projected holds", () => {
    const f = fixture(); f.task("root");
    request(f.db, "bound", ["root"], 6, { projected: true, unsettled: true });
    for (const id of ["bound", "prepared"]) {
      f.db.prepare(`INSERT INTO project_request_protocol(request_id,project_id,owner_json,fingerprint,binding_json,global_json,reservation_json,phase,created_at,updated_at)
        VALUES(?,'alpha','{}','fixture','{}','{}','{}','prepared',1,1)`).run(id);
      f.db.prepare(`INSERT INTO project_request_holds(request_id,task_id,project_id,lease_incarnation,run_count,input_tokens,output_tokens,paid_usd)
        VALUES(?,'root','alpha','fixture',1,1,1,6)`).run(id);
    }
    expect(jobCreditUsage(f.store("alpha"), "alpha", "root")).toMatchObject({ settledUsd: 0, outstandingUsd: 12 });
  });

  it("retains remaining participant holds during partial request projection", () => {
    const f = fixture(); f.task("root"); f.task("worker", "root", "alpha", null, "inspect");
    request(f.db, "partial", ["root", "worker"], 12, { projected: true, unsettled: true });
    f.db.prepare("DELETE FROM project_request_spend WHERE request_id='partial' AND task_id='worker'").run();
    f.db.prepare(`INSERT INTO project_request_protocol(request_id,project_id,owner_json,fingerprint,binding_json,global_json,reservation_json,phase,created_at,updated_at)
      VALUES('partial','alpha','{}','fixture','{}','{}','{}','prepared',1,1)`).run();
    for (const task of ["root", "worker"]) f.db.prepare(`INSERT INTO project_request_holds(request_id,task_id,project_id,lease_incarnation,run_count,input_tokens,output_tokens,paid_usd)
      VALUES('partial',?,'alpha','fixture',1,1,1,6)`).run(task);
    expect(jobCreditUsage(f.store("alpha"), "alpha", "root")).toMatchObject({ settledUsd: 0, outstandingUsd: 12 });
  });

  it("reports unknown cost once even below every dollar threshold", () => {
    const f = fixture(); f.task("root"); request(f.db, "unknown", ["root"], null);
    const notify = creditUsageFeedback(f.sy);
    expect(notify("alpha")[0]).toContain("unknown-cost"); expect(notify("alpha")).toEqual([]);
    request(f.db, "another-unknown", ["root"], null);
    expect(notify("alpha")).toEqual([]);
    expect(creditUsageFeedback(f.sy)("alpha")[0]).toContain("2 requests have unknown prices");
  });

  it("deduplicates crossed thresholds per connection and alerts at higher exposure/reconnect", () => {
    const f = fixture(); f.task("root", undefined, "alpha", 40);
    const notify = creditUsageFeedback(f.sy);
    request(f.db, "first", ["root"], 12);
    const first = notify("alpha")[0]!;
    expect(first).toContain("USD:10");
    expect(first).toContain("Shared job paid cap: $40.00, including all descendants");
    expect(notify("alpha")).toEqual([]);
    request(f.db, "second", ["root"], 10);
    expect(notify("alpha")[0]).toContain("root-cap:0.5"); expect(notify("alpha")).toEqual([]);
    request(f.db, "third", ["root"], 4);
    expect(notify("alpha")[0]).toContain("USD:25");
    expect(creditUsageFeedback(f.sy)("alpha")[0]).toContain("$26.0000 measured job-tree exposure");
    expect(notify("beta")).toEqual([]);
  });

  it("does not alert at zero spend/zero cap or silently invent a historical cap", () => {
    const f = fixture(); f.task("zero", undefined, "alpha", 0); f.task("historical", undefined, "alpha", null);
    const notify = creditUsageFeedback(f.sy);
    expect(notify("alpha")).toEqual([]);
    request(f.db, "old", ["historical"], 10);
    expect(notify("alpha").join(" ")).toContain("No explicit job paid cap was recorded");
  });

  it("honors alert disable and reports unreadable accounting without disrupting callers", () => {
    const f = fixture({ credit_usage_alerts: { enabled: false } }); f.task("root"); request(f.db, "large", ["root"], 100);
    expect(creditUsageFeedback(f.sy)("alpha")).toEqual([]);
    const g = fixture();
    const broken = creditUsageFeedback({ projectContext: g.sy.projectContext, projectStores: () => { throw new Error("private path never emitted"); } });
    expect(broken("alpha")[0]).toContain("No zero-spend"); expect(broken("alpha")).toEqual([]);
  });

  it("appends notices on policy-change and error responses while preserving the first payload", async () => {
    const f = fixture(); f.task("root"); request(f.db, "first", ["root"], 12);
    const server = buildMcpServer({ sy: f.sy, cfg: f.cfg, project: "alpha" });
    const [ct, st] = InMemoryTransport.createLinkedPair(); await server.connect(st);
    const client = new Client({ name: "credit-usage-test", version: "1" }); await client.connect(ct);
    cleanups.push(async () => { await client.close(); await server.close(); });
    const result = await client.callTool({ name: "set_supervision_policy", arguments: { instructions: "Synthetic change", reason: "Explicit synthetic instruction" } });
    const blocks = result.content as Array<{ text: string }>;
    expect(result.isError).toBeFalsy(); expect(JSON.parse(blocks[0]!.text)).toMatchObject({ instructions: "Synthetic change" });
    expect(blocks.slice(1).map(block => block.text).join(" ")).toContain("credit usage notice for FINAL");
    expect((await client.callTool({ name: "get_supervision_policy", arguments: {} })).content).toHaveLength(1);
    request(f.db, "higher", ["root"], 15);
    const failed = await client.callTool({ name: "collect_results", arguments: { taskIds: ["missing"] } });
    expect(failed.isError).toBe(true); const errors = failed.content as Array<{ text: string }>;
    expect(errors[0]!.text).toBe("synthetic unavailable result"); expect(errors[1]!.text).toContain("USD:25");
    request(f.db, "foreign", [f.task("beta-root", undefined, "beta")], 100, { project: "beta" });
    const beta = await client.callTool({ name: "collect_results", arguments: { taskIds: ["missing"], project: "beta" } });
    expect((beta.content as Array<{ text: string }>)[1]!.text).toContain("project beta");
  });

  it("resumes the exact saved supervisor submission through MCP with scoped outcomes and pending errors", async () => {
    const f = fixture();
    const calls: Array<{ ref: string; project: string }> = [];
    f.sy.resumeSupervisorSubmission = async (ref, project) => {
      calls.push({ ref, project });
      if (ref === "artifact:pending") throw new Error("supervisor_qualification_pending: original intent retained in artifact:pending");
      return [{ taskId: "actual-task-id", state: "queued", deduplicated: true }];
    };
    const server = buildMcpServer({ sy: f.sy, cfg: f.cfg, project: "alpha" });
    const [ct, st] = InMemoryTransport.createLinkedPair(); await server.connect(st);
    const client = new Client({ name: "submission-resume-test", version: "1" }); await client.connect(ct);
    cleanups.push(async () => { await client.close(); await server.close(); });
    const result = await client.callTool({ name: "resume_supervisor_submission", arguments: { submissionRef: "artifact:saved" } });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse((result.content as Array<{ text: string }>)[0]!.text)).toEqual({ submitted: [{ taskId: "actual-task-id", state: "queued", deduplicated: true }] });
    expect(calls).toEqual([{ ref: "artifact:saved", project: "alpha" }]);
    const pending = await client.callTool({ name: "resume_supervisor_submission", arguments: { submissionRef: "artifact:pending", project: "beta" } });
    expect(pending.isError).toBe(true);
    expect((pending.content as Array<{ text: string }>)[0]!.text).toBe("supervisor_qualification_pending: original intent retained in artifact:pending");
    expect(calls.at(-1)).toEqual({ ref: "artifact:pending", project: "beta" });
    const invalid = await client.callTool({ name: "resume_supervisor_submission", arguments: { submissionRef: "file:///foreign" } });
    expect(invalid.isError).toBe(true); expect(calls).toHaveLength(2);
    const foreign = await client.callTool({ name: "resume_supervisor_submission", arguments: { submissionRef: "artifact:saved", project: "missing" } });
    expect(foreign.isError).toBe(true); expect(calls).toHaveLength(2);
  });
});
