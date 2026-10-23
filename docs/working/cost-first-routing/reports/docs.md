# Documentation report
Status: Complete

## Changes
- Root and packaged README introductions and copyable prompts now lead with cost reduction across paid and free routes; prompts no longer disable paid routing.
- README setup explains enabled paid routing, $5 rolling weekly cap, T1-T3 free-exhaustion policy, T4 supervisor escalation, credentials/prices/headroom, explicit old settings and free-only alternatives.
- CLAUDE overview removes optionally-paid positioning.
- Authored docs index/setup/roles/operations explain the same defaults, including standalone supervisor on_free_exhaustion; setup preset table now reflects claude-code bounded paid fallback.
- Added setup cost-controls anchor linked from README/package README/docs index/roles/operations and dated decisions entry.
- Setup states that enabled plus zero weekly cap fails validation; zero daily/monthly caps block spend. Omitted supervisor policy applies whether endpoints are pinned or selected automatically.
- Setup distinguishes explicit preserved settings from omitted fields taking new defaults, and provides an explicit disabled switch before upgrading for users requiring strictly free operation.
- Preserved accurate routing mechanics, historical provider evidence, named free-only preset, and separate safety approval policy.

## Verification
- Scoped ripgrep review found no remaining paid-off-by-default or optionally-paid blanket positioning in owned authored docs.
- Reviewed diffs and checked exact paid.budgets.per_week_usd configuration spelling against current schema/example.
- git diff --check passed (line-ending advisories only).
- No builds, tests, live/network/provider calls, live configuration edits or commits performed. Supervisor must verify integrated defaults and docs.

## Limitations
- Historical docs/working records intentionally unchanged.
- Routing algorithm/ranking unchanged; docs avoid claiming globally optimal price selection.
