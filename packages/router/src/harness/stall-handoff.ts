import { z } from "zod";
import type { RunContext } from "../runners/types.js";
import { requestPaid } from "../routing/select.js";
import { assertRunAuthority } from "./task-authority.js";

const STALLED_ENDPOINT = "agent_endpoint_stalled";
const COMPACTED_EFFECTS = "agent_effect_history_compacted";
const CompactionReceipt = z.object({ schemaVersion: z.literal(1), executionId: z.string().min(1) }).strict();
const Receipt = z.object({
  schemaVersion: z.literal(1),
  endpointId: z.string().min(1),
  reason: z.string().startsWith("repeated_tool_call:"),
  executionId: z.string().min(1),
  requestId: z.string().min(1),
}).strict();

/** Task-local observed stalls, not a global model-quality claim or a new routing grant. */
export class StallHandoff {
  readonly excluded = new Set<string>();
  reason: string | null = null;
  lostEffectHistory = false;

  constructor(private readonly ctx: RunContext) {
    // Read this event type directly: ordinary paged task timelines must not erase an
    // exclusion after a long wait, a grant, or an interrupted/resumed session.
    const rows = ctx.tasks.db.prepare("SELECT data_json FROM events WHERE task_id=? AND type=? ORDER BY id")
      .all(ctx.taskId, STALLED_ENDPOINT) as Array<{ data_json: string }>;
    for (const row of rows) {
      const receipt = Receipt.parse(JSON.parse(row.data_json));
      this.excluded.add(receipt.endpointId);
      this.reason = receipt.reason;
    }
    const compacted = ctx.tasks.db.prepare("SELECT data_json FROM events WHERE task_id=? AND type=? ORDER BY id")
      .all(ctx.taskId, COMPACTED_EFFECTS) as Array<{ data_json: string }>;
    for (const row of compacted) {
      CompactionReceipt.parse(JSON.parse(row.data_json));
      this.lostEffectHistory = true;
    }
  }

  recordLostEffectHistory(executionId: string): void {
    if (this.lostEffectHistory) return;
    const receipt = CompactionReceipt.parse({ schemaVersion: 1, executionId });
    assertRunAuthority(this.ctx);
    this.ctx.tasks.event(this.ctx.taskId, COMPACTED_EFFECTS, receipt);
    this.lostEffectHistory = true;
  }

  record(endpointId: string, reason: string, executionId: string, requestId: string): void {
    if (this.excluded.has(endpointId)) return;
    const receipt = Receipt.parse({ schemaVersion: 1, endpointId, reason, executionId, requestId });
    assertRunAuthority(this.ctx);
    this.ctx.tasks.event(this.ctx.taskId, STALLED_ENDPOINT, receipt);
    this.excluded.add(endpointId);
    this.reason = reason;
  }

  /** Hard exclusions retain Gate's ordinary live size, quality, capacity and paid checks. */
  avoid(): string[] {
    return [...new Set([...this.excluded, ...this.ctx.plan.candidates
      .filter(endpoint => requestPaid(endpoint, this.ctx.cfg, this.ctx.plan)).map(endpoint => endpoint.id)])];
  }

  hasAlternative(): boolean {
    const avoid = new Set(this.avoid());
    return this.ctx.plan.candidates.some(endpoint => !avoid.has(endpoint.id));
  }
}
