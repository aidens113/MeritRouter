import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import type { ResolvedConfig } from "../config/load.js";
import { loadConfig } from "../config/load.js";
import type { Db } from "../storage/db.js";
import { LeaseRefSchema, type LeaseRef } from "../storage/lease-ref.js";
import { MeritRouterError } from "../core/errors.js";
import { currentSupervisorAuthority } from "../core/supervisor-authority.js";

export interface LabEffectAuthority { lease: LeaseRef | null; assert(): void; signal: AbortSignal }
const scopes = new AsyncLocalStorage<LabEffectAuthority>();
export const currentLabAuthority = () => scopes.getStore();
export function assertLabEffect(): void { scopes.getStore()?.assert(); }
export function labEffectSignal(fallback?: AbortSignal): AbortSignal | undefined {
  const signal = scopes.getStore()?.signal;
  return signal && fallback ? AbortSignal.any([signal, fallback]) : signal ?? fallback;
}
export function assertLabSupervisor(db: Db, cfg: ResolvedConfig, project: string, lease: LeaseRef): void {
  const parsed = LeaseRefSchema.parse(lease);
  const live = loadConfig(cfg.configPath);
  if (project !== parsed.project || !currentSupervisorAuthority(db, cfg, parsed) || live.security.outside_repository !== "supervisor") throw new MeritRouterError("lab_scope_denied", "original supervisor Lab authority was revoked or outside-repository policy no longer permits supervisors");
}
export function parseLabAuthority(raw: string | null): LeaseRef | null {
  return raw === null ? null : LeaseRefSchema.parse(JSON.parse(raw));
}
export async function withLabAuthority<T>(db: Db, cfg: ResolvedConfig, project: string, lease: LeaseRef | null, signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
  const stopper = new AbortController();
  const assert = () => {
    if (signal?.aborted || stopper.signal.aborted) throw new MeritRouterError("lab_control_cancelled", "Lab effect cancelled");
    if (lease) assertLabSupervisor(db, cfg, project, lease);
  };
  assert();
  const timer = lease ? setInterval(() => { try { assert(); } catch { stopper.abort("lab_authority_lost"); } }, 50) : null;
  const combined = signal ? AbortSignal.any([signal, stopper.signal]) : stopper.signal;
  try { return await scopes.run({ lease, assert, signal: combined }, async () => { assert(); const result = await run(); assert(); return result; }); }
  finally { if (timer) clearInterval(timer); }
}

export function serviceLabAuthority(db: Db, labId: string, name: string): LeaseRef | null {
  const row = z.object({ authority_json: z.string().nullable() }).parse(db.prepare("SELECT authority_json FROM lab_services WHERE lab_id=? AND name=?").get(labId, name));
  return parseLabAuthority(row.authority_json);
}
