import picomatch from "picomatch";
import type { ProfileName, VerificationMatch } from "../config/schema.js";
import { FILE_REF_RE, type WorkerTask } from "../core/task.js";
import { MULTI_GROUPS, type Tags, type TagGroup } from "../scoring/rulebook.js";

/** What a floor or rule condition is matched against. */
export interface MatchFacts {
  profile: ProfileName;
  /** Classifier or hint tags; null when the task was not classified. */
  tags: Partial<Tags> | null;
  /** Before dispatch: the task's declared paths. On a result: the paths it changed. */
  paths: string[];
  /** Known only on a result; null before dispatch (a condition on it then never matches). */
  protectedPathsChanged: boolean | null;
}

/**
 * Paths a task declares before it runs: its allowedPaths entries and the paths of its file
 * references. A glob entry is matched as written, so a rule on `src/auth/**` sees a declared
 * `src/auth/**` but not a broader `src/**`; the result re-evaluation sees the actual changes.
 */
export function declaredPaths(spec: Pick<WorkerTask, "constraints" | "context">): string[] {
  const out = new Set<string>(spec.constraints.allowedPaths ?? []);
  for (const ref of spec.context.fileRefs ?? []) {
    const m = FILE_REF_RE.exec(ref);
    if (m) out.add(m[2]!);
  }
  return [...out];
}

function tagMatches(group: TagGroup, wanted: readonly string[], tags: Partial<Tags>): boolean {
  const have = tags[group];
  if (have === undefined) return false;
  if (MULTI_GROUPS.has(group)) return (have as string[]).some((t) => wanted.includes(t));
  return wanted.includes(have as string);
}

/** True when every key of the condition matches the facts. */
export function matchesWhen(when: VerificationMatch, facts: MatchFacts): boolean {
  if (when.tags) {
    for (const [group, wanted] of Object.entries(when.tags) as [TagGroup, string[] | undefined][]) {
      if (!wanted) continue;
      if (!facts.tags || !tagMatches(group, wanted, facts.tags)) return false;
    }
  }
  if (when.profiles && !when.profiles.includes(facts.profile)) return false;
  if (when.changed_paths) {
    const isMatch = picomatch(when.changed_paths, { dot: true });
    if (!facts.paths.some((p) => isMatch(p.replace(/\\/g, "/")))) return false;
  }
  if (when.protected_paths_changed !== undefined && facts.protectedPathsChanged !== when.protected_paths_changed) return false;
  return true;
}
