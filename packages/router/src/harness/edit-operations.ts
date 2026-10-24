import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { editTools, workspacePath } from "./tools.js";
import { DeadlineArgs, type OperationDefinition } from "./operation-contract.js";
import { journaled } from "./journal.js";
import { isSimulatedCrash } from "../core/faults.js";
import { assertRunAuthority } from "./task-authority.js";
const Edit = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), path: z.string().min(1), content: z.string() }),
  z.object({ action: z.literal("replace"), path: z.string().min(1), expected_sha256: z.string().regex(/^[a-f0-9]{64}$/), content: z.string(), whole_file: z.literal(true) }),
  z.object({ action: z.literal("patch"), path: z.string().min(1), expected_sha256: z.string().regex(/^[a-f0-9]{64}$/), old_text: z.string().min(1), new_text: z.string(), replace_all: z.boolean().default(false) }),
  z.object({ action: z.literal("delete"), path: z.string().min(1), expected_sha256: z.string().regex(/^[a-f0-9]{64}$/) })
]);
export function editOperations(): OperationDefinition[] {
  return [{
    name: "apply_edits", description: 'Submit up to 64 edits together, each with required action and path. Create example: {"edits":[{"action":"create","path":"src/new.ts","content":"complete file"}]}. Patch requires expected_sha256, old_text and new_text; replace requires expected_sha256, content and whole_file:true; delete requires expected_sha256. Preflight all edits before writing. Sequential effects are individually journaled; partial application is explicitly returned.', args: z.object({ ...DeadlineArgs, edits: z.array(Edit).min(1).max(64) }),
    // Clients that drop anyOf/oneOf otherwise lose every field of the discriminated
    // union, including action. Keep the advertised shape flat and validate the union.
    modelArgs: z.object({ ...DeadlineArgs, edits: z.array(z.object({
      action: z.enum(["create", "patch", "replace", "delete"]), path: z.string().min(1),
      content: z.string().optional(), expected_sha256: z.string().optional(),
      old_text: z.string().optional(), new_text: z.string().optional(),
      replace_all: z.boolean().optional(), whole_file: z.boolean().optional(),
    })).min(1).max(64) }), sideEffect: "edit", available: env => !!env.workspace, async run(a, env) {
      const edits = a.edits as z.infer<typeof Edit>[];
      const seen = new Set<string>();
      const preflight = (edit: z.infer<typeof Edit>) => {
        assertRunAuthority(env.ctx);
        const target = workspacePath(env, edit.path);
        if (seen.has(target.rel))
          throw new Error(`Duplicate edit target ${target.rel}; combine edits before dispatch.`);
        const exists = existsSync(target.abs);
        if (edit.action === "create") {
          if (exists)
            throw new Error(`${target.rel} already exists; read_files and provide expected_sha256 for replacement.`);
        }
        else {
          if (!exists)
            throw new Error(`${target.rel} does not exist`);
          const raw = readFileSync(target.abs), hash = createHash("sha256").update(raw).digest("hex");
          if (hash !== edit.expected_sha256)
            throw new Error(`${target.rel} revision conflict; current sha256=${hash}; nothing written. Read current content before retrying.`);
          if (edit.action === "patch") {
            const text = raw.toString("utf8").replace(/\r\n/g, "\n"), old = edit.old_text.replace(/\r\n/g, "\n"), count = text.split(old).length - 1;
            if (count === 0 || count > 1 && !edit.replace_all)
              throw new Error(`${target.rel}: old_text matches ${count} times; sha256=${hash}; read surrounding context and provide one exact match.`);
          }
          if (edit.action === "replace" && (/(?:rest|remaining|existing)\s+(?:of\s+\w+\s+)?unchanged|\.\.\.\s*(?:rest|existing)/i.test(edit.content)))
            throw new Error(`${target.rel}: omission placeholder detected; provide complete content or surgical patch.`);
        }
        return target;
      };
      for (const edit of edits) {
        const target = preflight(edit);
        seen.add(target.rel);
      }
      seen.clear();
      const results: unknown[] = [];
      const legacy = editTools();
      for (let i = 0;i < edits.length;i++) {
        const edit = edits[i]!;
        try {
          preflight(edit);
          const name = edit.action === "delete" ? "delete_file" : edit.action === "patch" ? "replace_in_file" : "write_file";
          const args = edit.action === "patch" ? { path: edit.path, old_text: edit.old_text, new_text: edit.new_text, replace_all: edit.replace_all } : { path: edit.path, ...("content" in edit ? { content: edit.content } : {}) };
          const tool = legacy.find(t => t.def.function.name === name)!;
          const id = `${env.toolInvocationId ?? "edit"}:file:${i}`;
          const outcome = await journaled(env.ctx.session, { id, function: { name, arguments: JSON.stringify(args) } }, args, tool, async () => { env.ctx.signal.throwIfAborted(); return { ok: true, output: await tool.run(args, { ...env, toolInvocationId: id }) }; });
          results.push({ path: edit.path, status: "succeeded", output: outcome.output });
        }
        catch (error) {
          if (isSimulatedCrash(error))
            throw error;
          results.push({ path: edit.path, status: env.ctx.signal.aborted ? "cancelled" : "failed", diagnostic: (error as Error).message });
          return { status: "partial", applied: i, total: edits.length, results, notStarted: edits.slice(i + 1).map(x => x.path) };
        }
      }
      return { status: "succeeded", applied: edits.length, results };
    }
  }];
}
