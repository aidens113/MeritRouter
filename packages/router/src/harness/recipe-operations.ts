import { z } from "zod";
import { declaredCheckTool } from "./tools.js";
import { DeadlineArgs, type OperationDefinition } from "./operation-contract.js";
import { journaled } from "./journal.js";
import { LeaseRefSchema } from "../storage/task-leases.js";
import { commandTimeoutMs } from "./command-timeout.js";

// Only run_check's current, source-bound action envelope may describe an approval wait.
// Arbitrary command output (including JSON with a status field) is not action authority.
const CheckActionSchema = z.object({
  id: z.string().min(1), project: z.string(), taskId: z.string(),
  status: z.enum(["pending", "running", "completed", "denied", "cancelled", "uncertain"]),
  action: z.object({ command: z.string(), cwd: z.string(), source: z.string().regex(/^[a-f0-9]{64}$/), lease: LeaseRefSchema }),
  decisionReason: z.string().nullable(), decidedBy: z.string().nullable(), output: z.string().nullable(), exitCode: z.number().int().nullable(), createdAt: z.number().int(),
});
type RecipeStatus = "succeeded" | "failed" | "waiting_approval" | "denied" | "cancelled" | "unknown_effect";
const stopsRecipes = (status: string) => ["waiting_approval", "denied", "cancelled", "unknown_effect"].includes(status);
/** Recipe IDs resolve to existing trusted declarations; wrappers never authorize shell text. */
export function recipeOperations(): OperationDefinition[] {
  const args = z.object({ ...DeadlineArgs, id: z.string().regex(/^check:[1-9]\d*$/) });
  const recipe: OperationDefinition = {
    name: "run_recipe", description: "Run a declared check recipe by check:N ID from workspace_info. timeout_ms bounds active work, excluding only an authoritative pending approval wait; source preflight, task deadline and cancellation remain bounded. Uses existing authority, approval and cumulative check limits. No arbitrary shell interpolation.", args, sideEffect: "command", available: env => !!env.checks?.commands.length, async run(a, env) {
      const checks = env.checks!, index = Number((a.id as string).split(":")[1]) - 1, command = checks.commands[index];
      if (!command)
        throw new Error(`Unknown recipe ${a.id}; use workspace_info for granted IDs.`);
      const timeout = commandTimeoutMs(env.ctx.cfg, a.timeout_ms as number | undefined, checks.timeoutMs);
      const before = env.checkResults?.length ?? 0;
      const output = await declaredCheckTool().run({ command }, { ...env, checks: { ...checks, timeoutMs: timeout } });
      const record = (env.checkResults?.length ?? 0) > before ? env.checkResults?.at(-1) : undefined;
      let status: RecipeStatus = record ? record.exitCode === 0 ? "succeeded" : "failed" : "unknown_effect";
      if (!record) {
        try {
          const parsed = CheckActionSchema.safeParse(JSON.parse(output)), lease = LeaseRefSchema.safeParse(env.ctx.taskLease);
          if (parsed.success && lease.success) {
            const action = parsed.data;
            if (action.taskId === env.ctx.taskId && action.project === lease.data.project && action.action.command === command
              && JSON.stringify(action.action.lease) === JSON.stringify(lease.data)) {
              status = action.status === "pending" || action.status === "running" ? "waiting_approval"
                : action.status === "denied" || action.status === "cancelled" ? action.status
                : "unknown_effect"; // Even completed metadata is not an executed check record.
            }
          }
        } catch { /* No authoritative check result; preserve output and fail closed. */ }
      }
      return { id: a.id, command, status, output, record };
    }
  };
  return [recipe, {
    name: "run_checks", description: "Run selected declared check:N IDs sequentially, or all declared checks when ids is omitted. timeout_ms bounds active work, excluding only authoritative pending approval waits; source preflight, task deadline and cancellation remain bounded. Every command retains approval and cumulative quota; stop on failure by default.",
    args: z.object({ ...DeadlineArgs, ids: z.array(z.string().regex(/^check:[1-9]\d*$/)).min(1).max(64).optional(), stop_on_failure: z.boolean().default(true) }),
    sideEffect: "command", available: recipe.available,
    async run(a, env) {
      const ids = a.ids as string[] | undefined ?? env.checks!.commands.map((_, index) => `check:${index + 1}`);
      const results: unknown[] = [];
      for (let index = 0;index < ids.length;index++) {
        env.ctx.signal.throwIfAborted();
        const args = { id: ids[index], timeout_ms: a.timeout_ms };
        const invocation = `${env.toolInvocationId}:recipe:${index}`;
        let value: unknown;
        // Capture the policy used by this host, not a later configuration at source reuse.
        // This is journal metadata, never an extra model-supplied recipe argument.
        const captured = { ...args, timeout_policy: { version: "configured-v1", default_ms: commandTimeoutMs(env.ctx.cfg), check_limit_ms: Math.min(env.checks!.timeoutMs, 300000) } };
        await journaled(env.ctx.session, { id: invocation, function: { name: "run_recipe", arguments: JSON.stringify(captured) } }, captured, { sideEffect: "command" }, async () => {
          value = await recipe.run(args, { ...env, toolInvocationId: invocation });
          const ok = (value as {
            status: string;
          }).status === "succeeded";
          return { ok, output: JSON.stringify(value) };
        });
        results.push(value);
        if (stopsRecipes((value as { status: string }).status) || a.stop_on_failure && (value as {
          status: string;
        }).status !== "succeeded")
          break;
      }
      const terminal = results.find(result => stopsRecipes((result as { status: string }).status)) as { status: string } | undefined;
      return {
        status: terminal?.status ?? (results.every(result => (result as {
          status: string;
        }).status === "succeeded") ? "succeeded" : "failed"), results, notStarted: ids.slice(results.length)
      };
    }
  }];
}
