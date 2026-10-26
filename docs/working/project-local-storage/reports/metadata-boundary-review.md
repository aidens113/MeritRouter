# Independent review: repository metadata read/write boundary

Reviewer: project_storage_discovery
Date: 2026-10-26
Disposition: **original alias bypass corrected; no remaining blocker for the bounded read/write change**.
Scope: metadata-policy.ts, RepoReader and harness/tools.ts diffs, both new metadata test files,
repository operation adapters and batch edit preflight. Report only; no implementation changes.

## Latest independent rereview after correction

The worker froze a corrected RepoReader. Independently reread actual source and ran:

```text
pnpm exec vitest run tests/project-metadata-read.test.ts --maxWorkers=1
```

Observed exit 0: **12/12 tests passed**, 1 file, 9.03 seconds. The new real-Git regressions
exercise junction/hardlink read/list/search, alias-scoped globs, excessive exclusions and an
already-aborted signal, alongside pinned and ordinary root-under-metadata behavior.

Repeated the original disposable Windows junction + hardlink setup against the **actual source
RepoReader**, loaded through Vite SSR solely to execute TypeScript without altering source or
test files. Temporary Vite server closed and filesystem probe removed in finally. Observed:

```json
{"list":{"files":["app.txt"],"truncated":false},"search":{"matches":[{"path":"app.txt","line":1,"text":"needle PUBLIC"}],"truncated":true},"aliasScoped":{"matches":[],"truncated":false},"fileScoped":{"matches":[],"truncated":false},"alias/private.txt":"refused","alias-file.txt":"refused"}
```

The search's conservative truncated=true at limit1 matches the preexisting limit behavior;
private aliases do not appear or consume that match. Ordinary PUBLIC source remains accessible.

Source inspection confirms candidate enumeration uses the same scoped glob and reserved Git
exclusions as grep. unsafeWorktreePaths checks parent realpaths, final symlink targets, containment,
Git/private metadata components, regular-file identity and link count. Four bounded workers share
a per-scan parent resolution cache; unreadable/missing/ambiguous paths fail closed. It rejects
more than50,000 candidates; search refuses more than128 unsafe exclusions or20,000 argument bytes.
Unsafe paths become **literal negative Git pathspecs before grep executes**, avoiding the original
private-byte/output-buffer issue. Direct worktree reads now also refuse nlink>1. Pinned reads
remain based on commit paths and do not resolve through current filesystem links.

AbortSignal is checked before work, inside worker loops, and after filesystem awaits; it is
passed to Git subprocesses. Abort rejection is rethrown rather than converted to a skipped file,
so grep does not follow an aborted scan. Underlying individual filesystem calls are not cancelled,
but their fanout is bounded. Concurrent malicious link/file replacement between validation and
Git/read remains a TOCTOU limitation, not a capability-isolation guarantee.

The previous report findings below are retained as **pre-correction history**, not current defects.
Broader raw Git diff/staging/source-identity work remains pending as already scoped in the plan.

### Required follow-up before storage activation

Realistic Windows path lengths must be tested before activating the nested hierarchy. Typical
`D:/SwitchYardProjects/<project>/.MeritRouter/jobs/...` layouts with32-hex identity suffixes,
task/attempt/repository levels and deep Next.js filenames can exceed classic Windows/Git limits.
The pure path module explicitly does not enable OS long paths. Activation acceptance must use
realistic project roots/deep application files and either configure long-path handling in owned
Git processes or shorten the persisted hierarchy. Do not claim path construction tests prove
actual checkout/build support. This is an activation requirement, not a new blocker on the
documented pure-construction foundation.

## Historical blocking finding: physical alias bypass in search/list

`context/repo-reader.ts:resolveWorktreePath` validates the real target for readFile, but listFiles
and search use Git output plus lexical isProjectMetadataPath only. On Windows, Git traverses a
directory junction even though it lives under an ordinary source name. Git negative pathspecs
for `.MeritRouter` do not exclude matches addressed through that junction.

Reproduced with a disposable fresh Git repository using the actual new Git arguments:

```text
.MeritRouter/private.txt: needle PRIVATE
app.txt: needle PUBLIC
alias -> .MeritRouter             (Windows directory junction)
alias-file.txt -> private.txt     (filesystem hard link; separate related case)
```

`git ls-files -z --cached --others --exclude-standard` returned:

