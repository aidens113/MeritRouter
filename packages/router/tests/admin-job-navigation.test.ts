import { afterEach, describe, expect, it } from "vitest";
import type { Switchyard } from "../src/core/service.js";
import { WorkerTaskSchema } from "../src/core/task.js";
import { jobDetail } from "../src/admin/jobs.js";
import { jobTeam } from "../src/admin/job-team.js";
import { requestLog, requestLogCount } from "../src/admin/insights.js";
import { baseConfig, makeEnv, open, reply, ScriptedClient, type Env } from "./helpers.js";
let env: Env | undefined, sy: Switchyard | undefined;
afterEach(async () => { await sy?.close(); sy = undefined; env?.cleanup(); env = undefined; });
function setup() {
  const cfg = baseConfig({ repositories: {}, projects: { alpha: { repositories: { core: { path: "repo" } } }, beta: { repositories: { core: { path: "repo" } } } } });
  env = makeEnv({ config: cfg }); sy = open(env, new ScriptedClient(() => reply("unused")), { worker: false });
  const task = (id: string, parentTaskId?: string, profile = "inspect") => WorkerTaskSchema.parse({ id, parentTaskId, profile, goal: id, repositoryAliases: ["core"], constraints: { acceptanceCriteria: ["done"] } });
  sy.tasks.submit([task("job", undefined, "supervise"), task("child", "job"), task("subjob", "job", "supervise"), task("nested", "subjob"), task("other")], { project: "alpha" });
  sy.tasks.submit([task("foreign", "job")], { project: "beta" });
  sy.db.prepare("INSERT INTO executions(id,kind,profile,status,created_at) VALUES ('nav-exec','task','inspect','completed',1)").run();
  const request = (id: string, tasks: string[], purpose = "tool_loop", cached: number | null = null) => {
    sy!.db.prepare("INSERT INTO model_requests(id,execution_id,purpose,gateway_model,status,reserved_at,est_input_tokens,reserved_output_tokens,project_id,cached_input_tokens) VALUES (?,'nav-exec',?,'fixture/model','succeeded',1,10,10,'alpha',?)").run(id,purpose,cached);
    for (const task of tasks) sy!.db.prepare("INSERT INTO request_charges(request_id,task_id,input_tokens,output_tokens) VALUES (?,?,1,1)").run(id,task);
  };
  return { s: sy, request };
}
describe("job navigation data", () => {
  it("lists unplanned children and nested jobs, excluding forged foreign descendants", () => {
    const { s } = setup();
    expect(jobDetail(s,"job",{transcript:false})!.children.map(t=>t.taskId)).toEqual(["child","subjob"]);
    const tree=jobTeam(s,"job")!.tree;
    expect(tree.children.map(t=>t.taskId)).toEqual(["child","subjob"]);
    expect(tree.children[1]!.children[0]!.taskId).toBe("nested");
  });
  it("includes supervisor and all descendant requests once per batch and enforces stored project scope", () => {
    const { s, request } = setup();
    request("root",["job"]); request("batch",["child","nested"]); request("sub",["subjob"]); request("unrelated",["other"]); request("forged",["foreign"]);
    expect(requestLog(s,{jobId:"job",project:"alpha"}).map(r=>r.id).sort()).toEqual(["batch","root","sub"]);
    expect(requestLogCount(s,{jobId:"job",project:"alpha"})).toBe(3);
    expect(requestLog(s,{jobId:"job",project:"beta"})).toEqual([]);
    expect(requestLog(s,{jobId:"child"})).toEqual([]);
    expect(requestLog(s,{jobId:"missing"})).toEqual([]);
    request("mixed",["child","foreign"]);
    expect(requestLog(s,{jobId:"job"}).find(r=>r.id==="mixed")!.taskIds).toEqual(["child"]);
  });
  it("filters before limiting, pages deterministically, and preserves unknown versus measured zero cache", () => {
    const { s, request } = setup();
    request("a",["child"],"wanted",null);request("b",["child"],"wanted",0);request("z",["child"],"other");
    expect(requestLogCount(s,{jobId:"job",purpose:"wanted"})).toBe(2);
    expect(requestLog(s,{jobId:"job",purpose:"wanted",limit:1})).toMatchObject([{id:"b",cachedInputTokens:0}]);
    expect(requestLog(s,{jobId:"job",purpose:"wanted",limit:1,offset:1})).toMatchObject([{id:"a",cachedInputTokens:null}]);
  });
});
