import "server-only";
import { NextResponse } from "next/server";
import type { z } from "zod";
import { QUALIFICATION_PROJECT, type MeritRouter } from "meritrouter";
import { NotConfigured, requireSy } from "./sy";
import { findProject } from "./project";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly errors?: string[],
  ) {
    super(message);
  }
}

export function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status, headers: { "cache-control": "no-store" } });
}

/** Run a route handler body with the shared instance; errors become `{ ok: false, error }`. */
export async function handle(fn: (sy: MeritRouter) => Promise<unknown> | unknown): Promise<NextResponse> {
  try {
    const sy = requireSy();
    const out = await fn(sy);
    if (out instanceof NextResponse) return out;
    return json({ ok: true, ...(out && typeof out === "object" ? out : { result: out }) });
  } catch (err) {
    if (err instanceof NotConfigured) return json({ ok: false, error: `MeritRouter is not configured: ${err.message}` }, 503);
    if (err instanceof HttpError) return json({ ok: false, error: err.message, ...(err.errors ? { errors: err.errors } : {}) }, err.status);
    const e = err as Error & { code?: unknown };
    // Library errors carry a stable code (MeritRouterError). Match on it rather than instanceof:
    // Turbopack bundles the workspace library per route, so class identities can differ.
    const code = typeof e.code === "string" ? e.code : "";
    const status =
      code === "task_invalid" || code === "config_invalid" || code === "reason_required"
        ? 400
        : code === "not_found"
          ? 404
          : code === "cannot_accept_unmet" || code === "human_acceptance_required" || code === "usage" || code === "ambiguous_id"
            ? 409
            : code === "project_store_unavailable"
              ? 503
            : code.startsWith("gateway:")
              ? 502
              : 500;
    if (status === 500) console.error("[panel] request failed:", e);
    return json({ ok: false, error: e.message || String(err) }, status);
  }
}

/**
 * An optional `?project=` scope for a by-id route: the project (or `_qualification`) whose own
 * store the id is read from, or undefined (the id is then looked up across every project's store
 * and an id held by two projects is refused). An unknown project is a 404.
 */
export function projectParam(sy: MeritRouter, params: URLSearchParams): string | undefined {
  const project = params.get("project");
  if (project === null) return undefined;
  if (project === QUALIFICATION_PROJECT || findProject(sy, project, { archived: true })) return project;
  throw new HttpError(404, `No project ${project}`);
}

export async function body<T extends z.ZodType>(req: Request, schema: T): Promise<z.infer<T>> {
  if (req.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    throw new HttpError(415, "request body must use application/json");
  }
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new HttpError(400, "request body must be JSON");
  }
  const r = schema.safeParse(raw);
  if (!r.success) {
    const errors = r.error.issues.map((i) => `${i.path.map(String).join(".") || "body"}: ${i.message}`);
    throw new HttpError(400, errors.join("; "), errors);
  }
  return r.data;
}
