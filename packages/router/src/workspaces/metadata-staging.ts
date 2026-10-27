import { z } from "zod";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { assertNotProjectMetadataPath, isProjectMetadataPath } from "../projects/metadata-policy.js";
import { ensureProjectMetadataExcluded } from "./metadata-exclusion.js";
import { assertSafeIndexInput, gitIndexSnapshot, withGitIndexTransaction, type GitIndexCapability } from "./git-index-transaction.js";
import { git } from "./git.js";
import { withRepositoryMutation, type RepositoryMutationCapability } from "./repository-mutation.js";

const options = z.object({ paths: z.array(z.string().min(1).max(4096)).max(128).optional() }).strict();
const MAX_INPUTS = 20000;
// Git's pathspec magic signature characters (ctype GIT_PATHSPEC_MAGIC); "^" is Git's alias for "!".
const SHORT_MAGIC_SIGNATURES = new Set([..."!\"#%&',-/:;<=>@_`~^"]);
const SHORT_MAGIC_WORDS: Record<string, string> = { "/": "top", "!": "exclude", "^": "exclude" };

/**
 * Split pathspecs into positives and the positive form of each exclude pathspec.
 *
 * Git 2.55 (observed on Git for Windows 2.55.0.windows.3) `ls-files` with one magic positive
 * such as `:(literal)a/b.md` plus any exclude pathspec returns an empty or partial listing
 * depending on unrelated process state: adding any `-c` option, which every policy-wrapped
 * call does, flips a stable result. Selection therefore never hands exclude magic to
 * `ls-files`; it lists positives and subtracts what the positive form of each exclude lists.
 */
export function splitExcludePathspecs(specs: readonly string[]): { include: string[]; exclude: string[] } {
  const include: string[] = [], exclude: string[] = [];
  for (const spec of specs) {
    let words: string[] | null = null, pattern = spec;
    if (spec.startsWith(":(")) {
      const end = spec.indexOf(")");
      if (end < 0) throw new Error("Unsupported Git pathspec magic");
      words = spec.slice(2, end).split(",").map(word => word.trim()).filter(Boolean);
      pattern = spec.slice(end + 1);
    } else if (spec.startsWith(":")) {
      words = [];
      let at = 1;
      for (; at < spec.length && spec[at] !== ":"; at++) {
        const signature = spec[at]!;
        if (!SHORT_MAGIC_SIGNATURES.has(signature)) break;
        const word = SHORT_MAGIC_WORDS[signature];
        if (!word) throw new Error(`Unsupported Git pathspec magic '${signature}'`);
        words.push(word);
      }
      if (spec[at] === ":") at++;
      pattern = spec.slice(at);
    }
    if (!words?.includes("exclude")) { include.push(spec); continue; }
    exclude.push(`:(${[...new Set(words.filter(word => word !== "exclude"))].join(",")})${pattern}`);
  }
  // Git treats a pathspec made only of excludes as excluding from the whole tree.
  return { include: include.length ? include : ["."], exclude };
}

const listed = (output: string) => output.split("\0").filter(Boolean);

