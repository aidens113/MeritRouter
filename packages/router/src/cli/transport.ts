import type { ResolvedConfig } from "../config/load.js";
import type { MeritRouter } from "../core/service.js";
import { MeritRouterError } from "../core/errors.js";
import { SqliteRequestAccountingBroker } from "../admission/sqlite-accounting-broker.js";
import type { ProjectRuntimeBundle } from "../projects/runtime-registry.js";
import { SplitTransportRecovery, TransportRecovery, type SplitRecoveryProject } from "../operations/transport-recovery.js";

/** `transport inspect|reconcile`: the operator recovery for this installation's storage layout. */
export interface TransportRecoveryCommand {
  inspect(requestId: string, project?: string): unknown;
  reconcile(input: unknown, project?: string): Promise<unknown>;
}

/** The pinned project runtime that owns a split project's request protocol and task leases. */
function splitProject(sy: MeritRouter, slug: string): SplitRecoveryProject {
  const stores = sy.projectStores(slug);
  if (!("ledger" in stores) || !stores.identity) throw new MeritRouterError("split_projects_unavailable", `project ${slug} has no project-local runtime`);
  const bundle = stores as ProjectRuntimeBundle;
  return { identity: bundle.identity, db: bundle.db, now: () => bundle.admission.serverNow(), recover: requestId => bundle.ledger.recover(requestId) };
}

export function transportRecovery(sy: MeritRouter, cfg: ResolvedConfig): TransportRecoveryCommand {
  if (sy.layout !== "split") {
    const legacy = new TransportRecovery(sy.db, sy.admission, sy.spend);
    return { inspect: (id, project) => legacy.inspect(id, project), reconcile: async (input, project) => legacy.reconcile(input, project) };
  }
  // A deny-all authorizer: this broker instance can only settle a recorded request, never admit or dispatch one.
  const broker = new SqliteRequestAccountingBroker(sy.db, { cfg, spend: sy.spend, authorize: () => null });
  const split = new SplitTransportRecovery(sy.db, broker, slug => splitProject(sy, slug));
  return { inspect: (id, project) => split.inspect(id, project), reconcile: (input, project) => split.reconcile(input, project) };
}
