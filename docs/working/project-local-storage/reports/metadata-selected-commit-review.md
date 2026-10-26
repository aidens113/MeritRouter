# Independent C2b selected commit review

Reviewer: runtime_path_contract
Date: 2026-10-26
Status: blocked on two independently reproduced correctness/ownership defects.
Scope: frozen selected commit/ref-publication/receipt modules, Git index/staging/process
diffs and selected tests. Author's combined test run was active; no duplicate broad run.

## Blockers

### 1. Waiting concurrent caller bypasses unresolved publication gate

`commitSelectedInternal` calls assertNoPendingCommitPublication only before acquiring the
native index lock. Another invocation can pass that check before the first receipt exists,
wait on index.lock, and then proceed after the first invocation leaves an unresolved intent.

Actual-Git exact-source probe:
- First candidate sealed; start second invocation while receipt does not yet exist.
- First publishes HEAD, then fault callback writes a later worktree version and throws before
  index publication. First returns `reconciliation_required`, retaining pending receipt.
- Waiting second invocation acquires index.lock and returns `committed`; HEAD contains the
  second bytes despite the first unresolved intent.

Fix: repeat the pending-publication gate UNDER the acquired index lock, before creating a
new candidate/importing selected bytes, not just before request admission. Add a real concurrent
regression proving a caller admitted before the receipt was created is refused after waiting.

### 2. Redirected reference parent causes writes outside Git metadata ownership

`publishSelectedRef` checks Gitdir, HEAD/lock and branch-lock file, but not the physical
ancestor chain of branch reference/lock destinations before spawning update-ref.

Actual-Git exact-source probe: initialize fixture; copy main ref into another temp directory;
replace fixture `.git/refs/heads` with a Windows junction to that directory; modify application
file; invoke selected commit. Result: `committed`, and foreign directory's main ref changed.

Fix: resolve/validate every ref publication destination and its ancestors before ANY native
Git lock/write begins; refuse redirected parents, unsafe ref/packed-refs files and ambiguous
layouts. Preserve foreign files/locks. Cover linked-worktree common refs and packed ref cases.
Do not wait until Git creates a lock through the junction to decide ownership is acceptable.

## Verification

Node ESM probe transpiled exact relevant source modules into an OS-temp module fixture
(imports resolved to installed zod), executed actual Git in disposable repositories, then
removed only that fixture. No repository source/dist or live data changes. Exit0. Observed:

```json
{"case":"concurrent-pending","first":"reconciliation_required","second":{"kind":"committed"},"head":"second"}
{"case":"redirected-ref-dir","result":{"kind":"committed"},"foreignChanged":true}
```

## Positive source review and remaining acceptance checks

- Candidate tree derives from immutable selected cached binary patches into HEAD-based
  index; unrelated staged entries remain in preserved index. Worktree changes after seal
  cannot replace the candidate bytes. Selected physical checks precede first stage copy.
- Added HEAD-tree selection recovers already-staged deletions; dirty/racy original-index
  selection attempts to preserve ordinary Git normalization semantics instead of renormalizing
  every tracked file globally. Tests cover key racy same-size/CRLF cases; no broad portability
  claim from inspection. Deep paths use trusted process-local core.longpaths.
- Literal HEAD prepared transaction and raw symbolic type/target checks address same-OID
  attached/detached races. Child death/timeouts and foreign HEAD locks have dedicated tests.
  Old-OID ref validation does not intentionally rewind an external HEAD advance.
- Prepared receipt and exact index backups precede publication; outcomes distinguish refusal,
  acknowledged publication awaiting index reconciliation, and uncertain acknowledgement.
  No automatic HEAD rollback or unknown-lock cleanup is designed.
- Setup helper has fixed identity/message and no Actor trailers, separately tested. Ordinary
  commit message edge cleanup/trailer formatting compared with native Git commit -m still
  deserves a targeted compatibility check (commit-tree does not automatically provide the
  same whitespace cleanup policy); not claimed independently verified in this pass.
- Host-only callback/capability remains separate from model args. Scoped stdin allows exact
  cached apply and commit-message plumbing; existing arbitrary raw environment denial remains.
- Receipt scan cap1000 is a fail-closed history bound, not production retention/reconciliation
  management. Physical preflight is not protection against malicious concurrent link swaps.
- No caller integration, physical storage activation or final full suite accepted here.

No source/test edits, commits, live/provider operations or main tree mutations by this review.
