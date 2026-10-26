# Private metadata repository read boundary

Worker: runtime_path_contract
Date: 2026-10-26
Status: implemented; focused tests passed; source frozen for supervisor review.

## Changed

- NEW `projects/metadata-policy.ts`: case-insensitive reserved metadata component predicate,
  assertion and Git search exclusion pathspecs. Applies at any repository depth and includes
  legacy lowercase spelling. Windows trailing-dot/space forms recognized by predicate.
- `context/repo-reader.ts`: direct worktree/pinned reads refuse metadata; worktree reads
  additionally check realpath-relative target so an ordinary in-root junction cannot expose
  metadata. Lists filter before glob/limit/truncation. Searches use Git exclusion pathspecs
  before grep output, with defensive result filtering before match limit/truncation.
- NEW `tests/project-metadata-read.test.ts`: actual disposable Git fixtures with deliberately
  tracked metadata, ignored/untracked metadata, mixed/nested casing, pinned commits,
  ordinary file/glob positive controls, bounded list/search, and actual Windows junction.
- Separate root-requested followup to already owned runtime-paths/test files: repository
  alias validation now preserves `_lib`, `-lib`, `.repo`, while generated digest paths remain
  portable; adds3regressions. No existing configuration or service API changes.

## Validation

`pnpm exec vitest run tests/project-runtime-paths.test.ts tests/project-metadata-read.test.ts --maxWorkers=1`
->40/40 passed in2files (31path,9metadata), exit0,5.75s.
Final regression confirms ordinary source remains readable/listable/searchable when the
reader root itself is a workspace below a canonical project's `.MeritRouter/jobs/...`.
Physical metadata checks intentionally use paths relative to the reader root.

### Blocking alias review correction

Independent review/root reproduced leaks through junction aliases in Git listing/grep and
hard-linked aliases in direct reads. Corrected in this source version:

- Direct worktree reads refuse target nlink greater than1 conservatively.
- Before worktree listing/search results, enumerate Git candidate names and inspect physical
  targets without reading content. Cache parent realpaths within each invocation, check final
  links and target nlink with at most4 workers. Missing/unreadable/escaping/private targets
  are unsafe. Pinned commit behavior remains lexical because committed bytes have no runtime
  hardlink provenance; arbitrary copied secrets cannot be identified by this policy.
- Search passes literal negative pathspecs for unsafe aliases to Git BEFORE grep opens content.
  Bound scans to50000candidate names, unsafe exclusions to128, and search arguments to20000UTF8
  bytes; fail closed with a narrow-glob explanation rather than run an unsafe/oversized search.
  AbortSignal checked before operations and between filesystem awaits.
- `pnpm exec vitest run tests/project-metadata-read.test.ts --maxWorkers=1`
  ->12/12 pass, exit0,8.91s. Real junction and hardlink tests cover read/list/search;
  129hardlinks exceed exclusion bound and refuse search while narrowed safe glob succeeds.
  Already-aborted signals refuse operations. Existing positive root-under-metadata case passes.

Filesystem inspection and Git grep are separate operations; concurrent malicious link swaps
remain outside this preflight's guarantee. No OS sandbox or race-free snapshot claim.
The physical scan adds per-file filesystem work;50k bound is a safety limit, not a measured
large-repository latency guarantee. Supervisor/reviewer owns combined acceptance.

Earlier metadata-only run8/8 passed; combined package checks deferred to supervisor after
other workers freeze. No broad builds, providers, user/live data, migration or commits.

## Boundaries and limitations

- Shared `normalizeRelPath` behavior is unchanged: metadata guards are specifically in
  RepoReader methods; this phase does not change mutation authority or staging behavior.
- Authorized scoped Brain/artifact APIs stay separate. Arbitrary approved commands can
  still print data; these changes do not claim OS containment or universal output filtering.
- No Git ignore installation/staging preflight implemented. Tracked/indexed metadata still
  requires refusal/repair at the planned staging/exact-candidate boundary.
- workerSourceIdentity calls RepoReader for untracked files: unignored metadata will now
  refuse a snapshot, rather than hash its private bytes. Establish Git exclusions before
  activating project-local state. This does not silently omit metadata from a source digest.
- Physical containment retains existing check/read race limitations. No new hard-link or
  concurrent filesystem mutation guarantee is claimed; preflight is not OS isolation.
- Existing tracked private content remains in Git history; it is inaccessible through these
  readers but no history rewrite or on-disk deletion has been attempted.
