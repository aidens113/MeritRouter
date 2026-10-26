import { z } from "zod";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { assertNotProjectMetadataPath, isProjectMetadataPath, PROJECT_METADATA_SEARCH_EXCLUDES } from "../projects/metadata-policy.js";
import { ensureProjectMetadataExcluded } from "./metadata-exclusion.js";
import { assertSafeIndexInput, gitIndexSnapshot, withGitIndexTransaction, type GitIndexCapability } from "./git-index-transaction.js";
import { git } from "./git.js";

const options = z.object({ paths: z.array(z.string().min(1).max(4096)).max(128).optional() }).strict();
const MAX_INPUTS = 20000;

/** Stage only validated literal files selected by the original positive/negative Git pathspecs. */
export async function stageSelectedIntoOwnedIndex(repo: string, index: GitIndexCapability, input: { paths?: readonly string[] } = {}): Promise<string[]> {
  const parsed = options.parse(input);
  if ((parsed.paths?.reduce((total, value) => total + value.length, 0) ?? 0) > 30000) throw new Error("Git staging pathspecs exceed the supported argument bound");
  for (const spec of parsed.paths ?? []) assertNotProjectMetadataPath(spec);
  if (parsed.paths?.length === 0) return [];
    const selection = [...(parsed.paths ?? ["."]), ...PROJECT_METADATA_SEARCH_EXCLUDES];
    const tracked = (await git(repo, ["ls-files", "--cached", "-z", "--", ...selection], { index, timeoutMs: 10000 })).split("\0").filter(Boolean);
    const head = gitIndexSnapshot(index).head;
    const headSelections = head ? (await git(repo, ["ls-files", `--with-tree=${head}`, "--cached", "-z", "--", ...selection], { index })).split("\0").filter(Boolean) : [];
    const untracked = (await git(repo, ["ls-files", "--others", "--exclude-standard", "-z", "--", ...selection], { index, timeoutMs: 10000 })).split("\0").filter(Boolean);
    const paths = [...new Set([...tracked, ...untracked, ...headSelections])].filter(file => !isProjectMetadataPath(file));
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
      const nativeCached = new Set((await git(repo, ["ls-files", "--cached", "-z", "--", ...literals], { timeoutMs: 10000 })).split("\0").filter(Boolean));
      const nativeChanged = new Set((await git(repo, ["diff", "--name-only", "-z", "--", ...literals], { timeoutMs: 10000 })).split("\0").filter(Boolean));
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
    return paths;
}

/** Stage-only legacy API; no commit/HEAD publication hook is supplied. */
export async function stageWithoutProjectMetadata(repo: string, input: { paths?: readonly string[] } = {}): Promise<void> {
  options.parse(input);
  await ensureProjectMetadataExcluded(repo);
  if (input.paths?.length === 0) return;
  await withGitIndexTransaction(repo, async index => { await stageSelectedIntoOwnedIndex(repo, index, input); });
}
