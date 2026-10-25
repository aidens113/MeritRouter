import { z } from "zod";
import { LeaseRefSchema } from "../storage/task-leases.js";
import { awaitWorkerAction, outsideRepositoryPolicy, WorkerActionRequests } from "./worker-actions.js";
import type { ResolvedConfig } from "../config/load.js";
import type { HarnessTool } from "./tools.js";
import { currentSupervisorAuthority } from "../core/supervisor-authority.js";

/** Read current trusted policy; a pending request never preserves stale approval power. */
export function workerActionCapability(config: ResolvedConfig) {
  const approvalPolicy = outsideRepositoryPolicy(config);
  return { approvalPolicy, canApprove: approvalPolicy === "supervisor", waitingFor: approvalPolicy === "supervisor" ? "supervisor_decision" : approvalPolicy === "human_only" ? "human_operator" : "policy_change_or_cancellation" };
}

export function workerActionTools(): HarnessTool[] {
  return [{
    def: { type: "function", function: { name: "request_supervisor_action", description: "Request an exact command that cannot run inside your repository sandbox. This only files a request; the supervisor or operator reviews and executes it under host policy. No worker host permission is granted.", parameters: { type: "object", properties: { command: { type: "string" }, repository: { type: "string" }, timeout_seconds: { type: "integer", minimum: 1, maximum: 300 }, reason: { type: "string" } }, required: ["command", "repository", "reason"] } } },
    sideEffect: "external",
    run: async (args, env) => {
      const input = z.object({ command: z.string().trim().min(1).max(16000), repository: z.string().min(1), timeout_seconds: z.number().int().min(1).max(300).default(60), reason: z.string().trim().min(1).max(4000) }).strict().parse(args);
      if (!env.ctx.spec.repositoryAliases.includes(input.repository)) throw new Error("supervisor action must name an assigned repository alias");
      const reader = env.readers.get(input.repository);
      if (!reader) throw new Error("repository is unavailable to this task");
      const invocationId = (env as typeof env & { toolInvocationId?: string }).toolInvocationId;
      return JSON.stringify(await new WorkerActionRequests(env.ctx.tasks.db, env.ctx.now).file(env.ctx, { command: input.command, cwd: reader.root, timeoutMs: input.timeout_seconds * 1000, reason: input.reason, invocationId }));
    },
  }, {
    def: { type: "function", function: { name: "await_supervisor_action", description: "Wait without model requests for your exact supervisor action decision. The task lease and cancellation remain enforced.", parameters: { type: "object", properties: { id: { type: "string" }, timeout_seconds: { type: "integer", minimum: 1, maximum: 60 } }, required: ["id"] } } },
    sideEffect: "read", repeatBehavior: "execute",
    run: async (args, env) => {
      const input = z.object({ id: z.string().min(1), timeout_seconds: z.number().int().min(1).max(60).default(60) }).strict().parse(args);
      const lease = LeaseRefSchema.parse(env.ctx.taskLease);
      const row = new WorkerActionRequests(env.ctx.tasks.db, env.ctx.now).get(lease.project, input.id);
      if (!row || row.taskId !== env.ctx.taskId || row.action.lease.incarnation !== lease.incarnation || row.action.lease.runCount !== lease.runCount) throw new Error("unknown action for this task generation");
      return JSON.stringify(await awaitWorkerAction(env.ctx, row, input.timeout_seconds * 1000));
    },
  }, {
    def: { type: "function", function: { name: "supervisor_action_status", description: "Read your supervisor action request status and bounded result. Pending requests grant no host access.", parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } } },
    sideEffect: "read", repeatBehavior: "execute",
    run: async (args, env) => {
      const { id } = z.object({ id: z.string().min(1) }).strict().parse(args);
      const lease = LeaseRefSchema.parse(env.ctx.taskLease);
      const row = new WorkerActionRequests(env.ctx.tasks.db, env.ctx.now).get(lease.project, id);
      if (!row || row.taskId !== env.ctx.taskId || row.action.lease.incarnation !== lease.incarnation || row.action.lease.runCount !== lease.runCount) throw new Error("unknown action for this task generation");
      return JSON.stringify(row);
    },
  }];
}

export function supervisorActionTools(jobId: string): HarnessTool[] {
  return [{
    def: { type: "function", function: { name: "worker_action_requests", description: "List pending exact worker actions and current approval capability. canApprove:false under human_only means wait for the human operator with await_tasks; do not attempt supervisor approval or cancel work merely because approval is pending. Supervisor policy permits decide_worker_action. No worker sandbox bypass is granted.", parameters: { type: "object", properties: {} } } },
    sideEffect: "read", repeatBehavior: "execute",
    run: async (_args, env) => {
      const lease = LeaseRefSchema.parse(env.ctx.taskLease);
      if (env.ctx.taskId !== jobId || !currentSupervisorAuthority(env.ctx.tasks.db, env.ctx.cfg, lease, env.ctx.now())) throw new Error("owning supervisor required");
      const capability = workerActionCapability(env.ctx.cfg);
      return JSON.stringify(new WorkerActionRequests(env.ctx.tasks.db, env.ctx.now).list({ project: lease.project, jobId, status: "pending" }).map(row => ({ ...row, ...capability })));
    },
  }, {
    def: { type: "function", function: { name: "decide_worker_action", description: "Approve or deny one exact worker action with a reason. Approval is available only under current supervisor policy; human_only approvals require the human operator, so await_tasks instead. Pending human approval alone is not a reason to deny or cancel. Approving a shell command executes it outside worker containment. For other operations perform it yourself and supply the bounded response.", parameters: { type: "object", properties: { id: { type: "string" }, decision: { type: "string", enum: ["approve", "deny"] }, reason: { type: "string" }, response: { type: "string" } }, required: ["id", "decision", "reason"] } } },
    sideEffect: "external",
    run: async (args, env) => {
      const input = z.object({ id: z.string().min(1), decision: z.enum(["approve", "deny"]), reason: z.string().min(1), response: z.string().max(20000).optional() }).strict().parse(args);
      return JSON.stringify(await new WorkerActionRequests(env.ctx.tasks.db, env.ctx.now).decide({ ...input, config: env.ctx.cfg, project: LeaseRefSchema.parse(env.ctx.taskLease).project, actor: { kind: "supervisor", taskId: env.ctx.taskId, lease: LeaseRefSchema.parse(env.ctx.taskLease) }, signal: env.ctx.signal }));
    },
  }];
}
