import { z } from "zod";
import { declaredCheckTool } from "./tools.js";
import { DeadlineArgs, type OperationDefinition } from "./operation-contract.js";
import { journaled } from "./journal.js";
/** Recipe IDs resolve to existing trusted declarations; wrappers never authorize shell text. */
export function recipeOperations(): OperationDefinition[] {
  const args = z.object({ ...DeadlineArgs, id: z.string().regex(/^check:[1-9]\d*$/) });
  const recipe: OperationDefinition = {
    name: "run_recipe", description: "Run a declared check recipe by check:N ID from workspace_info. Uses existing authority, approval and cumulative check limits. No arbitrary shell interpolation.", args, sideEffect: "command", available: env => !!env.checks?.commands.length, async run(a, env) {
      const checks = env.checks!, index = Number((a.id as string).split(":")[1]) - 1, command = checks.commands[index];
      if (!command)
        throw new Error(`Unknown recipe ${a.id}; use workspace_info for granted IDs.`);
      const timeout = Math.min(Number(a.timeout_ms ?? 30000), checks.timeoutMs);
      const before = env.checkResults?.length ?? 0;
      const output = await declaredCheckTool().run({ command }, { ...env, checks: { ...checks, timeoutMs: timeout } });
      const record = (env.checkResults?.length ?? 0) > before ? env.checkResults?.at(-1) : undefined;
      let pending = false;
      try {
        const value = JSON.parse(output);
        pending = value.status !== "completed";
      }
      catch { /* Existing check output is text after completed execution. */ }
      return { id: a.id, command, status: pending ? "waiting_approval" : record && record.exitCode !== 0 ? "failed" : "succeeded", output, record };
    }
  };
  return [recipe, {
    name: "run_checks", description: "Run selected declared check:N IDs sequentially, or all declared checks when ids is omitted. Every command retains approval, deadline and cumulative quota; stop on failure by default.",
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
        await journaled(env.ctx.session, { id: invocation, function: { name: "run_recipe", arguments: JSON.stringify(args) } }, args, { sideEffect: "command" }, async () => {
          value = await recipe.run(args, { ...env, toolInvocationId: invocation });
          const ok = (value as {
            status: string;
          }).status === "succeeded";
          return { ok, output: JSON.stringify(value) };
        });
        results.push(value);
        if ((value as { status: string }).status === "waiting_approval" || a.stop_on_failure && (value as {
          status: string;
        }).status !== "succeeded")
          break;
      }
      return {
        status: results.some(result => (result as { status: string }).status === "waiting_approval") ? "waiting_approval" : results.every(result => (result as {
          status: string;
        }).status === "succeeded") ? "succeeded" : "failed", results, notStarted: ids.slice(results.length)
      };
    }
  }];
}
