import { z } from "zod";
import type { MeritRouter } from "../core/service.js";
import { MemoryManifestSchema } from "../context/memory-manifest.js";
import { brainDocumentVisible } from "./brain-entities.js";
import { requireProjectStores } from "./project-reads.js";

const Query = z.object({ project: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/).max(120), taskId: z.string().min(1).max(200).optional() }).strict();
const Row = z.object({ id: z.string(), task_id: z.string(), bytes: z.number().int().nonnegative(), created_at: z.number().int() });

/** Actual stored injection receipts, never a synthetic prediction of future context. */
export function brainMemoryManifestPreview(sy: MeritRouter, input: z.input<typeof Query>) {
  const query = Query.parse(input);
  if (!sy.projects.get(query.project)) throw new Error("Unknown project");
  const stores = requireProjectStores(sy, query.project);
  if (query.taskId && !stores.db.prepare("SELECT id FROM tasks WHERE id = ? AND project_id = ?").get(query.taskId, query.project)) throw new Error("Task is unavailable in this project");
  const rows = z.array(Row).parse(stores.db.prepare("SELECT a.id, a.task_id, a.bytes, a.created_at FROM artifacts a JOIN tasks t ON t.id = a.task_id WHERE t.project_id = ? AND a.kind = 'memory_manifest' AND (? IS NULL OR a.task_id = ?) ORDER BY a.created_at DESC, a.id DESC LIMIT 10").all(query.project, query.taskId ?? null, query.taskId ?? null));
  let previewBytes = 0;
  return rows.map(row => {
    const common = { taskId: row.task_id, artifactRef: `artifact:${row.id}`, createdAt: row.created_at };
    previewBytes += row.bytes;
    if (previewBytes > 200_000) return { ...common, manifest: null, unavailable: "Stored manifest exceeds the aggregate preview size limit; narrow to a task" };
    try {
      const artifact = stores.artifacts.readScoped(row.id, query.project);
      if (artifact.row.task_id !== row.task_id || artifact.row.kind !== "memory_manifest") throw new Error("Manifest owner changed");
      const manifest = MemoryManifestSchema.parse(JSON.parse(artifact.content.toString("utf8")));
      const scopedRef = (ref: string) => ref.startsWith("brain:") && brainDocumentVisible(query.project, ref.slice("brain:".length));
      if (manifest.project !== query.project || !manifest.entries.every(entry => scopedRef(entry.ref)) || !manifest.omissions.every(entry => scopedRef(entry.ref))) throw new Error("Manifest scope does not match this view");
      return { ...common, manifest, unavailable: null };
    } catch {
      return { ...common, manifest: null, unavailable: "Stored manifest is unavailable, invalid or outside this project's scope" };
    }
  });
}
