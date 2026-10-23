import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { MeritRouter } from "../core/service.js";

/**
 * Change watching for the panel's live updates (panel-v2 U1). A cursor holds cheap high-water marks
 * of the store (newest ids and update times per table, the brain repository's head, the config
 * file's mtime, the set of live workers); `liveChanges` compares the store with a cursor and names
 * the topics that changed since, with the ids it can attribute (`tasks:<id>`, `jobs:<id>`,
 * `sessions:<id>`). A topic followed by `:*` means "some id under this topic changed and the list
 * was cut short". Mutable rows are fingerprinted after writes to detect timestamp collisions; when
 * the database has not been written since the previous check (`PRAGMA data_version` and this
 * connection's `total_changes()`), mutable tables are not scanned. Database-version and worker
 * heartbeat queries still run on quiet ticks.
 */

/** Topics a page can subscribe to. Install-wide ones (keys, models, config, projects, workers) change in every scope. */
export const LIVE_TOPICS = ["tasks", "jobs", "sessions", "requests", "events", "brain", "keys", "web", "models", "config", "projects", "workers", "budget", "labs"] as const;
export type LiveTopic = (typeof LIVE_TOPICS)[number];

/** `all` (every project) or one project's slug. */
export type LiveScope = string;

type Mark = Array<number | string | null>;

export interface LiveCursor {
  v: 1;
  scope: LiveScope;
  /** Per source, its high-water marks. */
  marks: Record<string, Mark>;
  /** The database's `data_version` and this connection's `total_changes()` when the marks were read. */
  dv?: [number, number];
}

export interface LiveCheck {
  /** The cursor to pass to the next check (unchanged marks when nothing changed). */
  cursor: LiveCursor;
  /** Changed topics, sorted: coarse ones (`tasks`) and attributed ones (`tasks:<id>`). Empty when nothing changed. */
  topics: string[];
}

/** How many ids one source attributes per check before reporting `<topic>:*` instead. */
const MAX_IDS = 50;
/** Requests reserved within this window are watched for settling (an in-flight request is recent). */
const SETTLE_WINDOW_MS = 2 * 86_400_000;
/** A worker counts as live while its heartbeat is this recent (as `insights.workers`). */
const WORKER_LIVE_MS = 15_000;
/** How far up a task's parents a change is attributed to enclosing jobs. */
const MAX_JOB_DEPTH = 6;

type Db = MeritRouter["db"];
type Ctx = { sy: MeritRouter; db: Db; project: string | null; now: number };
type Source = {
  /** Read without touching the database (files, clocks): checked even when the store is unchanged. */
  external?: boolean;
  mark(c: Ctx): Mark;
  /** Topics for a changed mark; `prev` is the previous mark (undefined when none was known). */
  topics(c: Ctx, prev: Mark | undefined, next: Mark): string[];
};

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const scoped = (project: string | null, column = "project_id") => (project === null ? { sql: "1 = 1", args: [] as string[] } : { sql: `${column} = ?`, args: [project] });

function ids(topic: string, values: Array<string | null | undefined>, cut: boolean): string[] {
  const out = new Set<string>();
  for (const v of values) if (v) out.add(`${topic}:${v}`);
  if (cut) out.add(`${topic}:*`);
  return [...out];
}

/** `jobs:<id>` for each supervising ancestor of these tasks (a change inside a sub-job reaches the top job). */
function jobAncestors(db: Db, taskIds: string[]): string[] {
  const out = new Set<string>();
  const parentOf = db.prepare("SELECT profile, json_extract(spec_json, '$.parentTaskId') AS parent FROM tasks WHERE id = ?");
  for (const start of taskIds) {
    let id: string | null = start;
    for (let depth = 0; id && depth <= MAX_JOB_DEPTH; depth++) {
      const row = parentOf.get(id) as { profile: string; parent: string | null } | undefined;
      if (!row) break;
      if (row.profile === "supervise") out.add(`jobs:${id}`);
      id = row.parent;
    }
  }
  return [...out];
}

