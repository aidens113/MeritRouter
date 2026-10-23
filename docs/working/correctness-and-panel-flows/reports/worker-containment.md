# Worker containment implementation

Status: Implemented; supervisor integration/acceptance pending

Inspected native/external/readonly command entry points, post-submission checks, reviewer targeted checks,
repository readers/edit paths, artifacts and resume. No OS sandbox currently contains host processes.
Implementation therefore fails closed: bounded exact supervisor actions execute as supervisor, with no
blanket worker capability grant. Native file tools remain available; unsandboxed external workers disabled.

Added persisted generation/project/cwd/source-bound actions, scoped list/decision service and trusted operator
admin facade. Generic network/Lab requests carry supervisor-reported responses, never check evidence.
Supervisor owns network/Lab tool gates, watchdog accommodation and public exports. Worker owns shell paths,
artifact/file guards, check evidence restoration and focused acceptance fixtures.

Implemented `security.outside_repository=disabled|human_only|supervisor`, default human_only. Host policy
is reloaded from the trusted config path at filing, approval and while approved/direct host commands run.
Human-only requests require trusted operator execution; worker model roles/arguments never confer authority.
Supervisor direct command helper validates captured lease and cancellation and kills on policy/lease loss.
Commands capture real cwd, task/project/incarnation/generation, bounded timeout/output and source identity.
Approval is one-shot with persisted dispatch intent; uncertain effects never auto-replay. Checks carry durable
logical invocation IDs, allowing fresh bounded executions while interrupted same-invocation replay is safe.
Supervisor await_tasks surfaces pending actions; native/readonly workers have status and bounded await tools.
Postsubmit and reviewer-targeted checks wait under original task deadlines instead of unsandboxed execution.
Generic network/Lab actions store clearly labeled supervisor responses without fabricating execution proof.

File guards deny hardlink edits, Windows ADS/device/trailing-dot aliases, .git escapes and trusted config edits.
Artifact reads require own-task/context grants, safe resolved storage path and SHA integrity. Check restoration
queries check events before limiting, validates source/artifact/session task scope and restores full line counts.
Readonly common result fields preserve checks through budget exhaustion and invalid terminal output.
Pinned checks refuse changed HEAD or dirty working tree. Five-turn regression sets both fixture caps explicitly.

Validation: `npx vitest run tests/worker-containment.test.ts tests/readonly-checks.test.ts --maxWorkers=1
--minWorkers=1` run in packages/router:11/11 passed. With added initial artifact scope, three-file run14/14
passed. Further hardlink/junction/request-tool expansion: containment9/9 + artifact3/3 passed. Earlier five-case containment run passed;
later expanded run 10/11 passed and exposed same-task retry session handling, corrected and isolated test passed.
No commit, broad validation, real provider, live service/config or downstream operations performed.

Final expanded containment run:11/11 passed (8.48s), including pinned HEAD with dirty source refused,
approved running host process killed after original task cancellation before delayed outside-sentinel write,
and read-time pending reconciliation removes cancelled/generation-lost/deadline-lost actions from pending lists.
External runner refuses every profile; ConfigSchema binds supervise profile name exclusively to supervisor mode.
No autonomous external-worker launch can be enabled by choosing a misleading profile name.

Limitations / integration review:
- No generic OS sandbox is claimed. External coding worker launch is disabled until one exists; use native.
- Automatic worker Task Lab execution fails closed before registration/start. Generic supervisor responses do
  not satisfy durable Task Lab execution proof; a supervisor-executed proof integration remains unavailable.
- Generic operation requests accept trusted durable invocation identity. Loop/resume supply session+tool-call
  identity; same-invocation replay is stable while new read calls can request fresh supervisor observations.
- Supervisor owns web/Lab gates, public exports, watchdog wait accommodation and final production docs.
- Initial context artifact ingestion now rejects foreign/unowned artifacts before bytes; checks embedded
  upstream packages' task/dependency ownership as well. Safe `ArtifactStore.readScoped` validates path/SHA.
- Shared Git hook/filter/fsmonitor execution hardened by panel worker; task-lab synchronous Git uses the
  same `prepareGitProcess` policy helper. Supervisor owns integration and full-tree acceptance.
