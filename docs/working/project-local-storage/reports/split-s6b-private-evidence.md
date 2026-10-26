# S6b private evidence

Status: focused isolation and recursive typecheck passed; crash fixture diagnosis active.
Owner: supervisor. Date: 2026-10-26.

Private captures, artifacts, sessions and usage now reject coordination-role databases.
Bound project operations pin the complete store identity plus physical database file identity,
check local task/execution ownership and require FULL durability. Legacy unbound stores keep
their explicit compatibility semantics. This does not activate migration or root service getters.

Artifact/session paths normalize both cfg.storageDir (`.MeritRouter/state`) and runtime root
inputs to one registered `.MeritRouter` root. Existing ancestors and target files reject
junction/symlink redirection and hardlinks. Indexed session pointers must match the recorder's
canonical log path; append rechecks ownership before filesystem effects. Taskless sessions
are explicitly project stamped. These cooperative checks do not claim atomic OS sandboxing
against arbitrary hostile native filesystem races.

Observed: project-evidence-isolation6/6 PASS7.18s. Canonical duplicate task evidence, taskless
sessions, rejected foreign tasks before file creation, empty coordination stores, redirected
and hardlinked evidence, cached database alias changes and recorder refusal are exercised.
Runtime-registry19+project-tools12 independently PASS31/31 in17.09s on this evidence draft.
Legacy sessions/resume/artifacts/captures/usage40/40 PASS; fault injection9/10 PASS.
Supervisor delegation fault case failed before the injection (count6 expected7) in its old
600x20ms observation loop; exact original isolated rerun failed identically with task still
running and no failure result. Diagnostic bounded120s observation passed the complete original
journey in97.331s, preserving one child/one brief, resume journal, source and result assertions.
Its original180s test deadline and internal120s result wait remain unchanged; only this native
multi-publication fixture uses the longer observation. All50 distinct compatibility cases now
passed across the combined49 and exact rerun1; no green full-suite aggregate claimed.

Final evidence6+tools12 PASS18/18,13.48s; router+panel recursive typecheck PASS on held snapshot.
Remaining: full build after concurrent authors freeze, complete crash compatibility results,
host runtime/consumer activation and fresh Facebook real-provider acceptance.
