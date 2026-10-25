# Implementer batching charter correction
Status: Complete
Worker: loop_role_fix
Date: 2026-10-25

Updated only packages/router/charters/implementer.md declared-check guidance to prefer
run_checks with check:N IDs for independent checks when offered. It explicitly preserves
exact declared commands, dependency order, sequential execution and individual approvals.
run_check remains available for individual commands and legacy tool availability.
No-shell boundaries, allowed command patterns, fix-before-submit, exact result reporting,
and post-submission checks remain unchanged.

No tests or commits; supervisor owns focused native/check verification after this wording fix.
