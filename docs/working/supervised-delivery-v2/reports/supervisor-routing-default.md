# Report: supervisor-routing-default
## Outcome
Done: best_available supervisor routing is usable without inventing quality evidence; explicit strict policy remains fail-closed.
## What changed and why
- `routing/supervisor-quality.ts`: default minimum_quality is best_available; frontier_or_qualified_supervisor remains explicit strict policy. Missing/expired/weak evidence yields score:null, classification:null and an explicit unverified reason under best_available, never a fabricated benchmark result.
- `routing/select.ts`: proven candidates rank first within authorized paid policy; unverified supervisors rank by observed qualification then known parameter capacity, regardless smallest_sufficient worker preference. Unverified supervisors enforce size floors, including refusing unknown size without explicit existing floor override. Proven unknown-size candidates remain supported. Existing paid/tool/modality/access/independence exclusions remain.
- `gateway/gate.ts`: rechecks quality and current profile/tier floors each physical dispatch. Strict expiry blocks; best_available expiry can fall back only when size eligible. Remaining proven routes move ahead of expired proof. Session stickiness cannot bypass this.
- `tests/supervisor-quality.test.ts`: regression coverage for fresh defaults, strict policy, evidence ordering, disabled paid, size exclusions, tools/modalities/independence, Gate dispatch and evidence/floor changes.
## Commands run and observed results
- `pnpm exec vitest run tests/supervisor-quality.test.ts --maxWorkers=1 --minWorkers=1`: 18/18 passed after final source edits.
- `pnpm --filter meritrouter typecheck`: passed.
- Final focused rerun after last Gate tie-order edit: 18/18 passed (41.11s loaded host). Last source modification 2026-10-24 04:29:39 UTC.
- Broader `providers-routing.test.ts`: 15/15 passed; gate-request-ledger/capture still running in exec session12575, supervisor can poll.
- Initial test run before updating strict fixture intent failed 6/13, as expected from changed default; fixture updates explicitly select strict policy. A first edit command used wrong cwd and made no edits; corrected immediately.
## Not verified
No live provider calls, installation restart, full repository suite, panel, builds or paid usage. Supervisor owns integrated validation/publication. Parameter capacity and ordinary qualification are fallback heuristics, not demonstrated supervisor ability.
## Open questions or contradictions found
Unknown-size unverified candidates require explicit size-floor override; this intentionally preserves capability floor rather than guessing their size. Retained blocker code supervisor_quality_unavailable also covers default endpoint/floor exclusions and now has actionable policy-aware text.
