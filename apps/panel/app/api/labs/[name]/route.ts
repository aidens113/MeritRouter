import { insights } from "meritrouter";
import { body, handle, HttpError } from "@/lib/api";
export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ name: string }> };
function project(req: Request) { const p = new URL(req.url).searchParams.get("project"); if (!p || !/^[a-z0-9][a-z0-9._-]*$/.test(p)) throw new HttpError(400, "Choose a project"); return p; }
export async function GET(req: Request, ctx: Ctx) { return handle(async sy => { const name = (await ctx.params).name; const id = new URL(req.url).searchParams.get("operationId"); return id ? insights.labPromotionView(sy, project(req), name, id) : insights.labDetailView(sy, project(req), name); }); }
export async function POST(req: Request, ctx: Ctx) { return handle(async sy => insights.requestLabControl(sy, project(req), (await ctx.params).name, await body(req, insights.HumanLabControlSchema))); }
