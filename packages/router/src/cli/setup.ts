import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { MeritRouterError } from "../core/errors.js";
import { loadConfig, parseConfig } from "../config/load.js";
import { MeritRouter } from "../core/service.js";
import { createProject } from "../admin/projects.js";
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
    const doc = YAML.parseDocument(text);
    // Fresh installs (both `init` and `setup`) default to split project storage, which needs
    // `synchronous=FULL`, and to the renamed `.MeritRouter` runtime folder.
    doc.setIn(["storage", "directory"], ".MeritRouter");
    doc.setIn(["storage", "layout"], "split");
    doc.setIn(["storage", "durability"], "full");
    if (!opts.repositories || !Object.keys(opts.repositories).length) {
      // A fresh split installation (both `init` and `setup` write `split`) starts with no project
      // at all when it has nothing to give that project a directory: `createSplitProject`
      // provisioning needs `projects.<slug>.directory`, which an installation can never infer with
      // zero or several repositories (decision: no placeholder). The first project created,
      // through `provisionInitialProject` below, admin, the CLI, MCP, or the panel, becomes
      // primary (src/projects/resolve.ts picks the first configured project when none is named).
      // With exactly one repository, `provisionInitialProject` finishes the job below using that
      // repository's own folder as the project's directory; with repositories but no provisioning
      // (ambiguous directory), the entry is still written (never silently dropped) so
      // `meritrouter projects create <slug> <directory>` can adopt and finish it later.
      doc.deleteIn(["projects", opts.project]);
    }
    if (opts.setup) {
      // Application-directory installs keep the brain beside the config, not under the home directory.
      doc.setIn(["brain", "path"], ".MeritRouter/brain");
      if (opts.port !== undefined) doc.setIn(["panel", "port"], opts.port);
    } else {
      doc.setIn(["brain", "path"], "~/.MeritRouter/brain");
    }
    text = doc.toString();
    parseConfig(YAML.parse(text), opts.configPath);
    mkdirSync(dir, { recursive: true });
    writeFileSync(opts.configPath, text, { flag: "wx" });
    const created = YAML.parse(text)?.projects?.[opts.project] !== undefined;
    messages.push(created
      ? `wrote ${opts.configPath} (first project: ${opts.project})`
      : `wrote ${opts.configPath} (no projects yet: meritrouter projects create <slug> --directory <path>)`);
  }
  const models = path.join(dir, "models.yaml");
  if (existsSync(models)) messages.push(`kept existing ${models}`);
  else {
    copyFileSync(path.join(examples, "models.example.yaml"), models, constants.COPYFILE_EXCL);
    messages.push(`wrote ${models}`);
  }
  return messages;
}

/**
 * Finish a fresh split install's project right after `initializeConfig` wrote it: when the config
 * holds exactly one repository and nothing could give the project a directory yet,
 * `directory` is that repository's own folder (the natural default: its `.MeritRouter` store is
 * git-excluded there, never a separate folder the install has to invent), and the project's store
 * is provisioned immediately through `createProject` (which adopts the unprovisioned stub
 * `initializeConfig` wrote rather than refusing it; see `isUnprovisionedSplitStub`). Returns a
 * status line to print, or null when there was nothing to provision: the config already existed
 * (not a fresh write), it was never split, no project stub was written (no repository given), or
 * it already has a directory.
 */
export async function provisionInitialProject(configPath: string, slug: string, directory: string): Promise<string | null> {
  const cfg = loadConfig(configPath);
  if (cfg.storage.layout !== "split") return null;
  // Provisioning serves both init and setup --no-panel. Only setup's explicit
  // launch step may start a panel for this installation.
  const sy = new MeritRouter(cfg, { panelLifecycle: "passive" });
  try {
    // No stub was written (no repository was given: `initializeConfig` leaves no placeholder
    // project then). `ctx.projectDirectory` is not the right signal here: it is already inferred
    // from a single configured repository even before any store is provisioned (see
    // `resolve.ts`'s `projectDirectory`), so checking it would skip provisioning the very stub
    // this function exists to finish.
    if (!sy.projects.get(slug)) return null;
    const r = await createProject(sy, { slug, directory });
    if (!r.ok) {
      return `warning: project ${slug} was written but its store could not be provisioned automatically: ${r.errors.join("; ")}; run "meritrouter projects create ${slug} ${directory}" to finish`;
    }
    return `provisioned project ${slug}'s store at ${r.runtimeRoot}`;
  } finally {
    await sy.close();
  }
}
