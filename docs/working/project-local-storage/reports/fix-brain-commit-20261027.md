# Fix: Brain commit cost (cluster A) and skipped selections (cluster B), 2026-10-27

Worker: worker-heavy. No commits. All probes ran in OS temp or the session scratchpad.

## Outcome

**Partial.**

- **B is fixed and verified.** The cause is a Git bug, not stat or index state. Any Brain update
  of a tracked file was affected, not only removals.
- **A is about 30 % cheaper, but not yet small.** About 60 % of the processes that remain come
  from `src/workspaces/git-process-policy.ts`, which I do not own. Three acceptance tests still
  hit cluster A timeouts.

## Cluster B: the real cause

`git-process-policy.ts` prefixes every call with about 15 `-c` options. With those options, Git
2.55.0.windows.3 gives a wrong answer for `ls-files` (and `ls-files --with-tree`) when the
command has exactly one magic positive pathspec (`:(literal)a/b.md` or `:(top)…`) plus **any**
exclude pathspec. It returns nothing, or returns the path only some of the time. A plain `git`
with no `-c` answers correctly every time, which is why the lead saw 160/160 consistent results.
A single `-c core.longpaths=true` is enough to flip the answer. This was measured in fresh temp
repos (scratch `probe-ls3/4/5.mjs`):

| Query (file present, tracked, modified) | plain git | with one `-c` |
| --- | --- | --- |
| `ls-files --cached -- :(literal)p :(icase,exclude,glob)**/.MeritRouter` | 6/6 | 2/6, and 0/5 via the policy wrapper |
| `… :(literal)p :(exclude)zzz` and `:!zzz` | 6/6 | 0/6 |
| `ls-files --with-tree=HEAD --cached -- :(literal)p <excl>` | 8/8 | 1/8 |
| `ls-files --modified -- :(literal)p <excl>` | 6/6 | 1/6 |
| plain `p`, `.`, `:(glob)…`, `:(icase,literal)p`, or two literals, each with an exclude | stable | stable |
| `diff`, `grep`, `status` with `:(literal)p <excl>` | 6/6 | 6/6 |
| `ls-files --cached -- :(literal)p` with no exclude | 10/10 | 5/5 via the wrapper |

I did not establish the mechanism inside Git. The behaviour depends on memory layout, so the
symptom moves when the argv changes.

**Not just deletions.** In my new budget test, the third Brain write of an existing file
returned `commit: null` on the unfixed code. The tracked modification was silently skipped. The
mount pathspecs `brainMountPathspecs` builds (`:(literal)prefix/` plus
`:(exclude,literal)…lock`) take the same failing shape. So does the ls-files listing in
`repo-reader.search` that collects unsafe paths.

**Fix:**

