import { ClientConnectionsConfigSchema, insights } from "meritrouter";
import { z } from "zod";
import { body, handle, HttpError } from "@/lib/api";
import { connectionsView, syncConnections } from "@/lib/connections";

export const dynamic = "force-dynamic";

export async function GET() {
  return handle(async sy => {
    await syncConnections(sy);
    return { view: connectionsView(sy) };
  });
}

const Edit = z.object({
  enabled: ClientConnectionsConfigSchema.shape.enabled,
  project: ClientConnectionsConfigSchema.shape.project,
  port: ClientConnectionsConfigSchema.shape.port,
  profile: ClientConnectionsConfigSchema.shape.profile,
}).strict();

/** Config writes use the panel's same-origin proxy and the existing validated atomic patch path. */
export async function POST(req: Request) {
  return handle(async sy => {
    const edit = await body(req, Edit);
    const parsed = ClientConnectionsConfigSchema.safeParse({ ...sy.cfg.client_connections, ...edit });
    if (!parsed.success) throw new HttpError(400, parsed.error.issues.map(i => i.message).join("; "));
    const candidate = parsed.data;
    if (candidate.enabled && candidate.project && !connectionsView(sy).projects.some(p => p.slug === candidate.project)) {
      throw new HttpError(400, "Choose an active registered project.");
    }
    if (candidate.enabled && !candidate.project) throw new HttpError(400, "Choose a project before enabling connections.");
    const result = insights.patchConfig(sy, [{ path: ["client_connections"], value: candidate }]);
    if (!result.ok) throw new HttpError(400, "Connections were not saved.", result.errors);
    await syncConnections(sy);
    return { saved: true, view: connectionsView(sy) };
  });
}
