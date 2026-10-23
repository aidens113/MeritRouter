import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import YAML from "yaml";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { baseConfig, makeEnv, open, ScriptedClient, reply, servedFor, type Env } from "./helpers.js";
import { supervisionPolicy, setSupervisionPolicy } from "../src/admin/client-supervision.js";
import * as validation from "../src/core/validate.js";
import { scopedMcpTasks, guardMcpResume } from "../src/mcp/client-supervision.js";
import { parseConfig } from "../src/config/load.js";
import { ConfigSchema } from "../src/config/schema.js";
let env: Env | undefined;
afterEach(() => { env?.cleanup(); env = undefined; });
const content = (value: unknown) => (value as { content: Array<{text: string}> }).content;

describe("external client supervision", () => {
  it("defaults final dispatch off; strictly validates narrow writes and preserves unrelated YAML/comments", async () => {
    env = makeEnv(); const sy = open(env, new ScriptedClient(() => reply("{}")));
    try {
      writeFileSync(env.cfg.configPath, readFileSync(env.cfg.configPath, "utf8") + "\n# keep this comment\n");
      const original = YAML.parse(readFileSync(env.cfg.configPath, "utf8"));
      expect(supervisionPolicy(sy)).toMatchObject({ dispatch_final_supervisor: false, instructions: "", effectiveInstructions: expect.stringContaining("Delegate as much practical work") });
      for (const bad of [{ reason: "why" }, { dispatch_final_supervisor: false, reason: " " }, { dispatch_final_supervisor: false, reason: "why", paid: true }, { instructions: "x".repeat(8001), reason: "why" }]) expect(() => setSupervisionPolicy(sy, bad)).toThrow();
      expect(() => ConfigSchema.parse({ ...original, client_supervision: { dispatch_final_supervisor: "yes" } })).toThrow();
      expect(setSupervisionPolicy(sy, { dispatch_final_supervisor: true, reason: "User permits project supervisor" })).toMatchObject({ dispatch_final_supervisor: true, reason: "User permits project supervisor" });
      expect(setSupervisionPolicy(sy, { dispatch_final_supervisor: true, instructions: "Check browser behavior", reason: "User customization" }).effectiveInstructions).toContain("Human customization:\nCheck browser behavior");
      const changed = YAML.parse(readFileSync(env.cfg.configPath, "utf8")); delete changed.client_supervision; expect(changed).toEqual(original);
      expect(readFileSync(env.cfg.configPath, "utf8")).toContain("# keep this comment");
    } finally { await sy.close(); }
  });

  it("guards root/custom-mode/parent dispatch atomically and legacy resumes while allowing bounded supervisors", async () => {
    const config = baseConfig();
    env = makeEnv({ config: { ...config, profiles: { ...config.profiles, supervise: { mode: "supervisor", tools: "supervisor", min_total_parameters_b: 30, max_model_requests: 10 }, inspect: { ...config.profiles.inspect, mode: "supervisor", tools: "supervisor" } } } });
    const sy = open(env, new ScriptedClient(() => reply("{}")));
    const task = { profile: "supervise", goal: "Bounded implementation", repositoryAliases: ["core"], constraints: { acceptanceCriteria: ["Bounded feature works"] }, hints: { difficulty: "T1" } };
    const count = () => sy.db.prepare("SELECT COUNT(*) n FROM tasks").get();
    try {
      const before = count();
      expect(() => scopedMcpTasks(sy, "demo", [{ ...task, supervisionScope: "project" }])).toThrow(/disabled/);
      expect(() => scopedMcpTasks(sy, "demo", [task, { ...task, profile: "inspect", supervisionScope: "project" }])).toThrow(/disabled/);
      expect(count()).toEqual(before);
      expect(() => scopedMcpTasks(sy, "demo", [{ ...task, parentTaskId: "bogus" }])).toThrow(/same-project supervisor/);
      const specs = scopedMcpTasks(sy, "demo", [task]); expect(specs[0]!.supervisionScope).toBe("subtask");
      const [bounded] = await sy.submitTasks(specs, { project: "demo" });
      expect(sy.tasks.get(bounded!.taskId)!.spec.supervisionScope).toBe("subtask");
      expect(() => guardMcpResume(sy, "demo", bounded!.taskId)).not.toThrow();
      expect(() => scopedMcpTasks(sy, "demo", [{ ...task, parentTaskId: bounded!.taskId, supervisionScope: "project" }])).toThrow(/child task/);
      expect(scopedMcpTasks(sy, "demo", [{ ...task, parentTaskId: bounded!.taskId }])[0]!.supervisionScope).toBe("subtask");
      const legacy = await sy.startJob({ goal: "Legacy root", repositories: ["core"] });
      expect(sy.tasks.get(legacy!.taskId)?.spec.supervisionScope).toBeUndefined();
      expect(() => guardMcpResume(sy, "demo", legacy!.taskId)).toThrow(/disabled/);
      setSupervisionPolicy(sy, { dispatch_final_supervisor: true, reason: "Explicit user permits final dispatch" });
      expect(scopedMcpTasks(sy, "demo", [{ ...task, supervisionScope: "project" }])[0]!.supervisionScope).toBe("project");
      expect(() => guardMcpResume(sy, "demo", legacy!.taskId)).not.toThrow();
      expect(() => guardMcpResume(sy, "other", bounded!.taskId)).toThrow(/unknown task/);
    } finally { await sy.close(); }
  });

  it("rechecks project permission inside insertion lock after asynchronous validation", async () => {
    const cfg = baseConfig(); env = makeEnv({ config: { ...cfg, profiles: { ...cfg.profiles, supervise: { mode: "supervisor", tools: "supervisor", min_total_parameters_b: 30, max_model_requests: 10 } } } });
    const sy = open(env, new ScriptedClient(() => reply("{}")));
    let release!: () => void; let entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; }); const validated = new Promise<void>(resolve => { entered = resolve; });
    const original = validation.validateTask;
    const spy = vi.spyOn(validation, "validateTask").mockImplementationOnce(async (...args) => { const result = await original(...args); entered(); await held; return result; });
    try {
      setSupervisionPolicy(sy, { dispatch_final_supervisor: true, reason: "Explicit permission before validation" });
      const pending = sy.startJob({ goal: "Project job races revocation", repositories: ["core"], supervisionScope: "project" });
      await validated;
      setSupervisionPolicy(sy, { dispatch_final_supervisor: false, reason: "Explicit revocation while validation held" });
      const before = sy.db.prepare("SELECT COUNT(*) n FROM tasks").get();
      const rejected = expect(pending).rejects.toThrow(/final project supervisor is disabled/); release(); await rejected;
      expect(sy.db.prepare("SELECT COUNT(*) n FROM tasks").get()).toEqual(before);
      await expect(sy.startJob({ goal: "Direct core explicit project refused", repositories: ["core"], supervisionScope: "project" })).rejects.toThrow(/disabled/);
      await expect(sy.startJob({ goal: "CLI legacy default unaffected", repositories: ["core"] })).resolves.toHaveProperty("taskId");
      await expect(sy.startJob({ goal: "Bounded remains available", repositories: ["core"], supervisionScope: "subtask" })).resolves.toHaveProperty("taskId");
    } finally { release(); spy.mockRestore(); await sy.close(); }
  });

  it("rejects cross-project/non-supervisor parents and unsupported project profile overrides", async () => {
    const cfg = baseConfig();
    env = makeEnv({ config: { ...cfg, repositories: {}, brain: { project: "alpha", path: "brain" }, projects: { alpha: { repositories: { core: { path: "repo" } } }, beta: { repositories: { core: { path: "repo" } } } }, profiles: { ...cfg.profiles, supervise: { mode: "supervisor", tools: "supervisor", min_total_parameters_b: 30, max_model_requests: 10 } } } });
    const sy = open(env, new ScriptedClient(() => reply("{}")));
    const task = { profile: "supervise", goal: "bounded", repositoryAliases: ["core"], constraints: { acceptanceCriteria: ["done"] } };
    try {
      const parent = await sy.startJob({ goal: "parent", repositories: ["core"], project: "alpha", supervisionScope: "subtask" });
      expect(() => scopedMcpTasks(sy, "beta", [{ ...task, parentTaskId: parent.taskId }])).toThrow(/same-project supervisor/);
      const [worker] = await sy.submitTasks([{ ...task, profile: "summarize" }], { project: "alpha" });
      expect(() => scopedMcpTasks(sy, "alpha", [{ ...task, parentTaskId: worker!.taskId }])).toThrow(/same-project supervisor/);
      const raw = YAML.parseDocument(readFileSync(env.cfg.configPath, "utf8")); raw.setIn(["projects", "alpha", "profiles"], { inspect: { mode: "supervisor" } });
      writeFileSync(env.cfg.configPath, raw.toString());
      expect(() => parseConfig(raw.toJSON(), env!.cfg.configPath)).toThrow(/profiles/);
    } finally { await sy.close(); }
  });

  it("runs bounded supervisor with explicit outer-owner role text", async () => {
    const cfg = baseConfig(); env = makeEnv({ config: { ...cfg, profiles: { ...cfg.profiles, supervise: { mode: "supervisor", tools: "supervisor", min_total_parameters_b: 30, max_model_requests: 10, classify: "never" } } } });
    let sawBounded = false; let sy: ReturnType<typeof open>;
    const client = new ScriptedClient(req => { sawBounded ||= String(req.messages[0]?.content).includes("Bounded delegated subtask: Claude/Codex"); return reply(null, { ...servedFor(sy, req), toolCalls: [{ id: "finish", type: "function", function: { name: "finish_job", arguments: JSON.stringify({ status: "completed", summary: "Bounded feature complete; external final review outstanding", verified: [], not_verified: ["External project integration and acceptance"] }) } }] }); });
    sy = open(env, client, { worker: true });
    try { const job = await sy.startJob({ goal: "Bounded feature", repositories: ["core"], supervisionScope: "subtask" }); await sy.awaitResults([job.taskId], { timeoutSeconds: 30 }); expect(sawBounded).toBe(true); } finally { await sy.close(); }
  }, 40000);

  for (const transport of ["stdio", "http"] as const) it(`initializes and updates a live ${transport} connection exactly once`, async () => {
    const cfg = baseConfig();
    env = makeEnv({ config: { ...cfg, profiles: { ...cfg.profiles, supervise: { mode: "supervisor", tools: "supervisor", min_total_parameters_b: 30, max_model_requests: 10 }, inspect: { ...cfg.profiles.inspect, mode: "supervisor", tools: "supervisor" } } } }); const client = new Client({ name: "supervision-policy-test", version: "1" }); let child: ChildProcess | undefined;
    const args = [path.resolve("dist/cli.js"), "mcp", "--config", env.cfg.configPath, "--no-worker"];
    const processEnv = { PATH: process.env.PATH ?? "", MERITROUTER_PANEL_DIR: path.join(env.dir, "no-panel") };
    try {
      if (transport === "stdio") await client.connect(new StdioClientTransport({ command: process.execPath, args, env: processEnv }));
      else {
        child = spawn(process.execPath, [...args, "--http", "--port", "0"], { env: processEnv, stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
        const url = await new Promise<string>((resolve, reject) => { let output = ""; const timer = setTimeout(() => reject(new Error(output)), 30000); child!.stderr!.on("data", chunk => { output += chunk; const match = /at (http:\/\/\S+\/mcp)/.exec(output); if (match) { clearTimeout(timer); resolve(match[1]!); } }); child!.once("exit", code => { clearTimeout(timer); reject(new Error(`MCP exited ${code}: ${output}`)); }); });
        await client.connect(new StreamableHTTPClientTransport(new URL(url)));
      }
      expect(client.getInstructions()).toContain("responsible for the user's intended project outcome");
      let result = await client.callTool({ name: "get_supervision_policy", arguments: {} }); expect(content(result)).toHaveLength(1); expect(JSON.parse(content(result)[0]!.text).dispatch_final_supervisor).toBe(false);
      const denied = await client.callTool({ name: "start_job", arguments: { goal: "Whole project", repositories: ["core"], supervisionScope: "project" } }); expect(denied.isError).toBe(true); expect(content(denied)[0]!.text).toContain("disabled");
      const custom = await client.callTool({ name: "submit_tasks", arguments: { tasks: [{ profile: "inspect", goal: "Whole project", supervisionScope: "project", repositoryAliases: ["core"], constraints: { acceptanceCriteria: ["done"] } }] } }); expect(custom.isError).toBe(true); expect(content(custom)[0]!.text).toContain("disabled");
      const bounded = await client.callTool({ name: "start_job", arguments: { goal: "Implement one bounded feature", repositories: ["core"] } }); expect(bounded.isError).toBeFalsy(); const boundedBody = JSON.parse(content(bounded)[0]!.text); expect(boundedBody).toMatchObject({ supervisionScope: "subtask", finalOwner: "external-client" });
      const reader = open(env, new ScriptedClient(() => reply("{}")));
      let legacyId: string; let sessionId: string;
      try {
        expect(reader.db.prepare("SELECT COUNT(*) n FROM tasks").get()).toMatchObject({ n: 1 });
        expect(reader.tasks.get(boundedBody.taskId)!.spec.supervisionScope).toBe("subtask");
        const legacy = await reader.startJob({ goal: "Legacy final supervisor", repositories: ["core"] }); legacyId = legacy.taskId;
        reader.db.prepare("UPDATE tasks SET state='interrupted' WHERE id=?").run(legacyId);
        const session = reader.sessions.create({ taskId: legacyId, jobId: legacyId, role: "supervisor", agentLabel: "legacy" }); sessionId = session.id;
      } finally { await reader.close(); }
      for (const call of [{ name: "resume_task", arguments: { taskId: legacyId! } }, { name: "resume_session", arguments: { sessionId: sessionId! } }]) { const resumed = await client.callTool(call); expect(resumed.isError).toBe(true); expect(content(resumed)[0]!.text).toContain("disabled"); }
      result = await client.callTool({ name: "set_supervision_policy", arguments: { dispatch_final_supervisor: true, reason: "Explicit user request" } }); expect(result.isError).toBeFalsy(); expect(content(result)).toHaveLength(1); expect(JSON.parse(content(result)[0]!.text).dispatch_final_supervisor).toBe(true);
      result = await client.callTool({ name: "get_supervision_policy", arguments: {} }); expect(content(result)).toHaveLength(1);
      const finalJob = await client.callTool({ name: "start_job", arguments: { goal: "Explicitly authorized final project job", repositories: ["core"], supervisionScope: "project" } }); expect(finalJob.isError).toBeFalsy(); expect(JSON.parse(content(finalJob)[0]!.text)).toMatchObject({ supervisionScope: "project", finalOwner: "meritrouter" });
      const disabledClient = new Client({ name: "disabled-initialize", version: "1" });
      try { await disabledClient.connect(new StdioClientTransport({ command: process.execPath, args, env: processEnv })); expect(disabledClient.getInstructions()).toContain("final supervisors are permitted"); expect(disabledClient.getInstructions()).toContain("Delegate as much practical work"); } finally { await disabledClient.close(); }
      const raw = YAML.parseDocument(readFileSync(env.cfg.configPath, "utf8")); raw.setIn(["client_supervision", "dispatch_final_supervisor"], false); raw.setIn(["client_supervision", "instructions"], "UI-originated custom plan"); writeFileSync(env.cfg.configPath, raw.toString());
      result = await client.callTool({ name: "job_status", arguments: { jobId: "missing" } }); expect(result.isError).toBe(true); expect(content(result)[0]!.text).toBe("unknown job missing"); expect(content(result)).toHaveLength(2); expect(content(result)[1]!.text).toContain("UI-originated custom plan");
      result = await client.callTool({ name: "get_supervision_policy", arguments: {} }); expect(content(result)).toHaveLength(1); expect(JSON.parse(content(result)[0]!.text).instructions).toBe("UI-originated custom plan");
      result = await client.callTool({ name: "set_supervision_policy", arguments: { dispatch_final_supervisor: false, reason: "" } }); expect(result.isError).toBe(true);
    } finally { await client.close(); if (child && child.exitCode === null && child.signalCode === null) { const stopped = new Promise(resolve => child!.once("exit", resolve)); child.kill(); await stopped; } }
  }, 60000);
});
