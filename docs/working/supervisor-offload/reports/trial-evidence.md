# Trial evidence: why MeritRouter offload worked or failed

Synthesis only, read-only. Sources: instagram-meritrouter-assessment.md,
instagram-meritrouter-trial.md, trial-failure-audit.md, supervised-delivery-v2.md,
supervisor-lifecycle-stall.md, gate2-auto-integration.md, live-validation.md,
framework-validation.md, production-readiness.md, handoff.md.

## 1. What worked

**Shape that worked: external supervisor (Claude Code/Codex) dispatching bounded,
disjoint-file worker tasks directly through MeritRouter, with no MeritRouter-native
supervisor layer in between.** This is exactly the Instagram trial
(instagram-meritrouter-trial.md Current State, instagram-meritrouter-assessment.md
"Current State" and "Measured outcome and accounting"):

- 18 tasks, 19 sessions, 364 physical gate requests, 355 successful responses.
- 3 tasks explicitly accepted by the external supervisor with independent evidence;
  several more "completed/not_verified" results were salvaged (useful diffs retained,
  integrated, and repaired) rather than wasted. The assessment explicitly warns neither
  3/18 nor 8/18 is the right "acceptance rate" — most requests produced *some* reusable
  signal even when the task itself wasn't accepted outright.
- Net result: a locally working social app (feed, upload, follow, likes/comments,
  profile, search, notifications, DMs) passed typecheck/build, 10/10 unit tests, 21 API
  contract checks, 34 security/concurrency/upload checks, and desktop/mobile browser
  flows, after the external supervisor integrated worker commits.
- Rough useful-output-per-request: of 364 physical requests, the three cleanly accepted
  tasks used 46 requests (14+27+... see task table) for genuinely accepted work, while
  three split-frontend tasks (28 requests total) produced "baseline code with integration
  defects" that a later repair task fixed rather than discarded — i.e. maybe half of
  requests produced code that was ultimately kept in some form, the rest were discovery,
  repair loops, or rejected attempts (first mobile menu: 11 requests, fully discarded for
  deleting valid code).
