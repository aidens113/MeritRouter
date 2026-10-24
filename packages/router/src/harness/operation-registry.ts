import { z } from "zod";
import { repositoryOperations } from "./repository-operations.js";
import { editOperations } from "./edit-operations.js";
import { recipeOperations } from "./recipe-operations.js";
import { DeadlineArgs, type OperationDefinition } from "./operation-contract.js";
import { executeOperation, operationStatus, cancelOperation } from "./operation-lifecycle.js";
import { journaled } from "./journal.js";
const BatchItem = z.object({ id: z.string().min(1).max(100), operation: z.string(), args: z.record(z.string(), z.unknown()).default({}), depends_on: z.array(z.string()).max(64).default([]) });
/** The sole schema/handler registry used by native and task-scoped MCP adapters. */
export function operationRegistry(): OperationDefinition[] {
  const definitions = [...repositoryOperations(), ...editOperations(), ...recipeOperations()];
  const byName = new Map(definitions.map(x => [x.name, x]));
  definitions.push({
    name: "batch", description: "Up to 64 operations with stable IDs and dependency IDs. Independent reads run four at a time; mutations run sequentially. No nested batches. Child outcomes remain independent and individually journaled. Any effect can be partial; never retry uncertain commands.", args: z.object({ ...DeadlineArgs, items: z.array(BatchItem).min(1).max(64) }), sideEffect: "command", async run(a, env) {
      const items = a.items as z.infer<typeof BatchItem>[];
      const ids = new Set<string>();
      // Validate the whole graph and schemas before the first effect. Dependencies must precede children.
      for (const item of items) {
        if (ids.has(item.id))
          throw new Error(`Duplicate batch ID ${item.id}`);
        if (item.depends_on.some(id => !ids.has(id)))
          throw new Error(`Dependencies for ${item.id} must name preceding IDs`);
        const def = byName.get(item.operation);
        if (!def)
          throw new Error(`Unknown/non-batchable operation ${item.operation}`);
        def.args.parse(item.args);
        if (def.available && !def.available(env))
          throw new Error(`Unavailable operation ${item.operation}`);
        ids.add(item.id);
      }
      const results = new Map<string, unknown>();
      const succeeded = new Set<string>();
      const run = async (item: z.infer<typeof BatchItem>) => {
        if (env.ctx.signal.aborted) {
          results.set(item.id, { status: "cancelled", diagnostics: ["Parent cancelled; child not started"] });
          return;
        }
        if (item.depends_on.some(id => !succeeded.has(id))) {
          results.set(item.id, { status: "blocked", diagnostics: ["Dependency did not succeed"] });
          return;
        }
        const def = byName.get(item.operation)!, id = `${env.toolInvocationId ?? "batch"}:child:${item.id}`;
        const outcome = await journaled(env.ctx.session, { id, function: { name: def.name, arguments: JSON.stringify(item.args) } }, item.args, { sideEffect: def.sideEffect }, async () => {
          const result = await executeOperation(def, item.args, { ...env, toolInvocationId: id }); results.set(item.id, result); if (result.status === "succeeded")
            succeeded.add(item.id); return { ok: result.status === "succeeded", output: JSON.stringify(result) };
        });
        // A child outcome must be durably written before any dependent mutation starts.
        void outcome;
      };
      let i = 0;
      while (i < items.length) {
        const item = items[i]!;
        if (byName.get(item.operation)!.sideEffect !== "read") {
          await run(item);
          i++;
          continue;
        }
        const group: typeof items = [];
        while (i < items.length && group.length < 4 && byName.get(items[i]!.operation)!.sideEffect === "read" && !items[i]!.depends_on.some(id => group.some(x => x.id === id))) {
          group.push(items[i++]!);
        }
        await Promise.all(group.map(run));
      }
      return items.map(item => ({ id: item.id, result: results.get(item.id) }));
    }
  });
  definitions.push({ name: "operation_status", description: "Inspect this task's operation status. Journal/artifact records preserve durable evidence; do not poll with model requests.", args: z.object({ operation_id: z.string() }), sideEffect: "read", async run(a, env) { return operationStatus(env, a.operation_id as string); } });
  definitions.push({ name: "cancel_operation", description: "Request stop for an operation owned by this task; cancellation_requested is not confirmed termination.", args: z.object({ operation_id: z.string() }), sideEffect: "read", async run(a, env) { return cancelOperation(env, a.operation_id as string); } });
  return definitions;
}
