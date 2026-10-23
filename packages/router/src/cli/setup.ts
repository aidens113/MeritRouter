import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { MeritRouterError } from "../core/errors.js";
import { parseConfig } from "../config/load.js";
import { initConfigText } from "./projects.js";

export interface InitOptions {
  configPath: string;
  preset?: string;
  project: string;
  name?: string;
  repositories?: Record<string, { path: string }>;
  /** Setup starts with no placeholder repositories and keeps its brain beside its config. */
  setup?: boolean;
  port?: number;
}

/** Write first-run assets without replacing an existing config or model catalog. */
export function initializeConfig(opts: InitOptions): string[] {
  const examples = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../examples");
  const preset = opts.preset ?? "claude-code";
  if (!["claude-code", "standalone-free", "standalone-hybrid", "standalone-paid"].includes(preset)) {
    throw new MeritRouterError("usage", `unknown preset ${preset}; choose claude-code, standalone-free, standalone-hybrid, or standalone-paid`);
  }
  const dir = path.dirname(opts.configPath);
  const messages: string[] = [];
  if (existsSync(opts.configPath)) messages.push(`kept existing ${opts.configPath}`);
  else {
    let text = initConfigText(readFileSync(path.join(examples, "presets", `${preset}.yaml`), "utf8"), { slug: opts.project, ...(opts.name ? { name: opts.name } : {}), ...(opts.repositories ? { repositories: opts.repositories } : {}) });
    if (opts.setup) {
      const doc = YAML.parseDocument(text);
      if (!opts.repositories || !Object.keys(opts.repositories).length) doc.setIn(["projects", opts.project, "repositories"], {});
      doc.setIn(["brain", "path"], ".meritrouter/brain");
      if (opts.port !== undefined) doc.setIn(["panel", "port"], opts.port);
      text = doc.toString();
    }
    parseConfig(YAML.parse(text), opts.configPath);
    mkdirSync(dir, { recursive: true });
    writeFileSync(opts.configPath, text, { flag: "wx" });
    messages.push(`wrote ${opts.configPath} (first project: ${opts.project})`);
  }
  const models = path.join(dir, "models.yaml");
  if (existsSync(models)) messages.push(`kept existing ${models}`);
  else {
    copyFileSync(path.join(examples, "models.example.yaml"), models, constants.COPYFILE_EXCL);
    messages.push(`wrote ${models}`);
  }
  return messages;
}
