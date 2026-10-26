# C3.0 native commit message compatibility

Worker: c3_message
Date: 2026-10-26
Status: implementation/tests frozen; focused validation passed; caller activation remains supervisor work.
Directory: existing `.MeritRouter/development/metadata-exclusion`; no new checkout.

## Implementation

- Added `prepareCommitMessage(repo, {message, trailers})` in attribution/commit-message.ts.
  Runtime input has strict Zod shape, UTF-8 byte bounds, no NUL and bounded trailer values.
- Reproduces the non-editor `commit -m --trailer` pipeline: complete message line, initial
  whitespace cleanup except verbatim, native formatting with `interpret-trailers --no-divider`,
  then native final whitespace/comment cleanup. Non-editor scissors uses whitespace mode.
- Selected attributed commits prepare the message before staging; fixed trusted setup
  messages/identity retain their existing separate path. No existing callers activated.
- Supports default/whitespace/strip/verbatim/scissors cleanup, explicit comment character/
  string, Unicode/CRLF, safe trailer separator/key/where/ifExists/ifMissing configuration.
- Fails before staging for unknown/empty cleanup, non-UTF8 encoding, verbose diff insertion,
  or automatic comment-character selection. Does not silently reinterpret unsupported input.
- New Git formatting argv is closed in process policy AND stdin execution bridge: no filename,
  arbitrary option, in-place write, raw environment override or index capability. Input is
  explicit and bounded; output is capped; executable trailer configuration remains denied.

## Validation ledger

- Initial native-reference/authority suite: 28/28 PASS, exit0, 18.63s.
- Initial package `pnpm --filter meritrouter typecheck`: exit0.
- Strengthened command-policy guard to deny file-write argv even without stdin, plus added
  native comment-string/trailer cases and bare/empty configuration refusal regressions.
- Combined message + selected-publication suite: 62/62 PASS, exit0, 159.05s (message34,
  selected publication28). That run loaded the message helper before the final valueless/
  duplicate-config hardening below; do not mislabel it a final-source aggregate.
- Final review found that valueless config may omit its key/value newline. Corrected parser
  and refusal logic so bare commit.verbose cannot be mistaken for unset, and an invalid
  earlier verbose value cannot hide behind later false. Added three regressions.
- Final exact-source `pnpm exec vitest run tests/project-metadata-commit-message.test.ts
  --maxWorkers=1`: 37/37 PASS, exit0,24.54s. Includes26 byte-reference cases.
- `pnpm exec vitest run tests/git-process-containment.test.ts --maxWorkers=1`:
  16/16 PASS, exit0,6.77s (before final helper-only config parsing correction).
- Final `pnpm --filter meritrouter typecheck`: exit0. `git diff --check`: exit0.

References compare actual `cat-file commit` message bytes, author/committer identities and
parsed attribution, rather than only subject or trailer substrings. Fixtures use OS temp
repositories; no user data, Docker, real model/provider calls or live services involved.

Multiline caller clarification: existing `trailerArgs` in attribution/index.ts replaces
each run of CR/LF in Actor/extra trailer values with a single space before passing native
`commit --trailer` argv. Every matrix case uses Actor task `task\r\ncontinued`; the duplicate/
extra case also uses Worker `first\nsecond`. The same existing trailerArgs output is given
to native commit and the helper, then exact message bytes and parsed attribution are compared.
The helper intentionally keeps newline-free prepared trailer arguments; it does not change
or broaden the existing caller normalization contract. A temporary exploratory direct raw-
multiline probe confirmed native accepts it but the helper refuses it; those three exploratory
tests were removed per supervisor instruction to preserve the narrower supported authority.

## Verified implementation source references

Git's non-editor cleanup defaults and scissors mapping are documented in
[git-commit](https://git-scm.com/docs/git-commit). The implementation order was checked
against [Git v2.55 commit.c](https://github.com/git/git/blob/v2.55.0/builtin/commit.c),
[sequencer.c](https://github.com/git/git/blob/v2.55.0/sequencer.c), and the no-divider trailer
application in [trailer.c](https://github.com/git/git/blob/v2.55.0/trailer.c). Native formatting
configuration is described by [interpret-trailers](https://git-scm.com/docs/git-interpret-trailers).

## Limits and handoff

- Existing public commitAs wrappers/lifecycle guards are not changed; C3.1/C3.2 remain.
- No non-UTF8 or editor/verbose-diff message compatibility claim. Unsupported modes refuse
  explicitly; supported byte compatibility is measured only by the recorded reference cases.
- No full suite, recursive panel build, migration, runtime activation, commits or pushes by worker.
