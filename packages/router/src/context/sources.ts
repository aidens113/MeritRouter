import type { ResolvedConfig } from "../config/load.js";
import type { WorkerTask } from "../core/task.js";
import { FILE_REF_RE } from "../core/task.js";
import type { ArtifactStore } from "../storage/artifacts.js";
import { RepoReader, sliceLines } from "./repo-reader.js";

export interface ContextSource {
  /** Reference the worker must cite, e.g. `core:src/a.ts#L1-L40`, `artifact:a_x`, `inline`. */
  ref: string;
  /** Base reference without a line range; evidence may cite sub-ranges of it. */
  baseRef: string;
  text: string;
  sha256: string | null;
  commit: string | null;
  dirty: boolean;
  totalLines: number | null;
}

export interface ParsedFileRef {
  alias: string;
  relPath: string;
  start?: number;
  end?: number;
}

export function parseFileRef(ref: string): ParsedFileRef | null {
  const m = FILE_REF_RE.exec(ref);
  if (!m) return null;
  return {
    alias: m[1]!,
    relPath: m[2]!,
    ...(m[3] ? { start: Number(m[3]) } : {}),
    ...(m[4] ? { end: Number(m[4]) } : m[3] ? { end: Number(m[3]) } : {}),
  };
}

/** One RepoReader per alias, pinned to the task's base commit when one was supplied. */
export function readersFor(cfg: ResolvedConfig, spec: WorkerTask): Map<string, RepoReader> {
  const readers = new Map<string, RepoReader>();
  for (const alias of spec.repositoryAliases) {
    const repo = cfg.repositoryPaths[alias];
    if (!repo) continue;
    readers.set(alias, new RepoReader(alias, repo.path, spec.context.baseCommits?.[alias] ?? null));
  }
  return readers;
}

/** Load the explicit task context. Retrieved content is task data, never instructions. */
export async function loadSources(
  cfg: ResolvedConfig,
  spec: WorkerTask,
  artifacts: ArtifactStore,
  readers = readersFor(cfg, spec),
): Promise<ContextSource[]> {
  const sources: ContextSource[] = [];
  if (spec.context.inlineText) {
    sources.push({
      ref: "inline",
      baseRef: "inline",
      text: spec.context.inlineText,
      sha256: null,
      commit: null,
      dirty: false,
      totalLines: spec.context.inlineText.split("\n").length,
    });
  }
  for (const ref of spec.context.fileRefs ?? []) {
    const parsed = parseFileRef(ref);
    if (!parsed) throw new Error(`invalid file reference ${ref}`);
    const reader = readers.get(parsed.alias);
    if (!reader) throw new Error(`file reference ${ref} uses alias ${parsed.alias}, which is not in repositoryAliases`);
    const file = await reader.readFile(parsed.relPath);
    const slice = sliceLines(file.content, parsed.start, parsed.end);
    const baseRef = `${parsed.alias}:${file.relPath}`;
    sources.push({
      ref: parsed.start ? `${baseRef}#L${slice.start}-L${slice.end}` : baseRef,
      baseRef,
      text: slice.text,
      sha256: file.sha256,
      commit: file.commit ?? (await reader.headSha()),
      dirty: file.dirty,
      totalLines: file.totalLines,
    });
  }
  for (const ref of spec.context.artifactRefs ?? []) {
    const a = artifacts.read(ref);
    if (!a) throw new Error(`unknown artifact ${ref}`);
    const text = a.content.toString("utf8");
    sources.push({
      ref,
      baseRef: ref,
      text,
      sha256: a.row.sha256,
      commit: null,
      dirty: false,
      totalLines: text.split("\n").length,
    });
  }
  return sources;
}

/** Render sources as delimited data blocks. */
export function renderSources(sources: ContextSource[]): string {
  return sources
    .map((s) => {
      const meta = [s.commit ? `commit=${s.commit.slice(0, 12)}` : null, s.dirty ? "uncommitted-changes=true" : null]
        .filter(Boolean)
        .join(" ");
      return `<source ref="${s.ref}"${meta ? ` ${meta}` : ""}>\n${s.text}\n</source>`;
    })
    .join("\n\n");
}
