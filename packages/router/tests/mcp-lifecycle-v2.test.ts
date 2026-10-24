import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "../src/mcp/tools.js";
import { TaskArgumentSchema } from "../src/mcp/schemas.js";
import { supervisionPolicy, setSupervisionPolicy } from "../src/admin/client-supervision.js";
import { baseResult } from "../src/runners/types.js";
import { baseConfig, makeEnv, open, reply, ScriptedClient, summarizeTask, type Env } from "./helpers.js";
import type { MeritRouter } from "../src/core/service.js";

let env: Env | undefined;
let sy: MeritRouter | undefined;
let client: Client | undefined;
afterEach(async () => { await client?.close(); await sy?.close(); env?.cleanup(); client = undefined; sy = undefined; env = undefined; });
const body = (r: unknown) => JSON.parse((r as {content: {text: string}[]}).content[0]!.text);

describe("project-scoped external delivery lifecycle", () => {
  it("keeps FINAL ownership and makes delegated delivery the default without enabling paid routes", () => {
    env = makeEnv({config:baseConfig({client_supervision:{}})}); sy = open(env, new ScriptedClient(() => reply("{}")));
    expect(supervisionPolicy(sy)).toMatchObject({workflow:"delegated_delivery", dispatch_final_supervisor:false});
    expect(supervisionPolicy(sy).effectiveInstructions).toContain("runtime testing and repair");
    const paid = JSON.stringify(sy.cfg.paid);
    setSupervisionPolicy(sy, {workflow:"direct_tasks", reason:"User requests direct coordination"});
    expect(supervisionPolicy(sy).workflow).toBe("direct_tasks");
    expect(JSON.stringify(sy.cfg.paid)).toBe(paid);
  });

  it("advertises budget and base-commit controls without swallowing invalid runtime keys", () => {
    const parsed = TaskArgumentSchema.parse({...summarizeTask(), budget:{maxModelRequests:40,maxPaidUsd:0}, context:{baseCommits:{core:"a".repeat(40)}}});
    expect(parsed.budget?.maxModelRequests).toBe(40);
    expect(parsed.context?.baseCommits).toEqual({core:"a".repeat(40)});
  });

  it("one connection scopes collect/wait/cancel/accept/reject/resume to its explicit project", async () => {
    env = makeEnv({config:baseConfig({repositories:{},projects:{
      alpha:{repositories:{core:{path:"repo"}}},
      beta:{repositories:{core:{path:"repo"}}},
    }})});
    sy = open(env, new ScriptedClient(() => reply("{}")));
    const server = buildMcpServer({sy,cfg:env.cfg,project:"alpha"});
    const [ct,st] = InMemoryTransport.createLinkedPair();
    await server.connect(st); client = new Client({name:"final-supervisor-test",version:"1"}); await client.connect(ct);
    const tools = (await client.listTools()).tools;
    for (const name of ["collect_results","await_results","cancel_tasks","resume_task","accept_result","reject_result","resume_session","decide_budget_request"]) {
      expect(tools.find(t=>t.name===name)?.inputSchema.properties).toHaveProperty("project");
    }
    const submitted = body(await client.callTool({name:"submit_tasks",arguments:{project:"beta",tasks:[summarizeTask()]}}));
    const id = submitted.submitted[0].taskId;
    const result = {...baseResult({executionStatus:"completed",summary:"beta private result"}),taskId:id,acceptanceStatus:"not_verified"};
    sy.db.prepare("UPDATE tasks SET state='completed', result_json=? WHERE id=?").run(JSON.stringify(result),id);
    const foreign = body(await client.callTool({name:"collect_results",arguments:{taskIds:[id]}}));
    expect(foreign.completed).toEqual([]); expect(foreign.pending[0].state).toBe("unknown");
    expect(body(await client.callTool({name:"collect_results",arguments:{project:"beta",taskIds:[id]}})).completed[0].summary).toBe("beta private result");
    expect(body(await client.callTool({name:"await_results",arguments:{project:"beta",taskIds:[id],timeoutSeconds:1}})).completed).toHaveLength(1);
    expect((await client.callTool({name:"accept_result",arguments:{taskId:id,reason:"wrong scope"}})).isError).toBe(true);
    expect((await client.callTool({name:"accept_result",arguments:{project:"beta",taskId:id,reason:"independently inspected fixture"}})).isError).not.toBe(true);
    expect((await client.callTool({name:"reject_result",arguments:{project:"beta",taskId:id,reason:"final supervisor rejects fixture"}})).isError).not.toBe(true);
    const queued = body(await client.callTool({name:"submit_tasks",arguments:{project:"beta",tasks:[summarizeTask()]}})).submitted[0].taskId;
    expect((await client.callTool({name:"cancel_tasks",arguments:{taskIds:[queued]}})).isError).toBe(true);
    expect((await client.callTool({name:"cancel_tasks",arguments:{project:"beta",taskIds:[queued]}})).isError).not.toBe(true);
    await server.close();
  });
});
