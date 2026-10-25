# Budget guidance assertion correction
Status: Complete
Worker: loop_role_fix
Date: 2026-10-25

Changed only the obsolete native prompt wording assertion in
packages/router/tests/budget-control.test.ts:424. It now requires grouped run_checks
instruction, the run_check compatibility alias, and the exact two-run cap.

All command execution, undeclared refusal, successful/failed output, run-limit,
artifact logs, stored events, and post-submission assertions remain unchanged.
No source/runtime changes, commits, or test commands. Supervisor owns the serialized
failed-file rerun after completed full-suite snapshot1392pass/9fail/3skip.
