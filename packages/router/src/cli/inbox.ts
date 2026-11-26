import type { MeritRouter } from "../core/service.js";
import type { ChannelMessage } from "../core/channel.js";
import { CHANNEL_REQUEST_KINDS } from "../core/channel.js";
import { out, stamp, table } from "./terminal.js";

// `meritrouter inbox`: the supervisor's view of the two-way channel (core/channel.ts), backed by
// `MeritRouter.channel.listPendingForSupervisor` (supervisor-offload lane B). Read-only: it never
// answers, grants or reworks; use the MCP `reply`/`probe`/`rework` tools or a future CLI command
// for that. This command is also what the Claude Code Stop/SessionStart hooks
// (integrations/claude-code/hooks/) call with `--json` to decide whether the inbox is clear.

export interface InboxFlags {
  project?: string;
}

/** One row of `listPendingForSupervisor`, shaped for `--json` and the terminal table alike. */
export interface InboxRow {
  id: string;
  taskId: string;
  projectId: string;
  direction: ChannelMessage["direction"];
  kind: ChannelMessage["kind"];
  /** `request`: a worker message still awaiting an answer. `reply`: an answer/grant/deny not yet delivered to the worker. */
  waitingOn: "request" | "reply";
  body: string;
  createdAt: number;
}

function toRow(m: ChannelMessage): InboxRow {
  return {
    id: m.id,
    taskId: m.taskId,
    projectId: m.projectId,
    direction: m.direction,
    kind: m.kind,
    waitingOn: CHANNEL_REQUEST_KINDS.has(m.kind) ? "request" : "reply",
    body: m.body,
    createdAt: m.createdAt,
  };
}

/**
 * Renders `MeritRouter.channel.listPendingForSupervisor(projectScope)`: worker requests awaiting
 * an answer, and supervisor replies not yet delivered to their worker, oldest first. Returns the
 * process exit code (0 whether or not the inbox is empty; this command never fails on a clear
 * inbox, only on an actual error).
 */
export function inboxCommand(sy: MeritRouter, projectScope: string | undefined, json: boolean): number {
  const rows = sy.channel.listPendingForSupervisor(projectScope).map(toRow);
  out(
    json
      ? rows
      : rows.length
        ? table(
            rows.map((r) => ({
              id: r.id,
              task: r.taskId,
              waiting: r.waitingOn,
              kind: r.kind,
              since: stamp(r.createdAt),
              body: r.body.replace(/\s+/g, " ").slice(0, 100),
            })),
          )
        : "(inbox empty)",
    json,
  );
  return 0;
}
