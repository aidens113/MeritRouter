#!/usr/bin/env node
// Claude Code SessionStart hook (opt-in: installed only by `meritrouter connect claude --hooks`).
// Prints a one-line inbox summary as session context, so a supervisor starting a new session
// sees pending worker messages right away instead of discovering them mid-task. Plain Node, no
// dependencies, fails open: any error (server not reachable, bad JSON) prints nothing and exits 0.
//
// Args (written into `.claude/settings.json` by `connect --hooks`, see src/cli/connect.ts):
//   node sessionstart-inbox.mjs <cliPath> <configPath> <project>

import { execFileSync } from "node:child_process";

function main() {
  const [, , cliPath, configPath, project] = process.argv;
  if (!cliPath || !configPath || !project) return;
  const out = execFileSync(process.execPath, [cliPath, "inbox", "--json", "--config", configPath, "--project", project], {
    encoding: "utf8",
    timeout: 10_000,
  });
  const rows = JSON.parse(out);
  if (!Array.isArray(rows) || rows.length === 0) return;
  const requests = rows.filter((r) => r && r.waitingOn === "request").length;
  const replies = rows.filter((r) => r && r.waitingOn === "reply").length;
  process.stdout.write(`MeritRouter inbox (project ${project}): ${requests} worker message(s) awaiting an answer, ${replies} reply/replies not yet delivered. Run \`meritrouter inbox\`.\n`);
}

try {
  main();
} catch {
  // fail open
}
process.exit(0);
