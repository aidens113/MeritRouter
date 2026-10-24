# Historical delivery implementation checkpoints
Status: Archived

Superseded by the working document Current State. Counts and pending items describe their checkpoint only.

## Current State

Latest release audit: snapshot 9c80b12 finished with 1,337 passed, seven failed,
three skipped (139 files, 1,347 tests). This is not a green release result.
All seven failures were traced to obsolete fixture assumptions about legal early wait
returns, intentional memory notes, noninteractive CLI identity, or cancellation before
actual process startup. Strengthened focused reruns pass without relaxing production
authority or process-containment checks. Real CLI/MCP budget tests pass 2/2, including
explicit rejection of automated human-only decisions. Independent memory/headroom and
install-root checks pass 22/22. A final exact-revision full suite remains required.
Production UI/API acceptance passed 17/17 scenarios with no browser exceptions.
Supervisor rebuilt c4e85de and independently verified the mobile Markdown table fix
(640px scrollable table, 406px height, 390px page width) and corrected supervisor
settings copy plus actual null-cap/8000-token profile creation. Warm navigation p95
was 281ms; cold 10k-file indexing remains above target. Genuine Docker acceptance and
a qualified live-provider delivery pilot remain unverified; no such spending occurred.

Execution authorized by user: "Ok get to it." Implementation starts on feat/supervised-delivery-v2
in a separate worktree. Implementation briefs below supersede prior planning-only briefs for
their named workers. FINAL supervisor coordinates/reviews/tests; workers own bounded source
changes and do not commit. Paid live routes and original app files remain untouched.
Initial implementation now includes P0 spec/evidence/readiness contracts, scoped P1 MCP controls,
P2 quality/budget enforcement, native H1–H6 harness operations, persisted P7 delivery stages and
FINAL decisions, P4 memory services/injection, and P8 indexed/lazy Brain UI plus CAS/create.
These are in-progress feature-worktree changes, NOT published or fully accepted. P5/P6 actual
interactive platform isolation and release-wide validation remain open. Worker claims below
are distinct from independently observed checks; no new downstream usability claim is made.

User rejects the prior app as unusable, including locally. Earlier automated checks did not
establish usable product quality. This plan replaces task-completion-centric acceptance with
specification, integrated runtime checks and explicit final product review.
The initiator remains FINAL supervisor; delegated MeritRouter supervisors own bounded delivery
and normally plan, dispatch workers, integrate, review and test before returning evidence.
The earlier planning-only result is superseded by the authorized execution above. Existing
live paid/authority settings remain authoritative. Four design reports inform P0–P10.
Framework source is changing in the isolated feature worktree; downstream applications and
the user's configuration/memory are untouched. No new live-provider spending is authorized.
Checkpoint 375afc7 built successfully and passed recursive typechecking. Its isolated full
suite finished; failures exposed first-message ordering regressions and a changed legacy
uncapped budget default. Both causes are corrected: independently observed focused reruns
passed 44/44. The new default delivery lifecycle also passed a real fake-provider/command
end-to-end test, with separate FINAL acceptance. Initial isolated production Brain navigation
returned HTTP200, loaded in 1.075 seconds and had no browser errors; newer global memory and
settings controls still require production acceptance. Docker client is installed but its engine pipe is unavailable, blocking
genuine container-backed interactive acceptance on this host. Offline contract tests do
not substitute for that missing runtime verification.

Checkpoint 7152295 contains the second implementation integration. Subsequent independent
acceptance review found and closed dirty-source reuse, FINAL observation/decision CAS races,
source-changing final-check evidence binding, all-optional initial specifications, and stale
acceptance display. Focused real temporary-Git/default delivery tests now cover these fixes.
The initial snapshot full suite completed: 1,275 passed, 14 failed, 3 skipped (129 files,
1,292 tests, 1,278 seconds). Those failures were prompt position/budget compatibility,
intentional guidance/tool inventory changes, and a fixed-delay capacity assertion; fixes and
targeted reruns are on the feature branch. This is NOT a passing release suite. A fresh
release snapshot must run the complete suite and latest panel production acceptance.

Release snapshot 9c80b12 completed `pnpm -r build` successfully; its full139-file suite is
running independently. Initial snapshot fixes pass there. Additional failures found so far:
scripted supervisors integrate before workers finish after await_tasks returns for approval;
the classifier session test omits the intentional memory-omission note; noninteractive CLI
identity expectations predate explicit human authority; fixed-delay cancellation can occur
before command spawn. Fixtures are being strengthened at real lifecycle boundaries, not by
relaxing expected product/security outcomes. Memory resume headroom and trusted install-wide
preference reads across separate project Brain bindings are now source-complete with worker
19/19 focused passes; supervisor independent confirmation pending. Production demo seed
passed all expectations, including nested integration/rebase; UI/API acceptance is active.

