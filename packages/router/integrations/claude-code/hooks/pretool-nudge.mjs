#!/usr/bin/env node
// Claude Code PreToolUse hook (opt-in: installed only by `meritrouter connect claude --hooks`).
// Advisory only: it never blocks a tool call. On a large direct Write/Edit, or a Bash command
// that looks like a test/build run, it prints a one-line nudge toward delegating the work to a
// MeritRouter worker instead. Plain Node, no dependencies, fails open: any error here (bad input,
// unexpected shape) is swallowed and the hook exits 0 with no output.

import { readFileSync } from "node:fs";

const LARGE_EDIT_CHARS = 4000;
const LONG_COMMAND_RE = /\b(test|vitest|jest|build|lint|typecheck)\b/i;

function readStdin() {
  try {
    return JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Advisory text reaches the model only as PreToolUse `additionalContext` JSON on stdout (exit 0).
 * No permissionDecision is set, so the user's normal permission flow is untouched.
 */
function advise(text) {
  process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: text } })}
`);
}

function main() {
  const input = readStdin();
  if (!input || typeof input !== "object") return;
  const toolName = input.tool_name;
  const toolInput = input.tool_input ?? {};

  if (toolName === "Write" || toolName === "Edit" || toolName === "MultiEdit") {
    const text = String(toolInput.content ?? toolInput.new_string ?? toolInput.new_str ?? "");
    if (text.length >= LARGE_EDIT_CHARS) {
      advise(
        `[meritrouter] large direct ${toolName.toLowerCase()} (${text.length} chars): consider delegating this to a MeritRouter worker (\`delegate\`/\`submit_tasks\`) instead of writing it yourself.\n`,
      );
    }
    return;
  }

  if (toolName === "Bash") {
    const command = String(toolInput.command ?? "");
    if (LONG_COMMAND_RE.test(command)) {
      advise(
        `[meritrouter] this command may run for a while: a MeritRouter worker (\`run\`/\`delegate\` with kind "run") can execute it and report the result instead of blocking this turn.\n`,
      );
    }
  }
}

try {
  main();
} catch {
  // fail open
}
process.exit(0);
