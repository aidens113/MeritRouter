#!/usr/bin/env node
// Claude Code Stop hook (opt-in: installed only by `meritrouter connect claude --hooks`).
// Blocks ending the turn while `meritrouter inbox --json` shows a worker message still awaiting
// an answer, so a worker question never sits unread. Blocks at most once per stop. Plain Node, no dependencies,
// fails open: any error running or parsing `inbox` (server not reachable, bad JSON, missing
// arguments) lets the stop proceed rather than wedging the session.
//
// Args (written into `.claude/settings.json` by `connect --hooks`, see src/cli/connect.ts):
//   node stop-inbox-gate.mjs <cliPath> <configPath> <project>

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

function pendingRows() {
  const [, , cliPath, configPath, project] = process.argv;
  if (!cliPath || !configPath || !project) return null;
  const out = execFileSync(process.execPath, [cliPath, "inbox", "--json", "--config", configPath, "--project", project], {
    encoding: "utf8",
    timeout: 10_000,
  });
  const rows = JSON.parse(out);
  return Array.isArray(rows) ? rows : null;
}

/** Claude Code passes the hook input on stdin; `stop_hook_active` is true when this stop was already blocked once. */
function alreadyBlockedOnce() {
  try {
    const input = JSON.parse(readFileSync(0, "utf8") || "{}");
    return input && input.stop_hook_active === true;
  } catch {
    return false;
  }
}

function main() {
  // Block at most once per stop: a supervisor that has seen the reminder and still stops (for
  // example, deliberately leaving a question for the user) must never be wedged in a loop.
  if (alreadyBlockedOnce()) return;
  const rows = pendingRows();
  if (!rows || rows.length === 0) return;
  // Only messages awaiting the supervisor's own answer block. Replies the supervisor already sent
  // but the worker has not picked up yet are the worker's move, not the supervisor's.
  const requests = rows.filter((r) => r && r.waitingOn === "request");
  if (!requests.length) return;
  process.stdout.write(
    `${JSON.stringify({
      decision: "block",
      reason: `MeritRouter inbox: ${requests.length} worker message(s) awaiting your answer. Run the \`inbox\` MCP tool (or \`meritrouter inbox\`), answer, grant or deny each, then stop again.`,
    })}
`,
  );
}

try {
  main();
} catch {
  // fail open: inbox unreachable or unparsable should never block ending the turn
}
process.exit(0);
