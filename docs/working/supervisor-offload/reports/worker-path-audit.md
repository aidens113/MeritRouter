# Worker-side execution path audit: can free models do 60-80% of the work?

Scope: read-only audit of `packages/router/src/runners`, `harness`, `charters`, `verification`,
routing selection, and executor entry points. No files changed.

## 1. Task types supported

| Type | Entry point | Tools | Result production |
|---|---|---|---|
| Coding edit (native) | `runners/coding/native.ts` `NativeCodingRunner.run` (chosen by `coding.runner === "native"`; `runners/coding/index.ts:112`) | `harnessV2Tools` (batch/read_files/apply_edits/run_checks, `harness/operation-dispatch.ts:7`) + legacy `repoTools`, `editTools`, `declaredCheckTool`, `commandTool`, `artifactTool`, brain read tools, web tools, lab tools, `request_more_budget` (`native.ts:77-90`) | `runAgentLoop` to `submit_result`; each edit-bearing response auto-committed under the serving model's identity (`native.ts:128-135`); declared checks re-run post-submission |
| Coding edit (external, e.g. OpenCode) | `runners/coding/index.ts` `ExternalCodingRunner.run` | — | **Disabled**: always returns `state:"failed", stopReason:"worker_sandbox_unavailable"` (`index.ts:102-110`). Only `native` is usable today despite `openCodeConfig()` existing. |
| Read-only analysis/review | `runners/readonly.ts` `runReadOnly` | `repoTools`, optional `declaredCheckTool`, optional `artifactTool`, brain read, web tools, `request_more_budget`, limited lab tools (`readonly.ts:55-64`) | Same agent loop to `submit_result`, schema-validated |
| One-shot completion (summarize/extract/classify) | `runners/completion.ts` `runCompletion` | **No tools** — single JSON-mode request over supplied sources, retried up to `max_invalid_output_retries` on validation failure (`completion.ts:48-94`) | Direct JSON parse + `validateWorkerOutput` |
| Batch (several small completions in one physical request) | `runners/batch.ts` `runBatch`/`runItems`/`runChunk` | None (same as completion) | One shared JSON response `{"items":[...]}` demultiplexed by id; missing/duplicated/invalid items retried as a new linked execution (`batch.ts:170-307`) |
| Supervisor | `runners/supervisor.ts` (not read per brief scope) | brain/supervisor tools, delegation | out of scope here |

Native coding is the only path that can actually edit files and run commands; it is also the
most tool- and prompt-heavy path, which matters directly for free/small models.

## 2. Prompt quality for small/free models

- `runners/prompts.ts:6-11` generic `systemPrompt(role)`: ~40 words. Fine for completion tasks.
- Charters (`charters/*.md`) are concatenated into the system message ahead of the harness
  block. Sizes (words): `classifier` 42, `inspector` 68, `summarizer` 70, `analyst` 73,
  `reviewer` 256, `implementer` 305, `worker` (shared charter) 535, `supervisor` 2389 (not used
  by workers).
- Coding system message = `implementer.md` (305w) + harness tool/edit instructions
  (`native.ts:101`, ~120w) + `harnessV2StartupContext` guidance block
  (`operation-dispatch.ts:38`, ~340 words, one dense paragraph of tool-usage rules: batching,
  sha256 guards, `replace_lines`, timeouts, concurrency limits) ≈ **800-900 words / ~1100-1300
  tokens** of system instructions alone, before the task brief, criteria, declared checks and
  provided context. The `HARNESS_V2_GUIDANCE` string (`operation-dispatch.ts:38`) is a single
  unbroken paragraph with no headers, numbered steps or worked multi-tool example beyond two
  one-liners (`read_files`, `batch`) — it reads like API documentation for a capable model, not
  a short step-by-step for a small one.