const SOURCES: Record<string, Source & { topic: LiveTopic }> = {
  workerActions: {
    topic: "tasks",
    mark: ({ db, project }) => {
      const s = scoped(project);
      const r = db.prepare(`SELECT MAX(created_at) AS m, COUNT(*) AS n FROM worker_action_requests WHERE ${s.sql}`).get(...s.args) as { m: number | null; n: number };
      return [num(r.m), r.n];
    },
    topics: () => ["tasks", "jobs", "tasks:*", "jobs:*"],
  },
  labs: {
    topic: "labs",
    mark: ({ db, project }) => {
      const s = scoped(project, "l.project_id");
      // Lease-renewal timestamps are deliberately excluded: state and ownership changes matter
      // to the page, while a healthy supervisor renews every second.
      const labs = db.prepare(`SELECT l.id,l.name,l.state,l.updated_at,l.last_activity FROM labs l WHERE ${s.sql} ORDER BY l.id`).all(...s.args);
      const services = db.prepare(`SELECT x.lab_id,x.name,x.state,x.pid,x.restart_count,x.owner_id FROM lab_services x JOIN labs l ON l.id=x.lab_id WHERE ${s.sql} ORDER BY x.lab_id,x.name`).all(...s.args);
      const checks = db.prepare(`SELECT x.id,x.lab_id,x.revision,x.created_at FROM lab_checks x JOIN labs l ON l.id=x.lab_id WHERE ${s.sql} ORDER BY x.id`).all(...s.args);
      const promotions = db.prepare(`SELECT x.id,x.state,x.updated_at FROM lab_promotions x JOIN labs l ON l.id=x.lab_id WHERE ${s.sql} ORDER BY x.id`).all(...s.args);
      const operations = db.prepare(`SELECT id,state,error_code,updated_at FROM lab_operations WHERE ${scoped(project).sql} ORDER BY id`).all(...scoped(project).args);
      return [digest([labs, services, checks, promotions, operations])];
    },
    topics: () => ["labs"],
  },
  tasks: {
    topic: "tasks",
    mark: ({ db, project }) => {
      const s = scoped(project);
      const r = db.prepare(`SELECT MAX(updated_at) AS m, COUNT(*) AS n FROM tasks WHERE ${s.sql}`).get(...s.args) as { m: number | null; n: number };
      return [num(r.m), r.n];
    },
    topics: ({ db, project }, prev) => {
      if (!prev) return ["tasks"];
      const s = scoped(project);
      const rows = db.prepare(`SELECT id FROM tasks WHERE updated_at >= ? AND ${s.sql} ORDER BY updated_at DESC LIMIT ${MAX_IDS + 1}`).all(num(prev[0]), ...s.args) as Array<{ id: string }>;
      const cut = rows.length > MAX_IDS;
      const changed = rows.slice(0, MAX_IDS).map((r) => r.id);
      return ["tasks", ...ids("tasks", changed, cut), ...jobAncestors(db, changed), ...(cut ? ["jobs", "jobs:*"] : [])];
    },
  },
  sessions: {
    topic: "sessions",
    mark: ({ db, project }) => {
      const s = scoped(project);
      const r = db.prepare(`SELECT MAX(updated_at) AS m, COUNT(*) AS n FROM sessions WHERE ${s.sql}`).get(...s.args) as { m: number | null; n: number };
      return [num(r.m), r.n];
    },
    topics: ({ db, project }, prev) => {
      if (!prev) return ["sessions"];
      const s = scoped(project);
      const rows = db
        .prepare(`SELECT id, task_id, job_id FROM sessions WHERE updated_at >= ? AND ${s.sql} ORDER BY updated_at DESC LIMIT ${MAX_IDS + 1}`)
        .all(num(prev[0]), ...s.args) as Array<{ id: string; task_id: string | null; job_id: string | null }>;
      const cut = rows.length > MAX_IDS;
      const kept = rows.slice(0, MAX_IDS);
      const tasks = kept.map((r) => r.task_id).filter((t): t is string => !!t);
      return [
        "sessions",
        ...ids("sessions", kept.map((r) => r.id), cut),
        ...ids("tasks", tasks, cut),
        ...ids("jobs", kept.map((r) => r.job_id), cut),
        ...jobAncestors(db, tasks),
      ];
    },
  },
  budget: {
    topic: "budget",
    mark: ({ db, project }) => {
      const s = scoped(project);
      const t = scoped(project, "t.project_id");
      // Budget decisions can update an older row within the same millisecond. Pool holds also
      // change when a task finishes, a grant/carve changes, or a request is charged.
      return [digest([
        db.prepare(`SELECT * FROM budget_requests WHERE ${s.sql} ORDER BY id`).all(...s.args),
        db.prepare(`SELECT g.*, t.state FROM task_request_grants g JOIN tasks t ON t.id = g.task_id WHERE ${t.sql} ORDER BY g.task_id`).all(...t.args),
        db.prepare(`SELECT g.*, t.state FROM job_budget_carves g JOIN tasks t ON t.id = g.child_task_id WHERE ${t.sql} ORDER BY g.child_task_id`).all(...t.args),
        db.prepare(`SELECT c.* FROM request_charges c JOIN tasks t ON t.id = c.task_id WHERE ${t.sql} ORDER BY c.rowid`).all(...t.args),
      ])];
    },
    topics: () => ["budget", "tasks:*", "jobs:*"],
  },
  requests: {
    topic: "requests",
    mark: ({ db, project, now }) => {
      const s = scoped(project);
      const newest = db.prepare(`SELECT MAX(reserved_at) AS m FROM model_requests WHERE ${s.sql}`).get(...s.args) as { m: number | null };
      const recent = db
        .prepare(`SELECT MAX(finished_at) AS f, SUM(status = 'reserved') AS open, COUNT(*) AS n FROM model_requests WHERE ${s.sql} AND reserved_at >= ?`)
        .get(...s.args, now - SETTLE_WINDOW_MS) as { f: number | null; open: number | null; n: number };
      // The count of recent rows is kept out of the mark: it drops as the window slides.
      return [num(newest.m), num(recent.f), num(recent.open)];
    },
    topics: () => ["requests"],
  },
  events: {
    topic: "events",
    mark: ({ db, project }) => {
      const s = scoped(project);
      const r = db.prepare(`SELECT id FROM events WHERE ${s.sql} ORDER BY id DESC LIMIT 1`).get(...s.args) as { id: number } | undefined;
      return [r?.id ?? 0];
    },
    topics: ({ db, project }, prev) => {
      if (!prev) return ["events"];
      const s = scoped(project);
      const rows = db.prepare(`SELECT DISTINCT task_id FROM events WHERE id > ? AND ${s.sql} LIMIT ${MAX_IDS + 1}`).all(num(prev[0]), ...s.args) as Array<{ task_id: string | null }>;
      const cut = rows.length > MAX_IDS;
      const tasks = rows.slice(0, MAX_IDS).map((r) => r.task_id).filter((t): t is string => !!t);
      return ["events", ...ids("tasks", tasks, cut), ...jobAncestors(db, tasks)];
    },
  },
  jobs: {
    topic: "jobs",
    mark: ({ db, project }) => {
      const s = scoped(project);
      const t = scoped(project, "t.project_id");
      const state = db.prepare(`SELECT MAX(updated_at) AS m FROM job_state WHERE ${s.sql}`).get(...s.args) as { m: number | null };
      const q = db.prepare(`SELECT MAX(q.id) AS m, MAX(q.answered_at) AS a FROM job_questions q JOIN tasks t ON t.id = q.task_id WHERE ${t.sql}`).get(...t.args) as { m: number | null; a: number | null };
      const plans = db.prepare(`SELECT MAX(created_at) AS m, COUNT(*) AS n FROM job_plans WHERE ${s.sql}`).get(...s.args) as { m: number | null; n: number };
      const channel = db.prepare(`SELECT MAX(c.id) AS m FROM job_channel c JOIN tasks t ON t.id = c.job_id WHERE ${t.sql}`).get(...t.args) as { m: number | null };
      const merges = db.prepare(`SELECT MAX(m.updated_at) AS m FROM merge_queue m JOIN tasks t ON t.id = m.task_id WHERE ${t.sql}`).get(...t.args) as { m: number | null };
      const leases = db
        .prepare(`SELECT MAX(l.id) AS m, MAX(l.released_at) AS r FROM file_leases l JOIN tasks t ON t.id = l.task_id WHERE ${t.sql}`)
        .get(...t.args) as { m: number | null; r: number | null };
      return [num(state.m), num(q.m), num(q.a), num(plans.m), plans.n, num(channel.m), num(merges.m), num(leases.m), num(leases.r)];
    },
    topics: ({ db, project }, prev) => {
      if (!prev) return ["jobs"];
      const s = scoped(project);
      const t = scoped(project, "t.project_id");
      const found: Array<string | null> = [];
      const pull = (sql: string, args: unknown[]) => found.push(...(db.prepare(sql).all(...args) as Array<{ id: string | null }>).map((r) => r.id));
      pull(`SELECT task_id AS id FROM job_state WHERE updated_at >= ? AND ${s.sql} LIMIT ${MAX_IDS}`, [num(prev[0]), ...s.args]);
      pull(`SELECT q.task_id AS id FROM job_questions q JOIN tasks t ON t.id = q.task_id WHERE (q.id > ? OR q.answered_at >= ?) AND ${t.sql} LIMIT ${MAX_IDS}`, [num(prev[1]), num(prev[2]), ...t.args]);
      pull(`SELECT job_id AS id FROM job_plans WHERE created_at >= ? AND ${s.sql} LIMIT ${MAX_IDS}`, [num(prev[3]), ...s.args]);
      pull(`SELECT c.job_id AS id FROM job_channel c JOIN tasks t ON t.id = c.job_id WHERE c.id > ? AND ${t.sql} LIMIT ${MAX_IDS}`, [num(prev[5]), ...t.args]);
      pull(`SELECT m.job_id AS id FROM merge_queue m JOIN tasks t ON t.id = m.task_id WHERE m.updated_at >= ? AND ${t.sql} LIMIT ${MAX_IDS}`, [num(prev[6]), ...t.args]);
      pull(`SELECT l.job_id AS id FROM file_leases l JOIN tasks t ON t.id = l.task_id WHERE (l.id > ? OR l.released_at >= ?) AND ${t.sql} LIMIT ${MAX_IDS}`, [num(prev[7]), num(prev[8]), ...t.args]);
      const direct = [...new Set(found.filter((v): v is string => !!v))];
      const cut = direct.length > MAX_IDS;
      return ["jobs", ...ids("jobs", direct.slice(0, MAX_IDS), cut), ...jobAncestors(db, direct.slice(0, MAX_IDS))];
    },
  },
  brainAccess: {
    topic: "brain",
    mark: ({ db, project }) => {
      const s = scoped(project);
      const r = db.prepare(`SELECT MAX(id) AS m, MAX(decided_at) AS d FROM brain_access_requests WHERE ${s.sql}`).get(...s.args) as { m: number | null; d: number | null };
      const files = db.prepare("SELECT MAX(mtime) AS m, COUNT(*) AS n FROM brain_files").get() as { m: number | null; n: number };
      return [num(r.m), num(r.d), num(files.m), files.n];
    },
    topics: () => ["brain"],
  },
  brainHead: {
    topic: "brain",
    external: true,
    mark: ({ sy, project }) => {
      const roots = project ? [sy.brainFor(project).root] : [sy.brain.root, ...sy.projects.slugs().map((slug) => sy.brainFor(slug).root)];
      return [digest([...new Set(roots)].sort().map((root) => [root, gitHead(root)]))];
    },
    topics: () => ["brain"],
  },
  keys: {
    topic: "keys",
    mark: ({ db }) => {
      const state = db.prepare("SELECT MAX(updated_at) AS m, COUNT(*) AS n FROM provider_key_state").get() as { m: number | null; n: number };
      const vault = db.prepare("SELECT COUNT(*) AS n, MAX(id) AS m, SUM(enabled) AS e, TOTAL(length(enc)) AS l, TOTAL(COALESCE(monthly_cap_usd, 0)) AS c FROM paid_keys").get() as Record<string, number | null>;
      const spend = db.prepare("SELECT MAX(created_at) AS c, MAX(settled_at) AS s FROM paid_spend").get() as { c: number | null; s: number | null };
      const web = db.prepare("SELECT MAX(updated_at) AS m, COUNT(*) AS n FROM web_backend_state").get() as { m: number | null; n: number };
      return [num(state.m), state.n, num(vault.n), num(vault.m), num(vault.e), num(vault.l), num(vault.c), num(spend.c), num(spend.s), num(web.m), web.n];
    },
    topics: () => ["keys"],
  },
  web: {
    topic: "web",
    mark: ({ db, project, now }) => {
      const s = scoped(project);
      const newest = db.prepare(`SELECT MAX(id) AS m FROM web_requests WHERE ${s.sql}`).get(...s.args) as { m: number | null };
      const recent = db.prepare(`SELECT MAX(finished_at) AS f FROM web_requests WHERE ${s.sql} AND started_at >= ?`).get(...s.args, now - SETTLE_WINDOW_MS) as { f: number | null };
      return [num(newest.m), num(recent.f)];
    },
    topics: () => ["web"],
  },
  models: {
    topic: "models",
    mark: ({ db, sy }) => {
      const eps = db.prepare("SELECT COUNT(*) AS n, MAX(last_scanned_at) AS m FROM endpoints").get() as { n: number; m: number | null };
      const scans = db.prepare("SELECT MAX(id) AS m, MAX(finished_at) AS f FROM scans").get() as { m: number | null; f: number | null };
      const eo = db.prepare("SELECT COUNT(*) AS n, MAX(updated_at) AS m FROM endpoint_overrides").get() as { n: number; m: number | null };
      const ro = db.prepare("SELECT COUNT(*) AS n, MAX(id) AS m, SUM(enabled) AS e FROM routing_overrides").get() as { n: number; m: number | null; e: number | null };
      const quarantine = db.prepare("SELECT id, endpoint_id, policy_violation FROM model_requests WHERE policy_violation IS NOT NULL ORDER BY rowid").all();
      const acknowledgements = db.prepare("SELECT key, value FROM meta WHERE key LIKE 'quarantine_ack:%' ORDER BY key").all();
      return [sy.catalog.version(), eps.n, num(eps.m), num(scans.m), num(scans.f), eo.n, num(eo.m), ro.n, num(ro.m), num(ro.e), digest([quarantine, acknowledgements])];
    },
    topics: () => ["models"],
  },
  projects: {
    topic: "projects",
    mark: ({ db }) => {
      const r = db.prepare("SELECT COUNT(*) AS n, SUM(archived_at IS NOT NULL) AS a, MAX(created_at) AS c, MAX(archived_at) AS x FROM projects").get() as Record<string, number | null>;
      return [num(r.n), num(r.a), num(r.c), num(r.x)];
    },
    topics: () => ["projects"],
  },
  config: {
    topic: "config",
    external: true,
    mark: ({ sy }) => [mtime(sy.cfg.configPath)],
    topics: () => ["config", "projects", "models"],
  },
  workers: {
    topic: "workers",
    // A worker that stops writing its heartbeat leaves the set without a database write.
    external: true,
    mark: ({ db, now }) => {
      const rows = db.prepare("SELECT key, value FROM meta WHERE key LIKE 'worker:%'").all() as Array<{ key: string; value: string }>;
      const live = rows.filter((r) => now - Number(r.value) <= WORKER_LIVE_MS).map((r) => r.key.slice("worker:".length));
      return [digest(live.sort())];
    },
    topics: () => ["workers"],
  },
};

