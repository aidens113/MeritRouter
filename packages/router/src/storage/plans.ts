import { z } from "zod";
import type { Db } from "./db.js";
import { immediate } from "./db.js";
import { ImportanceSchema, ProfileNameSchema, type Importance } from "../config/schema.js";
import { LabNameSchema } from "../labs/recipe.js";

/**
 * A job's decomposition as a versioned task graph (`plan_work`). Every version is immutable;
 * re-planning appends a version, and nodes already dispatched keep their tasks. Node labels are
 * the task labels the supervisor dispatches them under (`<job>:<label>` is the idempotency key),
 * so a node's task is the job's child task with that label.
 */

export const PLAN_LABEL_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
export const PLAN_DIFFICULTIES = ["T1", "T2", "T3", "T4"] as const;
export type PlanDifficulty = (typeof PLAN_DIFFICULTIES)[number];
/** Most nodes one plan version may hold. */
export const MAX_PLAN_NODES = 50;

/** Most runs a redundant node may get. */
export const MAX_REDUNDANCY = 2;
/** Difficulties a redundant node may have (small nodes only). */
export const REDUNDANT_DIFFICULTIES: ReadonlySet<PlanDifficulty> = new Set(["T1", "T2"]);

/** Estimated cost of a node by tier, for the critical path (a T3 node costs four T1 nodes). */
export const TIER_WEIGHT: Readonly<Record<PlanDifficulty, number>> = { T1: 1, T2: 2, T3: 4, T4: 8 };
/** Weight of a node with no difficulty hint and no profile minimum tier. */
export const DEFAULT_NODE_WEIGHT = TIER_WEIGHT.T2;

export const PlanNodeSchema = z
  .object({
    label: z.string().regex(PLAN_LABEL_RE),
    /** `supervise` starts a sub-job (dispatched through the delegate path: depth limit, branch fork, budget carve). */
    profile: ProfileNameSchema,
    goal: z.string().min(1).max(20_000),
    acceptanceCriteria: z.array(z.string().min(1)).min(1),
    /** Labels of nodes in this plan, or of tasks the job dispatched earlier. */
    dependsOn: z.array(z.string().regex(PLAN_LABEL_RE)).default([]),
    writableRepository: z.string().nullable().default(null),
    repairFromTask: z.string().min(1).nullable().default(null),
    allowedPaths: z.array(z.string().min(1)).nullable().default(null),
    checks: z.array(z.string().min(1)).default([]),
    labChecks: z.array(LabNameSchema).max(10).default([]),
    difficulty: z.enum(PLAN_DIFFICULTIES).nullable().default(null),
    importance: ImportanceSchema.nullable().default(null),
    /**
     * The node starts only on accepted upstream results (`met`, including results the supervisor
     * or a human accepted): a `not_verified` or `needs_supervisor` upstream keeps it waiting, an
     * `unmet` one fails it. Defaults to true for high and critical importance.
     */
    requiresAcceptedInputs: z.boolean(),
    /** Estimated cost (tier weight) used for the critical path. */
    weight: z.number().positive(),
    /**
     * Redundant execution: 2 runs the node's first attempt twice, on different endpoints, and
     * keeps the first result that passes verification (the other run is cancelled; both are
     * charged). Only for small non-coding nodes: T1/T2, no writable repository.
     */
    redundancy: z.number().int().min(1).max(MAX_REDUNDANCY).default(1),
  })
  .strict()
  .superRefine((n, ctx) => {
    if (n.redundancy < 2) return;
    if (n.profile === "supervise") ctx.addIssue({ code: "custom", path: ["redundancy"], message: `plan node ${n.label}: redundancy is not for sub-supervisors (supervise nodes)` });
    if (n.writableRepository !== null) ctx.addIssue({ code: "custom", path: ["redundancy"], message: `plan node ${n.label}: redundancy is only for non-coding nodes (it has a writable repository)` });
    if (n.difficulty && !REDUNDANT_DIFFICULTIES.has(n.difficulty)) ctx.addIssue({ code: "custom", path: ["redundancy"], message: `plan node ${n.label}: redundancy is only for small nodes (T1 or T2, not ${n.difficulty})` });
  });
