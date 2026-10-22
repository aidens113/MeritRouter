# Operations

## Which limits are hard, estimated, or external

| Limit | Kind | Where |
| --- | --- | --- |
| Model requests per task (`maxModelRequests`), including fallbacks, classification, repairs, and every coding-agent call | Hard | Atomic reservation before dispatch (`admission.ts`) |
| Package allocation per hour/day | Hard | Same reservation |
| A job's request pool: the supervisor's own requests plus what its delegated tasks and sub-supervisors hold | Hard | Same reservation (`heldRequests`); grants checked against the pool when briefs are dispatched and requests for more are approved (`admission/budget-requests.ts`) |
| Requests for more per task, and the run cap an approval raises | Hard | `request_more_budget` (`team.max_budget_requests_per_task`); the executor adds approved extras to every later run |
| Supervisor edits under `supervisor.implementation: delegate` | Hard | The edit tools refuse everything but coordination files (`harness/coordination-edits.ts`) |
| Implementers' own check runs (`run_check`) | Hard | Only the task's declared checks, exactly as declared; `coding.max_check_runs_per_task` per task |
| Only verified-free, eligible models (unless paid policy allows); one model per request; served model must match | Hard | Route plan, gate |
| Size floors, modalities, tool support, metadata age | Hard | Route plan |
| Paid spend | Hard | Worst-case cost reserved per request against global, per-key, prepaid-balance, and per-task budgets before dispatch; settled to billed cost |
| Paid policy | Hard | Paid models (priced models, or any model through a paid key) only where `paid.tiers` / `supervisor.paid_policy` allow |
| Worker file edits | Hard (native runner) | Edit tools refuse paths outside `allowedPaths` |
| Brain access | Hard | Every brain read and write checked against role grants; workers write only their report |
| Ledger integrity | Hard | Ledger entries are append-only and need a real validation record |
| Deadlines, cancellation, lease ownership | Hard | Checked before every dispatch; late responses cannot complete a cancelled task |
| One writer per repository | Hard | Claim transaction (repositories are keyed `<project>/<alias>`, so projects never block each other) |
| Fair share between projects (`priority`) and a project's running tasks (`max_concurrent_tasks`) | Hard | Claim transaction (`storage/fair-claim.ts`) |
| A project's paid cap (`paid_budgets`) and request share (`request_share`) | Hard | The same reservation as the global budgets, after them |
| Input/output token budgets | Estimated | ~3 chars/token at admission; reconciled when the provider reports usage |
| Per-item tokens inside a prompt batch | Estimated | Proportional share, labelled `estimated` |
| Provider calls, including a retry on the provider's next key | Hard | Each call is admitted and recorded before it is sent; attempts are exact |
| Configured key limits (`rpm`, `rpd`, `tpm`, `tpd`) and known per-model rate limits | Hard | Sliding windows in the store, reserved with the key (`providers/limits.ts`) |
| Provider rate limits and quotas | External, tracked | The provider decides; SwitchYard keeps per-key state from 429s, `retry-after`, rate-limit headers, and OpenRouter's free daily quota |

Allowed commands (`coding.allowed_commands`, `supervisor.allowed_commands`) refuse shell
operators, so a pattern cannot be extended with `&& ...`, but an allowed command such as
`npm test` still runs scripts the worker can edit (`package.json`, test files). Treat any allowed
command as arbitrary code execution and use an OS-level sandbox or container if that matters.

A worktree is not a sandbox. Containment for coding agents is: a provider allowlist that only
reaches the job gateway, stripped credentials, denied shell by default, and diff validation
against `allowedPaths` afterwards. Out-of-scope edits are reported and make acceptance `unmet`;
they are not reverted in the worktree.

## Provider keys

SwitchYard calls every provider directly with your keys: keys in the encrypted vault (added in
the panel or with `switchyard keys add`) and keys declared under `providers` in the config.
`switchyard keys list` shows every key with its source, billing class, status, and last four
characters; `switchyard doctor` adds one line per provider.

- **Rotation between keys.** Each request takes the provider's next available key, least
  recently chosen first. A key is skipped while it is cooling down, disabled, at a rate limit its
  last response headers reported, out of OpenRouter free daily quota (for `:free` models), or at
  a configured limit. A key-level failure (429, invalid key, out of credits) moves the same
  request to the provider's next key before the gate moves to the next model; every one of
  those calls is admitted and counted against the task's request budget.
- **Cooldowns.** A 429 cools the key for every model of that provider, for the wait the provider
  named (`retry-after` or a rate-limit reset header), else 30 s doubling with consecutive 429s
  up to 15 minutes. A provider whose every key is cooling reports `rate_limited` with the
  earliest return time; routing ranks it last (`routing.respect_provider_cooldowns`), and a
  request whose provider has no available key moves on to the next ranked model.
- **Invalid keys.** A 401 or 403 marks the key invalid until you fix it. It stays visible as
  INVALID in `keys list`, `doctor`, and the panel. Fix it by replacing the secret (a different
  secret under the same env var or vault entry counts as a new key), by `switchyard keys enable
  <id>`, or by a `switchyard keys test` whose listing now works; each clears the mark.
- **Out of credits.** A 402 or a spend-cap refusal disables only that key. After 6 hours one
  request may check it again; `keys enable <id>` clears it at once.
- **Limits.** Optional `rpm`, `rpd`, `tpm`, `tpd` on a provider (`providers.<id>.rpm`), on a key
  (config or `keys add --rpm ...`), and per quota group (`quota_group`, `--quota-group`: keys
  sharing one provider quota, such as a Google project or a Cloudflare account; the tightest
  limit any member declares applies to their combined use). They are sliding windows kept in the
  store, so every process shares them and they survive restarts. A model's stored `rateLimits`
  are enforced the same way when known. Provider-side limits are learned from responses; they
  are never hard-coded.