```text
.MeritRouter/private.txt
alias-file.txt
alias/private.txt
app.txt
```

`git grep -n -I -E --no-color -z -e needle --untracked --
:(icase,exclude,glob)**/.MeritRouter :(icase,exclude,glob)**/.MeritRouter/**`
returned private content under both `alias/private.txt` and `alias-file.txt`, followed by public
app.txt. Neither alias matches isProjectMetadataPath, so current RepoReader.search returns it to
the model. listFiles likewise presents alias/private.txt and can consume limit before ordinary
source. readFile(alias/private.txt) refusal does not protect these other operations.

The junction case directly violates the scoped physical read/list/search boundary. Before
working-tree search returns content or chooses limit, validate physical candidate identity or
exclude discovered aliases using a safe pathspec scheme. Git excludes should apply before reading
private matches into large output buffers, not merely strip text after a potentially capped
command. Pinned commits need separate semantics: resolve commit paths against the commit, not
current filesystem links. Do not accidentally refuse normal application source merely because
the reader root itself is nested under a `.MeritRouter` ancestor.

Hard links are a related explicit limitation: realpath does not distinguish an ordinary hardlink
name from private metadata bytes. Existing mutation guard refuses multiple links, but readFile
and search do not. Decide a conservative hardlink read policy or accurately delimit guarantees;
do not claim physical private-content isolation while allowing these aliases. Historical copied
content/ordinary committed aliases cannot be classified purely by inode or metadata folder name.

## Other observations

- Direct lexical reserved-path checks are case-insensitive and separator-independent. Existing
  normalizeRelPath already rejects trailing Windows dot/space syntax. Direct worktree read checks
  realpath relative to reader root, covering in-root symlink/junction aliases as intended.
- Git grep negative pathspecs cover ordinary root/nested mixed-case metadata paths; defensive
  output filtering occurs before the match count. It does not cover physical alias discovery.
- Pinned readFile explicitly rejects reserved lexical paths before Git cat-file/show. Pinned
  list/search filter reserved commit paths; a symlink blob in a commit is not followed like a
  worktree junction, and historical ordinary file content is not given hidden provenance.
- Harness workspacePath checks metadata before mkdir/read/hash/write/delete. Legacy write,
  replace, delete and apply_edits all reach it. Batch preflight checks every element before any
  edit executes, so mixed valid/forbidden input fails without the earlier valid file mutation.
- Existing parent-link/symlink/hardlink mutation protections remain unchanged. They protect
  ordinary aliases into metadata for writes. Arbitrary concurrent filesystem replacement races
  remain outside this change's guarantee; path checks are not OS capability isolation.
- A metadata ancestor outside the reader/workspace root is intentionally allowed: otherwise
  managed application workspaces under the new hierarchy would become unusable.
- The shared assertion message says inaccessible through repository tools, but separate raw
  `harness/repository-operations.ts` git_diff returns `git diff HEAD --` and can expose tracked
  metadata. That broader staging/source-identity phase is already pending in the plan. Do not
  represent this bounded change as full protection across every repository operation yet.
- Approved arbitrary commands and deliberately authorized Brain/artifact access are separate
  capabilities. This review does not propose weakening or removing those APIs.

## Test assessment and required regression

The new tests are meaningful for lexical root/nested legacy casing, pinned reads, filtering
before result limits, ordinary glob behavior, direct junction read refusal, whole-batch no-effects,
existing-file preservation and workspaces beneath a metadata ancestor. The existing junction
test checks readFile only; it must also exercise actual listFiles/search on Windows. Add a
regression where the private alias would sort before a legitimate result and use a small limit;
assert no PRIVATE text reaches search output. Include hardlinks according to the chosen policy.

No duplicate focused suite ran: the supervisor was already running combined tests/typecheck.
One new targeted probe ran through Node fs + execFile against a disposable temp Git repository,
using exact current grep/list arguments. It exited 0 and printed:

```json
{"platform":"win32","list":[".MeritRouter/private.txt","alias-file.txt","alias/private.txt","app.txt"],"grep":"alias-file.txt\u00001\u0000needle PRIVATE\nalias/private.txt\u00001\u0000needle PRIVATE\napp.txt\u00001\u0000needle PUBLIC\n"}
```

Probe cleanup completed in finally with the verified OS temporary root; no live project data,
source or shared documentation changed. This report records the pre-correction frozen source.
