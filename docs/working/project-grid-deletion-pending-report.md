# Pending-request project deletion implementation

Status: Implemented; supervisor integration and live cleanup pending.

## Changes

Owned files changed: `admission/request-receipts.ts`, `admin/projects.ts`, `projects/deletion.ts`, appended `storage/migrations.ts`, `tests/project-request-protocol.test.ts`, and new `tests/project-delete-pending-requests.test.ts`.

Deletion no longer treats pending requests or genuine, project-owned strict transport holds as an impossible prerequisite. It still refuses active tasks, unknown/mixed request or transport ownership, changed nonce identity, and unresolved Lab resources. Within the same SQLite transaction as the normal project purge:

- Remove private request protocol bindings and their project associations, revoking `beginDispatch` and `assertDispatch` through checks understood by existing Gate binaries.
- Set definitely undispatched reserved requests to failed; set dispatch-intent requests with unknown outcomes to uncertain. Preserve recorded successful/failed outcomes and settled spend. Keep worst-case paid charges for uncertain requests and synchronize the model accounting cost; refund unsent paid requests to zero. Token reservation accounting remains conservative.
- Retain opaque anti-replay request ID/fingerprint/reservation hash and exact physical slot linkage in a new tombstone table. No project names, task identities, prompts, outputs, raw bindings, or credentials are stored there.
- Quarantine strict physical slots, preserving id/nonce/platform and capacity while stripping holder, task, owner and project lease payloads. `lease_json='[]'` is valid and remains a strict counted hold; these detached holds do not block other project deletion. Claim/wait rows can go normally.
- Remove captures and project-private model metadata (route notes, error text, telemetry and citations). Preserve model request accounting, global spend history and successful usage; per-task charge rows go with their deleted tasks as before.

Preview and result expose additive `retainedRequests` counts; the first modal's existing Kept list explicitly discloses revoked requests, uncertain billing, quarantined physical holds and opaque replay records. No UI component change is required.

The new table deliberately has no foreign key to expiring opaque keys: old binaries' existing key GC remains compatible. Current admission independently checks the deletion tombstone. Current GC retains tombstones while their exact physical slot remains and expires them only after the retry window and absent slot; existing admission key bounds and conservative platform capacity remain in force.

## Safety and limitations

This operation abandons project authority; it does not pretend that an old socket or remote provider stopped. A separate-process request that already passed its final dispatch check may still complete. Its strict capacity hold remains quarantined; remote usage/billing is unknown and conservatively charged. Late old and new ledger callbacks fail the missing private receipt before changing accounting or restoring project data. A distinct safe transport-recovery feature remains necessary to reclaim such quarantined capacity. No generic force-release operation was added.

The supervisor separately delegated late session-recorder and capture-start privacy guards after read-only review identified those surfaces. Those changes are outside this worker's ownership and are not claimed here as its work.

## Validation

Focused runs observed:

- Project/admission/request deletion suites: 30/30 passed before final paid/GC assertions.
- Final focused request/admission/deletion suites: 22/22 passed after genuine paid reservation and legacy-GC compatibility assertions. `git diff --check` passed.

Tests use actual temporary projects, real Gate and SQLite transactions with fake clients. They cover deletion paused after reservation and dispatch intent, dispatch/replay fencing, genuine paid reservation refunds/conservative cost, foreign hold preservation, actual late provider response, immutable successful accounting with a retained hold, config/database rollback, active/mixed-authority rejection, private capture removal, opaque tombstones, idempotent retirement, corrupted nonce rejection and legacy-key-GC compatibility.

No builds, full suite, live configuration/data, provider calls, commits, or repository-folder deletion were performed by this worker. Root owns integration, direct production verification and Facebook deletion through the grid UI.

## Senior-supervisor integration verification

45 independent focused tests, recursive typecheck and recursive build passed. A missing
endpointId in the new global capture test fixture was corrected before typecheck passed.
Full router run: 144 files passed, 1 failed, 1 skipped; 1,365 tests passed, 1 failed, 3 skipped in 832.15s. The sole failure was labs-browser.test.ts:171 waiting 20s for browser_check_started under concurrent load. The exact failed cancellation case passed independently (11.39s; 1 passed/7 skipped), without source changes. All requested deletion, admission, ledger, accounting, rollback and late-callback cases passed. Initial full run was not wholly green; do not describe it as such.

Facebook and Instagram were deleted using the grid and both confirmation modals. Final
grid/API and read-only row verification confirm absence, preserved source folders, no clone
worktrees or Brain folders, and2anonymous transport holds. One locked worktree cache was
removed using the feature cleanup routine with the panel stopped; final panel restarted
and browser checked at http://127.0.0.1:4477. No live provider calls or manual DB mutation.
