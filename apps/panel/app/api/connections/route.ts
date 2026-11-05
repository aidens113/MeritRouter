import { createHash, randomBytes } from "node:crypto";
import { ClientConnectionsConfigSchema, clientConnectionTokenRequired, insights } from "meritrouter";
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
  enabled: ClientConnectionsConfigSchema.shape.enabled.removeDefault().optional(),
  rotate_token: z.boolean().optional(),
  host: ClientConnectionsConfigSchema.shape.host.removeDefault().optional(),
  project: ClientConnectionsConfigSchema.shape.project.removeDefault().optional(),
  port: ClientConnectionsConfigSchema.shape.port.removeDefault().optional(),
  enabled_modes: ClientConnectionsConfigSchema.shape.enabled_modes.removeDefault().optional(),
  default_mode: ClientConnectionsConfigSchema.shape.default_mode.removeDefault().optional(),
  agent_profile: ClientConnectionsConfigSchema.shape.agent_profile.removeDefault().optional(),
  agent_writable_repository: ClientConnectionsConfigSchema.shape.agent_writable_repository.removeDefault().optional(),
  repositories: ClientConnectionsConfigSchema.shape.repositories.removeDefault().optional(),
  agent_max_model_requests: ClientConnectionsConfigSchema.shape.agent_max_model_requests.removeDefault().optional(),
  agent_timeout_seconds: ClientConnectionsConfigSchema.shape.agent_timeout_seconds.removeDefault().optional(),
  agent_max_paid_usd: ClientConnectionsConfigSchema.shape.agent_max_paid_usd.removeDefault().optional(),
  agent_max_active_jobs: ClientConnectionsConfigSchema.shape.agent_max_active_jobs.removeDefault().optional(),
}).strict();

/** Config writes use the panel's same-origin proxy and the existing validated atomic patch path. */
export async function POST(req: Request) {
  return handle(async sy => {
    const { rotate_token, ...edit } = await body(req, Edit);
    const merged = { ...sy.cfg.client_connections, ...edit };
    const generateToken = rotate_token === true || (!merged.access_token_hash && clientConnectionTokenRequired(merged) && (edit.host !== undefined || edit.enabled === true));
    const accessToken = generateToken ? randomBytes(32).toString("hex") : null;
    if (accessToken) merged.access_token_hash = createHash("sha256").update(accessToken).digest("hex");
    const parsed = ClientConnectionsConfigSchema.safeParse(merged);
    if (!parsed.success) throw new HttpError(400, parsed.error.issues.map(i => i.message).join("; "));
    const candidate = parsed.data;
    const disablingOnly = edit.enabled === false && Object.keys(edit).length === 1;
    const editingAgents = Object.keys(edit).some(key => !["enabled", "host", "port"].includes(key));
    const validateAgents = !disablingOnly && editingAgents;
    const view = connectionsView(sy);
    const selected = view.projects.find(p => p.slug === candidate.project);
    if (validateAgents && candidate.project && !selected) throw new HttpError(400, "Choose an active registered agent project.");
    if (validateAgents && candidate.project && candidate.repositories.some(alias => !selected?.repositories.some(r => r.alias === alias))) {
      throw new HttpError(400, "Choose repositories registered in the selected project.");
    }
    if (validateAgents && candidate.project && candidate.enabled_modes.some(mode => mode !== "direct")) {
      if (!selected || !candidate.repositories.length) throw new HttpError(400, "Agent modes require a selected project and at least one allowed repository.");
      if (candidate.enabled_modes.includes("agent") && !view.agentProfiles.includes(candidate.agent_profile)) throw new HttpError(400, "Choose a configured coding or read-only profile for agents.");
      if (candidate.enabled_modes.includes("team") && !view.teamAvailable) throw new HttpError(400, "Configure the supervise profile before enabling team mode.");
    }
    if (validateAgents && candidate.project && candidate.enabled_modes.includes("agent") && view.codingAgentProfiles.includes(candidate.agent_profile) && candidate.agent_writable_repository && (!candidate.repositories.includes(candidate.agent_writable_repository) || !selected?.repositories.some(r => r.alias === candidate.agent_writable_repository && r.writable))) {
      throw new HttpError(400, "Choose a writable repository from the allowed project repositories.");
    }
    const result = insights.patchConfig(sy, [{ path: ["client_connections"], value: candidate }]);
    if (!result.ok) throw new HttpError(400, "Connections were not saved.", result.errors);
    await syncConnections(sy);
    return { saved: true, view: connectionsView(sy), ...(accessToken ? { access_token: accessToken } : {}) };
  });
}
