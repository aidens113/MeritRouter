import { z } from "zod";
import { insights } from "switchyard-router";
import { body, handle, HttpError } from "@/lib/api";
export const dynamic = "force-dynamic";
function project(req: Request) { const p = new URL(req.url).searchParams.get("project"); if (!p) throw new HttpError(400, "Choose a project"); return p; }
const Save = z.object({ recipe: z.record(z.string(), z.unknown()), promotion: z.enum(["manual", "supervisor", "auto"]), maxActive: z.number().int().min(1).max(100).nullable() }).strict();
export async function GET(req: Request) { return handle(sy => insights.labRecipeView(sy, project(req))); }
export async function PUT(req: Request) { return handle(async sy => { const input = await body(req, Save); try { return await insights.saveLabRecipe(sy, project(req), input); } catch (e) { if (e instanceof z.ZodError) throw new HttpError(400, e.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ")); throw e; } }); }