- Charters themselves are good: short, bulleted, concrete ("smallest change", "no unrelated
  refactors", "read before you write"). The `worker.md` shared charter explicitly tells the
  model to say "Blocked" rather than invent scope, and gives the exact 5-section report format.
- No charter or harness message gives a worked example of a full tool call with real JSON for
  `apply_edits`'s discriminated union beyond one `create` example (`edit-operations.ts:22`); the
  `patch`/`replace_lines` forms are only described in prose, which is where a weaker model is
  most likely to mis-form `expected_sha256`/`old_text` combinations.
- Output format (`OUTPUT_CONTRACT`, `core/worker-output.ts:134-145`) is explicit and compact
  (~90 words) with a clear JSON skeleton — this part is well suited to small models.

## 3. Tool interface: edits, commands, failure feedback, loop/stall guards, compaction

**Edit format.** Two parallel surfaces exist simultaneously for native coding:
- Legacy single-file tools (`harness/tools.ts:199-236`): `write_file` (whole file),
  `replace_in_file` (exact-text search/replace, optional `replace_all`), `delete_file`.
- `apply_edits` batch operation (`harness/edit-operations.ts:13-98`, exposed via harness v2):
  up to 64 edits per call, actions `create` (whole content) / `replace` (whole file,
  sha256-guarded) / `patch` (exact old_text→new_text, sha256-guarded) / `replace_lines`
  (line-range replacement, sha256-guarded) / `delete` (sha256-guarded). Every mutating action
  except `create` requires `expected_sha256` read from a prior `read_files`, so a stale read is
  rejected with the current hash and told to re-read (`edit-operations.ts:47-49`) rather than
  silently clobbering concurrent changes. Preflight validates every edit in the batch before any
  write; a mid-batch failure returns `status:"partial"` with per-path results and `notStarted`
  (`edit-operations.ts:61-96`) instead of leaving ambiguous partial state.
- `write_file`/`apply_edits` refuse symlinked paths, hard-linked files, paths outside
  `allowedPaths`, and paths escaping the workspace root via realpath checks
  (`tools.ts:138-172`) — containment is code-enforced, not prompt-enforced, which matches the
  project's stated design.

**Commands/checks.** `run_command` only accepts configured glob-like patterns and rejects any
shell metacharacter outright (`tools.ts:250-258`); `run_check`/`run_checks` only accept the
task's exact declared command strings, capped by `coding.max_check_runs_per_task`
(`tools.ts:293-337`). Both route through a supervisor-execution handoff
(`requestWorkerCommand`/`awaitWorkerCommand`) when no OS sandbox is proven, which adds latency
and a dependency on an external approver.

**Failure feedback.** Every tool error is caught and turned into a `error: <message>` string
fed back as the tool-result message (`loop.ts:388-390`); `apply_edits` preflight errors are
specific (wrong hash with the correct hash included, duplicate target, patch match count).
Repeated identical failing calls are explicitly called out.

**Loop/stall guards** (`harness/repeat-policy.ts`, used from `loop.ts:396-477`):
- Exact repeated side-effecting calls are refused outright with "the exact call already ran"
  (`loop.ts:382`) rather than re-executed — prevents duplicate commits/deletes.
- Pure reads (`read_files`, `search_text`, `git_status`, etc.) with identical arguments compared
  by *outcome*: 2nd identical observation warns, 3rd stops the task as `stalled` with reason
  `repeated_tool_call:<name>` (`RepeatObservations.observe`, `repeat-policy.ts:6-12`).
- `StallHandoff` (`harness/stall-handoff.ts`): on a stall, the serving endpoint is durably
  excluded for the task and the loop retries on another free candidate once available
  (`loop.ts:485-498`); if none remain it reports `model_handoff_exhausted:<reason>`.
- Progress nudges: a coding run that has used half its request allowance without editing
  anything gets an explicit "implement now" nudge (`loop.ts:248-256`); a supervisor-mode run gets
  a different coordination nudge. A run close to its request cap gets a budget-request nudge if
  `request_more_budget` is available (`loop.ts:243-247`), and the very last request is
  submission-only (`loop.ts:261-263,379-381`).
- These guards are specifically commented as added **because of observed live failures**
  ("live 2026-10-21: coding workers spent whole budgets reading and searching", `loop.ts:185`),
  i.e. this is empirically-driven hardening, not speculative design.

**Context compaction** (`harness/compaction.ts`): prefix-stable — only triggers once the
transcript exceeds the input budget, then cuts down to 50% of budget in one batch (old turns
replaced by a one-line-per-call summary, newest turn always kept), to avoid repeatedly breaking
provider prompt caching. Falls back to stubbing individual tool outputs when even the newest
turn doesn't fit. This is good for cost on a frontier model's cache; for a small/free model
there is usually no prompt cache to protect, so this design trades away some fidelity in
exchange for a benefit free-tier endpoints may not have.

## 4. Output contract and validation

- Fixed schema (`WorkerOutputSchema`, `core/worker-output.ts:6-23`, zod, `.passthrough()`):
  `summary`, `findings[]` (`description`+`evidenceRefs`), `criteria[]`
  (`index`,`status: met|unmet|unknown`,`evidenceRefs`,`note?`), optional `data`. This **is** the
  "outcome / changed / checks / not verified" contract, just index-keyed rather than named
  fields; `writeWorkerReport` (`harness/worker.ts:91-118`) later renders it into the brief's
  5-section report format (Outcome/What changed/Commands+results/Not verified/Open questions).
- Validation is mechanical and model-blind: `validateWorkerOutput`
  (`core/worker-output.ts:91-132`) checks every criterion index is assessed exactly once, every
  `evidenceRefs` entry resolves inside the `EvidenceUniverse` (files actually read/provided,
  with line-range bounds checked — `checkEvidenceRef`, lines 37-64), a schema-level `outputSchema`
  via ajv when the task declares one, and — critically — **"met" with no evidenceRefs is a hard
  validation error**, not just a style nit (line 116).
- `acceptanceStatus` coming out of this function is only ever `unmet` or `not_verified`
  (line 83/131) — a worker's self-reported "met" **cannot** by itself produce a "met" result.
  That status is decided later by `verification/decide.ts`.
- Checks (`run_check`/`run_checks`) that the harness itself executes are logged as structured
  `WORKER_CHECK_EVENT` rows with command, exit code, and an artifact log ref
  (`tools.ts:308-330`, `check-evidence.ts`), independent of the model's narration, and restored
  on resume filtered by source/session identity (`check-evidence.ts:18-40`) so a model cannot
  retroactively claim a check it didn't run. So: **check evidence is harness-trusted**;
  **criteria-met narration is model-claimed and never auto-trusted** (see §5).

## 5. Verification

- Deterministic checks: `verification/checks.ts` `runNamedChecks` computes 8 named checks
  (`output_contract`, `evidence_provenance`, `scope`, `protected_paths`, `declared_checks`,
  `criterion_evidence`, `ephemeral_lab_checks`, `evaluator_change_review`) purely from structured
  result fields, declared-check run records, and the evidence universe — no model call. Declared
  checks are matched to the *submitted revision*; a stale binding (result changed after the
  check ran) is explicitly `stale`, not `passed` (`checks.ts:100-107`).
- `criterion_evidence`: a criterion with `verify: "check"` is decided purely by its linked
  check's pass/fail; a criterion the model only claims "met" becomes `claimed` (not `passed`)
  until independently reviewed (`checks.ts:208-229`).
- `verification/decide.ts` `decide()` combines check report + optional reviewer verdict into
  `verificationStatus`/`acceptanceStatus`/`action`. Self-reported "met" alone caps out at
  `not_verified` (line 124); only a passing independent review or a passing deterministic check
  can produce `met`/accept. A failed check or failed criterion is a "deterministic defect" that
  cannot be overruled by a reviewer pass and triggers a repair cycle (bounded by
  `maxQualityRetries`) before falling to the supervisor (`decide.ts:81-98`).
- Reviewer pass (`verification/review.ts`, 672 lines, not read in depth per brief) supplies the
  optional independent `ReviewOutcome`; `decide.ts` treats a reviewer "pass" as unable to
  override a check-verified outcome (line 58), so review cannot launder a failing test.
- The supervisor's verdict access is `applySupervisorDecision` (`decide.ts:173-187`): cannot
  accept `unmet`, needs a reason for anything short of `met`, and `strict_acceptor: human`
  configurations refuse an agent acceptance outright (line 183-185).

Net effect: the actual accept/reject decision the supervisor relies on is produced by code, from
structured facts (exit codes, path lists, evidence refs), not trusted from the worker's prose —
this is a genuine strength for using unreliable free models as workers, since a weak model's
over-claiming is caught mechanically rather than believed.

## 6. Complexity/overhead for a simple "edit 2 files, run tests" task

Concepts a simple coding brief actually passes through, in order: `WorkerTask` spec → executor
claims a lease → `planRoute`/`planLimits` picks an endpoint (qualification + size-floor +
paid-policy + health/circuit-breaker filtering, `routing/select.ts:158-204`) → `NativeCodingRunner`
prepares an isolated worktree (`finish.ts`/`workspaces/worktree.ts`) → `RepoReader`s + context
loader build the evidence universe → `harnessV2Tools` + 6 more tool groups assembled
(repo/edit/check/command/artifact/brain/web/lab/budget) → system prompt = charter + harness v2
guidance block → `runAgentLoop` (repeat-policy, stall-handoff, compaction, channel delivery,
budget nudges, per-response auto-commit under model identity via `commitAs`/attribution) →
`submit_result` validated by zod → `finishCoding` → `runNamedChecks` (8 checks) →
`decide()` → possible repair loop or reviewer pass → supervisor acceptance. That is roughly a
dozen subsystems (routing, workspaces/worktree, context/sources, harness loop +4 harness
sub-modules, operation-registry/dispatch, attribution/commitAs, verification/checks,
verification/decide, brain, sessions/recorder) for one bounded edit task, several of which exist
for reasons unrelated to the task itself (per-line attribution, brain working-document grants,
lab bindings, channel delivery for job coordination). None of this is unused scaffolding — it's
what makes acceptance trustworthy and recoverable — but it is a lot of indirection for "edit
`foo.ts`, run `npm test`".

**Heavy machinery that is present but mostly irrelevant to a simple offloaded task:** Labs
(`src/labs/`, 20+ files: browser journeys, Docker compose, network isolation — only engaged
when `env.lab`/`ctx.lab` is set), the team channel (`channel-tools.ts`/`channel-delivery.ts`,
224+ lines, only active "while its task belongs to a job"), brain access-request workflow
(`brain_request_access`/`brain_decide_request`), and the harness-v2 generic `batch` operation
with dependency graphs (`operation-registry.ts:8-83`) — a sizeable, union-typed, dependency-aware
mini task-graph DSL offered to every coding worker regardless of whether the brief needs it.
These tools are all gated by `available()` so they don't appear for tasks that don't need them,
but the `apply_edits`/`batch` schemas themselves (discriminated unions, zod `.optional()` field
merging across operations, `depends_on` graphs) are nontrivial JSON surfaces to generate
correctly, and are offered on every native coding task regardless of size.

**Requests per simple task (estimate).** For a 2-file edit + test-run brief that goes smoothly:
1 request to read/orient (or more if the model doesn't batch), 1 request to write/patch both
files (ideally one `apply_edits` call), 1 request to run checks (`run_checks` or two
`run_check` calls folded into one turn), 1 request to call `submit_result` ≈ **3-5 model
requests** for a cooperative, capable model using harness-v2 batching well. A weaker/free model
that does not batch, needs the stall nudge, retries a rejected `apply_edits` hash conflict, or
needs one repair/reviewer round after `decide()` finds a defect easily reaches **8-15 requests**
for the same brief — each one carrying the full ~1.3k-token system/tool-def preamble (tool defs
alone are `estimateTokens` over 9+ tool groups, `native.ts:95`). Qualification
(`cfg.qualification.required`, `select.ts:200-201`) also means a never-before-used free endpoint
must pass trial runs before it is eligible at all, which is additional overhead before any real
task, though it is a one-time cost per endpoint/profile/tier rather than per-task.

## 7. Ranked gaps vs. the 60-80% free-model-offload goal

1. **External/sandboxed coding runner is dead code.** `ExternalCodingRunner` always fails
   (`runners/coding/index.ts:102-110`), so every coding brief must use the native in-process
   harness; there is no way to run a free model inside, e.g., a container-isolated OpenCode/Aider
   even though the config and `openCodeConfig()` builder exist. *Fix:* either implement the OS
   sandbox this code is waiting for, or remove the dead path and the config option to stop
   implying a capability that doesn't exist — currently a repo integrator could reasonably believe
   `coding.runner: "opencode"` works.

2. **Harness-v2 tool surface is the densest part of the prompt and is offered uniformly to every
   coding worker, strong or weak.** The `HARNESS_V2_GUIDANCE` block (`operation-dispatch.ts:38`)
   packs batching semantics, concurrency limits, sha256/patch rules, and timeout defaults into one
   ~340-word paragraph with only two tiny JSON examples, for a union-typed `apply_edits`/`batch`
   schema that is genuinely hard to generate correctly from a small model. *Fix:* gate harness-v2
   tools (or at least `batch`'s dependency-graph form) behind a profile/tier flag so a `free`-tier
   coding task gets the simpler legacy single-file tools (`write_file`/`replace_in_file`) by
   default, with harness-v2 batching offered only to tiers known to handle it; reserve the dense
   guidance paragraph for the tiers that opt into it, and give small-tier workers a short, numbered,
   worked-example version instead of the prose paragraph.

3. **No per-tier prompt budget check.** Nothing in `native.ts`/`readonly.ts` shrinks the charter
   + harness-guidance system prompt for a small-context free model; `inputBudget` only governs how
   much *task content* fits, not whether the ~1.1-1.3k-token system preamble itself is
   proportionate to the model's real capability. *Fix:* add a tier-aware "lite" system prompt
   (shorter charter variants already exist for `inspector`/`summarizer`; do the same for
   `implementer` instead of concatenating the full harness-v2 guidance for every tier).

4. **No empirical success-rate data was found in the audited files.** `endpointExclusions`
   enforces per-task qualification (`select.ts:196-202`) and `StallHandoff` records *within-task*
   stalls, but nothing here aggregates a free model's completion/acceptance rate on native-coding
   briefs over time to tell a supervisor which free endpoints are actually good enough for coding
   vs. only for completion/read-only work. *Fix (outside this audit's file set):* check whether
   `calibration.ts`/`audit.ts` in `verification/` already do this across tasks; if not, that's the
   concrete next step for deciding which free models get the 60-80% share.

5. **`ExternalCodingRunner` aside, the native loop's safety nudges assume models that mostly
   cooperate with batching.** The "half your budget used, you haven't edited anything" nudge
   (`loop.ts:248-256`) is a good backstop, but it only fires after roughly half the *allotted*
   requests are burned — for a task given a small request budget (likely for a free/cheap tier to
   control cost) that's a late warning. *Fix:* scale the nudge threshold down (e.g. a fixed request
   count rather than a fraction of `allowance`) for small per-task budgets, so a free model that
   wastes its first 2 of 6 requests reading gets redirected sooner.

6. **Supervisor-authored briefs are the actual lever, and this audit's file set doesn't cover
   them.** Every strength above (code-enforced containment, zod-validated output, deterministic
   acceptance) depends on the *brief* giving clear, narrow `allowedPaths` and concrete
   `constraints.checks`; nothing in the runner/harness code can compensate for a vague goal. This
   is a supervisor-side authoring concern, not a worker-path defect, but it is the most leveraged
   fix for raising free-model success rate and is out of this audit's scope (worker-side only).

## Not independently verified
No tests were run (read-only audit per brief). Claims about tool-definition token sizes are
estimates from counting words/characters, not an actual tokenizer run. `verification/review.ts`
was located but not read in depth (672 lines, out of the brief's required-file list). Live
success-rate data for free models on coding tasks was not located in the files read; it may
exist in `verification/calibration.ts` or `admin/job-metrics.ts`, neither of which this brief
asked me to read.
