# S6d installation Lab and service capacity

Status: implementation draft; isolated acceptance pending schema append.
Worker: c3_message. MAIN checkout only. No existing C3 source edits in this phase yet.

New labs/project-capacity.ts owns the cross-store capacity concern. Coordination holds only
installation/project/store UUID, generation, kind, opaque Lab/service digests and timestamp.
Global count covers every held generation/project for the installation; stale rows never age
out. Constructor accepts a trusted limits callback, validated every admission against global
Lab/service cap ranges. A caller cannot supply limits to reserve/release.

Local FULL store/physical identity and actual validated Lab/service/task ownership precede
independent coordination IMMEDIATE transactions. Global callbacks do not read local SQL.
Local rollback can overhold a global reservation; same binding replays one slot. New Lab
slots require a durable creating intent. Existing admitted stopped retained Labs keep slots
until destruction. Missing/failed/stale proof cannot clear accounting.

Service admission occurs after command-authority.prepare and before native transport start.
Private lab_capacity_owners captures exact command token/process identity/immutable handle.
Service restart/backoff retains one global slot; replacing its private binding requires the
previous exact archived native retirement audit. Release awaits that shared audit outside
SQL transactions, then reacquires local IMMEDIATE and revalidates the entire snapshot before
deleting global accounting and its private row. Cleared PID/token alone is never the proof.
Lab release refuses private/global service holds, unknown commands/processes and incomplete
task retained/pruned cleanup evidence. No model proof flags, expiry refunds or global SQL
transaction opening local queries.

Schema owner S5 received exact global project_lab_capacity and private lab_capacity_owners
append/classification requests and acknowledged serialized append after supervisor checkpoint.
This worker did not edit migrations/store-role. Supervisor will also make port release refuse
any retained private capacity owner.

Required later integration (not edited yet): reserveLab after durable creating row before
Git/port allocation; reserveService after exact command.prepare before transport; terminal
service release after native stop and durable stopped/null PID/token identity; backoff keeps
slot. Task stop retires service capacity owners before port release, then Lab slot only after
durable retained/pruned cleanup complete. Retained destroy saves destroyed before Lab release.
Pregrant capacity refusal needs supervisor-approved live-only prepared-command unsent archive
API: no startAttempted, no binding and exact current opaque prepared receipt. Unknown/crash
does not manufacture an unsent proof. Existing repository-command remains frozen pending
foundation commit; no such source edit yet.

Validation: no acceptance tests run yet. New two-project FULL store/native audit tests next.