export type PlanNode = z.infer<typeof PlanNodeSchema>;
export type PlanNodeInput = z.input<typeof PlanNodeSchema>;

const PlanBodySchema = z
  .object({
    schemaVersion: z.literal(1),
    nodes: z.array(PlanNodeSchema).min(1).max(MAX_PLAN_NODES),
  })
  .strict();

export interface JobPlan {
  jobId: string;
  version: number;
  nodes: PlanNode[];
  note: string | null;
  createdBy: string | null;
  createdAt: number;
}

export interface CriticalPath {
  /** Node labels from the first node to start to the last to finish. */
  labels: string[];
  /** Sum of the nodes' weights along the path. */
  cost: number;
}

/** Whether a node's dependents-on-inputs rule defaults to accepted inputs. */
export function defaultRequiresAcceptedInputs(importance: Importance | null | undefined): boolean {
  return importance === "high" || importance === "critical";
}

/** A node's estimated cost: its difficulty's tier weight, else the profile's minimum tier, else T2. */
export function nodeWeight(difficulty: PlanDifficulty | null | undefined, profileMinTier?: string | null): number {
  if (difficulty) return TIER_WEIGHT[difficulty];
  if (profileMinTier && profileMinTier in TIER_WEIGHT) return TIER_WEIGHT[profileMinTier as PlanDifficulty];
  return DEFAULT_NODE_WEIGHT;
}

/**
 * Validate a plan's graph: unique labels, every dependency a node of the plan or a label in
 * `external` (tasks the job already dispatched), and no cycle among the plan's nodes. Throws
 * an Error naming the problem.
 */
export function assertPlanGraph(nodes: Array<Pick<PlanNode, "label" | "dependsOn">>, external: ReadonlySet<string>): void {
  const byLabel = new Map<string, Pick<PlanNode, "label" | "dependsOn">>();
  for (const n of nodes) {
    if (byLabel.has(n.label)) throw new Error(`plan label ${n.label} is used more than once`);
    byLabel.set(n.label, n);
  }
  for (const n of nodes) {
    for (const d of n.dependsOn) {
      if (d === n.label) throw new Error(`plan node ${n.label} depends on itself`);
      if (!byLabel.has(d) && !external.has(d)) throw new Error(`plan node ${n.label} depends on ${d}, which is neither a node of this plan nor a task of this job`);
    }
  }
  const state = new Map<string, 1 | 2>();
  const visit = (label: string, trail: string[]): void => {
    const s = state.get(label);
    if (s === 2) return;
    if (s === 1) throw new Error(`plan dependency cycle: ${[...trail, label].join(" -> ")}`);
    state.set(label, 1);
    for (const d of byLabel.get(label)?.dependsOn ?? []) if (byLabel.has(d)) visit(d, [...trail, label]);
    state.set(label, 2);
  };
  for (const n of nodes) visit(n.label, []);
}

/**
 * The longest chain of the plan by estimated cost (sum of node weights). Dependencies outside
 * the plan count as already done. Ties go to the node listed first. Assumes an acyclic graph.
 */
export function criticalPath(nodes: Array<Pick<PlanNode, "label" | "dependsOn" | "weight">>): CriticalPath {
  if (!nodes.length) return { labels: [], cost: 0 };
  const byLabel = new Map(nodes.map((n) => [n.label, n]));
  const best = new Map<string, { cost: number; via: string | null }>();
  const solve = (label: string): number => {
    const known = best.get(label);
    if (known) return known.cost;
    const n = byLabel.get(label)!;
    let via: string | null = null;
    let upstream = 0;
    for (const d of n.dependsOn) {
      if (!byLabel.has(d)) continue;
      const c = solve(d);
      if (c > upstream) {
        upstream = c;
        via = d;
      }
    }
    best.set(label, { cost: upstream + n.weight, via });
    return upstream + n.weight;
  };
  let end = nodes[0]!.label;
  for (const n of nodes) if (solve(n.label) > solve(end)) end = n.label;
  const labels: string[] = [];
  for (let at: string | null = end; at; at = best.get(at)!.via) labels.unshift(at);
  return { labels, cost: best.get(end)!.cost };
}