function mtime(file: string): number {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/** The commit a git repository's HEAD points at (null when it has none or is not a repository). */
export function gitHead(root: string): string | null {
  try {
    const git = path.join(root, ".git");
    if (!existsSync(git)) return null;
    const head = readFileSync(path.join(git, "HEAD"), "utf8").trim();
    if (!head.startsWith("ref: ")) return head || null;
    const ref = head.slice(5).trim();
    const loose = path.join(git, ...ref.split("/"));
    if (existsSync(loose)) return readFileSync(loose, "utf8").trim() || null;
    const packed = path.join(git, "packed-refs");
    if (!existsSync(packed)) return null;
    for (const line of readFileSync(packed, "utf8").split(/\r?\n/)) {
      const [sha, name] = line.split(" ");
      if (name === ref && sha) return sha;
    }
    return null;
  } catch {
    return null;
  }
}

function dataVersion(db: Db): [number, number] {
  const dv = num(db.pragma("data_version", { simple: true }));
  const own = num((db.prepare("SELECT total_changes() AS n").get() as { n: number }).n);
  return [dv, own];
}

function scopeProject(scope: LiveScope): string | null {
  return scope === "all" ? null : scope;
}

function readMarks(c: Ctx, only?: (s: Source) => boolean): Record<string, Mark> {
  const marks: Record<string, Mark> = {};
  for (const [name, src] of Object.entries(SOURCES)) if (!only || only(src)) {
    marks[name] = src.mark(c);
    // High-water timestamps alone miss writes within the same millisecond and updates to
    // older rows. Fingerprint mutable rows only after a database write, never on quiet ticks.
    const tables = MUTABLE_TABLES[name];
    if (tables) marks[name].push(digest(tables.map((table) => {
      const s = scoped(c.project);
      return c.db.prepare(`SELECT * FROM ${table} WHERE ${s.sql} ORDER BY rowid`).all(...s.args);
    })));
    const globalTables = GLOBAL_MUTABLE_TABLES[name];
    if (globalTables) marks[name].push(digest(globalTables.map((table) =>
      c.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
    )));
    if (name === "jobs") {
      const s = scoped(c.project, "t.project_id");
      marks[name].push(digest([
        ...["job_questions", "merge_queue", "file_leases"].map((table) =>
          c.db.prepare(`SELECT x.* FROM ${table} x JOIN tasks t ON t.id = x.task_id WHERE ${s.sql} ORDER BY x.rowid`).all(...s.args)),
        c.db.prepare(`SELECT x.* FROM job_channel x JOIN tasks t ON t.id = x.job_id WHERE ${s.sql} ORDER BY x.rowid`).all(...s.args),
      ]));
    }
  }
  return marks;
}

const MUTABLE_TABLES: Record<string, string[]> = {
  tasks: ["tasks"], sessions: ["sessions"], requests: ["model_requests"],
  workerActions: ["worker_action_requests"],
  jobs: ["job_state", "job_plans"],
  web: ["web_requests"], brainAccess: ["brain_access_requests", "brain_grants"],
};
const GLOBAL_MUTABLE_TABLES: Record<string, string[]> = {
  keys: ["provider_key_state", "paid_keys", "paid_spend", "web_backend_state"],
  models: ["endpoints", "endpoint_overrides", "routing_overrides", "scans", "model_requests"],
  projects: ["projects"], brainAccess: ["brain_files"],
};
const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

const same = (a: Mark | undefined, b: Mark): boolean => !!a && a.length === b.length && a.every((v, i) => v === b[i]);

/** A cursor at the store's current state for `scope` (`all` or a project slug). */
export function liveCursor(sy: MeritRouter, scope: LiveScope, now = Date.now()): LiveCursor {
  const c: Ctx = { sy, db: sy.db, project: scopeProject(scope), now };
  const dv = dataVersion(sy.db);
  return { v: 1, scope, marks: readMarks(c), dv };
}

/**
 * What changed in `cursor.scope` since `cursor`. Mutable tables are scanned only after writes
 * since the cursor was read (by this connection or another process). Database-version queries,
 * files and the worker heartbeat set are checked every time.
 */
export function liveChanges(sy: MeritRouter, cursor: LiveCursor, now = Date.now()): LiveCheck {
  const c: Ctx = { sy, db: sy.db, project: scopeProject(cursor.scope), now };
  const dv = dataVersion(sy.db);
  const quiet = !!cursor.dv && cursor.dv[0] === dv[0] && cursor.dv[1] === dv[1];
  const next = { ...cursor.marks, ...readMarks(c, quiet ? (s) => !!s.external : undefined) };
  const topics = new Set<string>();
  for (const [name, src] of Object.entries(SOURCES)) {
    const mark = next[name];
    if (!mark || same(cursor.marks[name], mark)) continue;
    for (const t of src.topics(c, cursor.marks[name], mark)) topics.add(t);
    // A changed older row may lie below the previous timestamp cutoff. Fine-grained
    // subscribers must refresh too, including enclosing jobs for task/session changes.
    if (name === "tasks" || name === "sessions" || name === "jobs") {
      topics.add(`${name}:*`);
      topics.add("jobs:*");
      if (name === "sessions") topics.add("tasks:*");
    }
  }
  return { cursor: { v: 1, scope: cursor.scope, marks: next, dv }, topics: [...topics].sort() };
}

const CursorSchema = z
  .object({
    v: z.literal(1),
    scope: z.string().min(1).max(100),
    marks: z.record(z.string().max(40), z.array(z.union([z.number(), z.string().max(200), z.null()])).max(20)),
    dv: z.tuple([z.number(), z.number()]).optional(),
  })
  .strict();

/** A cursor as an opaque URL-safe string (the SSE event id). */
export function encodeLiveCursor(cursor: LiveCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

/**
 * A cursor from a client (untrusted): null when it is malformed or for another scope. The
 * `data_version` pair is dropped: it belongs to the connection that read it, so a resumed cursor
 * always compares the marks.
 */
export function decodeLiveCursor(text: string, scope: LiveScope): LiveCursor | null {
  if (!text || text.length > 4000) return null;
  try {
    const parsed = CursorSchema.safeParse(JSON.parse(Buffer.from(text, "base64url").toString("utf8")));
    if (!parsed.success || parsed.data.scope !== scope) return null;
    const known = Object.fromEntries(Object.entries(parsed.data.marks).filter(([k]) => Object.hasOwn(SOURCES, k)));
    return { v: 1, scope, marks: known };
  } catch {
    return null;
  }
}

/** Whether a changed topic list reaches a subscription (`tasks` matches `tasks`; `tasks:x` matches `tasks:x` and `tasks:*`). */
export function liveMatches(subscription: string, changed: readonly string[]): boolean {
  const colon = subscription.indexOf(":");
  if (colon < 0) return changed.includes(subscription);
  return changed.includes(subscription) || changed.includes(`${subscription.slice(0, colon)}:*`);
}
