import "server-only";
import { ClientConnectionsController, PROFILE_NAMES, insights, type ClientConnectionsConfig, type MeritRouter } from "meritrouter";

type Owner = { sy: MeritRouter; controller: ClientConnectionsController; closing: boolean; close: Promise<void> | null };
const KEY = Symbol.for("meritrouter.panel.connections");
const globalOwner = globalThis as unknown as Record<symbol, Owner | undefined>;

export type ConnectionsView = {
  config: Omit<ClientConnectionsConfig, "access_token_hash">;
  readonly tokenConfigured: boolean;
  readonly tokenRequired: boolean;
  status: "off" | "starting" | "running" | "error";
  error: string | null;
  ollamaBaseUrl: string;
  openaiBaseUrl: string;
  projects: Array<{ slug: string; name: string; repositories: Array<{ alias: string; writable: boolean }> }>;
  agentProfiles: string[];
  codingAgentProfiles: string[];
  teamAvailable: boolean;
  models: Array<{ id: string; name: string }>;
};

/** Only the panel owns this listener; creating an SDK/worker instance never binds a port. */
function owner(sy: MeritRouter): Owner {
  const current = globalOwner[KEY];
  if (current) {
    if (current.sy !== sy) throw new Error("The panel connection listener belongs to another router instance");
    return current;
  }
  const controller = new ClientConnectionsController({
    dispatch: (request, signal, accessToken) => sy.requestClientConnection(request, signal, accessToken),
    jobs: {
      submit: (request, signal, accessToken) => sy.submitClientJob(request, signal, accessToken),
      get: access => sy.getClientJob(access),
      cancel: access => sy.cancelClientJob(access),
    },
  });
  const next: Owner = { sy, controller, closing: false, close: null };
  globalOwner[KEY] = next;
  const closeRouter = sy.close.bind(sy);
  // The existing panel power action drains sy.close(). Stop accepting clients before that drain.
  sy.close = () => {
    if (!next.close) {
      next.closing = true;
      const watchKey = Symbol.for("meritrouter.panel.connections.watch");
      const watches = globalThis as unknown as Record<symbol, NodeJS.Timeout | undefined>;
      if (watches[watchKey]) clearInterval(watches[watchKey]);
      delete watches[watchKey];
      next.close = (async () => {
        try { await controller.close(); }
        finally { await closeRouter(); }
      })();
    }
    return next.close;
  };
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => { void sy.close().catch(err => console.error("[panel] connections shutdown failed:", err)); });
  }
  return next;
}

export async function syncConnections(sy: MeritRouter): Promise<void> {
  const active = owner(sy);
  if (!active.closing) await active.controller.sync(sy.cfg.client_connections);
}

export function connectionsView(sy: MeritRouter): ConnectionsView {
  const status = owner(sy).controller.status();
  const { access_token_hash: _tokenHash, ...config } = sy.cfg.client_connections;
  return {
    config,
    tokenConfigured: status.tokenConfigured,
    tokenRequired: status.tokenRequired,
    status: status.state,
    error: status.error,
    ollamaBaseUrl: status.ollamaBaseUrl,
    openaiBaseUrl: status.openaiBaseUrl,
    projects: insights.projectsGrid(sy).filter(p => !p.archived).map(p => ({ slug: p.slug, name: p.name, repositories: p.repositories.map(r => ({ alias: r.alias, writable: r.writable })) })),
    agentProfiles: PROFILE_NAMES.filter(name => ["read_only", "coding"].includes(sy.cfg.profiles[name]?.mode ?? "")),
    codingAgentProfiles: PROFILE_NAMES.filter(name => sy.cfg.profiles[name]?.mode === "coding"),
    teamAvailable: sy.cfg.profiles.supervise?.mode === "supervisor",
    models: status.models,
  };
}