- **Health.** Per provider, from key state: `healthy` (a key can serve now), `rate_limited`
  (keys will return; `resumeAt` when known), `invalid` (every key needs you), `unknown` (no
  usable key: none added, disabled, or an unset env var). The circuit breakers and adaptive
  slots in [Teams](#teams-plans-leases-and-capacity) and [Recovery](#recovery) work on top of it.
- **Discovery.** Adding, re-keying, or re-enabling a key lists its provider at once; `switchyard
  models scan`, the panel's Scan button, and a running worker every
  `discovery.interval_minutes` (60) list the models of each provider with a usable key, using
  the first key whose listing works. Each model is enriched with recorded provenance: the
  provider's metadata, OpenRouter's public catalog, Hugging Face parameter counts, an opt-in tool
  probe (`discovery.probe_tools`, at most `discovery.max_probe_requests_per_day`), and your
  overrides. A model whose context limit, output limit, or tool support stays unknown is not used
  for work that needs it. A provider whose listing failed keeps its stored models; models a
  successful listing no longer includes become unavailable. The same run refreshes OpenRouter's
  free daily quota for each key and fetches paid prices. `switchyard keys test` lists what one
  key can use without changing the catalog.
- **Replacing a key.** Add the new key, `switchyard keys test vault:<new id>`, then
  `switchyard keys remove <old id>` (a removed key with recorded spend keeps its row, without the
  secret). For a config key, change the environment variable and restart the worker and panel,
  which read the environment when they start.
- **Secrets.** Vault secrets are AES-256-GCM encrypted with the master key from
  `SWITCHYARD_MASTER_KEY` or `<storage>/.master-key`. Without that key the vault cannot be read:
  back it up (`switchyard backup --include-master-key` copies it; keep that backup private) or add
  the keys again. A literal `api_key` in the config file works, but `doctor` warns that the file
  holds a secret; prefer `api_key_env` or the vault.
- **Upgrading from a FreeLLMAPI setup** (history: SwitchYard used FreeLLMAPI as its gateway before
  2026-10-20). A config that still has a `gateway` section fails to load and says what to do:
  delete it, move `request_timeout_seconds` under `providers`, add your keys, and run
  `switchyard models scan`. Stored FreeLLMAPI-discovered models are deleted by the upgrade and come
  back from that scan.

## Web search and fetch

Agents (the roles in `web.roles`) get two tools while web access is on (`web.enabled`) and at
least one search backend has a key: `web_search(query, max_results <= 10)` and `web_fetch(url)`.
With no backend at all the tools are not offered, so no agent sees a tool that can only fail.

- **A pool, like model providers.** `web.search.backends` lists the search backends in order;
  `auto` stands for every backend not named elsewhere in the list, in the order ollama, tavily,
  brave, exa, searxng. Backends without a key (or SearXNG without `base_url`) are skipped; one
  named explicitly without a key gets a doctor warning, never turns the tools off.
  `web.search.strategy: spread` (default) starts each call at the least recently used healthy
  backend, so free allowances add up; `fallback` starts at the first. Either way a backend that
  fails is skipped within the same tool call (each backend at most once), and the tool output
  says which backend answered and which failed before it. Several keys of one backend rotate
  (least recently used first; an `ollama-cloud` backend uses every usable `ollama-cloud` key).
- **Health per key, kept in the store** (`web_backend_state`, so every process sees it): a 429,
  5xx, timeout, or dropped connection cools the key for the wait the backend named
  (`retry-after`), else 30 s doubling with consecutive failures up to 15 minutes; 401/403 marks it
  invalid; 402 or a spend message marks it out of credits, rechecked after 6 hours. A success
  clears it. A new secret (under the same env var or vault entry), re-enabling the key (panel,
  `keys enable`), or removing it clears the mark. A backend is "cooling", "invalid", or "out of
  credits" when none of its keys can be tried; when nothing in the pool can serve, the tool error
  lists each backend and when it is back.
- **Caps (optional).** `web.search.limits.<backend>: { per_day, per_month }` caps attempts on a
  backend per UTC day and month, counted from SwitchYard's own record (for ollama, page fetches
  count too). A capped backend is skipped until its window resets. SwitchYard has no built-in
  allowance numbers: set your plan's.
- **Fetch chain.** `web.fetch.backends` (default `[builtin, ollama]`): SwitchYard's own fetch
  first (free), then Ollama's `web_fetch` when the built-in fetch fails (an HTTP error, a
  timeout, too many redirects) or refuses the content (not a text page). A URL the SSRF guard
  refuses is never sent to any backend.
- **Budgets (hard, in code).** The first attempt of every web tool call is recorded in
  `web_requests` in one write transaction that checks `web.max_requests_per_task` (default 12) and
  `web.max_requests_per_day` (default 300 per UTC day, install-wide, across processes). Both count
  tool calls (a call that moved on to a second backend counts once). Past either, the tool returns
  an error telling the agent to continue with what it has; the refused call is not sent and not
  recorded. Paid search plans are capped only by these limits and the per-backend caps, not by
  `paid.budgets`.
- **What is recorded.** Each attempt is a row in `web_requests` (backend, key ref, outcome, error
  kind, results or bytes); each call is one `web_request` event on the task with its attempts,
  and a tool call in the session log. Task usage carries `webRequests` (calls); the task page
  lists every attempt and marks the one that answered; the Provider keys page shows each backend's
  state and its requests today and this month; the session timeline marks web tools.
- **Untrusted content.** Results and pages come back only as tool results, wrapped in a
  `<web_content ... trust="untrusted">` block that says it is data, not instructions; a page
  cannot close that block early. Nothing from the web goes into a system prompt. Each search
  and each page is stored as an artifact the agent can cite as evidence; a page longer than
  `web.page_excerpt_chars` (10,000) is returned as an excerpt plus that artifact's ref.
