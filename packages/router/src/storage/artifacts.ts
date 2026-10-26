import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { z } from "zod";
import path from "node:path";
import type { Db } from "./db.js";
import { ProjectEvidenceScope } from "./project-evidence-scope.js";
import { newId } from "./db.js";

export interface ArtifactRow {
  id: string;
  task_id: string | null;
  execution_id: string | null;
  kind: string;
  label: string;
  rel_path: string;
  media_type: string;
  sha256: string;
  bytes: number;
  created_at: number;
}
const ArtifactRowSchema=z.object({id:z.string(),task_id:z.string().nullable(),execution_id:z.string().nullable(),kind:z.string(),label:z.string(),rel_path:z.string(),media_type:z.string(),sha256:z.string().regex(/^[a-f0-9]{64}$/),bytes:z.number().int().nonnegative(),created_at:z.number().int().nonnegative()}).strict();

/** Artifacts are ordinary files under <storage>/artifacts, indexed in SQLite. */
export class ArtifactStore {
  readonly root: string;
  private readonly scope:ProjectEvidenceScope;

  constructor(
    private readonly db: Db,
    storageDir: string,
    private readonly now: () => number = Date.now,
  ) {
    this.scope=new ProjectEvidenceScope(db);
    this.root = path.join(this.scope.rootFor(storageDir), "artifacts");
  }

  write(opts: {
    taskId?: string | null;
    executionId?: string | null;
    kind: string;
    label: string;
    content: string | Buffer;
    mediaType?: string;
    extension?: string;
  }): string {
    this.scope.assertTask(opts.taskId);this.scope.assertExecution(opts.executionId,opts.taskId);
    const id = newId("a");
    const data = typeof opts.content === "string" ? Buffer.from(opts.content, "utf8") : opts.content;
    const dir = path.join(this.root, opts.taskId ?? "_shared");
    this.scope.path(dir,this.root);
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${id}${opts.extension ?? ".txt"}`);
    this.scope.path(file,dir);
    writeFileSync(file, data);
    this.db
      .prepare(
        "INSERT INTO artifacts (id, task_id, execution_id, kind, label, rel_path, media_type, sha256, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        opts.taskId ?? null,
        opts.executionId ?? null,
        opts.kind,
        opts.label,
        path.relative(this.root, file).split(path.sep).join("/"),
        opts.mediaType ?? "text/plain",
        createHash("sha256").update(data).digest("hex"),
        data.length,
        this.now(),
      );
    return `artifact:${id}`;
  }

  writeJson(opts: { taskId?: string | null; executionId?: string | null; kind: string; label: string; value: unknown }): string {
    return this.write({ ...opts, content: JSON.stringify(opts.value, null, 2), mediaType: "application/json", extension: ".json" });
  }

  get(ref: string): ArtifactRow | undefined {
    this.scope.assert();
    const id = ref.startsWith("artifact:") ? ref.slice("artifact:".length) : ref;
    const raw=this.db.prepare("SELECT * FROM artifacts WHERE id = ?").get(id);
    if(!raw)return undefined;const row=ArtifactRowSchema.parse(raw);this.scope.assertTask(row.task_id);this.scope.assertExecution(row.execution_id,row.task_id);return row;
  }

  absolutePath(row: ArtifactRow): string {
    const file=path.join(this.root, ...row.rel_path.split("/"));this.scope.path(file,this.root);return file;
  }

  read(ref: string): { row: ArtifactRow; content: Buffer } | undefined {
    const row = this.get(ref);
    if (!row) return undefined;
    return { row, content: readFileSync(this.absolutePath(row)) };
  }

  /** Authorize the indexed owner before touching artifact bytes; null/shared owners grant no project access. */
  readScoped(ref: string, project: string): { row: ArtifactRow; content: Buffer } {
    this.scope.assertProject(project);
    const row = this.get(ref);
    const owner = row?.task_id ? z.object({ project_id: z.string() }).safeParse(this.db.prepare("SELECT project_id FROM tasks WHERE id=?").get(row.task_id)) : null;
    if (!row || !owner?.success || owner.data.project_id !== project) throw new Error("artifact is unavailable in this project");
    const root = realpathSync(this.root);
    const file = realpathSync(this.absolutePath(row));
    const relative = path.relative(root, file);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("artifact is unavailable in this project");
    const content = readFileSync(file);
    if (content.length !== row.bytes || createHash("sha256").update(content).digest("hex") !== row.sha256) throw new Error("artifact integrity check failed");
    return { row, content };
  }

  listForTask(taskId: string): ArtifactRow[] {
    this.scope.assertTask(taskId);
    const rows=z.array(ArtifactRowSchema).parse(this.db.prepare("SELECT * FROM artifacts WHERE task_id = ? ORDER BY created_at").all(taskId));
    for(const row of rows)this.scope.assertExecution(row.execution_id,taskId);
    return rows;
  }
}
