import type { Db } from "./db.js";
import type { TaskRow } from "./tasks.js";

/** A project's fair-share weight and its worker-task cap at claim (decision D5 of docs/working/projects.md). */
export interface ProjectClaimLimits {
  priority: number;
  /** Most worker tasks of the project running at once; undefined: no per-project cap. */
  maxConcurrent?: number | undefined;
}

/** `meta` keys holding the stride state: one pass per project, and the pass of the last claim. */
const PASS_PREFIX = "claim_pass:";
const VIRTUAL_TIME = "claim_pass";

/**
 * The order in which `TaskStore.claim` offers candidates: weighted round-robin across projects
 * with ready tasks, oldest first within a project (stride scheduling).
 *
 * Each project has a pass; the next candidate is the oldest ready task of the project with the
 * lowest pass, and a claim advances that project's pass by `1 / priority`. While two projects both
 * have ready tasks, they are therefore claimed in the ratio of their priorities, however long
 * either backlog is. A project that was idle (or whose tasks were blocked) is lifted to the pass
 * of the last claim, so it rejoins at the front of the rotation without having banked credit
 * for the time it had nothing to run. Ties go to the older task, so a single project (or equal
 * passes) is plain FIFO.
 *
 * The passes live in `meta` and are read and written inside the claim's IMMEDIATE transaction,
 * so the rotation carries across ticks, restarts, and processes sharing one store.
 */
export class FairClaimOrder {
  private readonly queues = new Map<string, { rows: TaskRow[]; next: number }>();
  private readonly pass = new Map<string, number>();
  private readonly dirty = new Set<string>();
  private virtualTime: number;

  constructor(
    private readonly db: Db,
    candidates: TaskRow[],
    private readonly limitsOf: (projectId: string) => ProjectClaimLimits,
  ) {
    for (const row of candidates) {
      let q = this.queues.get(row.project_id);
      if (!q) this.queues.set(row.project_id, (q = { rows: [], next: 0 }));
      q.rows.push(row);
    }
    this.virtualTime = this.read(VIRTUAL_TIME) ?? 0;
    for (const p of this.queues.keys()) {
      const stored = this.read(PASS_PREFIX + p);
      if (stored !== null) this.pass.set(p, stored);
    }
  }

  private read(key: string): number | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
    const n = row ? Number(row.value) : NaN;
    return Number.isFinite(n) ? n : null;
  }

  private effective(project: string): number {
    return Math.max(this.pass.get(project) ?? this.virtualTime, this.virtualTime);
  }

  /** The next candidate to try, removed from its queue; null when every queue is empty. */
  next(): TaskRow | null {
    let best: { project: string; pass: number; head: TaskRow } | null = null;
    for (const [project, q] of this.queues) {
      const head = q.rows[q.next];
      if (!head) continue;
      const pass = this.effective(project);
      if (
        !best ||
        pass < best.pass ||
        (pass === best.pass && (head.created_at < best.head.created_at || (head.created_at === best.head.created_at && project < best.project)))
      ) {
        best = { project, pass, head };
      }
    }
    if (!best) return null;
    this.queues.get(best.project)!.next++;
    return best.head;
  }

  /** The row `next()` returned was claimed: its project moves back by one stride. */
  claimed(row: TaskRow): void {
    const p = row.project_id;
    const at = this.effective(p);
    this.virtualTime = at;
    this.pass.set(p, at + 1 / (this.limitsOf(p).priority || 1));
    this.dirty.add(p);
  }

  /** Persist the passes that moved (inside the caller's transaction). */
  save(): void {
    if (!this.dirty.size) return;
    const put = this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    put.run(VIRTUAL_TIME, String(this.virtualTime));
    for (const p of this.dirty) put.run(PASS_PREFIX + p, String(this.pass.get(p)));
    this.dirty.clear();
  }
}
