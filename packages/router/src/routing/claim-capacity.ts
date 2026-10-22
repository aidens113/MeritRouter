import type { ResolvedConfig } from "../config/load.js";
import { TIER_NAMES, type TierName } from "../config/schema.js";
import type { WorkerTask } from "../core/task.js";
import type { ProviderCapacity } from "../gateway/capacity.js";
import type { ClaimAdmission, StoredTask, TaskRow } from "../storage/tasks.js";
import type { TaskRouter } from "./router.js";

/** Route plans are reused for this long across claim passes (health changes slowly). */
const PLAN_CACHE_MS = 1000;

/**
 * Tiers a queued task can route at before it is classified: its forced or recorded tier
 * (a resumed task keeps its classification), else the supervisor's hint, else every tier from
 * its task type's minimum up to T3 (the classifier may still raise it).
 */
export function claimTiers(cfg: ResolvedConfig, row: TaskRow, spec: WorkerTask): TierName[] {
  const fixed = spec.routing?.tier ?? (row as TaskRow & { tier?: string | null }).tier ?? spec.hints?.difficulty ?? null;
  if (fixed && (TIER_NAMES as readonly string[]).includes(fixed)) return [fixed as TierName];
  if (fixed === "T4") return ["T3"];
  const min = cfg.profiles[spec.profile]?.min_tier ?? "T1";
  return TIER_NAMES.slice(TIER_NAMES.indexOf(min));
}

/**
 * The scheduler's provider-slot admission: a worker task starts only when some platform in its
 * route plan has a slot that is not taken by an in-flight request, by another task admitted
 * there that has not sent its first request yet, or by a waiting supervisor or reviewer. The
 * task then holds a claim on that platform until its first request (or `CLAIM_HOLD_MS`), so
 * one claim pass cannot start more tasks than there are slots. Otherwise it stays queued with
 * reason `waiting_for_provider_slot:<platforms>`. A task with no route at all is admitted (the
 * run reports why it cannot route).
 */
export class ProviderSlotAdmission implements ClaimAdmission {
  private readonly chosen = new Map<string, string>();
  private cache: { at: number; plans: Map<string, string[]> } = { at: 0, plans: new Map() };

  constructor(
    private readonly cfg: ResolvedConfig,
    private readonly router: Pick<TaskRouter, "plan" | "inputModalities">,
    private readonly capacity: ProviderCapacity,
    private readonly now: () => number = Date.now,
  ) {}

  /** Platforms the task can route to, in route order (union over its possible tiers). */
  platforms(row: TaskRow, spec: WorkerTask): string[] {
    const now = this.now();
    if (now - this.cache.at > PLAN_CACHE_MS) this.cache = { at: now, plans: new Map() };
    const modalities = this.router.inputModalities({ row, spec } as StoredTask);
    const qualifying = (row as TaskRow & { purpose?: string }).purpose === "qualification";
    const out: string[] = [];
    for (const tier of claimTiers(this.cfg, row, spec)) {
      const key = [spec.profile, tier, modalities.join("+"), spec.routing?.endpointId ?? "", qualifying ? "q" : ""].join("|");
      let platforms = this.cache.plans.get(key);
      if (!platforms) {
        const plan = this.router.plan(spec.profile, tier, modalities, spec.routing?.endpointId, qualifying);
        platforms = [...new Set(plan.candidates.map((ep) => ep.providerId))];
        this.cache.plans.set(key, platforms);
      }
      for (const p of platforms) if (!out.includes(p)) out.push(p);
    }
    return out;
  }

  check(row: TaskRow, spec: WorkerTask): { wait: string; data: Record<string, unknown> } | null {
    this.chosen.delete(row.id);
    if (!this.capacity.enabled) return null;
    let platforms: string[];
    try {
      platforms = this.platforms(row, spec);
    } catch {
      return null;
    }
    if (!platforms.length) return null;
    const r = this.capacity.admissible(platforms);
    if (r.platform) {
      this.chosen.set(row.id, r.platform);
      return null;
    }
    return {
      wait: platforms.join(","),
      data: { platforms: r.usage.map((u) => ({ platform: u.platform, limit: u.limit, inFlight: u.requests, starting: u.claims, waiting: u.waiting })) },
    };
  }

  claimed(row: TaskRow, _spec: WorkerTask, owner: string): void {
    const platform = this.chosen.get(row.id);
    this.chosen.delete(row.id);
    if (platform) this.capacity.recordClaim(row.id, owner, platform, { taskId: row.id, owner, runCount: row.run_count + 1, incarnation: row.lease_incarnation, project: row.project_id });
  }
}
