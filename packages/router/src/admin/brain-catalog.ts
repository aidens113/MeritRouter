import { z } from "zod";
import type { MeritRouter } from "../core/service.js";

const Query = z.object({
  project: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/).max(120),
  prefix: z.string().max(2000).default(""),
  after: z.string().max(5000).optional(),
  limit: z.number().int().min(1).max(100).default(50),
});

/** Project-scoped indexed page. The cursor is an exclusive canonical path, never a capability. */
export async function brainCatalogPage(sy: MeritRouter, input: z.input<typeof Query>) {
  const query = Query.parse(input);
  if (!sy.projects.get(query.project)) throw new Error(`Unknown project ${query.project}`);
  const page = await sy.brainFor(query.project).catalog({ kind: "human" }, { prefix: query.prefix, limit: query.limit, scope: "project" });
  let after: string | undefined;
  if (query.after) {
    let cursor: { path: string; generation: string; project: string; prefix: string };
    try { cursor = z.object({ path: z.string().max(2000), generation: z.string(), project: z.string(), prefix: z.string() }).parse(JSON.parse(Buffer.from(query.after, "base64url").toString("utf8"))); }
    catch { throw new BrainCursorError("Invalid document cursor. Return to the first page."); }
    if (cursor.generation !== page.generation || cursor.project !== query.project || cursor.prefix !== query.prefix) throw new BrainCursorError("The document index changed. Return to the first page to see current documents.");
    after = cursor.path;
  }
  const result = after ? await sy.brainFor(query.project).catalog({ kind: "human" }, { prefix: query.prefix, limit: query.limit, after, scope: "project" }) : page;
  return { ...result, next: result.next ? Buffer.from(JSON.stringify({ path: result.next, generation: result.generation, project: query.project, prefix: query.prefix })).toString("base64url") : null };
}

export class BrainCursorError extends Error { readonly code = "brain_cursor_stale"; }

const SearchQuery = Query.omit({ after: true }).extend({ query: z.string().min(1).max(2000), offset: z.number().int().min(0).max(10000).default(0), generation: z.string().optional() });
export async function brainSearchPage(sy: MeritRouter, input: z.input<typeof SearchQuery>) {
  const query = SearchQuery.parse(input);
  if (!sy.projects.get(query.project)) throw new Error(`Unknown project ${query.project}`);
  const brain = sy.brainFor(query.project);
  await brain.refreshIndex({ maxAgeMs: 5000 });
  const { generation } = await brain.catalog({ kind: "human" }, { limit: 1, scope: "project" });
  if (query.generation && query.generation !== generation) throw new BrainCursorError("The search index changed. Restart the search for current results.");
  const entries = brain.search({ kind: "human" }, query.query, { prefix: query.prefix, offset: query.offset, limit: query.limit + 1, scope: "project" });
  return { entries: entries.slice(0, query.limit), generation, next: entries.length > query.limit && query.offset + query.limit <= 10000 ? query.offset + query.limit : null };
}
