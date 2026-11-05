import "server-only";
import { ClientConnectionsController, PROFILE_NAMES, insights, type ClientConnectionsConfig, type MeritRouter } from "meritrouter";

type Owner = { sy: MeritRouter; controller: ClientConnectionsController; closing: boolean; close: Promise<void> | null };
const KEY = Symbol.for("meritrouter.panel.connections");
const globalOwner = globalThis as unknown as Record<symbol, Owner | undefined>;

export type ConnectionsView = {
  config: ClientConnectionsConfig;
  status: "off" | "starting" | "running" | "error";
  error: string | null;
  ollamaBaseUrl: string;
  openaiBaseUrl: string;
  projects: Array<{ slug: string; name: string }>;
  profiles: string[];
};

/** Only the panel owns this listener; creating an SDK/worker instance never binds a port. */
function owner(sy: MeritRouter): Owner {
  const current = globalOwner[KEY];
  if (current) {
    if (current.sy !== sy) throw new Error("The panel connection listener belongs to another router instance");
    return current;
  }
  const controller = new ClientConnectionsController({ dispatch: (request, signal) => sy.requestClientConnection(request, signal) });
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
  return {
    config: { ...sy.cfg.client_connections },
    status: status.state,
    error: status.error,
    ollamaBaseUrl: status.ollamaBaseUrl,
    openaiBaseUrl: status.openaiBaseUrl,
    projects: insights.projectsGrid(sy).filter(p => !p.archived).map(p => ({ slug: p.slug, name: p.name })),
    profiles: PROFILE_NAMES.filter(name => sy.cfg.profiles[name]?.mode === "completion"),
  };
}
