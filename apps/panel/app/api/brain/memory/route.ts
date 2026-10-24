import { randomUUID } from "node:crypto";
import { insights, MemoryPreferences, memoryRecordPath, parseMemoryRecord } from "meritrouter";
import { z } from "zod";
import { body, handle, HttpError } from "@/lib/api";
import { findProject } from "@/lib/project";

export const dynamic = "force-dynamic";
const scope = z.enum(["project", "global"]);
const Query = z.object({ project: z.string().min(1).max(120).optional(), scope: scope.default("project"), after: z.string().max(5000).optional() });
const Write = z.object({ project: z.string().min(1).max(120).optional(), scope, kind: z.enum(["user_preference", "project_fact", "decision", "empirical_lesson"]), id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,80}$/), body: z.string().trim().min(1).max(20000), expectedDigest: z.string().regex(/^[a-f0-9]{64}$/).nullable(), operation: z.enum(["write", "revoke"]).default("write"), confirmInstruction: z.literal(true) }).strict();

export async function GET(req: Request) {
  return handle(async sy => {
    const query = Query.safeParse(Object.fromEntries(new URL(req.url).searchParams));
    if (!query.success) throw new HttpError(400, "Invalid memory query");
    const input = query.data;
    if (input.scope === "project" && !input.project) throw new HttpError(400, "Project memory requires a project");
    if (input.project && !findProject(sy, input.project)) throw new HttpError(404, "Unknown project");
    // Global management uses the install's Brain binding, even if every configured project
    // is archived. It does not choose a live user's project as the global UI destination.
    const project = input.project ?? sy.brain.project;
    const prefix = input.scope === "global" ? "global/preferences/" : `projects/${project}/memory/`;
    try {
      const page = await insights.brainCatalogPage(sy, { project, prefix, after: input.after, limit: 10 });
      const records = page.entries.flatMap(entry => {
        const document = insights.brainRead(sy, entry.path, project);
        const record = parseMemoryRecord(document.content);
        const matchingScope = record && (input.scope === "global" ? record.scope.kind === "global" && record.kind === "user_preference" : record.scope.kind === "project" && record.scope.project === project);
        return record && matchingScope && memoryRecordPath(record) === entry.path ? [{ record, path: entry.path, digest: document.digest }] : [];
      });
      return { records, next: page.next, generation: page.generation };
    } catch (err) {
      if ((err as { code?: string }).code === "brain_cursor_stale") throw new HttpError(409, (err as Error).message);
      throw err;
    }
  });
}

export async function POST(req: Request) {
  return handle(async sy => {
    // The proxy's panel authentication and CSRF gate remain authoritative. Unlike ordinary
    // CLI APIs, a trusted preference instruction additionally needs a direct browser origin.
    const origin = req.headers.get("origin");
    const authority = `${new URL(req.url).protocol}//${req.headers.get("host") ?? new URL(req.url).host}`;
    if (!origin || origin !== new URL(authority).origin) throw new HttpError(403, "Use the signed-in panel to authorize a memory instruction");
    const input = await body(req, Write);
    if (input.scope === "project" && !input.project) throw new HttpError(400, "Project memory requires a project");
    if (input.project && !findProject(sy, input.project)) throw new HttpError(404, "Unknown project");
    const project = input.project ?? sy.brain.project;
    if (input.scope === "global" && input.kind !== "user_preference") throw new HttpError(400, "Only explicit user preferences are global; inferred lessons use promotion review");
    if (input.operation === "revoke" && (input.kind !== "user_preference" || !input.expectedDigest)) throw new HttpError(400, "Revocation requires an existing preference revision");
    const sourceRef = `panel:memory:${randomUUID()}`;
    const capability = randomUUID();
    const actor = { agent: "panel-user", role: "human" };
    const memory = new MemoryPreferences(sy.brainFor(project), reference => reference === capability ? { actor, originalInstruction: input.body, sourceRef, scope: input.scope, project, expiresAt: Date.now() + 30_000, operation: input.operation, id: input.id } : null);
    try {
      const saved = input.operation === "revoke"
        ? await memory.revokePreference(capability, input.id, input.expectedDigest!)
        : input.kind === "user_preference"
          ? await memory.writePreference(capability, { id: input.id, body: input.body }, input.expectedDigest)
          : await memory.writeProject({ kind: "human", name: "panel-user" }, actor, { id: input.id, body: input.body, kind: input.kind, source: { kind: input.kind === "decision" ? "decision" : "observation", ref: sourceRef } }, input.expectedDigest);
      return { saved };
    } catch (err) {
      if ((err as { code?: string }).code === "brain_conflict") throw new HttpError(409, (err as Error).message);
      if ((err as { code?: string }).code === "brain_rejected" || err instanceof z.ZodError) throw new HttpError(400, (err as Error).message);
      throw err;
    }
  });
}
