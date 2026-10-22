import { afterEach, describe, expect, it, vi } from "vitest";
import { appendFileSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { requestEvidence, REQUEST_EVIDENCE_LIMITS } from "../src/admin/request-evidence.js";
import { requestDetail } from "../src/admin/entities.js";
import { baseConfig, makeEnv, open, reply, ScriptedClient, summarizeTask, type Env } from "./helpers.js";
import type { Switchyard } from "../src/core/service.js";
import type { SessionRecorder } from "../src/sessions/recorder.js";
import type { ChatMessage } from "../src/gateway/types.js";
let env: Env | undefined, sy: Switchyard | undefined;
afterEach(async () => { await sy?.close(); sy = undefined; env?.cleanup(); env = undefined; vi.restoreAllMocks(); });
async function setup() {
  env = makeEnv({ config: baseConfig({ repositories: {}, brain: { project: "alpha", path: "brain" }, projects: { alpha: { repositories: { core: { path: "repo" } } }, beta: { repositories: { core: { path: "repo" } } } } }) });
  sy = open(env, new ScriptedClient(() => reply("{}")));
  const [a] = await sy.submitTasks([summarizeTask({ idempotencyKey: "alpha-a" })], { project: "alpha" });
  const [b] = await sy.submitTasks([summarizeTask({ idempotencyKey: "alpha-b" })], { project: "alpha" });
  const [foreign] = await sy.submitTasks([summarizeTask({ idempotencyKey: "beta" })], { project: "beta" });
  sy.db.prepare("INSERT INTO executions(id,kind,profile,status,created_at) VALUES ('shared-execution','batch','summarize','completed',1)").run();
  function request(id: string, tasks = [a!.taskId], status = "succeeded") {
    sy!.db.prepare("INSERT INTO model_requests(id,execution_id,purpose,gateway_model,status,reserved_at,finished_at,est_input_tokens,reserved_output_tokens,project_id) VALUES (?,'shared-execution','work','fixture/model',?,1,2,100,100,'alpha')").run(id, status);
    for (const task of tasks) sy!.db.prepare("INSERT INTO request_charges(request_id,task_id,input_tokens,output_tokens,tokens_exact) VALUES (?,?,10,20,1)").run(id, task);
  }
  function session(task = a!.taskId) { return sy!.sessions.create({ taskId: task, role: "implementer", profile: "summarize", agentLabel: "implementer:evidence" }); }
  return { s: sy, a: a!.taskId, b: b!.taskId, foreign: foreign!.taskId, request, session };
}
function input(rec: SessionRecorder, content = "Selected request input", extra: ChatMessage[] = []) {
  const messages: ChatMessage[] = [{ role: "system", content: "Recorded charter" }, { role: "user", content }, ...extra];
  rec.syncMessages(messages);
  rec.modelRequest({ executionId: "shared-execution", purpose: "work", chat: { messages, max_tokens: 321, temperature: 0.25, tool_choice: "auto", response_format: { type: "json_object" }, tools: [{ type: "function", function: { name: "write_file", description: "fixture", parameters: {} } }] } });
}
function response(rec: SessionRecorder, requestId: string, toolCalls: Array<{id:string;type:"function";function:{name:string;arguments:string}}> = []) {
  rec.append("model_response", { requestId, endpointId: "fixture/model", content: "Exact recorded response", toolCalls, finishReason: "stop", usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: null, reasoningTokens: null, reportedCostUsd: null, basis: "provider_reported" }, servedModel: "fixture-model", servedProvider: "fixture", attempts: [], estimatedInputTokens: 100 });
}
describe("bounded model request evidence", () => {
  it("replays rewritten input as of exact requestId, preserves params and correlates only recorded actions", async () => {
    const f = await setup(); f.request("r_old"); f.request("r_selected"); f.request("r_future"); const rec = f.session();
    input(rec, "Old request input"); response(rec, "r_old");
    input(rec, "Selected request input");
    response(rec, "r_selected", [
      { id: "edit", type: "function", function: { name: "write_file", arguments: JSON.stringify({path:"src/recorded.ts",content:"<script>window.evidenceInjected=true</script>",headers:{Authorization:"Bearer fixture-private-secret"}}) } },
      { id: "unknown", type: "function", function: { name: "write_file", arguments: '{"path":"unconfirmed.ts"}' } },
      { id: "failed", type: "function", function: { name: "delete_file", arguments: '{"path":"failed.ts"}' } },
    ]);
    const edit = rec.toolIntent({ callId: "edit", name: "write_file", args: { path: "src/recorded.ts", headers: { Authorization: "Bearer fixture-private-secret" } }, sideEffect: "edit" }); rec.toolOutcome(edit, { ok: true, output: "wrote src/recorded.ts" });
    rec.toolIntent({ callId: "unknown", name: "write_file", args: { path: "unconfirmed.ts" }, sideEffect: "edit" });
    const failed = rec.toolIntent({ callId: "failed", name: "delete_file", args: { path: "failed.ts" }, sideEffect: "edit" }); rec.toolOutcome(failed, { ok: false, output: "refused" });
    const unrelated = rec.toolIntent({ callId: "other", name: "write_file", args: { path: "unrelated.ts" }, sideEffect: "edit" }); rec.toolOutcome(unrelated, { ok: true, output: "not from response" });
    input(rec, "FUTURE INPUT MUST NOT LEAK"); response(rec, "r_future");
    rec.setWorkspace({repos:[{alias:"core",worktree:"not-read",branch:"fixture",baseCommit:null,head:"a".repeat(40)}]}); rec.end("completed", "fixture");
    f.s.db.prepare("UPDATE tasks SET result_json=? WHERE id=?").run(JSON.stringify({summary:"Task-wide later result",changedPaths:["later-task-wide.ts"]}), f.a);
    f.s.artifacts.write({ taskId: f.a, executionId: "shared-execution", kind: "patch", label: "Related task patch", content: "not read" });
    const readArtifact = vi.spyOn(f.s.artifacts, "read").mockImplementation(() => { throw new Error("must not read artifacts"); });
    const view = requestEvidence(f.s, "alpha", "r_selected")!;
    expect(view.state).toBe("available"); expect(view.exchanges).toHaveLength(1);
    expect(view.exchanges[0]!.input.map(m=>m.content)).toEqual(["Recorded charter","Selected request input"]);
    expect(view.exchanges[0]!.parameters).toMatchObject({messageCount:2,maxTokens:321,temperature:0.25,toolChoice:"auto",responseFormat:"json_object",tools:["write_file"]});
    expect(view.exchanges[0]!.actions.map(a=>({id:a.callId,file:a.file,ok:a.ok}))).toEqual([{id:"edit",file:"src/recorded.ts",ok:true},{id:"failed",file:null,ok:false},{id:"unknown",file:null,ok:null}]);
    expect(JSON.stringify(view)).not.toContain("FUTURE INPUT"); expect(JSON.stringify(view)).not.toContain("fixture-private-secret"); expect(JSON.stringify(view)).not.toContain("unrelated.ts");
    expect(view.relatedTasks[0]).toMatchObject({changedPaths:["later-task-wide.ts"],commits:[{repository:"core",sha:"a".repeat(40)}]}); expect(readArtifact).not.toHaveBeenCalled();
    expect(requestDetail(f.s,"r_selected")!.evidence?.exchanges).toHaveLength(1);
  });
  it("caps a shorter messageCount without using final transcript or correlating a failed fallback by executionId", async () => {
    const f = await setup(); f.request("r_final"); f.request("r_failed",[f.a],"failed"); const rec=f.session();
    rec.syncMessages([{role:"system",content:"keep"},{role:"user",content:"outside shorter count"}]);
    rec.append("model_request",{executionId:"shared-execution",purpose:"work",messageCount:1,maxTokens:100,temperature:null,tools:[],toolChoice:null,responseFormat:null}); response(rec,"r_final");
    expect(requestEvidence(f.s,"alpha","r_final")!.exchanges[0]!.input.map(m=>m.content)).toEqual(["keep"]);
    const failed=requestEvidence(f.s,"alpha","r_failed")!; expect(failed.state).toBe("unavailable"); expect(failed.exchanges).toEqual([]);
    expect(requestEvidence(f.s,"beta","r_final")).toBeNull();
    expect(requestDetail(f.s,"r_final","beta")).toBeNull();
  });
  it("deduplicates same-project shared batch exchanges retaining participant session links", async () => {
    const f=await setup(); f.request("r_batch",[f.a,f.b]);
    for(const task of [f.a,f.b]){const rec=f.session(task);input(rec,"Shared batch prompt");response(rec,"r_batch");rec.end("completed","batch");}
    const view=requestEvidence(f.s,"alpha","r_batch")!;expect(view.exchanges).toHaveLength(1);expect(view.exchanges[0]!.sessions).toHaveLength(2);expect(view.relatedTasks).toHaveLength(2);
  });
  it("withholds mixed-project classifier payloads before reading either session", async () => {
    const f=await setup();f.request("r_mixed",[f.a,f.foreign]);const rec=f.session();input(rec,"FOREIGN BETA GOAL MUST NEVER DISPLAY");response(rec,"r_mixed");
    const view=requestEvidence(f.s,"alpha","r_mixed")!;expect(view.state).toBe("unavailable");expect(view.exchanges).toHaveLength(0);expect(JSON.stringify(view)).not.toContain("FOREIGN");expect(view.relatedTasks.map(t=>t.taskId)).toEqual([f.a]);
    f.s.db.prepare("UPDATE model_requests SET error_message='FOREIGN provider echo',route_note='FOREIGN route text',web_citations_json=? WHERE id='r_mixed'").run(JSON.stringify([{url:"https://example.test/foreign",title:"FOREIGN citation"}]));
    const detail=requestDetail(f.s,"r_mixed")!;expect(detail.taskIds).toEqual([f.a]);expect(detail.charges.map(c=>c.taskId)).toEqual([f.a]);expect(detail.errorMessage).toBeNull();expect(detail.routeNote).toBeNull();expect(detail.webCitations).toEqual([]);
  });
  it("reports corrupt, missing, symlink and byte-capped journals without raw path/error leakage", async () => {
    const f=await setup();f.request("r_partial");const rec=f.session();input(rec);response(rec,"r_partial");appendFileSync(rec.logPath,'{"seq":');
    expect(requestEvidence(f.s,"alpha","r_partial")!.state).toBe("partial");
    rmSync(rec.logPath);expect(requestEvidence(f.s,"alpha","r_partial")!.state).toBe("unavailable");
    const foreign=path.join(env!.dir,"private-directory");mkdirSync(foreign);writeFileSync(path.join(foreign,"private-file"),"DO NOT READ PRIVATE CONTENT");symlinkSync(foreign,rec.logPath,process.platform === "win32" ? "junction" : "dir");expect(JSON.stringify(requestEvidence(f.s,"alpha","r_partial"))).not.toContain("DO NOT READ");rmSync(rec.logPath);
    writeFileSync(rec.logPath,"x".repeat(REQUEST_EVIDENCE_LIMITS.journalBytes+1000));const capped=requestEvidence(f.s,"alpha","r_partial")!;expect(capped.state).toBe("unavailable");expect(capped.warnings.join(" ")).toContain("byte limit");expect(JSON.stringify(capped)).not.toContain(env!.dir);
  });
  it("bounds long untrusted messages and surfaces display omissions", async () => {
    const f=await setup();f.request("r_long");const rec=f.session();const messages:ChatMessage[]=Array.from({length:40},(_,i)=>({role:"user",content:`${i}:`+"x".repeat(6000)}));
    rec.syncMessages(messages);rec.modelRequest({executionId:"shared-execution",purpose:"work",chat:{messages,max_tokens:100}});response(rec,"r_long");
    const view=requestEvidence(f.s,"alpha","r_long")!;expect(view.state).toBe("partial");expect(view.exchanges[0]!.response.content).toBe("Exact recorded response");expect(Buffer.byteLength(JSON.stringify(view))).toBeLessThan(150000);expect(view.warnings.join(" ")).toContain("shortened");
  });
  it("retains journal truncation flags and tolerates malformed related result metadata", async () => {
    const f=await setup();f.request("r_tools");const rec=f.session();input(rec);response(rec,"r_tools",[{id:"edit",type:"function",function:{name:"write_file",arguments:'{"path":"src/fixture.ts"}'}}]);
    const intent=rec.toolIntent({callId:"edit",name:"write_file",args:{path:"src/fixture.ts"},sideEffect:"edit"});rec.toolOutcome(intent,{ok:true,output:"x".repeat(20000)});
    const evidence=requestEvidence(f.s,"alpha","r_tools")!;expect(evidence.exchanges[0]!.actions[0]).toMatchObject({truncated:true,file:"src/fixture.ts"});expect(evidence.exchanges[0]!.actions[0]!.outcome!.length).toBeLessThan(8100);
    f.s.db.prepare("UPDATE tasks SET result_json='{' WHERE id=?").run(f.a);
    const detail=requestDetail(f.s,"r_tools")!;expect(detail.evidence?.state).toBe("partial");expect(detail.evidence?.warnings.join(" ")).toContain("malformed");
  });
});