- Models that produced accepted or salvageable work in that trial: Beam ("useful
  repairs"), gpt-oss ("fixed the test types successfully"). The assessment is explicit
  that task/prompt/budget differences prevent concluding one model is generally better
  (same doc, "Worker quality failures versus router responsibility").
- Supervision pattern that made this work: isolation per worktree, explicit task
  budgets, four-worker/four-writer concurrency, provenance (edit commits/session logs),
  and — critically — heavy external-supervisor integration (installing dependencies,
  fixing wrong imports/exports, running final checks, browser QA) on top of worker output.
  MeritRouter did not deliver an integrated product by itself; the external supervisor did,
  using MeritRouter workers as a (noisy) drafting layer.

## 2. Ranked failure classes

Ranked by how much delivery time/requests they consumed across both trials.

1. **Framework/machinery failures in the native-supervisor path (highest impact).**
   The Facebook MVP trial (gate2-auto-integration.md, trial-failure-audit.md) is
   dominated by: never-admitted orphan provider slots blocking all capacity after
   cooldown, deadline/budget "continuation" bugs (blocked-job continuation downgrading
   authority, linked-session initialization leaking ownership), provenance/path-selector
   mismatches in edit recovery, panel-lifecycle EBUSY races, a Windows native-process
   CSPRNG-abort crash under empty environment, and repeated supervisor heartbeat/session
   stalls requiring manual operator resume (v2 through v4 runner restarts logged in
   handoff.md and trial-failure-audit.md). Root cause as recorded: these are framework
   bugs in machinery that exists to make an *unattended, long-running, budget-tracked
   native supervisor* safe — not model capability. They consumed essentially the whole
   November effort and the app was still undelivered at 589-800/800 physical requests.
2. **Provider quota/429 misclassification (high impact, framework bug).** Ollama Cloud's
   monthly-usage-exhaustion 429 was initially treated as ordinary transient backoff
   instead of per-key terminal/out_of_credits, so capacity collapsed to 1 and a stale
   "never-admitted" slot then blocked all remaining throughput (trial-failure-audit.md,
   "ollama-monthly-limit-classification"/"-fix" briefs). Framework bug, not a model
   problem; fixed, but cost days of live-trial time to diagnose.
3. **Tool ergonomics / argument friction (medium-high, framework complexity problem).**
   Instagram assessment section C: 476 tool intents, 60 unsuccessful; 21 were
   `list_files '.'` rejected as reserved syntax, 21 missing/incorrect repository alias.
   Four repair tasks burned 91 requests with two of them making zero edits because of
   this. This is squarely a framework/tool-contract defect (undocumented alias/root
   semantics), not the model failing to reason.
4. **Worker code-quality failures (medium, genuine model-capability problem).**
   Incomplete contracts, wrong imports/exports, CommonJS top-level-await, a worker that
   replaced a page with "rest unchanged" placeholders (deleting valid code, fully
   rejected), a worker that replaced real test types with `any` and deleted an assertion.
   The assessment explicitly separates these as "model/code failures," with the router's
   job being to detect/contain/explain them (which it mostly did) rather than prevent them.
5. **Check/approval friction under human-only policy (medium, framework-complexity/UX
   problem).** Workers requested Linux-style commands on Windows, waited on approvals the
   external supervisor's MCP surface couldn't grant, and a declared `npm test` blocked
   under human-only policy mid-task (Instagram assessment section D; Facebook trial
   likewise shows many `request_supervisor_action`/`await` cycles). Not a model-capability
   defect; it's a missing preflight/visibility layer around a correctly-working safety
   policy.
6. **Cancellation / lease-release delay (medium, framework bug).** ~58-62 seconds between
   cancel request and actual ownership release in two measured cases (Instagram assessment
   section B); replacement tasks waited on the stale lease. Root cause not established at
   the time; framework problem.
7. **MCP lifecycle project-scoping inconsistency (medium, framework bug).** Submit/status
   accepted an explicit project argument but cancel/resume/accept/reject/collect bound to
   the server's *default* project, so one client couldn't complete a task's lifecycle
   without a workaround (Instagram assessment section A). Framework API defect.
8. **Verification/review gaps (medium, framework incompleteness).**
   `evaluator_change_review` returns `not_implemented`; a test-editing task needed 12
   review requests and had zero reserved; the one time review budget *was* reserved, all
   three reviewer candidates were outside the free plan, so no independent review ever
   ran despite successful-looking execution (Instagram assessment section E). This directly
   weakens the "verify" half of delegate->report->verify.
9. **Misleading status/attention UI (low-medium, framework UX problem).** A destructively
   rewritten, rejected task showed green "Completed" with "Nothing needs your attention"
   while two completed results were actually `not_verified` (Instagram assessment
   section F). Pure presentation bug, but it is exactly the kind of thing that would let
   an external supervisor wrongly trust offloaded work.
10. **Integration/environment gaps (low-medium, expected and acceptable today).** Workers
    had no pre-installed dependencies and no stable shared contracts, so the external
    supervisor had to install deps, write INTERFACES, and manually integrate every time
    (Instagram assessment section H). This is a process-design gap (no bootstrap-first
    staging), not strictly a bug.

Overall split: items 1, 2, 6, 7, 8, 9 are framework-complexity problems (self-inflicted by
machinery MeritRouter built for itself); item 3 and 5 are framework/contract-ergonomics
problems; items 4 and 10 are the genuine, expected cost of using free/cheap worker models
and should be managed by supervision, not "fixed" in the router.

## 3. Free providers/models actually used

- **Ollama Cloud** was the real backbone for free coding in both trials: `beam`,
  `gpt-oss` (:120b and others), `nemotron-3-ultra`, `minimax-m2.7`/`m3`/`m3.1-flash`,
  `glm-5.3-flash`. Reliability: generally served requests (Tetris job: 13 requests, 47s,
  clean game) but suffered real provider-side friction — per-model 402 "not in your free
  usage"/403 "not yet available," periodic 429s, and (Facebook trial) a genuine monthly
  quota exhaustion that the router initially misclassified as transient. Quality: the
  Instagram trial's accepted/salvaged work came from Beam and gpt-oss; several
  pinned/alternate models (minimax variants, glm-5.3-flash) failed outright with plan
  refusals (`gateway_not_in_plan`) rather than producing bad code — i.e. a chunk of
  "failures" were access/plan mismatches, not model incompetence.
- No evidence in these documents of other free providers (e.g., non-Ollama) being used
  live in either trial; "free-only routing" and "paid coding never" held throughout both.
- Paid routing was used only for the *supervisor* role in the Facebook trial
  (Claude Opus via paid supervision requests), never for coding.

## 4. Internal vs. external supervisor

The two trials are a direct natural experiment on this exact question.

- **Instagram trial = external supervisor only.** instagram-meritrouter-trial.md states
  explicitly: "No standalone MeritRouter supervisor job or Lab was used; the external
  Codex supervisor planned, dispatched, integrated, tested and accepted results." Outcome:
  delivered, worker-only, accepted app in ~35 minutes of task time plus substantial
  external-supervisor integration.
- **Facebook MVP trial = MeritRouter's own internal/native supervisor ("root" job)
  running on a free model (nemotron-3-ultra/beam), with the external Codex session only
  as "FINAL" acceptor** (gate2-auto-integration.md: "FINAL owns exact candidate
  acceptance; root authors ZERO application source" — "root" here is the MeritRouter
  native supervisor, "FINAL" is the external Codex client). Outcome: never delivered.
  589-800 of an 800-request budget and ~$15-20 of paid *supervision* spend were consumed
  mostly on framework firefighting (orphan slots, continuation bugs, provenance mismatches,
  repeated heartbeat stalls needing manual v2/v3/v4 runner restarts) rather than on
  product progress.

**Conclusion the evidence supports directly:** the external-supervisor pattern is the one
that has actually delivered something end to end this cycle. The internal native
supervisor is still shaking out serious machinery bugs and has not delivered a product in
either working document reviewed here.

## 5. Machinery vs. a reliable delegate->report->verify loop

Honest assessment: the large majority of recent recorded effort went into machinery, not
into hardening the basic loop.

- `trial-failure-audit.md` and `gate2-auto-integration.md` together are almost entirely
  about budget/deadline continuation, never-admitted-slot recovery, transport recovery,
  provenance/path-selector correctness, panel-lifecycle EBUSY races, and repeated manual
  "v2/v3/v4" live-runner restarts — all in service of the *internal* supervisor's
  long-running, budget-accounted, resumable session. None of that moved the Facebook app
  forward; the app directory was still missing at several checkpoints.
- `supervised-delivery-v2.md` is a large forward-looking design (DeliverySpec, Criterion,
  ExecutionPlan, EvidenceReceipt, DeliveryBundle; quality-ranked supervisor routing;
  600/80/80 budget envelopes; harness v2 with 6 serial units; written memory by role;
  Labs/interactive-runtime isolation; Brain panel performance) — ambitious, and partly
  implemented, but it is machinery and policy layered on top of a loop that the Instagram
  trial already showed can work with much simpler mechanics (explicit per-task budgets,
  four-writer concurrency, provenance, cautious acceptance).
- By contrast, the concrete things that actually blocked the simple loop from being fully
  reliable — tool-ergonomics argument errors, MCP project-scoping inconsistency,
  cancellation/lease delay, misleading status UI, missing evaluator review — are each
  comparatively small, well-diagnosed fixes recorded in instagram-meritrouter-assessment.md
  sections A-H, and most were *not* the focus of the subsequent month of work, which went
  into the internal-supervisor Facebook trial and its machinery instead.
- Fair reading: the team repeatedly chose to harden an ambitious, fully-autonomous
  internal-supervisor product (budgets, deadlines, provenance, Labs) before finishing the
  cheaper, already-proven path (external supervisor + bounded workers + the eight fixes
  above). That is the core imbalance.

## 6. Top 5 recommendations for a reliable external-supervisor loop within a week

1. **Standardize on the Instagram pattern now: external Claude Code/Codex as the sole
   supervisor, dispatching bounded, disjoint-file worker tasks directly through
   MeritRouter's task API.** Do not route this week's work through MeritRouter's own
   native/root supervisor job or Labs; that path is the one with the unresolved machinery
   failures and zero delivered products in these documents.
2. **Fix the eight concrete, already-diagnosed external-supervisor blockers from
   instagram-meritrouter-assessment.md, in this order:** (a) MCP project-scoping
   consistency for cancel/resume/accept/reject/collect (section A); (b) tool-ergonomics
   root/alias handling for `list_files`/read/search (section C — this alone caused ~60 of
   476 failed tool intents); (c) cancellation lease-release delay (section B); (d)
   Completed/attention UI showing true acceptance state, not just structural pass
   (section F). These are small, bounded, and each has a stated acceptance test.
3. **Freeze or explicitly deprioritize the internal-supervisor machinery:** never-admitted
   orphan-slot recovery, deadline/budget "continuation" repair, provenance/path-selector
   recovery beyond what's already fixed, Labs/hydrated-browser isolation, and the
   supervisor-quality/upward-budget-request system in supervised-delivery-v2.md. None of
   it is needed for an external supervisor driving short-lived, explicitly-budgeted worker
   tasks, and all of it has been consuming the team's time without producing a delivered
   product.
4. **Implement evaluator_change_review for real (or explicitly disable the reserve so it
   stops silently blocking), and bootstrap dependencies/stable contracts before dispatch**
   rather than after worker failure — both are concrete, bounded fixes named in the
   Instagram assessment (sections E and H) that directly raise useful-output-per-request
   without new machinery.
5. **Keep the Ollama-quota classification fix (already landed) and add a cheap,
   mechanical "plan-eligibility preflight"** so pinned/unavailable models fail fast with a
   clear reason before a worker is dispatched, instead of burning a task slot on
   `gateway_not_in_plan` (seen repeatedly in both trials). Track useful-output-per-request
   as a visible metric across future short, bounded repeats of the Instagram pattern,
   rather than attempting another long autonomous MVP build this week.
