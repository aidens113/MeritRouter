import { z } from "zod";
import { platform } from "node:os";
import { RepositoryArgs, DeadlineArgs, resolveReader, type OperationDefinition } from "./operation-contract.js";
import { sliceLines } from "../context/repo-reader.js";
import { git } from "../workspaces/git.js";
import { scopedArtifact } from "./check-evidence.js";
import { OutputPageArgs } from "./output-pages.js";
const FileArgs = z.object({ path: z.string().min(1), start_line: z.number().int().positive().optional(), end_line: z.number().int().positive().optional() });
// SDK registration also parses inputs. Retain legacy string acceptance there while
// advertising the preferred object fields even to clients that discard union branches.
const fileModelSchema = z.toJSONSchema(FileArgs);
delete fileModelSchema.$schema; // Dialect declarations belong at the tool-schema root, not nested items.
const ModelFileArgs = z.union([z.string().min(1), FileArgs]).meta(fileModelSchema);
const PagingArgs = { offset: z.number().int().nonnegative().max(1000000).default(0), limit: z.number().int().min(1).max(1000).default(1000) };
export function repositoryOperations(): OperationDefinition[] {
  return [
    { name: "workspace_info", description: "Inspect granted repositories, OS, writable scope and declared recipe IDs. Batch observations; commands must use authorized recipes.", args: z.object(DeadlineArgs), sideEffect: "read", async run(_, env) { return { platform: platform(), repositories: [...env.readers].map(([alias, r]) => ({ alias, root: r.root, revision: r.commit })), writable: env.workspace ? { alias: env.workspace.alias, allowedPaths: env.workspace.allowedPaths } : null, recipes: env.checks?.commands.map((command, i) => ({ id: `check:${i + 1}`, command })) ?? [], limits: { timeout_ms: 30000, max_timeout_ms: 300000, batch_items: 64, read_concurrency: 4 } }; } },
    {
      name: "read_files", description: "Read up to 64 files in one call. Use one call for all known independent files: {\"files\":[{\"path\":\"src/a.ts\"},{\"path\":\"src/b.ts\",\"start_line\":1,\"end_line\":80}]}. Independent outcomes preserve successful files when another is missing; ranges use numbered lines.", args: z.object({ ...RepositoryArgs, ...DeadlineArgs, files: z.array(z.union([z.string().min(1), FileArgs])).min(1).max(64) }), modelArgs: z.object({ ...RepositoryArgs, ...DeadlineArgs, files: z.array(ModelFileArgs).min(1).max(64) }), sideEffect: "read", async run(a, env) {
        const r = resolveReader(env, a.alias), inputs = a.files as Array<string | z.infer<typeof FileArgs>>, results: unknown[] = new Array(inputs.length);
        if(!r.commit)await r.dirtyPaths(env.ctx.signal);
        let next = 0;
        await Promise.all(Array.from({ length: Math.min(4, inputs.length) }, async () => {
          while (next < inputs.length) {
            const i = next++, input = inputs[i]!, spec = typeof input === "string" ? { path: input } : input;
            try {
              env.ctx.signal.throwIfAborted();
              const f = await r.readFile(spec.path, env.ctx.signal);
              const lines = sliceLines(f.content, spec.start_line, spec.end_line);
              env.universe.refs.set(`${r.alias}:${f.relPath}`, f.totalLines);
              results[i] = { path: f.relPath, status: "succeeded", sha256: f.sha256, revision: f.commit, totalLines: f.totalLines, ...lines };
            }
            catch (e) {
              results[i] = { path: spec.path, status: "failed", diagnostic: String((e as Error).message) };
            }
          }
        }));
        return results;
      }
    },
    {
      name: "list_paths", description: "List repository paths; empty, . and ./ denote root. Continue with nextOffset until null.", args: z.object({ ...RepositoryArgs, ...DeadlineArgs, ...PagingArgs, dir: z.string().default(""), glob: z.string().optional() }), sideEffect: "read", async run(a, env) {
        const offset = a.offset as number, limit = a.limit as number, result = await resolveReader(env, a.alias).listFiles(a.dir as string, a.glob as string | undefined, offset + limit + 1, env.ctx.signal);
        const more = result.truncated || result.files.length > offset + limit;
        return { files: result.files.slice(offset, offset + limit), offset, truncated: more, nextOffset: more ? offset + limit : null };
      }
    },
    {
      name: "search_text", description: "Search contents. No matches succeeds. Literal mode escapes ordinary text. Continue with nextOffset until null.", args: z.object({ ...RepositoryArgs, ...DeadlineArgs, ...PagingArgs, pattern: z.string().min(1), mode: z.enum(["literal", "regex"]).default("literal"), path_glob: z.string().optional(), ignore_case: z.boolean().default(false) }), sideEffect: "read", async run(a, env) {
        const pattern = a.mode === "literal" ? (a.pattern as string).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : a.pattern as string, offset = a.offset as number, limit = a.limit as number;
        const result = await resolveReader(env, a.alias).search(pattern, { pathGlob: a.path_glob as string | undefined, ignoreCase: a.ignore_case as boolean, limit: offset + limit + 1, signal: env.ctx.signal });
        const more = result.matches.length > offset + limit;
        return { matches: result.matches.slice(offset, offset + limit), offset, truncated: more, nextOffset: more ? offset + limit : null };
      }
    },
    ...(["git_status", "git_diff"] as const).map(name => ({
      name, description: `Read-only ${name}; no commit, push or reset. Unavailable for pinned repository snapshots.`, args: z.object({ ...RepositoryArgs, ...DeadlineArgs }), sideEffect: "read" as const, async run(a: Record<string, unknown>, env: Parameters<OperationDefinition["run"]>[1]) {
        const r = resolveReader(env, a.alias); if (r.commit)
          throw new Error("Working-tree inspection is unavailable for a pinned snapshot; read_files preserves its granted revision."); return git(r.root, name === "git_status" ? ["status", "--porcelain=v1"] : ["diff", "--no-ext-diff", "--no-textconv", "HEAD", "--"], { signal: env.ctx.signal });
      }
    })),
    { name: "read_output_page", description: "Read a lossless task-scoped output page; offsets count UTF-16 characters.", args: OutputPageArgs, sideEffect: "read", async run(a, env) { const text = scopedArtifact(env, a.ref as string).content.toString("utf8"), offset = a.offset as number, length = a.length as number; return { text: text.slice(offset, offset + length), offset, nextOffset: offset + length < text.length ? offset + length : null, totalCharacters: text.length }; } }
  ];
}