/** Stage only validated literal files selected by the original positive/negative Git pathspecs. */
export async function stageSelectedIntoOwnedIndex(repo: string, index: GitIndexCapability, input: { paths?: readonly string[] } = {}): Promise<string[]> {
  const parsed = options.parse(input);
  if ((parsed.paths?.reduce((total, value) => total + value.length, 0) ?? 0) > 30000) throw new Error("Git staging pathspecs exceed the supported argument bound");
  for (const spec of parsed.paths ?? []) assertNotProjectMetadataPath(spec);
  if (parsed.paths?.length === 0) return [];
  const { include, exclude } = splitExcludePathspecs(parsed.paths ?? ["."]);
  const head = gitIndexSnapshot(index).head;
  // Private metadata is filtered here rather than by exclude magic (see splitExcludePathspecs).
  // Tracked metadata is already refused by the index transaction; untracked metadata is ignored
  // through info/exclude, and every candidate path is checked again below.
  const excluded = new Set(exclude.length ? [
    ...listed(await git(repo, ["ls-files", ...(head ? [`--with-tree=${head}`] : []), "--cached", "-z", "--", ...exclude], { index, timeoutMs: 10000 })),
    ...listed(await git(repo, ["ls-files", "--others", "--exclude-standard", "-z", "--", ...exclude], { index, timeoutMs: 10000 })),
  ] : []);
  const keep = (file: string) => !isProjectMetadataPath(file) && !excluded.has(file);
  const tracked = listed(await git(repo, ["ls-files", "--cached", "-z", "--", ...include], { index, timeoutMs: 10000 })).filter(keep);
  const headSelections = head ? listed(await git(repo, ["ls-files", `--with-tree=${head}`, "--cached", "-z", "--", ...include], { index })).filter(keep) : [];
  const untracked = listed(await git(repo, ["ls-files", "--others", "--exclude-standard", "-z", "--", ...include], { index, timeoutMs: 10000 })).filter(keep);
  const paths = [...new Set([...tracked, ...untracked, ...headSelections])];
  if (paths.length > MAX_INPUTS) throw new Error("Git staging exceeds the supported input bound");
  const trackedSet = new Set([...tracked, ...headSelections]);
  const cachedSet = new Set(tracked);
  const stageable = new Set([...tracked, ...untracked]);
  for (const file of paths) await assertSafeIndexInput(repo, file, trackedSet.has(file));
  let chunk: string[] = [], bytes = 0;
  const flush = async () => {
    if (!chunk.length) return;
    for (const file of chunk) await assertSafeIndexInput(repo, file, trackedSet.has(file));
    // Ask the locked original index which tracked inputs are actually dirty/racy before
    // copying content. A fresh temporary index timestamp can otherwise hide same-size edits.
    // Clean cached paths must retain ordinary Git add semantics (no global renormalization).
    const literals = chunk.map(file => `:(literal)${file}`);
    const nativeCached = new Set(listed(await git(repo, ["ls-files", "--cached", "-z", "--", ...literals], { timeoutMs: 10000 })));
    const nativeChanged = new Set(listed(await git(repo, ["diff", "--name-only", "-z", "--", ...literals], { timeoutMs: 10000 })));
    const fresh = chunk.filter(file => cachedSet.has(file) && (!nativeCached.has(file) || nativeChanged.has(file)));
    const added = chunk.filter(file => !cachedSet.has(file));
    const present: string[] = [], deleted: string[] = [];
    for (const file of fresh) {
      try { await lstat(path.join(repo, ...file.split("/"))); present.push(file); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") deleted.push(file); else throw error; }
    }
    for (const file of chunk) await assertSafeIndexInput(repo, file, trackedSet.has(file));
    if (present.length) await git(repo, ["add", "--renormalize", "-A", "--", ...present.map(file => `:(literal)${file}`)], { index, timeoutMs: 10000 });
    const ordinary = [...added, ...deleted];
    if (ordinary.length) await git(repo, ["add", "-A", "--", ...ordinary.map(file => `:(literal)${file}`)], { index, timeoutMs: 10000 });
    chunk = []; bytes = 0;
  };
  for (const file of paths) {
    if (file.length > 4096) throw new Error("Git staging filename exceeds the supported length");
    if (!stageable.has(file)) continue; // Already-staged deletions remain selected, without re-adding a missing path.
    if (chunk.length >= 64 || bytes + file.length > 20000) await flush();
    chunk.push(file); bytes += file.length;
  }
  await flush();
  // Independent cross-check: a tracked path inside the selection whose working-tree content
  // differs from HEAD (or from the index when unborn) must have been selected. A selection
  // listing that silently dropped it would otherwise publish "unchanged" or a partial commit.
  // Ask the locked native index, like the dirty check above: the owned copy's fresh file
  // timestamp disables Git's racy-entry content check and hides same-size edits.
  const selected = new Set(paths);
  const skipped = listed(await git(repo, ["diff", "--name-only", "-z", "--no-renames", ...(head ? [head] : []), "--", ...include], { timeoutMs: 10000 }))
    .filter(file => keep(file) && !selected.has(file));
  if (skipped.length) throw new Error(`Selected staging missed ${skipped.length} changed tracked path(s), first ${JSON.stringify(skipped[0]!.slice(0, 512))}; nothing was published`);
  return paths;
}

/** Stage-only legacy API; no commit/HEAD publication hook is supplied. */
export async function stageWithoutProjectMetadata(repo: string, input: { paths?: readonly string[] } = {}, control: { mutation?: RepositoryMutationCapability } = {}): Promise<void> {
  options.parse(input);
  await withRepositoryMutation([repo], async () => {
    await ensureProjectMetadataExcluded(repo);
    if (input.paths?.length === 0) return;
    await withGitIndexTransaction(repo, async index => { await stageSelectedIntoOwnedIndex(repo, index, input); });
  }, control.mutation === undefined ? {} : { capability: control.mutation });
}