- **SSRF protection.** Only `http` and `https`; URLs with credentials, local host names
  (`localhost`, `*.local`, `*.internal`, metadata names), and hosts that are or resolve to
  loopback, private (10/8, 172.16/12, 192.168/16), carrier-grade NAT, link-local (including
  169.254.169.254), unique-local IPv6, multicast, or documentation addresses are refused. The
  built-in fetch checks the address again at connection time (so DNS rebinding cannot slip
  through) and on every redirect (at most `web.fetch.max_redirects`, 5). Timeout
  `web.fetch.timeout_seconds` (15), body cap `web.fetch.max_bytes` (2 MB after decompression);
  only text content types are read, HTML is reduced to text. A SearXNG instance you configure
  may be local: it is your own server.
- **Keys.** Search keys live in the encrypted vault under the service id and never appear among
  model credentials, routing, or `paid` spend; error messages are masked so a key never reaches
  a log, an event, or the model.
- **Not in the MCP server.** Claude Code, Codex, and ChatGPT have their own web search; the MCP
  tools are unchanged.

### Web search inside model calls (native)

Some providers search the web during the model request itself. An endpoint's `nativeWebSearch`
says how (`openrouter_plugin`, `anthropic_server_tool`, `openai_web_search_options`, or
`always_on`), its price per search, and where that came from (scan metadata, a documented fact,
or your override); the model page shows it with its source link.

- **When it runs.** An always-on model searches on every request. Any other is turned on only
  for a task with `hints.web: true`, while `web.native.enabled` (default on), at a known price,
  and, if the price is above zero, where paid routing is allowed for that request; otherwise
  the model serves without searching and the agent's own `web_search` tool remains.
- **Routing.** `hints.web: true` ranks models with search on ahead of the rest (free before paid
  still comes first); `hints.web: false` excludes always-on models; otherwise always-on models
  rank last. Their answers are web-derived and untrusted, like any model output.
- **Money (hard, in code).** A priced search makes the request paid: free_tier keys cannot serve
  it, the worst case (tokens plus `web.native.max_searches_per_request` searches, or one for the
  OpenRouter plugin) is reserved against `paid.budgets`, key caps, and the task's `maxPaidUsd`,
  and spend settles to the provider's reported cost or to tokens plus searches. An unknown price
  counts as paid and is never reserved: optional search stays off, and an always-on model with
  an unknown price is not routed until an override sets `usdPerSearch`.
- **What is recorded.** Each request row keeps the via (marked "count assumed" when the provider
  reported no count), the searches, and up to 50 cited sources (`web_citations_json`); the
  requests table shows them, task usage adds `nativeWebSearches`, and the route note says
  "native web search".

## Projects: fairness and limits

One worker serves every project of an install. It takes turns between projects; the global caps
(`execution.max_concurrent_tasks`, `allocation`, `paid.budgets`, provider slots, file leases)
still apply on top of everything below. Every field is optional and set per project under
`projects.<slug>` in the config or on the project's Settings page (Scheduling and budgets):

```yaml
projects:
  my-app:
    priority: 2                # > 0, at most 100, default 1
    max_concurrent_tasks: 3    # whole number > 0; unset: no project cap
    paid_budgets:              # USD per rolling window, inside the global paid.budgets
      per_day_usd: 1
      per_week_usd: 5
      per_month_usd: 15
    request_share: 0.5         # (0, 1]: share of allocation.max_model_requests_per_hour / _per_day
```

- **`priority`.** While several projects have ready tasks, the worker claims them in the ratio of
  their priorities (stride scheduling), oldest task first within a project. Priorities 3 and 1
  give three claims to one for every one to the other, whatever the length of either backlog: a
  50-task backlog in one project does not hold back another project's single task. A project
  that had nothing to run rejoins at the front of the rotation but banks no credit for the idle
  time. The rotation is stored in the database, so it carries across restarts and across
  processes sharing the store. Prompt batches never mix projects.
- **`max_concurrent_tasks`.** At most this many of the project's worker tasks run at once. It
  counts what `execution.max_concurrent_tasks` counts. Top-level supervisors are bounded by
  `supervisor.max_concurrent_jobs` instead, and sub-supervisors by their job's `team.max_agents`.
  A task held by the cap stays queued with the state reason
  `waiting_for_project_cap: project <slug> is at its limit of N running tasks`. One
  `waiting_for_project_cap` event is recorded while the reason holds. The wait appears in job
  metrics as `project_cap` and in the plan graph as "waits for a slot". The next free slot
  clears it.
- **`paid_budgets`.** A cap on the project's paid spend per day, week, or month, inside the
  global `paid.budgets`. Spend is counted from paid requests charged to the project's tasks.
  When the cap is reached:
  - the gate skips that paid model for the project's tasks (`project_paid_budget_exhausted`),
    and the task falls back to free models; other projects keep paid routing;
  - when every candidate was skipped only because of this cap (for example a task pinned to a
    paid model), the task fails with `project_paid_budget_exhausted`, as a global
    `paid_budget_exhausted` would.
- **`request_share`.** A fraction of the package allocation. The project may make
  `max(1, floor(cap * share))` model requests in each configured allocation window, counted from
  the requests charged to it. Past that, admission refuses with `project_allocation_exhausted`
  and a retry time, and the task waits for capacity until the window reopens, like a package
  allocation denial. With no `allocation` configured, a share has no effect.

The panel's dashboard (`/all`) shows each project's running and waiting tasks, its oldest wait,
and its requests and paid spend for 24 hours and 7 days. `switchyard daemon status` prints the
queue and running counts per project.

### Repository setup