const PlanRowSchema = z.object({
  job_id: z.string(),
  version: z.number().int(),
  plan_json: z.string(),
  note: z.string().nullable(),
  created_by: z.string().nullable(),
  created_at: z.number().int(),
});

function hydrate(raw: unknown): JobPlan {
  const r = PlanRowSchema.parse(raw);
  const body = PlanBodySchema.parse(JSON.parse(r.plan_json));
  return { jobId: r.job_id, version: r.version, nodes: body.nodes, note: r.note, createdBy: r.created_by, createdAt: r.created_at };
}

/** Versioned job plans in SQLite (`job_plans`). */
export class PlanStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  /** Record a new version of a job's plan; returns it. Nodes are validated (schema and graph). */
  record(jobId: string, nodes: PlanNodeInput[], opts: { note?: string | null; createdBy?: string | null; external?: ReadonlySet<string> } = {}): JobPlan {
    const parsed = PlanBodySchema.parse({ schemaVersion: 1, nodes });
    assertPlanGraph(parsed.nodes, opts.external ?? new Set());
    return immediate(this.db, () => {
      const max = (this.db.prepare("SELECT MAX(version) AS v FROM job_plans WHERE job_id = ?").get(jobId) as { v: number | null }).v ?? 0;
      const version = max + 1;
      const createdAt = this.now();
      this.db
        .prepare("INSERT INTO job_plans (job_id, version, plan_json, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(jobId, version, JSON.stringify(parsed), opts.note ?? null, opts.createdBy ?? null, createdAt);
      return { jobId, version, nodes: parsed.nodes, note: opts.note ?? null, createdBy: opts.createdBy ?? null, createdAt };
    });
  }

  /** Remove a version recorded by a dispatch that then failed (only the latest may be removed). */
  discard(jobId: string, version: number): void {
    immediate(this.db, () => {
      const max = (this.db.prepare("SELECT MAX(version) AS v FROM job_plans WHERE job_id = ?").get(jobId) as { v: number | null }).v;
      if (max !== version) throw new Error(`plan version ${version} of ${jobId} is not the latest`);
      this.db.prepare("DELETE FROM job_plans WHERE job_id = ? AND version = ?").run(jobId, version);
    });
  }

  latest(jobId: string): JobPlan | null {
    const row = this.db.prepare("SELECT * FROM job_plans WHERE job_id = ? ORDER BY version DESC LIMIT 1").get(jobId);
    return row ? hydrate(row) : null;
  }

  get(jobId: string, version: number): JobPlan | null {
    const row = this.db.prepare("SELECT * FROM job_plans WHERE job_id = ? AND version = ?").get(jobId, version);
    return row ? hydrate(row) : null;
  }

  /** Every version, oldest first. */
  list(jobId: string): JobPlan[] {
    return this.db.prepare("SELECT * FROM job_plans WHERE job_id = ? ORDER BY version ASC").all(jobId).map(hydrate);
  }

  /** The node with this label in the latest version that has one. */
  nodeFor(jobId: string, label: string): PlanNode | null {
    const rows = this.db.prepare("SELECT * FROM job_plans WHERE job_id = ? ORDER BY version DESC").all(jobId);
    for (const row of rows) {
      const node = hydrate(row).nodes.find((n) => n.label === label);
      if (node) return node;
    }
    return null;
  }
}

/**
 * Whether a task may start only on accepted upstream results: its plan node says so, or (not a
 * plan node) its importance is high or critical.
 */
export function requiresAcceptedInputs(db: Db, spec: { parentTaskId?: string | undefined; label?: string | undefined; importance?: Importance | undefined }): boolean {
  if (spec.parentTaskId && spec.label) {
    const node = new PlanStore(db).nodeFor(spec.parentTaskId, spec.label);
    if (node) return node.requiresAcceptedInputs;
  }
  return defaultRequiresAcceptedInputs(spec.importance);
}

/** How many runs a task's first attempt gets: its plan node's `redundancy`, else 1. */
export function redundancyFor(db: Db, spec: { parentTaskId?: string | undefined; label?: string | undefined }): number {
  if (!spec.parentTaskId || !spec.label) return 1;
  return new PlanStore(db).nodeFor(spec.parentTaskId, spec.label)?.redundancy ?? 1;
}
