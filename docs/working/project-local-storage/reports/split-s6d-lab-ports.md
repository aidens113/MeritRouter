# S6d shared Lab port authority

Status: isolated authority4/4 passed; callsite integration authored, broad check pending.
Owner: supervisor. Date: 2026-10-26. MAIN only; all fixtures OS TEMP.

ProjectLabPortReservations holds host ports globally with installation/project/store UUID,
generation, numeric port and opaque Lab/name digests. Names, recipes, paths and process
evidence stay local. S5 appended/classified the shared table. No age-based reclamation.
Fresh/resumed allocation requires exact pinned local connection and explicit broker;
unbound legacy allocation is unchanged.

Local authority/proof is checked under local IMMEDIATE before independent global transactions.
Global code never queries local state. Local rollback may overhold a global port; replay
binds the same name/port. Release requires creating/stopped/failed/destroyed state, no command
owners, no nonstopped attempt processes, and no live/uncertain service token or PID. C3 owns
kernel-zero retirement; missing native proof cannot become an elapsed-time waiver.

Observed4/4 PASS6.12s: two projects with duplicate private Lab identity, idempotence, numeric
conflict, privacy, rollback hold, unknown process refusal, stale registration, wrong/missing
broker, actual bound socket and broker recreation with same-owner projection recovery.
No providers/live projects touched. C3 authored optional LabManager bridge at both allocations
and existing release sites, preserving ordinary stopped retained-Lab reservations.

Remaining: independent callsite verification, coherent recursive typecheck/build, and actual
default runtime construction supplying one per-project authority before split Labs can start.
