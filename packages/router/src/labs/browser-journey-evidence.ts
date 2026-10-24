import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { LabRecord } from "./store.js";
import { labOwnedPath } from "./paths.js";
import { git, dirtyPaths } from "../workspaces/git.js";
import { productDigest } from "../verification/product-spec.js";
import type { BrowserJourneyCheck, BrowserJourneyEvidence } from "./browser-journey-schema.js";
/** Hash only declared isolated data; links, oversized or concurrently replaced files fail closed. */
export async function journeyFixtureDigest(lab: LabRecord, signal: AbortSignal): Promise<string> {
  const entries: Record<string, string> = {};
  let files = 0, bytes = 0;
  const root = path.resolve(lab.root, "../../..");
  const walk = async (directory: string, prefix: string): Promise<void> => {
    signal.throwIfAborted();
    for (const name of (await readdir(directory)).sort()) {
      const file = labOwnedPath(root, path.join(directory, name)), stat = await lstat(file), key = `${prefix}/${name}`;
      if (stat.isSymbolicLink() || stat.nlink > 1 && !stat.isDirectory())
        throw new Error("journey_fixture_link_denied");
      if (stat.isDirectory()) {
        if (prefix.split("/").length > 32)
          throw new Error("journey_fixture_depth_limit");
        await walk(file, key);
      }
      else if (stat.isFile()) {
        if (++files > 10000 || (bytes += stat.size) > 32 * 1024 * 1024)
          throw new Error("journey_fixture_size_limit");
        const body = await readFile(file, { signal }), after = await lstat(file);
        if (body.length !== stat.size || after.ino !== stat.ino || after.dev !== stat.dev || after.mtimeMs !== stat.mtimeMs)
          throw new Error("journey_fixture_changed_while_hashing");
        entries[key] = createHash("sha256").update(body).digest("hex");
      }
      else
        throw new Error("journey_fixture_special_file_denied");
    }
  };
  for (const name of [...lab.recipe.data].sort())
    await walk(labOwnedPath(root, path.join(lab.root, "data", name)), name);
  return productDigest(entries);
}
export async function journeySourceSnapshot(lab: LabRecord, signal: AbortSignal) {
  const heads: Record<string, string> = {}, trees: Record<string, string> = {}, dependencies: Record<string, string> = {};
  for (const repo of [...lab.repositories].sort((a, b) => a.alias.localeCompare(b.alias))) {
    signal.throwIfAborted();
    if ((await dirtyPaths(repo.worktree, { signal })).length)
      throw new Error("browser_journey_requires_clean_sources");
    heads[repo.alias] = (await git(repo.worktree, ["rev-parse", "HEAD"], { signal })).trim();
    trees[repo.alias] = (await git(repo.worktree, ["rev-parse", "HEAD^{tree}"], { signal })).trim();
    for (const name of ["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "Cargo.lock", "requirements.txt", "poetry.lock"]) {
      const exists = await git(repo.worktree, ["ls-tree", "--name-only", heads[repo.alias]!, "--", name], { signal });
      if (exists.trim())
        dependencies[`${repo.alias}/${name}`] = productDigest(await git(repo.worktree, ["show", `${heads[repo.alias]}:${name}`], { signal, maxBuffer: 4 * 1024 * 1024 }));
    }
  }
  return { heads, trees, dependencyDigest: productDigest(dependencies) };
}
export function journeyEnvironmentDigest(evidence: Pick<BrowserJourneyEvidence, "isolation" | "browser" | "serviceIdentities" | "resourceDigest">): string {
  return productDigest({ isolation: evidence.isolation, browser: evidence.browser, services: evidence.serviceIdentities, resources: evidence.resourceDigest, networkPolicy: "none_parent_owned_origin_broker_v1", filesystemPolicy: "read_only_no_host_mounts_private_tmpfs_v1" });
}
export async function journeyInputsDigest(lab: LabRecord, spec: BrowserJourneyCheck, signal: AbortSignal): Promise<string> {
  const data = await journeyFixtureDigest(lab, signal), uploads: Record<string, string> = {};
  for (const [id, file] of Object.entries(spec.uploads)) {
    const digest = createHash("sha256").update(Buffer.from(file.base64, "base64")).digest("hex");
    if (digest !== file.sha256)
      throw new Error("journey_upload_digest_mismatch");
    uploads[id] = digest;
  }
  return Object.keys(uploads).length ? productDigest({ data, uploads }) : data;
}
