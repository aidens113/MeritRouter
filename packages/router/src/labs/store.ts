import { z } from "zod";
import type { Db } from "../storage/db.js";
import { LabNameSchema, LabRecipeSchema } from "./recipe.js";
export const LabStateSchema = z.enum(["creating", "stopped", "starting", "running", "failed", "destroyed"]);
export const LabRepositorySchema = z.object({ alias: z.string().min(1), source: z.string().min(1), worktree: z.string().min(1), branch: z.string().min(1), target: z.string().min(1), base: z.string().regex(/^[a-f0-9]{40,64}$/) }).strict();
export const LabRecordSchema = z.object({
  id: z.string().min(1), project: z.string().min(1), name: LabNameSchema, state: LabStateSchema,
  root: z.string().min(1), recipe: LabRecipeSchema, repositories: z.array(LabRepositorySchema),
  ports: z.record(z.string(), z.number().int().min(1024).max(65535)), env: z.record(z.string(), z.string()),
  goal: z.string(), createdAt: z.number().int(), updatedAt: z.number().int(), lastActivity: z.number().int(),
}).strict();
export type LabRecord = z.infer<typeof LabRecordSchema>;
export const LabServiceSchema = z.object({
  lab_id: z.string(), name: LabNameSchema, state: z.enum(["stopped", "starting", "running", "backoff", "failed"]),
  pid: z.number().int().positive().nullable(), token: z.string().min(16).nullable(), log_path: z.string(), restart_count: z.number().int().nonnegative(),
  next_restart: z.number().nullable(), started_at: z.number().nullable(), owner_id: z.string().nullable(), owner_until: z.number(),
});
export type LabServiceRecord = z.infer<typeof LabServiceSchema>;
const Row = z.object({ id: z.string(), project_id: z.string(), name: z.string(), state: z.string(), root: z.string(), recipe_json: z.string(), repositories_json: z.string(), ports_json: z.string(), env_json: z.string(), goal: z.string(), created_at: z.number(), updated_at: z.number(), last_activity: z.number() });
export class LabsStore {
  constructor(readonly db: Db) { }
  private hydrate(raw: unknown): LabRecord {
    const r = Row.parse(raw);
    return LabRecordSchema.parse({ id: r.id, project: r.project_id, name: r.name, state: r.state, root: r.root, recipe: JSON.parse(r.recipe_json), repositories: JSON.parse(r.repositories_json), ports: JSON.parse(r.ports_json), env: JSON.parse(r.env_json), goal: r.goal, createdAt: r.created_at, updatedAt: r.updated_at, lastActivity: r.last_activity });
  }
  get(project: string, name: string): LabRecord | null { const row = this.db.prepare("SELECT * FROM labs WHERE project_id=? AND name=?").get(project, name); return row ? this.hydrate(row) : null; }
  byId(id: string): LabRecord | null { const row = this.db.prepare("SELECT * FROM labs WHERE id=?").get(id); return row ? this.hydrate(row) : null; }
  list(project?: string): LabRecord[] { return this.db.prepare(`SELECT * FROM labs ${project === undefined ? "" : "WHERE project_id=?"} ORDER BY created_at,id`).all(...(project === undefined ? [] : [project])).map((r) => this.hydrate(r)); }
  insert(lab: LabRecord): void {
    const l = LabRecordSchema.parse(lab);
    this.db.prepare("INSERT INTO labs (id,project_id,name,state,root,recipe_json,repositories_json,ports_json,env_json,goal,created_at,updated_at,last_activity) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").run(l.id, l.project, l.name, l.state, l.root, JSON.stringify(l.recipe), JSON.stringify(l.repositories), JSON.stringify(l.ports), JSON.stringify(l.env), l.goal, l.createdAt, l.updatedAt, l.lastActivity);
    this.event(l.id, "created", { project: l.project, name: l.name });
  }
  save(lab: LabRecord): void {
    const l = LabRecordSchema.parse(lab);
    this.db.prepare("UPDATE labs SET state=?, repositories_json=?, ports_json=?, env_json=?, updated_at=?, last_activity=? WHERE id=?").run(l.state, JSON.stringify(l.repositories), JSON.stringify(l.ports), JSON.stringify(l.env), l.updatedAt, l.lastActivity, l.id);
  }
  event(id: string, type: string, data: unknown): void { this.db.prepare("INSERT INTO lab_events (lab_id,type,data_json,created_at) VALUES (?,?,?,?)").run(id, type, JSON.stringify(data), Date.now()); }
  services(id: string): LabServiceRecord[] { return this.db.prepare("SELECT * FROM lab_services WHERE lab_id=? ORDER BY name").all(id).map((r) => LabServiceSchema.parse(r)); }
  service(id: string, name: string): LabServiceRecord | null { const raw = this.db.prepare("SELECT * FROM lab_services WHERE lab_id=? AND name=?").get(id, name); return raw ? LabServiceSchema.parse(raw) : null; }
  saveService(service: LabServiceRecord): void {
    const s = LabServiceSchema.parse(service);
    this.db.prepare("INSERT INTO lab_services (lab_id,name,state,pid,token,log_path,restart_count,next_restart,started_at,owner_id,owner_until) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(lab_id,name) DO UPDATE SET state=excluded.state,pid=excluded.pid,token=excluded.token,restart_count=excluded.restart_count,next_restart=excluded.next_restart,started_at=excluded.started_at,owner_id=excluded.owner_id,owner_until=excluded.owner_until").run(s.lab_id, s.name, s.state, s.pid, s.token, s.log_path, s.restart_count, s.next_restart, s.started_at, s.owner_id, s.owner_until);
  }
}
