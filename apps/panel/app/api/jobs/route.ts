import { z } from "zod";
import { body, handle, HttpError } from "@/lib/api";

export const dynamic = "force-dynamic";

const Body = z.object({
  goal: z.string().trim().min(1, "describe the goal").max(20_000),
  repositories: z.array(z.string().min(1)).min(1, "pick at least one repository").max(20),
  acceptanceCriteria: z.array(z.string().trim().min(1)).max(50).default([]),
  checks: z.array(z.string().trim().min(1)).max(20).default([]),
  label: z
    .string()
    .trim()
    .regex(/^([a-z0-9][a-z0-9-]{0,40})?$/, "label: lowercase letters, digits, and dashes, up to 41 characters")
    .optional(),
  maxModelRequests: z.number().int().positive().max(10_000).optional(),
  maxPaidUsd: z.number().min(0).max(10_000).optional(),
});

/**
 * Start a standalone job. The job is only queued here: the panel never runs tasks, so a worker
 * (the MCP server or `switchyard worker`) picks it up.
 */
export async function POST(req: Request) {
  return handle(async (sy) => {
    if (!sy.cfg.profiles.supervise) throw new HttpError(409, "Jobs need the supervise task type: add profiles.supervise in Settings first.");
    const b = await body(req, Body);
    const unknown = b.repositories.filter((r) => !sy.cfg.repositories[r]);
    if (unknown.length) throw new HttpError(400, `Unknown repositories: ${unknown.join(", ")}`, unknown.map((u) => `repositories: unknown alias ${u}`));
    const out = await sy.startJob({
      goal: b.goal,
      repositories: b.repositories,
      acceptanceCriteria: b.acceptanceCriteria,
      checks: b.checks,
      ...(b.label ? { label: b.label } : {}),
      ...(b.maxModelRequests ? { maxModelRequests: b.maxModelRequests } : {}),
      ...(b.maxPaidUsd !== undefined ? { maxPaidUsd: b.maxPaidUsd } : {}),
    });
    return { job: out };
  });
}
