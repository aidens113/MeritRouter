import { afterEach, describe, expect, it } from "vitest";
import type { MeritRouter } from "../src/core/service.js";
import { WorkerTaskSchema } from "../src/core/task.js";
import { syntheticResult, type ClaimLimits } from "../src/storage/tasks.js";
import { SupervisorChannelStore } from "../src/storage/supervisor-channel.js";
import { toolRefs } from "../src/core/channel.js";
import { exportExchanges, exchangeRecordLine, type ExchangeRecord } from "../src/admin/exchange-export.js";
import { makeEnv, open, reply, ScriptedClient, type Env } from "./helpers.js";

let env: Env | undefined;
let sy: MeritRouter | undefined;
afterEach(async () => {
  await sy?.close();
  sy = undefined;
  env?.cleanup();
  env = undefined;
});

const LIMITS: ClaimLimits = { maxConcurrent: 10, maxWritersPerRepo: 10, leaseMs: 600_000, defaultTimeoutMs: 600_000 };

async function collect(it: AsyncIterable<ExchangeRecord>): Promise<ExchangeRecord[]> {
  const out: ExchangeRecord[] = [];
  for await (const r of it) out.push(r);
  return out;
}

describe("exportExchanges", () => {
  it("yields one record per task with its brief, messages in order, rendered report, checks and rework lineage", async () => {
    env = makeEnv();
    sy = open(env, new ScriptedClient(() => reply("unused", { model: "m", provider: "p" })), { worker: false });
    const project = sy.projects.primary.project.slug;

    sy.tasks.submit(
      [
        WorkerTaskSchema.parse({
          id: "t_1",
          profile: "implement",
          goal: "Add a --json flag to the status command in src/cli.ts",
          repositoryAliases: ["core"],
          writableRepository: "core",
          constraints: { acceptanceCriteria: ["status --json works"], allowedPaths: ["src/cli.ts"], checks: ["pnpm test"] },
          label: "cli-json",
        }),
      ],
      { project },
    );
    sy.tasks.claim("owner-1", LIMITS);
    const store = new SupervisorChannelStore(sy.db);
    const { message: q } = store.post({ taskId: "t_1", direction: "worker_to_supervisor", kind: "question", body: "Use Bearer sk-ant-abcdefgh12345678 for the test fixture?" });
    store.answer(q.id, { kind: "answer", body: "No, use a fake token." });
    const { message: tr } = store.post({ taskId: "t_1", direction: "worker_to_supervisor", kind: "tool_request", body: "need write", refs: toolRefs(["write_file"]) });
    store.answer(tr.id, { kind: "grant", body: "granted", refs: toolRefs(["write_file"]) });

    sy.tasks.finish("t_1", "owner-1", {
      ...syntheticResult("t_1", "completed", "done"),
      acceptanceStatus: "met",
      checks: [{ command: "pnpm test", exitCode: 0, logRef: "log:1" }],
      servedEndpoints: ["openrouter/vendor/big-a:free"],
    }, "completed");

    sy.tasks.submit(
      [WorkerTaskSchema.parse({ id: "t_2", profile: "inspect", goal: "Find why the status command is slow", repositoryAliases: ["core"], constraints: { acceptanceCriteria: ["found"] } })],
      { project },
    );
    sy.tasks.claim("owner-2", LIMITS);
    sy.tasks.finish("t_2", "owner-2", { ...syntheticResult("t_2", "completed", "done"), acceptanceStatus: "met" }, "completed");
    store.recordRework({ taskId: "t_2", reworkOf: "t_1" });

    const records = await collect(exportExchanges(sy, { project }));
    expect(records.map((r) => r.taskId)).toEqual(["t_1", "t_2"]);

    const r1 = records[0]!;
    expect(r1.brief.goal).toBe("Add a --json flag to the status command in src/cli.ts");
    expect(r1.brief.allowedPaths).toEqual(["src/cli.ts"]);
    expect(r1.brief.checks).toEqual(["pnpm test"]);
    expect(r1.toolGrants).toEqual(["write_file"]);
    // Oldest first: question, its answer, then the tool_request and its grant.
    expect(r1.messages.map((m) => m.kind)).toEqual(["question", "answer", "tool_request", "grant"]);
    expect(r1.checks).toEqual([{ command: "pnpm test", exitCode: 0, logRef: "log:1" }]);
    expect(r1.servedEndpoints).toEqual(["openrouter/vendor/big-a:free"]);
    expect(r1.rework.reworksTask).toBeNull();
    expect(r1.rework.reworkedBy).toEqual(["t_2"]);
    expect(r1.report).toContain("## Outcome");

    const r2 = records[1]!;
    expect(r2.rework.reworksTask).toBe("t_1");
    expect(r2.rework.reworkedBy).toEqual([]);

    // Secret-shaped text is redacted everywhere, including inside a channel message body.
    const serialized = records.map(exchangeRecordLine).join("\n");
    expect(serialized).not.toContain("sk-ant-abcdefgh12345678");
    expect(serialized).toContain("[redacted]");
    // Each line is valid JSON (the JSONL contract).
    for (const line of serialized.split("\n")) expect(() => JSON.parse(line)).not.toThrow();
  });

  it("omits tasks before `since`", async () => {
    env = makeEnv();
    sy = open(env, new ScriptedClient(() => reply("unused", { model: "m", provider: "p" })), { worker: false });
    const project = sy.projects.primary.project.slug;
    sy.tasks.submit([WorkerTaskSchema.parse({ id: "t_old", profile: "inspect", goal: "old work item here", repositoryAliases: ["core"], constraints: { acceptanceCriteria: ["x"] } })], { project });
    sy.tasks.claim("o", LIMITS);
    sy.tasks.finish("t_old", "o", { ...syntheticResult("t_old", "completed", "done"), acceptanceStatus: "met" }, "completed");

    const cutoff = Date.now() + 10_000;
    sy.db.prepare("UPDATE tasks SET created_at = ? WHERE id = 't_old'").run(cutoff - 20_000);
    const records = await collect(exportExchanges(sy, { project, since: cutoff }));
    expect(records).toEqual([]);
  });
});
