#!/usr/bin/env node
import { parseMcpArgv, runMcpServer } from "./mcp/serve.js";

/**
 * SwitchYard's MCP server as a standalone script (`node dist/mcp.js`), the same as
 * `switchyard mcp`. Tools are in mcp/tools.ts, transports in mcp/serve.ts and mcp/http.ts.
 *
 * Arguments: [--config <file>] [--project <slug>] [--no-worker] [--http] [--host <h>] [--port <n>]
 */
Promise.resolve()
  .then(() => runMcpServer(parseMcpArgv(process.argv.slice(2))))
  .then(
    () => process.exit(0),
    (err: unknown) => {
      process.stderr.write(`switchyard mcp: ${(err as Error).message}\n`);
      process.exit(1);
    },
  );
