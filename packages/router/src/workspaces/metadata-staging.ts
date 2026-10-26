import { z } from "zod";
import { assertNotProjectMetadataPath, isProjectMetadataPath, PROJECT_METADATA_SEARCH_EXCLUDES } from "../projects/metadata-policy.js";
import { ensureProjectMetadataExcluded } from "./metadata-exclusion.js";
import { assertSafeIndexInput, withGitIndexTransaction } from "./git-index-transaction.js";
import { git } from "./git.js";

const options = z.object({ paths: z.array(z.string().min(1).max(4096)).max(128).optional() }).strict();
const MAX_INPUTS = 20000;

/** Stage only validated literal files selected by the original positive/negative Git pathspecs. */
export async function stageWithoutProjectMetadata(repo: string, input: { paths?: readonly string[] } = {}): Promise<void> {
  const parsed = options.parse(input);
  if ((parsed.paths?.reduce((total, value) => total + value.length, 0) ?? 0) > 30000) throw new Error("Git staging pathspecs exceed the supported argument bound");
  for (const spec of parsed.paths ?? []) assertNotProjectMetadataPath(spec);
  await ensureProjectMetadataExcluded(repo);
  if (parsed.paths?.length === 0) return;
  await withGitIndexTransaction(repo, async index => {
    const selection = [...(parsed.paths ?? ["."]), ...PROJECT_METADATA_SEARCH_EXCLUDES];
    const tracked = (await git(repo, ["ls-files", "--cached", "-z", "--", ...selection], { index, timeoutMs: 10000 })).split("\0").filter(Boolean);
    const untracked = (await git(repo, ["ls-files", "--others", "--exclude-standard", "-z", "--", ...selection], { index, timeoutMs: 10000 })).split("\0").filter(Boolean);
    const paths = [...new Set([...tracked, ...untracked])].filter(file => !isProjectMetadataPath(file));
    if (paths.length > MAX_INPUTS) throw new Error("Git staging exceeds the supported input bound");
    const trackedSet = new Set(tracked);
    for (const file of paths) await assertSafeIndexInput(repo, file, trackedSet.has(file));
    let chunk: string[] = [], bytes = 0;
    const flush = async () => {
      if (!chunk.length) return;
      for (const file of chunk) await assertSafeIndexInput(repo, file, trackedSet.has(file));
      await git(repo, ["add", "-A", "--", ...chunk.map(file => `:(literal)${file}`)], { index, timeoutMs: 10000 });
      chunk = []; bytes = 0;
    };
    for (const file of paths) {
      if (file.length > 4096) throw new Error("Git staging filename exceeds the supported length");
      if (chunk.length >= 64 || bytes + file.length > 20000) await flush();
      chunk.push(file); bytes += file.length;
    }
    await flush();
  });
}
