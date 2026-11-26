import { createWriteStream } from "node:fs";
import type { MeritRouter } from "../core/service.js";
import { exportExchanges, exchangeRecordLine } from "../admin/exchange-export.js";
import { out } from "./terminal.js";

// `meritrouter exchanges export --project <slug> [--since <ms>] [--out <file>]`: streams the
// supervisor<->worker exchange corpus (src/admin/exchange-export.ts) as JSONL, one line per
// task. Registration in `cli.ts` (command name, flag parsing) is the lead's to add; this module
// only exports the command function so lane D's `src/cli.ts` wiring can call it without lane E
// touching that file.

export interface ExchangesExportFlags {
  project: string;
  since?: number;
  out?: string;
}

/**
 * Runs the export and writes JSONL either to `flags.out` or stdout. Returns the process exit
 * code: 0 on success, 1 when the project's store cannot be read or no project was given.
 */
export async function exchangesExportCommand(sy: MeritRouter, flags: ExchangesExportFlags): Promise<number> {
  if (!flags.project) {
    out("exchanges export: --project <slug> is required", false);
    return 1;
  }
  const dest = flags.out ? createWriteStream(flags.out, { encoding: "utf8" }) : null;
  let count = 0;
  try {
    for await (const record of exportExchanges(sy, { project: flags.project, ...(flags.since !== undefined ? { since: flags.since } : {}) })) {
      const line = exchangeRecordLine(record) + "\n";
      if (dest) dest.write(line);
      else process.stdout.write(line);
      count++;
    }
  } catch (err) {
    out(`exchanges export failed: ${(err as Error).message}`, false);
    return 1;
  } finally {
    if (dest) await new Promise<void>((resolve) => dest.end(resolve));
  }
  if (flags.out) out(`${count} exchange(s) written to ${flags.out}`, false);
  return 0;
}

/** Parses `exchanges export` flags from the already-split CLI argv tail (after `exchanges export`). */
export function parseExchangesExportArgs(argv: string[]): ExchangesExportFlags {
  let project = "";
  let since: number | undefined;
  let outFile: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--project") project = argv[++i] ?? "";
    else if (arg === "--since") {
      const v = Number(argv[++i]);
      if (Number.isFinite(v)) since = v;
    } else if (arg === "--out") outFile = argv[++i];
  }
  return { project, ...(since !== undefined ? { since } : {}), ...(outFile !== undefined ? { out: outFile } : {}) };
}
