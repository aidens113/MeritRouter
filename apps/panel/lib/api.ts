import "server-only";
import { NextResponse } from "next/server";
import type { z } from "zod";
import type { Switchyard } from "switchyard-router";
import { NotConfigured, requireSy } from "./sy";

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
export async function handle(fn: (sy: Switchyard) => Promise<unknown> | unknown): Promise<NextResponse> {
  try {
    const sy = requireSy();
    const out = await fn(sy);
    if (out instanceof NextResponse) return out;
    return json({ ok: true, ...(out && typeof out === "object" ? out : { result: out }) });
  } catch (err) {
    if (err instanceof NotConfigured) return json({ ok: false, error: `SwitchYard is not configured: ${err.message}` }, 503);
    if (err instanceof HttpError) return json({ ok: false, error: err.message, ...(err.errors ? { errors: err.errors } : {}) }, err.status);
    const e = err as Error & { code?: unknown };
    // Library errors carry a stable code (SwitchyardError). Match on it rather than instanceof:
    // Turbopack bundles the workspace library per route, so class identities can differ.
    const code = typeof e.code === "string" ? e.code : "";
    const status = code === "task_invalid" || code === "config_invalid" ? 400 : code.startsWith("gateway:") ? 502 : 500;
    if (status === 500) console.error("[panel] request failed:", e);
    return json({ ok: false, error: e.message || String(err) }, status);
  }
}

export async function body<T extends z.ZodType>(req: Request, schema: T): Promise<z.infer<T>> {
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
