import YAML from "yaml";
import { PROJECT_SLUG_RE } from "../config/schema.js";
import { SwitchyardError } from "../core/errors.js";
import type { Switchyard } from "../core/service.js";
import { archiveProject, createProject, deleteProject, previewProjectDeletion, projectsGrid, selectableProjects, unarchiveProject } from "../admin/insights.js";
import { repoFlags } from "./args.js";
import { chooseProject, type SelectOptions } from "./project-select.js";
import { out, stamp, table } from "./terminal.js";

// `switchyard projects list|create|archive|unarchive`, and the config `init` writes (a global
// config plus a first project in the `projects` shape).

export interface ProjectsFlags {
  all?: boolean;
  name?: string;
  repo?: string[];
  /** `projects delete <slug> --confirm <slug>`: the slug again, to confirm. */
  confirm?: string;
}

const USAGE = 'usage: switchyard projects [list [--all]] | create <slug> [--name "<name>"] [--repo <alias>=<path> ...] | archive <slug> | unarchive <slug> | delete <slug> [--confirm <slug>]';

export async function projectsCommand(sy: Switchyard, args: string[], values: ProjectsFlags, json: boolean, select: SelectOptions): Promise<number> {
  const sub = args[0] ?? "list";
  if (sub === "list") {
    const current = (() => {
      try {
        return chooseProject(selectableProjects(sy), select)?.slug ?? null;
      } catch {
        return null;
      }
    })();
    const cards = projectsGrid(sy, { includeArchived: values.all ?? false });
    const rows = cards.map((p) => ({
      "": p.slug === current ? "*" : "",
      project: p.slug,
      name: p.name,
      repositories: p.repositories.map((r) => `${r.alias}${r.exists ? "" : " (missing)"}`).join(", "),
      jobs: `${p.runningJobs} running, ${p.queuedJobs} queued`,
      tasks: `${p.runningTasks} running, ${p.queuedTasks} queued`,
      "last activity": p.lastActivityAt ? stamp(p.lastActivityAt) : "",
      attention: p.attention || "",
      ...(values.all ? { archived: p.archived ? "yes" : "" } : {}),
    }));
    out(json ? cards : table(rows), json);
    return 0;
  }
  if (sub === "create") {
    const slug = args[1];
    if (!slug) throw new SwitchyardError("usage", USAGE);
    const r = await createProject(sy, { slug, ...(values.name ? { name: values.name } : {}), repositories: repoFlags(values.repo) });
    if (!r.ok) throw new SwitchyardError("usage", `project ${slug} was not created:\n  ${r.errors.join("\n  ")}`);
    out(
      json
        ? r
        : [
            `created project ${r.project.slug} (${r.project.repositories.length} repositor${r.project.repositories.length === 1 ? "y" : "ies"}) in ${sy.cfg.configPath}`,
            ...r.prepared,
            ...(r.convertedLegacy ? [`the single-project config was converted: its repositories moved under projects.${r.convertedLegacy}`] : []),
            `work in it with --project ${r.project.slug}, or from inside one of its repositories`,
          ].join("\n"),
      json,
    );
    return 0;
  }
  if (sub === "archive" || sub === "unarchive") {
    const slug = args[1];
    if (!slug) throw new SwitchyardError("usage", USAGE);
    const p = sub === "archive" ? archiveProject(sy, slug) : unarchiveProject(sy, slug);
    out(json ? p : `${p.slug}: ${p.archived ? "archived (hidden; its settings, tasks, sessions, and brain are kept)" : "active"}`, json);
    return 0;
  }
  if (sub === "delete") {
    const slug = args[1];
    if (!slug) throw new SwitchyardError("usage", USAGE);
    if (values.confirm === undefined) {
      // Without --confirm: what deleting would remove and keep, and how to confirm.
      const p = await previewProjectDeletion(sy, slug);
      out(
        json
          ? p
          : [
              `Deleting project ${p.slug} (${p.name}) removes:`,
              ...p.removes.map((l) => `  - ${l}`),
              "It keeps:",
              ...p.keeps.map((l) => `  - ${l}`),
              p.blockers.length ? `It cannot be deleted now: ${p.blockers.join("; ")}.` : `This cannot be undone. To delete it: switchyard projects delete ${p.slug} --confirm ${p.slug}`,
            ].join("\n"),
        json,
      );
      return p.blockers.length ? 1 : 0;
    }
    const r = await deleteProject(sy, slug, { confirm: values.confirm });
    const c = r.removed;
    out(
      json
        ? r
        : [
            `deleted project ${r.slug}: ${c.tasks} task(s), ${c.sessions} session(s), ${c.artifacts} artifact(s), ${c.worktrees} worktree(s), and its brain folder (${c.brainEntries} file(s))${r.brainCommit ? ` in brain commit ${r.brainCommit.slice(0, 7)}` : ""}; repository folders and branches were not touched`,
            ...(r.newPrimary ? [`${r.newPrimary} is now the primary project (brain.project)`] : []),
            ...r.problems.map((p) => `warning: ${p}`),
          ].join("\n"),
      json,
    );
    return 0;
  }
  throw new SwitchyardError("usage", USAGE);
}

/**
 * The config `init` writes: the preset with its first project named `slug` (and `brain.project`,
 * the primary project, set to it). A preset in the single-project shape has its top-level
 * repositories moved under `projects.<slug>`. `repositories` replaces the preset's placeholder.
 */
export function initConfigText(presetText: string, opts: { slug: string; name?: string; repositories?: Record<string, { path: string }> }): string {
  if (!PROJECT_SLUG_RE.test(opts.slug)) throw new SwitchyardError("usage", `--project ${JSON.stringify(opts.slug)}: lower-case letters, digits, '.', '_', '-', starting with a letter or digit`);
  const doc = YAML.parseDocument(presetText);
  const projects = doc.get("projects");
  if (YAML.isMap(projects) && projects.items.length) {
    const first = projects.items[0]!;
    if (YAML.isScalar(first.key)) first.key.value = opts.slug;
    else first.key = doc.createNode(opts.slug);
  } else {
    const repos = (doc.get("repositories") as YAML.Node | undefined)?.toJSON?.() ?? {};
    doc.delete("repositories");
    doc.setIn(["projects", opts.slug], doc.createNode({ repositories: repos }));
  }
  // Without --name the display name is the slug, never the preset's placeholder.
  doc.setIn(["projects", opts.slug, "name"], opts.name ?? opts.slug);
  if (opts.repositories && Object.keys(opts.repositories).length) doc.setIn(["projects", opts.slug, "repositories"], doc.createNode(opts.repositories));
  doc.setIn(["brain", "project"], opts.slug);
  return doc.toString();
}
