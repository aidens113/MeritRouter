# Delegated committed source snapshot

Status: implemented in isolated feature; frozen final focused checks passed.

Worktree: D:/SwitchYardRouter-context-snapshot, feat/delegated-context-snapshot, off9a75ba6. Owned production files are harness/supervisor-tools.ts and new harness/delegated-source.ts; unique delegated-context-snapshot.test.ts, approved actual-branch correction in supervisor-lifecycle.test.ts, and docs/roles.md contract. No application/runtime/config/provider/store changes or commits.

## Confirmed cause

Ordinary dispatch populated context.baseCommits for writable coding aliases and sub-supervisors only. Inspect/review tasks therefore received an empty map. The existing readersFor/loadSources/read-only runner correctly use the provided pin, but absent pins fall back to the configured canonical checkout. With canonical master.git-only and all integrated API/UI on the parent's private job branch, that is the wrong read subject. This matches the live delegated inspect's empty base map and empty-root listing.

Staffing independently built a brief with fileRefs but no baseCommits; rulebookTier tried those sources in the canonical checkout and returned null after a read failure. Final submission's normal validateTask/loadSources then rejected nonexistent canonical files. Both channels needed the same runtime-owned source binding; the reader itself did not need modification.

## Fix

The runtime captures one immutable source map for fresh permitted aliases. plan_work shares that exact map with deterministic staffing and actual dispatch; direct delegate captures once itself. Read-only inspect/review and coding context aliases receive the selected hashes. Upstream coding-dependent base selection remains unchanged.

For writable parent aliases, source pinning requires the persisted parent/project/alias scope, configured repository, a runtime integration source for that alias, matching source alias, identical real common Git directory, actual declared branch, clean working tree and stable committed HEAD across the fence. The hash is verified in the canonical repository's shared object store. Missing writable source, foreign repository/project/alias, dirty parent, branch mismatch or racing HEAD refuses before task/grant creation. There is no silent fallback to canonical for a missing writable integration source.

Read-only aliases have no writable integration worktree by design. They retain the parent's explicitly declared commit, or freeze their configured clean committed HEAD. This does not invent write authority. File reference, alias, repository and protected-path validation remain in the existing services/readers. Later parent movement does not retarget the stored child pin; existing already-dispatched retries retain the original child and skip restaffing.

Ordinary draft-only plan recording still avoids source Git work. Real dispatch always binds its read subject. Dirty source is refused rather than representing uncommitted files as the chosen committed snapshot.

## Validation

Offline frozen install reused219cached dependencies, downloaded0; no manifest/lock change. Initial unique fixture runs hit setup-only mistakes (internal Git rm is unsupported, generic coding Worktrees.prepare is detached rather than a supervisor branch); fixture now removes its placeholder using fs+commitAll and creates a real named parent branch. An escape assertion was corrected because the existing path normalizer rejects ../ as reserved syntax before its escape message. These did not change production source.

- Existing supervisor lifecycle46/46 passed in77.82s tests on the new production source with only approved fixture branch correction.
- Router typecheck passed before final fixture-only corrections.
- Final pinned Vitest3.2.7 command: pnpm --filter meritrouter exec vitest run tests/delegated-context-snapshot.test.ts tests/supervisor-lifecycle.test.ts --fileParallelism=false ->60/60 passed across2files in132.43s (127.88s tests); new14Git cases31.81s and lifecycle46cases96.07s. No source/test edits occurred during this final run.
- Fresh final router typecheck/build -> both exit0.
- git diff --check -> exit0, CRLF normalization warnings only.

New14 real temporary Git cases cover inspect/review explicit file context + list/read/search at the parent snapshot while canonical stays.git-only; parent advancement during staffing and immutable dispatch subject; idempotent plan retry; direct delegation/coding base preservation; missing/alias/branch/foreign/symlinked-foreign/dirty/project source refusals without grants/children/models; wrong-alias/path-escape reads; explicit read-only source; and racing HEAD refusal. No model/provider requests are permitted in these fixtures.

## Integration and live limits

Root owns final independent review/checks and controlled deployment. This worker did not copy app code to canonical, alter its branch, change child budgets or resume failed live inspections. The fix does not promote the app; it lets read-only children inspect the parent's actual committed source. Root must verify a fresh live child has the expected baseCommits and sees the real files, retire obsolete failed dependencies through supported APIs, preserve prior charges and complete independent API/UI/runtime review.
