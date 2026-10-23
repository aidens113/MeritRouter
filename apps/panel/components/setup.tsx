import { FileWarning } from "lucide-react";
import { Card, Mono } from "./ui";

/** Shown instead of a page when the config cannot be loaded. */
export function SetupScreen({ error, configPath }: { error: string; configPath: string }) {
  const missing = /not found/i.test(error);
  return (
    <div className="mx-auto max-w-3xl py-8">
      <Card className="p-6">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-warn-soft text-warn-ink">
            <FileWarning size={20} aria-hidden />
          </span>
          <div className="min-w-0">
            <h1 className="text-lg font-semibold text-ink">{missing ? "MeritRouter needs a config file" : "The MeritRouter config could not be loaded"}</h1>
            <p className="mt-1 text-sm text-ink-2">
              The panel looked for <Mono>{configPath}</Mono>.
            </p>
          </div>
        </div>
        <div className="mt-5">
          <div className="text-xs font-medium uppercase tracking-wide text-ink-3">Error</div>
          <pre className="mt-1 overflow-x-auto whitespace-pre-wrap rounded-lg bg-surface-2 p-3 font-mono text-xs text-bad-ink">{error}</pre>
        </div>
        <ol className="mt-5 list-decimal space-y-2 pl-5 text-sm text-ink-2">
          <li>
            Copy <Mono>packages/router/examples/meritrouter.config.example.yaml</Mono> to <Mono>meritrouter.config.yaml</Mono> at the repository root and edit it, or point the panel at an existing file with{" "}
            <Mono>MERITROUTER_CONFIG=/path/to/meritrouter.config.yaml</Mono>.
          </li>
          <li>
            To try the panel with sample data, run <Mono>pnpm --filter meritrouter-panel seed:demo</Mono> and start it with <Mono>MERITROUTER_CONFIG=apps/panel/.demo/meritrouter.config.yaml</Mono>.
          </li>
          <li>Fix the error above and reload this page; the panel retries automatically.</li>
        </ol>
      </Card>
    </div>
  );
}