SwitchYard makes each configured repository folder a git repository with at least one commit
(what it does to each kind of folder is in [setup.md](setup.md#projects)). It is idempotent and
safe to run from several processes at once: a lock file in the system temp folder
(`switchyard-prepare-<hash>.lock`, never inside the repository) serialises preparation of one
folder, the state is read again under the lock, and a lock older than two minutes is taken over.
A caller that waits a minute without getting the lock reports `busy` and the next run retries.

Every preparation that did something or failed is a `repository_prepare` event (no task;
`data: { project, alias, path, action, error?, message }`). A repeated identical failure is
recorded once. The overview's notices and attention items are read from these events, plus a
live check for a file in place of the folder.

Errors and their fixes: `git_missing` (install git, restart), `not_a_folder` (choose a folder),
`permission` (give your account write access), `inside_repository` (the folder holds files
another repository tracks; use that repository's top folder), `too_broad` (a drive root or the
home folder), `git_failed` (git's own message; a failing global hook, for example, since hooks
are not skipped). The generic settings editor does not prepare when it changes a path; the next
service reload or overview load does.

### Archiving a project

`switchyard projects archive <slug>`, or Archive on the project's Settings page, hides a project:
- Archiving is refused while the project has running or queued tasks.
- Nothing is deleted. The project's settings stay in the config, and its tasks, sessions, and
  brain folder stay where they are.
- An archived project is left off the projects grid's main list, the switcher, and the
  dashboard. Its panel pages answer 404, except its Settings page, which shows the settings
  read-only with Unarchive. The CLI and MCP never pick it implicitly.
- `switchyard projects unarchive <slug>`, or Unarchive in the grid's "Archived projects" list or
  on its Settings page, brings it back.

The archived flag is kept in the store (`projects` table), not in the config file.

### Deleting a project

`switchyard projects delete <slug>` shows what deleting removes and keeps, with counts, and
whether it can be deleted now; `switchyard projects delete <slug> --confirm <slug>` deletes it. In
the panel, the Danger zone at the end of the project's Settings page does the same in two steps:
a dialog listing what goes and what stays, then one that asks for the slug before "Delete
permanently". Archived projects can be deleted too.
- Refused while the project has running or queued tasks, for the last project that is not
  archived, and for a single-project config (it is the install's only project). The confirmation
  must equal the slug.
- Removed: `projects.<slug>` from the config (through the config editor: validated first, the
  previous file kept as `switchyard.config.yaml.bak`); the project's tasks and everything stored
  for them (results, contracts, verdicts, plans, leases, merge queue, team channel, questions,
  supervisor transcripts), its sessions and their logs, artifacts, events, brain access requests
  and grants, and its `projects` row, in one transaction; the worktrees SwitchYard made for its
  tasks and jobs under `<storage>/worktrees` (`git worktree remove`, then `prune`); and its brain
  folder `projects/<slug>/`, in one brain commit with a `Remove-Reason` trailer (edits made
  outside SwitchYard are committed first, so the text stays in the brain's history).
- Kept: the repository folders and every branch in them (job branches included), model requests
  with their per-task charges and paid spend (for accounting; the requests no longer belong to a
  project, so they count only in install-wide views, and their charges name tasks that no longer
  exist), brain mounts outside the brain repository, and the brain's git history.
- Deleting the primary project (`brain.project`) moves `brain.project` to another live project.
  A running worker or MCP server that had it as its primary keeps its old brain handle until it
  restarts.

### The reserved `_qualification` project

Qualification runs (`switchyard qualify`) and comparison runs on the eval goals
(`switchyard compare`) run in an internal project, `_qualification`:
- It holds the fixture repositories those runs check out (`q-...`, `c-...`), so no user project
  lists them.
- Its supervisor working documents go to `projects/_qualification/` in the brain.
- No user slug can collide with it: user slugs start with a letter or digit.
- It never appears as a project in the grid, the switcher, `doctor`, the CLI's project choice, or
  the panel's project API. Submitting into it by name is refused.
- In the panel, its tasks, jobs, and sessions open under `/all/qualification` (read-only). An old
  `/tasks/<id>`, `/jobs/<id>`, or `/sessions/<id>` link to them redirects there.
- It has priority 1 and no project caps. The global caps and
  `qualification.max_requests_per_day` still apply.

A comparison on goals you supply (`compare --goals <file>`) uses your repositories, so it runs
in the primary project (`brain.project`). Audits run in the audited task's project.

## Reading results

- `executionStatus` says whether the run finished; `verificationStatus` says what verification
  established (`not_required`, `pending`, `passed`, `failed`, `inconclusive`, `skipped_budget`);
  `acceptanceStatus` is the outcome: `met`, `unmet`, `not_verified` (nothing established it), or
  `needs_supervisor` (the supervisor must accept or reject). See "Verification" below.
- `classification` shows the score breakdown (rulebook version included); `routing.attempts`
  shows every model tried and why it was skipped or failed.
- `artifactRefs` / `patchRefs` point at files under `.switchyard/artifacts/`
  (`switchyard artifact <ref>`). Patches include the base commit in `baseCommits`; apply them
  with `git apply` after checking the base.
- **Tokens.** `usage.inputTokens` is every input token the provider read, cached ones included;
  `cachedInputTokens` is the part served from its prompt cache (null when not reported);
  `uncachedInputTokens` is the new input (each request's input minus its cached tokens, all of
  it when the cache is unknown). A conversation rereads its whole history on every request, so
  with caching most input is cached (Ollama Cloud reported 90% on a supervisor job). The panel's
  token figures are new input plus output, with cached input and the total beside them; the
  request log lists each request's full input and its cached part. Configured token limits on
  keys (`tpm`, `tpd`) still count the full input, as most providers do.

## Verification

Every task gets an immutable acceptance contract before it runs (stored in `task_contracts`,
shown on the panel's task page): criteria with ids, scope and base commit, the effective
importance and where it came from, the verification level and the rules that set it, required
checks, the request budget split (classification, execution, review, repair), and the rulebook
and policy fingerprints.

- **Importance** (`low | normal | high | critical`, with `importanceReason` for high and
  critical) is set by the submitter or the supervisor's `delegate`; `verification.floors` raise
  it (by default `security` / `data_migration` risk tags -> critical, `public_api_change` ->
  high), as do path rules and the parent job. It raises verification, never difficulty.
- **Level** comes from `verification.matrix` (tier x importance; T1/T2 normal -> `standard`, T3 ->
  `deep`, critical -> `strict`) and `verification.rules`, and is re-evaluated on the actual
  result (changed paths, protected-path edits) at the tier the run used. It only rises.
  - `basic`: output contract, evidence provenance, scope, protected paths.
  - `standard`: plus every declared check on the submitted revision and per-criterion
    evidence. Deterministic; no model review.
  - `deep`: plus an independent reviewer.
  - `strict`: a `review_strict`-qualified reviewer, then supervisor acceptance.
- **Reviewers** run in a child session in a fresh context with an evidence package (contract,
  base, patch or artifact, check logs; the author's summary labelled as a claim). They are never
  an endpoint that classified, executed, or repaired the task, and prefer another model family.
  `verification.reviewer_qualification: preferred` (default) falls back to a size-floor reviewer
  and marks the verdict `reviewer_unqualified`; strict always requires a qualified reviewer.
  Qualify reviewers with the `review` eval family (`switchyard qualify`).
- **Decision:** all mandatory items pass -> `met`; a concrete defect gets one repair at the next
  tier, starting from the submitted revision, then a re-review; missing evidence can trigger one
  targeted check; otherwise `needs_supervisor`. Failed checks stay `unmet`; a defect only a
  reviewer found goes to `needs_supervisor` so the supervisor can overrule it.
- **Budget:** review and repair reserves are added to the execution caps, bounded by
  `verification.max_total_requests_per_task` (24) or an explicit task budget. A level raised by
  the result may draw from the remaining room; if none is left the result is `skipped_budget` /
  `needs_supervisor`. The level is never lowered to fit.
- **Acceptance:** the supervisor decides `needs_supervisor` results with `accept_task` /
  `reject_task`, judged against the job's goal and the specifications it was given, and
  `integrate_task` refuses `unmet` results and requires an explicit acceptance for
  `not_verified` ones. With `verification.strict_acceptor: human`, strict results need a person:
  `switchyard accept|reject <task> --reason ...` or the panel's Accept/Reject buttons (MCP
  `accept_result` acts as the supervisor and is refused for them).

### Calibration

Verification is itself measured. Every reviewer verdict is recorded with its reviewer, level,
and qualification; what happens afterwards confirms or contradicts it: acceptance or rejection,
integration onto a job branch, job checks after integration, and undo through attribution (an
undone or later-failing result that passed is an escaped defect; a reviewer fail the supervisor
overrules is a false rejection). The panel's Calibration page (`/all/calibration`) shows passed-verification vs
subsequently-confirmed per level and per reviewer, with review cost per accepted task.

- Cached verdicts (`verification.cache_verdicts`, default on): a decisive verdict is reused,
  at no cost, for the same judged content (contract criteria, artifact digest, policy
  fingerprint, source revisions) when it was given at the required level or a stricter one, by
  a reviewer that did not author the task, unless something contradicted it since.
- Audits (`verification.audit_sample_rate`, default 0): a deterministic sample of results that
  needed no review is reviewed in the background as a separate `audit` task. Audits never
  change acceptance and are skipped when the request allocation is tight or tasks are waiting
  for capacity.

### Truncated replies and compaction

A reply cut off at the output limit gets one continuation request on the same model, and the two
parts are joined; a cut-short tool call gets one retry of the turn with a larger output
allowance, or on another model. Both count against the task's request budget. While a model
keeps serving a conversation (`routing.sticky_endpoints`), its own context sets the input budget.
Compaction runs only when the conversation exceeds that budget: it replaces the oldest whole
turns with one summary of their tool calls, down to half the budget, so the cached prefix
changes rarely.

## Teams: plans, leases, and capacity

- **Plans.** A supervisor's `plan_work` records the job's decomposition as an immutable,
  versioned, acyclic plan (`job_plans`) and dispatches every node through the normal delegate
  path; re-planning adds a version and keeps nodes already dispatched. The plan reports its
  critical path (tier-weighted: T1=1, T2=2, T3=4). See it with `switchyard plan <job>`, MCP
  `get_plan`, or the panel's job page.
- **Upstream results.** When a dependent first runs, its upstreams' summaries, findings, artifact
  and patch refs, and acceptance/verification status are saved as one artifact and shown to it as
  an "Upstream results" block; the upstream artifacts become citable evidence. A coding
  dependent starts from the job branch head once the upstream is integrated, otherwise from the
  upstream's own head. A node with `requires_accepted_inputs` (default for high and critical
  importance) waits while an upstream is `not_verified` or `needs_supervisor`, and fails on
  `unmet`.
- **File leases.** A coding task takes a lease on its write globs when it is claimed and keeps it
  until it finishes, is interrupted, or its task lease expires; a resumed task re-takes it. A task
  whose globs overlap a live lease in the same repository waits (`waiting_for_file_lease`).
- **Capacity.** `team.max_agents` (default 8; `supervisor.max_workers_per_job` is an older alias)
  caps running tasks per job; `execution.max_concurrent_tasks` bounds everything.
- **Request budgets (one pool per job).** Each task a supervisor delegates holds a grant from the
  job's budget while it is open: the brief's `max_requests` (its `budget.maxModelRequests`), else
  `team.default_task_requests`, else its tier's execution cap. A finished task holds what it used;
  the rest returns. A brief that does not fit (budget minus the supervisor's requests, open holds,
  and `team.supervisor_reserve_requests`, default 4) is refused with the number available, and the
  supervisor's own next request is refused when it would eat into what its tasks hold. Size the
  supervise profile's `max_model_requests` for the team it runs (the presets use 1000).
- **Requests for more.** A worker running low calls `request_more_budget(requests, reason)` and
  waits (no model requests; exempt from the watchdog) up to `team.budget_request_wait_seconds`
  (300). `team.budget_approver` decides who answers: `supervisor` (the job's supervisor:
  `await_tasks` returns early and it calls `decide_budget_request`; a top-level task's MCP client
  uses the MCP tools `budget_requests` and `decide_budget_request`), `auto` (up to
  `team.auto_grant_max` per request while the pool has room), or `human`. From a terminal:
  `switchyard budget list [--status ...] [--job <id>]`, `switchyard budget approve <id> [--grant N]
  [--reason ...]`, `switchyard budget deny <id> [--reason ...]`. A request whose task finished
  expires; an interrupted wait leaves it pending, and an approval then applies to the resumed run.
  Paid budgets never grow with extra requests.
  The panel shows pending decisions on the task, job, project and install dashboard. Supply a
  reason to approve or deny; approval can grant fewer requests than asked, within the current
  job pool. Job Overview shows the pool, reserve and held grants; task Usage shows its grant,
  approved extras and decision history. Budget changes arrive through the live connection.
  The scoped `POST /api/budget/requests/<id>` accepts `project`, `approve`, `reason` and optional
  integer `grant`; stale decisions, finished tasks and exhausted pools return 409. Unknown or
  out-of-project requests return 404, including unassigned requests presented in another scope.
- **Supervisors delegate implementation.** With `supervisor.implementation: delegate` (default),
  a supervisor's `write_file` / `replace_in_file` / `delete_file` succeed only on paths matching
  `supervisor.coordination_paths` (`**/*.md`, `docs/**`), files its briefs listed in
  `shared_files`, and files of this job's integrations that ended in conflict; anything else is
  refused with "delegate it". Set `allowed` to let a supervisor edit freely.
- **Implementers run their declared checks.** A native coding task with `constraints.checks` gets
  `run_check`: only those commands, exactly as declared, in its worktree with the environment,
  timeout, and shell of the post-submission checks; each run's log is a `check_log` artifact and a
  `worker_check_run` event. At most `coding.max_check_runs_per_task` (20) runs per task; the
  results are informational, the post-submission checks still decide acceptance.
- **Sub-supervisors.** A supervisor may hand a sub-goal to a child supervisor (`delegate` or a
  `plan_work` node with profile `supervise`) while the job tree is shallower than
  `team.max_depth` (2). The child works on `switchyard/job-<child>` forked from the parent's job
  branch as integrated so far, keeps its own section of the parent's working document, and runs on
  a carved share of the parent's remaining request budget (`team.child_budget_share`, 0.5;
  unused requests return when it finishes, an interrupted child keeps its share). Sub-supervisors
  take no job slot; they count toward the parent's `team.max_agents`. The parent integrates the
  child's branch like any task, so worker commits keep their trailers and blame still names the
  worker. Undoing a sub-job by task reverts its whole subtree.
- **Merge queue.** `integrate_task` enqueues; each job branch integrates one item at a time and
  runs the job's checks after each (a failing check is recorded, not undone automatically). A
  failed pick is retried as a clean rebase in the item's worktree; a real conflict re-delegates
  the task once with the conflict as context. Recovery after a crash picks only the commits not
  yet on the branch.
- **Team channel.** Agents in a job post findings, blockers, and interface contracts with
  `post_channel` and read them with `read_channel` (only tasks in a job see these tools). Posts
  are append-only, validated and capped (`team.channel_max_posts_per_task` 10,
  `team.channel_max_posts_per_supervisor` 40, `team.channel_max_post_chars` 2000), idempotent per
  call, mirrored into a "Team Channel" section of the job's working document, and shown to other
  agents as quoted data, never as instructions. A worker sees job-wide posts and posts that
  reference its task.
- **Provider capacity.** Each provider (platform) has an adaptive limit on in-flight requests,
  shared by every process on the store: it starts at `team.provider_concurrency_start` (2),
  grows by one after `team.provider_concurrency_increase_after` (5) consecutive successes, and
  halves on a 429, a reported cooldown, or an open circuit breaker, between 1 and
  `team.provider_concurrency_max` (8) or a per-platform `team.provider_concurrency_limits`
  ceiling. A worker whose providers are all full waits queued
  (`waiting_for_provider_slot`); supervisors are never held back and supervisor and reviewer
  requests take the next free slot first, so a job whose workers fill every slot still
  completes. Slots of a dead process expire with its task lease.
- **Staffing.** `plan_work` plans nodes without a difficulty at the rulebook's deterministic
  tier (the task is still classified, so tags can raise it) and reports nodes to split and the
  slots in use; the charter keeps strong models for supervision and Deep/Strict review.
- **Metrics.** Per job (sub-jobs included), derived from stored data: wall-clock, parallelism
  over time (peak and mean), planned and actual critical path, requests and cost per completed
  task, verification share, and waiting time by reason. `switchyard metrics <job>`, MCP
  `get_job_metrics`, a project's Teams page (`/p/<slug>/teams`) and job pages.
- **Team vs single agent.** `switchyard compare` runs the same goals as a team job and as one
  agent with the same models and records both metric sets. It prints the plan and its request
  budget first, `--dry-run` stops there, and nothing runs without `--yes`; runs are capped and
  share `qualification.max_requests_per_day` with `qualify`. The team cap inside a comparison
  is enforced by polling, so a run can briefly exceed it.
- **Redundant nodes.** A small non-coding plan node (T1/T2) with `redundancy: 2` runs on two
  different endpoints; the first result that passes verification wins and the other run is
  superseded. Both runs are charged; a node whose budget cannot hold both is refused.

## Recovery

- State lives in `.switchyard/switchyard.db` (SQLite, WAL). It is written before every
  acknowledgement and at every state change.
- When a worker dies, its leases expire (`execution.lease_seconds`). The next worker marks those
  tasks `interrupted` and their still-running sessions `interrupted` (`process_died`), then
  resumes them automatically (up to 3 runs per task):
  - read-only workers, native coding workers, and supervisors continue their session from its
    log: the transcript is restored, and any tool call that was in flight is settled first
    (reads are retried; delegations and idempotent commands re-run under their original call id;
    edits made but not committed are committed as "recovered edits after interruption" under the
    agent's identity, or discarded with `sessions.recover_edits: reset`; a pending `ask_user`
    is answered from the stored question). A submission accepted before the crash finishes
    without another model request. Coding work continues in the same worktree.
  - external coding agents (OpenCode) are relaunched in the same worktree with a summary of the
    interrupted session.
  - completion, batch, and classification runs re-run fresh in a new linked session.
- Manual resume: `switchyard resume <session-id>` continues that session; `switchyard resume
  <task-id>` restarts the task (a coding task in a fresh worktree; the old one stays as
  evidence). MCP `resume_session` / `resume_task` and the panel's Resume buttons do the same.
- Stuck runs: a run whose session records nothing for `execution.watchdog_minutes` (default 10;
  0 disables) is interrupted with stop reason `watchdog` and resumed like a crash (counts against
  the 3 automatic runs). A pending model request, a running tool call, or final checks extend the
  allowance to their own timeout plus 60 s; supervisors waiting in `await_tasks` or on a question
  are exempt.
- Failing providers: each provider has a circuit breaker for transport failures (5xx, timeouts,
  connection errors, 429 without a reported cooldown; never invalid model output). After 5
  consecutive failures it opens for 30 s, doubling to 15 minutes, then lets one probe through.
  Routing ranks open providers last and the gate skips them; when every candidate is open the
  task waits for capacity instead of failing. `insights.providerHealth` shows the state.
- A model whose provider reports serving a different model than the one requested is quarantined
  (the response is discarded). In the model's Controls tab, record a reason to acknowledge that
  violation and permit retries. The original request evidence remains; any later mismatch
  quarantines the endpoint again. This acknowledgement does not change key-plan refusals.
- Provider keys: see [Provider keys](#provider-keys) for cooling, invalid, and out-of-credits keys.
- Tasks waiting for capacity (`waiting_for_capacity`) retry automatically until their deadline.

## Agent sessions

Every model-driven run is an agent session: each run of a task (a recovery re-run or a tier
escalation is a new session linked to the one before it), each classification, and each batch
item. A delegated task's session names the supervisor session that delegated it as its parent.

- The log is `.switchyard/sessions/<session id>.jsonl`, one event per line, fsynced as it is
  written: the transcript (`message`), model requests, responses and errors, a tool journal
  (`tool_intent` written before a tool runs, `tool_outcome` after, with the tool's side-effect
  class), notes, workspace changes (worktree, branch, base commit, head), and the end state.
  SQLite indexes it in `sessions` and `session_events` (no payloads). A failure to write the log
  fails the run.
- Statuses: `running`, `completed`, `failed` (budget exhaustion is `failed` with stop reason
  `budget_exhausted`), `interrupted` (shutdown, lost lease, or deferral for capacity), and
  `cancelled`.
- Read them with `switchyard sessions [--status s] [--task id] [--job id]` and
  `switchyard session <id> [--after seq] [--limit n] [--json]`, the MCP tools `list_sessions` and
  `get_session`, or a project's Sessions page (`/p/<slug>/sessions`, also linked from task and job pages).
- External agents (OpenCode) run their tools inside their own process: their sessions record the
  model traffic through the policy gateway, not individual tool calls.
- A resume appends a `resumed` event recording what was settled and the notice the agent got.

## The web panel: turning it off, and rebuilding it

- The power button at the top of the panel, beside the project switcher, turns the panel off
  after a confirmation: `POST /api/panel/stop` writes `<storage>/panel.stopped`, answers, and the
  panel process exits; the page then shows "Panel turned off". Agents and workers keep running.
  It comes back on its own as soon as agents use SwitchYard again: any MCP tool call (checked at
  most every 30 seconds per server, in the background), a new MCP session, `switchyard run`, or
  `switchyard submit` clears the marker and starts it (unless `panel.auto_start` is off). Only the
  idle background checks (the MCP server's minute check, `switchyard worker` starting) leave it
  off. `switchyard panel` and the MCP `panel` tool start it even with `panel.auto_start` off. The
  route accepts only same-origin requests.
- The panel's production build contains the router code: Turbopack bundles `switchyard-router`
  although `next.config.ts` lists it in `serverExternalPackages`, because it externalizes only
  modules whose real path is under `node_modules`, and the pnpm workspace link resolves to
  `packages/router`. A router change therefore reaches the panel only after `pnpm -r build` (or
  `pnpm --filter switchyard-panel build`) and a panel restart. When `.next/BUILD_ID` is older than
  the newest file in the router's `dist/`, starting or checking the panel reports it
  (`ensurePanel`'s `warning`; `panelBuildCheck` for `doctor`).

## Housekeeping

- Worktrees and agent homes are not deleted automatically (deleting a project removes its own;
  see [Deleting a project](#deleting-a-project)). Remove old ones with `git worktree remove` in
  the source repository, then delete the folder.
- Backups: see [Backup and restore](#backup-and-restore).
- Durability: `storage.durability: full` sets SQLite `synchronous=FULL` (survives power loss at
  some write cost); `normal` (default) can lose the last transactions on power loss but never
  corrupts. Session logs are fsynced per event either way.
- Session logs are not pruned automatically.

## Backup and restore

A backup covers the whole install: every project's rows and the brain repository with every
project's folder and `global/`. There is no per-project backup, so `backup` and `restore` refuse
`--project`.

`switchyard backup <dir>` writes a new directory while workers keep running:
- `switchyard.db`: an online SQLite snapshot of the store, consistent while workers run.
- The session logs and artifacts that the snapshot indexes.
- `brain.bundle`: the brain repository as a git bundle of all its refs.
  - Only committed history is in the bundle.
  - Uncommitted brain changes are listed in the manifest (`brain.uncommitted`) and printed as a
    warning. SwitchYard commits edits made outside it on its next brain write, so take the
    backup after that, or commit them yourself.
  - A brain that does not exist yet or has no commits is recorded as not included, with the
    reason.
- `manifest.json`, written last; a directory without it is an incomplete backup. Format 2 adds
  the `brain` section; format 1 backups (store only) still restore.
- The vault master key, only with `--include-master-key`.
- Never included: worktrees, agent homes, qualification scratch, and logs.
- Brain mounts are also never included. They are folders in other repositories, so the manifest
  lists each one (prefix, path, and the project that adds it, or global) under
  `brain.mountsNotIncluded`, and the CLI prints them. Back those repositories up themselves.

`switchyard restore <dir> [--force]` restores the store and the brain into the configured
storage directory and `brain.path`. Every refusal happens before anything is changed. A restore
is refused:
- while any task holds a live lease or a daemon runs;
- when the brain has uncommitted changes, even with `--force`, so a restore never overwrites
  uncommitted brain work (SwitchYard's lock file does not count);
- over an existing store, or a brain with other history, unless `--force` is given.

With `--force`:
- the old store entries move to `.switchyard/pre-restore-<time>/`;
- the old brain moves to `<brain>.pre-restore-<time>`, next to it.

The restored brain is a fresh repository holding every ref of the bundle, with the backed-up
branch checked out at the backed-up commit. A brain already at that commit is left alone.
Restored running tasks have their leases expired, so the next worker recovers them. The command
prints each brain mount that was not in the backup, so you can restore it from its own
repository.

## One daemon for every project

An install runs one worker for all of its projects; there are no per-project daemons, services,
or workers.
- `switchyard daemon` (or `daemon run`) runs the worker in the foreground and restarts it with
  backoff (`--max-restarts`, `--window`, `--max-delay`).
- `switchyard daemon start` runs the same in the background. Its output goes to
  `<storage>/logs/daemon.out`, its lifecycle to `daemon.log`, and the worker's output to
  `worker.log`.
- `switchyard daemon status` prints the daemon's process id and start time. Under it, a table
  gives each project's queued and running tasks, read from the store. Internal or removed
  projects appear when they have work, and archived projects are marked. It also works when no
  daemon runs.
- `switchyard daemon stop` asks the daemon to stop. The daemon gives its worker 30 s to stop,
  then exits. If the daemon has not exited within `--timeout` seconds (default 45), its
  process tree is ended; the worker's tasks are recovered on the next start.
- `switchyard service install` registers the same daemon with the platform's service manager.
- `daemon`, `daemon start`, and `service` take the global config and refuse `--project` with an
  explanation. The daemon also does not pass a shell's `SWITCHYARD_PROJECT` on to its worker.
- A second daemon for the same storage directory is refused.
- MCP servers for individual projects run beside the daemon with `--no-worker`.

## The brain and attribution

- The brain is one git repository (`brain.path`) for every project: `projects/<slug>/` per
  project and `global/` for knowledge shared by all of them (see [roles.md](roles.md#the-brain-shared-knowledge)).
  `switchyard brain ls|read|search` (in the selected project, or every project when none is
  chosen) and each project's Brain page browse it. Every change is a commit under the writing
  agent, so `git log` and `git blame` inside it show who (and which model) wrote what.
  Initialization and writes share the brain lock, including when several projects initialize
  the same repository concurrently. The lock file is excluded from initialization and adopted
  external changes. Initialization errors propagate instead of leaving a partially ready brain.
  Service shutdown cancels queued promotion callbacks and waits for started settlement writes
  before closing the database, so their Git processes do not outlive the service.
  Panel document history and blame are project scoped: private paths and rename ancestry from
  another project are unavailable. Commit subjects are retained only when every changed path is
  visible; mixed commits expose only the selected document's changes, without shared metadata.
- Job branches live in your repositories as `switchyard/job-<id>`; integration worktrees under
  `.switchyard/worktrees/job-<id>-<alias>`. Review, then `git merge --no-ff` (not squash).
- `switchyard blame <repo> <path> --ref <branch>` attributes lines to agents and models.

## Known limitations

- Live behaviour against real providers and OpenCode has not been exercised yet (no credentials
  were available during development). Every policy path is covered by tests with fake providers
  behind an injectable HTTP fetch and a scripted coding agent. Still to confirm live: rate-limit
  header formats (OpenRouter reset, SambaNova `-day`, Anthropic periods), OpenAI
  `insufficient_quota` as out of credits, Cloudflare and Cohere list pagination, Anthropic model
  `capabilities`, and the shape of OpenRouter's `/api/v1/key`.
- Quarantine acknowledgements permit retries without independently proving the provider is
  fixed; the next response still passes served-model validation.
- OpenCode's JSON event format is undocumented; its output is stored as evidence, not parsed.
- Paid routes have not been exercised against real providers yet; prices are yours to keep
  current (OpenRouter prices are fetched when `pricing_url` is set).
- Audio/video inputs are routed only to models that accept them; there is no transcription or
  frame-extraction preprocessing yet.
- Tasks and jobs run only while a worker process is running (the MCP server stops with the
  Claude session; run `switchyard worker`, `switchyard daemon start`, or
  `switchyard service install` for unattended work, and the MCP servers with `--no-worker`).
- Idempotency keys are unique per install, not per project: a key already used in one project
  is refused in another.
- Line attribution for external agents (OpenCode) is per model request, not per tool call, and can
  blur when the agent sends several requests at once.