- `src/workspaces/metadata-staging.ts`: `ls-files` never receives exclude magic.
  - The new `splitExcludePathspecs` turns caller pathspecs into positives plus the positive form
    of each exclude (long or short magic; Git's other short magic is refused).
  - Staging lists the positives and subtracts what the converted excludes list
    (`--with-tree/--cached` and `--others`).
  - Private metadata is filtered in JavaScript by `isProjectMetadataPath`, which already ran.
- **Loud failure.** After staging, `git diff --name-only --no-renames HEAD -- <positives>` runs
  against the locked *native* index. Any changed tracked path inside the selection that was not
  selected (and not excluded) throws `Selected staging missed N changed tracked path(s)…`. That
  error aborts the transaction before publication.
  - It uses the native index because the owned copy's fresh file time turns off Git's racy-entry
    check. That hid a same-size edit in my first version, and the test caught it.
- `src/context/repo-reader.ts` (`search`): the unsafe-path `ls-files` drops the exclude magic
  and filters in JavaScript. Grep output also drops any path in the unsafe set.

## Cluster A: measured spawns (child_process wrapped in `tests/brain-commit-performance.test.ts`)

`commands` counts pipeline Git commands. `spawns` adds the policy's per-call probes: a
synchronous `config --no-includes --list` on every call, and a synchronous
`rev-parse --show-toplevel` on every call that is not `rev-parse`.

| Step | Before: spawns / commands | After: spawns / commands | Wall time before → after |
| --- | --- | --- | --- |
| First `Brain.ensure` | 206 / ~85 | 174 / 71 | 5.2 s → 6.4 s |
| Steady Brain write (new file) | 194 / ~80 | 133 / 53 | 5.2 s → 6.5 s |
| Brain update of a tracked file | 150 (and it did **not** commit) | 133 / 53 (commits) | 4.2 s → 5.7 s |
| `commitAs`, tracked modification | 171 / 70 | 118 / 47 | 5.4 s → 4.6 s |
| `commitAs`, deletion | 171 / 70 | 118 / 47 | 5.0 s → 4.3 s |

Wall times are not comparable. Other agents held the CPU at 99 % during the "after" runs and
loaded it less during the "before" runs, so the counts are the reliable measure.

Changes, none of which removes an under-lock check:

- **`repository-mutation.ts`**
  - One `rev-parse --absolute-git-dir --git-common-dir` call replaces two.
  - A nested (capability) scope no longer resolves owners twice in a row. The outer scope's lock
    is held, so the second resolution added nothing. The top-level re-resolution after the lock
    is acquired is kept.
- **`git-index-transaction.ts`**
  - The unlocked copies of the metadata and write-topology checks are gone. The same checks run
    under the index lock, before any effect.
  - One rev-parse resolves git-dir and index.
  - Under the lock, `before`, HEAD and branch are now read before the metadata check. The final
    metadata re-check is skipped only when HEAD is unchanged and the native index is
    byte-identical; it still runs for an unborn HEAD.
- **`selected-commit.ts`**
  - The three sequencer `--git-path` lookups now take one call.
  - `ensureProjectMetadataExcluded` (about 9 commands) is re-run only when `info/exclude` is not
    the file this process last established, compared by dev, ino, size, mtime and ctime. Tracked
    metadata is still refused under the index lock.
- **`selected-ref-publication.ts`**: one rev-parse returns the ref format, the git-dir and the
  branch `--git-path`. Both topology checks are kept.
- **`brain.ts`**: the in-process queue-key lookup (`--git-common-dir`) is cached per repo. It
  only orders in-process work; the fence still resolves and locks the real owner.

**What remains for a commitAs (47 commands).** About 22 come from modules I do not own:

- `metadata-exclusion` assertions: 3
- `git-write-topology`: 3 × 3
- `commit-message`: 4
- receipts and command guard: about 3
- `mount-git`: 3 per Brain write

**Main lever left (not owned): `git-process-policy.ts`.** Its probes are 70 of 118 spawns
(59 %), and they use `execFileSync`, which blocks the event loop. Caching the
`config --list` verdict and the `--show-toplevel` result per repository, revalidated by the
stat identity of the config files and the worktree root, would bring commitAs to about 47
processes and remove the synchronous blocking. My estimate is about 2.5× fewer processes. Not
measured.

Optional, owned: drop the first of the two `assertGitWriteTopology` calls in
`publishSelectedRef`, which saves 3 commands. I kept it because it is defence in depth before
the ref locks are prepared.

## Commands run and observed results

- Before the fix, `npx vitest run tests/projects-followups.test.ts -t "removes with a recorded
  reason"`: failed with `git log … null`. Debug output showed that `ls-files --cached` with
  either exclude returned "" while the same query without excludes returned the path, against
  both the owned and the native index.
- The scratch probes in the table above.
- `npx vitest run tests/brain-commit-performance.test.ts` → 5 passed (40 s).
- Acceptance, serial, default timeouts (logs in the scratchpad `acc/`):

| File | Result | Notes |
| --- | --- | --- |
| attribution | 4/4 passed | 80 s |
| brain | 10/10 passed | 168 s |
| project-metadata-brain | 17/17 passed | 163 s |
| projects-operations | 3/3 passed | 60 s |
| brain-commit-performance | 5/5 passed | |
| projects-followups | 5 passed, 1 failed | First run: npx segfaulted (exit 139, 2 s) before running anything. Rerun: "removes with a recorded reason…" (cluster B) **passes**; "a revert goes through the brain's lock…" times out at 30 s (cluster A). |
| team-capacity | 6 passed, 2 failed, both runs | "holds tasks beyond…" hits the 10 s hook timeout; "never holds a supervisor back…" hits its 60 s timeout, then `EBUSY` (cluster A). |
| resilience | 10 passed, 1 failed, both runs | "the gate skips a failing provider…" hits the 10 s hook timeout. The R1 cascade failure from the triage is gone. |

- Related files: `project-metadata-index-transaction`, `-selected-commit`, `-exclusion`,
  `-mutation`, `-read`, `-commit` and `checked-candidate-seal` → 107 passed, 1 skipped.
- `npx tsc --noEmit -p .` in `packages/router` → no errors. An earlier run showed two errors in
  `src/projects/store-*.ts`, which another agent was editing; they were gone at the end.

## Not verified

- Wall-time improvement on an idle machine. The CPU was at 99 % from other agents throughout.
- Git's internal mechanism for the pathspec bug, and other Git versions.
- The full router suite.
- The policy-cache estimate (that file is not owned).
- Whether the three cluster A tests pass once the policy is fixed.

## Open questions or contradictions found

- The brief names `src/workspaces/selected-commit.ts` and `selected-ref-publication.ts`. Both
  files live in `src/attribution/`; I edited those.
- The brief lists `src/git.ts` as must-not-touch, but that file does not exist. I assumed it
  means `src/workspaces/git.ts` and did not touch it.
- The triage's "nondeterministic in plain repos" is better described as "depends on argv and
  environment". Through the policy wrapper it is close to deterministic: it failed for every
  Brain update and removal.
