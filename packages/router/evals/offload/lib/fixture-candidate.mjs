import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { git } from "./comparison.mjs";

const Hash = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const FixturePath = /^(?:src|tests)\/[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*\.ts$/;

export function writeFixtureFiles(dir, allowedPaths, files) {
  if (!Array.isArray(files) || !files.length || new Set(files.map((file) => file.path)).size !== files.length ||
      files.some((file) => !FixturePath.test(file.path) || !allowedPaths.includes(file.path) ||
        typeof file.content !== "string" || file.content.length > 50_000)) {
    throw new Error("Candidate contains an invalid, duplicate or non-fixture source file");
  }
  for (const { path: relative, content } of files) {
    const absolute = path.join(dir, relative);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
}

/** Materialize only ordinary files from the worker's sealed Git candidate, without checking out or running it. */
export function materializeWorkerCandidate(dir, { base, head, taskId, endpoint, allowedPaths }) {
  if (!Hash.test(base) || !Hash.test(head) || base === head || git(dir, "merge-base", base, head).trim() !== base) {
    throw new Error("Worker candidate does not descend from the fixture base");
  }
  const [task, model] = git(dir, "log", "-1", "--format=%(trailers:key=Task,valueonly)%x00%(trailers:key=Model,valueonly)", head).split("\0");
  if (task?.trim() !== taskId || model?.trim() !== endpoint) throw new Error("Worker candidate attribution differs from the accepted task and route");
  const changed = git(dir, "diff", "--name-only", "--no-renames", "-z", base, head).split("\0").filter(Boolean);
  if (!changed.length || changed.some((file) => !FixturePath.test(file) || !allowedPaths.includes(file))) {
    throw new Error("Worker candidate changed files outside the fixture brief");
  }
  const files = changed.map((file) => {
    const entry = git(dir, "ls-tree", "-z", head, "--", file);
    if (!/^100644 blob [a-f0-9]{40,64}\t/.test(entry)) throw new Error("Worker candidate contains a non-regular source file");
    return { path: file, content: git(dir, "show", `${head}:${file}`) };
  });
  writeFixtureFiles(dir, allowedPaths, files);
  const lines = git(dir, "diff", "--numstat", "--no-renames", "-z", base, head).split("\0").filter(Boolean)
    .reduce((total, row) => {
      const [added, removed] = row.split("\t");
      if (!/^\d+$/.test(added) || !/^\d+$/.test(removed)) throw new Error("Worker candidate contains a binary change");
      return total + Number(added) + Number(removed);
    }, 0);
  return { head, files: changed, changedLines: lines };
}
