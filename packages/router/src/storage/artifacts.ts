import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Db } from "./db.js";
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

/** Artifacts are ordinary files under <storage>/artifacts, indexed in SQLite. */
export class ArtifactStore {
  readonly root: string;

  constructor(
    private readonly db: Db,
    storageDir: string,
    private readonly now: () => number = Date.now,
  ) {
    this.root = path.join(storageDir, "artifacts");
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
    const id = newId("a");
    const data = typeof opts.content === "string" ? Buffer.from(opts.content, "utf8") : opts.content;
    const dir = path.join(this.root, opts.taskId ?? "_shared");
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${id}${opts.extension ?? ".txt"}`);
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
    const id = ref.startsWith("artifact:") ? ref.slice("artifact:".length) : ref;
    return this.db.prepare("SELECT * FROM artifacts WHERE id = ?").get(id) as ArtifactRow | undefined;
  }

  absolutePath(row: ArtifactRow): string {
    return path.join(this.root, ...row.rel_path.split("/"));
  }

  read(ref: string): { row: ArtifactRow; content: Buffer } | undefined {
    const row = this.get(ref);
    if (!row) return undefined;
    return { row, content: readFileSync(this.absolutePath(row)) };
  }

  listForTask(taskId: string): ArtifactRow[] {
    return this.db.prepare("SELECT * FROM artifacts WHERE task_id = ? ORDER BY created_at").all(taskId) as ArtifactRow[];
  }
}
