# Independent resumed memory headroom review

Reviewer: repair_hydration_review
Date: 2026-10-25
Status: Corrected source independently reviewed; 8 narrow regressions passed; clear for supervisor integration
Scope: isolated D:/SwitchYardRouter-memory-headroom. Reviewer owns this report only.

Read main Current State and written memory-headroom-review brief, owned source diff, new resumed-memory-compaction-projection tests, compaction implementation, actual loop compaction/effect safeguards and supervisor call site.

No source blocker found. Compaction projection deep-clones messages before invoking the mutating compactor, preserving actual transcript and nested tool output evidence. Its input allowance uses the smallest candidate context and task input cap, subtracts actual tools, actual output allowance, reserved tokens, 2000 margin and desired role/maxTokens memory budget. It does not expand a context window. Immovable prompt head is remeasured after attempted projection and can produce zero memory with a source-free omission before any Brain record reads.

Actual loop compaction remains unchanged and owns lost-effect recording. Fresh appended memory sits in the newest preserved turn; the new actual-loop tests inspect requested payloads after both normal compaction and larger sticky endpoint refusal/fallback. Existing persisted lost-effect guards still reject before pending-effect replay.

The existing memory-body estimate uses characters/4 whereas gateway admission estimates characters/3 with dense-character handling. Thus manifest tokenBudget remains an estimate cap, not an exact tokenizer guarantee; the existing actual loop/Gate provide final request fit enforcement. This change does not introduce that estimator difference.

Awaiting implementer's final frozen suite result before independently running the four new cases plus the narrow existing handoff guard. No source/tests/runtime/config/store/provider changes or commits by reviewer.

## Additional blocking boundary case

Supervisor requested near-role-cap memory with a large immutable prompt head. Review confirms the prior estimator caveat is a real fit blocker, not merely a manifest-label concern: at context cap 131072, output 8000 and reserved 1000, an immutable head near 108071 gateway-estimated tokens leaves about 12001 memory-estimator tokens after the 2000 margin. A roughly 11900-token characters/4 memory block costs about 15872 gateway tokens, taking the request above the cap with no assistant turns that compaction can remove. The new small-memory fixtures do not establish this boundary.

Withdraw provisional source clearance. Asked implementer to add the exact large-memory immutable-head regression and reserve actual conservative rendered-memory size without broadening source ownership. Await corrected frozen source and test receipt. Earlier no-blocker text is superseded by this finding.

Implementer changed rendered-memory estimation to gateway estimateTokens units (including dense Unicode), conservatively including message overhead for each entry. This closes the identified boundary gap without changing loop budgets or moving effect compaction. Review also caught an intended Unicode test encoded as literal question marks; implementer corrected it to String.fromCodePoint(0x754c) and asserts the actual body contains that character. Requested ASCII fixture sizing that definitely fits all records under the old chars/4 estimator and therefore demonstrates the old overfit, rather than accidentally skipping a record.


## Final independent validation

Reviewed final frozen production memory.ts and boundary fixtures. ASCII records now use 3 × 14000 characters; Unicode uses String.fromCodePoint(0x754c) and checks that actual refreshed memory contains that character. Implementer reports explicit old-estimator reproduction failures of ASCII132749 and dense136749 against131072, then exact restored corrected source. This baseline reproduction was not rerun by reviewer because changing source is outside read-only ownership.

Independently ran:

`pnpm exec vitest run tests/resumed-memory-compaction-projection.test.ts tests/model-stall-handoff.test.ts -t "fresh memory|immovable head|task input|full-role memory|refuses resumed handoff before pending-effect replay|validates persisted lost-effect"`

Observed PASS: 8 passed, 19 skipped, 17.40 seconds. All six new memory cases passed: actual-loop tail memory survival, larger sticky endpoint refusal/fallback to smaller candidate, immutable head zero room/source-free omission, task/tools/output/maxTokens caps, near-role-cap ASCII and dense Unicode immutable-head fit. Both existing real-compaction/persisted-lost-history guards passed and still refuse before pending-effect replay.

No remaining blocker. The prior estimator caveat and withdrawn clearance are superseded by the final gateway-unit estimator correction and these observed results. Clear for supervisor integration and broader verification. Reviewer did not run providers, mutate live state/configuration or edit application/framework source/tests; only this report was written.
