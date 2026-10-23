/** Ordered schema migrations. Never edit an applied migration; append a new one. */
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    idempotency_key TEXT UNIQUE,
    spec_hash TEXT NOT NULL,
    profile TEXT NOT NULL,
    spec_json TEXT NOT NULL,
    state TEXT NOT NULL,
    state_reason TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    started_at INTEGER,
    deadline_at INTEGER,
    finished_at INTEGER,
    lease_owner TEXT,
    lease_expires_at INTEGER,
    run_count INTEGER NOT NULL DEFAULT 0,
    cancel_requested INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER,
    writable_repo TEXT,
    result_json TEXT
  );
  CREATE INDEX tasks_state ON tasks(state);

  CREATE TABLE task_deps (
    task_id TEXT NOT NULL REFERENCES tasks(id),
    depends_on TEXT NOT NULL REFERENCES tasks(id),
    PRIMARY KEY (task_id, depends_on)
  );

  CREATE TABLE executions (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('task', 'batch')),
    profile TEXT NOT NULL,
    retry_of TEXT,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    finished_at INTEGER,
    detail_json TEXT
  );

  CREATE TABLE execution_members (
    execution_id TEXT NOT NULL REFERENCES executions(id),
    task_id TEXT NOT NULL REFERENCES tasks(id),
    item_id TEXT NOT NULL,
    outcome TEXT,
    PRIMARY KEY (execution_id, task_id)
  );

  -- One row per physical model request admitted at the package gate.
  CREATE TABLE model_requests (
    id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL REFERENCES executions(id),
    purpose TEXT NOT NULL,
    gateway_model TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('reserved', 'succeeded', 'failed', 'uncertain')),
    reserved_at INTEGER NOT NULL,
    finished_at INTEGER,
    est_input_tokens INTEGER NOT NULL,
    reserved_output_tokens INTEGER NOT NULL,
    served_model TEXT,
    served_endpoint_id TEXT,
    served_provider TEXT,
    provider_attempts INTEGER,
    attempts_exact INTEGER,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cached_input_tokens INTEGER,
    reasoning_tokens INTEGER,
    usage_basis TEXT,
    reported_cost_usd REAL,
    estimated_cost_usd REAL,
    http_status INTEGER,
    error_kind TEXT,
    error_message TEXT,
    cache_hit INTEGER,
    policy_violation TEXT,
    telemetry_json TEXT
  );
  CREATE INDEX model_requests_reserved_at ON model_requests(reserved_at);
  CREATE INDEX model_requests_execution ON model_requests(execution_id);

  -- Each participating task's allowance charged for one physical request.
  CREATE TABLE request_charges (
    request_id TEXT NOT NULL REFERENCES model_requests(id),
    task_id TEXT NOT NULL REFERENCES tasks(id),
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    tokens_exact INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (request_id, task_id)
  );
  CREATE INDEX request_charges_task ON request_charges(task_id);

  CREATE TABLE artifacts (
    id TEXT PRIMARY KEY,
    task_id TEXT,
    execution_id TEXT,
    kind TEXT NOT NULL,
    label TEXT NOT NULL,
    rel_path TEXT NOT NULL,
    media_type TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX artifacts_task ON artifacts(task_id);

  CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT,
    ts INTEGER NOT NULL,
    type TEXT NOT NULL,
    data_json TEXT
  );
  CREATE INDEX events_task ON events(task_id);

  CREATE TABLE workspaces (
    task_id TEXT PRIMARY KEY REFERENCES tasks(id),
    repo_alias TEXT NOT NULL,
    source_path TEXT NOT NULL,
    worktree_path TEXT NOT NULL,
    base_sha TEXT NOT NULL,
    source_dirty INTEGER NOT NULL,
    dirty_paths_json TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,
  `
  CREATE TABLE pool_verifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    gateway_model TEXT NOT NULL,
    verified_at INTEGER NOT NULL,
    ok INTEGER NOT NULL,
    detail_json TEXT NOT NULL
  );
  CREATE INDEX pool_verifications_model ON pool_verifications(gateway_model, verified_at);
  `,
  `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE endpoints (
    id TEXT PRIMARY KEY,
    data_json TEXT NOT NULL,
    first_seen_at INTEGER NOT NULL,
    last_scanned_at INTEGER NOT NULL
  );

  CREATE TABLE endpoint_overrides (
    endpoint_id TEXT PRIMARY KEY,
    data_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE routing_overrides (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile TEXT,
    tier TEXT,
    kind TEXT NOT NULL CHECK (kind IN ('force', 'prefer', 'block')),
    endpoint_id TEXT NOT NULL,
    allow_below_floor INTEGER NOT NULL DEFAULT 0,
    note TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE classifications (
    spec_hash TEXT NOT NULL,
    rulebook_version TEXT NOT NULL,
    data_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (spec_hash, rulebook_version)
  );

  CREATE TABLE scans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    ok INTEGER,
    summary_json TEXT
  );

  CREATE TABLE qualification_runs (
    id TEXT PRIMARY KEY,
    endpoint_id TEXT NOT NULL,
    suite_version TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    detail_json TEXT
  );

  CREATE TABLE qualification_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES qualification_runs(id),
    endpoint_id TEXT NOT NULL,
    eval_id TEXT NOT NULL,
    family TEXT NOT NULL,
    tier TEXT NOT NULL,
    trial INTEGER NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('pass', 'fail', 'infra_error')),
    task_id TEXT,
    detail_json TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX qualification_results_endpoint ON qualification_results(endpoint_id, family, tier);

  ALTER TABLE tasks ADD COLUMN tier TEXT;
  ALTER TABLE tasks ADD COLUMN classification_json TEXT;
  ALTER TABLE tasks ADD COLUMN purpose TEXT NOT NULL DEFAULT 'work';
  ALTER TABLE model_requests ADD COLUMN endpoint_id TEXT;
  ALTER TABLE model_requests ADD COLUMN tier TEXT;
  ALTER TABLE model_requests ADD COLUMN route_note TEXT;
  `,
  `
  -- Repositories registered at runtime (qualification fixtures), merged into config aliases.
  CREATE TABLE repository_registry (
    alias TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    writable INTEGER NOT NULL DEFAULT 1,
    origin TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE qualification_tasks (
    task_id TEXT PRIMARY KEY REFERENCES tasks(id),
    run_id TEXT NOT NULL REFERENCES qualification_runs(id),
    eval_id TEXT NOT NULL,
    trial INTEGER NOT NULL,
    endpoint_id TEXT NOT NULL,
    fixture_path TEXT NOT NULL,
    evaluated INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX qualification_tasks_run ON qualification_tasks(run_id);
  `,
  `
  CREATE TABLE paid_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    billing_class TEXT NOT NULL,
    enc TEXT NOT NULL,
    iv TEXT NOT NULL,
    tag TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    last4 TEXT NOT NULL DEFAULT '',
    monthly_cap_usd REAL,
    prepaid_balance_usd REAL,
    balance_checked_at INTEGER,
    expires_at INTEGER,
    created_at INTEGER NOT NULL
  );

  -- One row per paid request: worst case reserved before dispatch, settled to actual cost.
  CREATE TABLE paid_spend (
    request_id TEXT PRIMARY KEY REFERENCES model_requests(id),
    key_id INTEGER NOT NULL,
    provider TEXT NOT NULL,
    endpoint_id TEXT NOT NULL,
    reserved_usd REAL NOT NULL,
    actual_usd REAL,
    cost_basis TEXT,
    created_at INTEGER NOT NULL,
    settled_at INTEGER
  );
  CREATE INDEX paid_spend_created ON paid_spend(created_at);
  CREATE INDEX paid_spend_key ON paid_spend(key_id, created_at);

  -- Billing class of FreeLLMAPI keys (FreeLLMAPI has no paid flag). A paid key blocks its
  -- platform from free routing because FreeLLMAPI rotates every key on a platform.
  CREATE TABLE fl_key_billing (
    fl_key_id INTEGER PRIMARY KEY,
    platform TEXT NOT NULL,
    billing_class TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,
  `
  CREATE TABLE brain_access_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT,
    job_id TEXT,
    role TEXT NOT NULL,
    pattern TEXT NOT NULL,
    mode TEXT NOT NULL,
    reason TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied')),
    decided_by TEXT,
    decision_reason TEXT,
    created_at INTEGER NOT NULL,
    decided_at INTEGER
  );
  CREATE INDEX brain_access_requests_status ON brain_access_requests(status);

  CREATE TABLE brain_grants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    pattern TEXT NOT NULL,
    mode TEXT NOT NULL,
    granted_by TEXT NOT NULL,
    request_id INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX brain_grants_task ON brain_grants(task_id);

  -- Disposable search index over the brain's markdown files (rebuilt from the files).
  CREATE TABLE brain_files (path TEXT PRIMARY KEY, mtime REAL NOT NULL, size INTEGER NOT NULL, title TEXT, kind TEXT, status TEXT, lines INTEGER);
  CREATE VIRTUAL TABLE brain_fts USING fts5(path UNINDEXED, title, body);
  `,
  `
  -- Supervisor transcripts, so an interrupted job resumes where it stopped.
  CREATE TABLE job_state (
    task_id TEXT PRIMARY KEY REFERENCES tasks(id),
    messages_json TEXT NOT NULL,
    detail_json TEXT,
    updated_at INTEGER NOT NULL
  );

  -- Questions a supervisor asks the user (answered from the panel, CLI, or MCP).
  CREATE TABLE job_questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    question TEXT NOT NULL,
    options_json TEXT,
    answer TEXT,
    answered_by TEXT,
    asked_at INTEGER NOT NULL,
    answered_at INTEGER
  );
  CREATE INDEX job_questions_task ON job_questions(task_id);
  `,
  `
  -- Agent sessions: one per model-driven run. The JSONL log under <storage>/sessions/ is the
  -- record of truth; these rows index it (counters, status, events without payloads).
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    task_id TEXT,
    job_id TEXT,
    parent_session_id TEXT,
    previous_session_id TEXT,
    role TEXT NOT NULL,
    agent_label TEXT NOT NULL,
    profile TEXT,
    tier TEXT,
    status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'interrupted', 'cancelled')),
    stop_reason TEXT,
    log_path TEXT NOT NULL,
    last_seq INTEGER NOT NULL DEFAULT 0,
    model_requests INTEGER NOT NULL DEFAULT 0,
    tool_calls INTEGER NOT NULL DEFAULT 0,
    workspace_json TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    ended_at INTEGER
  );
  CREATE INDEX sessions_task ON sessions(task_id, created_at);
  CREATE INDEX sessions_job ON sessions(job_id, created_at);
  CREATE INDEX sessions_parent ON sessions(parent_session_id);
  CREATE INDEX sessions_status ON sessions(status, created_at);
  CREATE INDEX sessions_created ON sessions(created_at);

  CREATE TABLE session_events (
    session_id TEXT NOT NULL REFERENCES sessions(id),
    seq INTEGER NOT NULL,
    type TEXT NOT NULL,
    at INTEGER NOT NULL,
    name TEXT,
    ok INTEGER,
    PRIMARY KEY (session_id, seq)
  );
  CREATE INDEX session_events_type ON session_events(type, at);
  `,
  `
  -- Acceptance contracts: compiled once per task before its first run and never changed.
  CREATE TABLE task_contracts (
    task_id TEXT PRIMARY KEY REFERENCES tasks(id),
    contract_json TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TRIGGER task_contracts_immutable BEFORE UPDATE ON task_contracts
  BEGIN
    SELECT RAISE(ABORT, 'task contracts are immutable');
  END;
  `,
  `
  -- Verdict calibration: one row per reviewer verdict (a verification review, a reuse of a cached
  -- verdict, or a background audit), keyed for the verdict cache.
  CREATE TABLE verdict_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    purpose TEXT NOT NULL CHECK (purpose IN ('verification', 'audit')),
    attempt INTEGER NOT NULL,
    reviewer TEXT,
    level TEXT NOT NULL,
    qualification TEXT,
    qualified INTEGER NOT NULL,
    verdict TEXT CHECK (verdict IS NULL OR verdict IN ('pass', 'fail', 'inconclusive')),
    revision TEXT,
    requests INTEGER NOT NULL DEFAULT 0,
    cache_key TEXT,
    cached_from INTEGER,
    audit_task_id TEXT,
    record_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX verdict_records_task ON verdict_records(task_id, created_at);
  CREATE INDEX verdict_records_cache ON verdict_records(cache_key);
  CREATE INDEX verdict_records_reviewer ON verdict_records(reviewer, created_at);

  -- What happened to a result after verification: integrated onto a job branch, a job check on
  -- that branch, or undone through attribution.
  CREATE TABLE verification_signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('integrated', 'job_check', 'undone')),
    job_id TEXT,
    detail_json TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX verification_signals_task ON verification_signals(task_id, created_at);
  CREATE INDEX verification_signals_job ON verification_signals(job_id, kind, created_at);

  -- Audit sampling: one decision per finished result considered, and the audit task it started.
  CREATE TABLE verification_audits (
    task_id TEXT PRIMARY KEY,
    decision TEXT NOT NULL,
    audit_task_id TEXT,
    reviewer TEXT,
    status TEXT NOT NULL,
    detail_json TEXT,
    created_at INTEGER NOT NULL,
    finished_at INTEGER
  );
  CREATE INDEX verification_audits_status ON verification_audits(status);
  `,
  `
  -- Agent teams (T1): a job's decomposition as versioned plans, and team-wide file leases.
  CREATE TABLE job_plans (
    job_id TEXT NOT NULL REFERENCES tasks(id),
    version INTEGER NOT NULL,
    plan_json TEXT NOT NULL,
    note TEXT,
    created_by TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (job_id, version)
  );
  CREATE TRIGGER job_plans_immutable BEFORE UPDATE ON job_plans
  BEGIN
    SELECT RAISE(ABORT, 'plan versions are immutable; record a new version');
  END;

  CREATE TABLE file_leases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    repository TEXT NOT NULL,
    globs_json TEXT NOT NULL,
    mode TEXT NOT NULL,
    acquired_at INTEGER NOT NULL,
    released_at INTEGER,
    release_reason TEXT
  );
  CREATE INDEX file_leases_open ON file_leases(repository, released_at);
  CREATE INDEX file_leases_task ON file_leases(task_id);
  CREATE INDEX file_leases_job ON file_leases(job_id, acquired_at);
  `,
  `
  -- Agent teams (T2): request budgets carved from a parent job for its sub-supervisors, and the
  -- merge queue that integrates tasks and sub-jobs onto a job branch one at a time.
  CREATE TABLE job_budget_carves (
    child_task_id TEXT PRIMARY KEY REFERENCES tasks(id),
    parent_task_id TEXT NOT NULL REFERENCES tasks(id),
    requests INTEGER NOT NULL,
    parent_remaining INTEGER,
    share REAL NOT NULL,
    depth INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX job_budget_carves_parent ON job_budget_carves(parent_task_id);

  CREATE TABLE merge_queue (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    kind TEXT NOT NULL CHECK (kind IN ('task', 'job')),
    repo_alias TEXT NOT NULL,
    branch TEXT NOT NULL,
    lock_key TEXT NOT NULL,
    integration_worktree TEXT NOT NULL,
    source_worktree TEXT,
    source_base TEXT NOT NULL,
    source_head TEXT NOT NULL,
    commits_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('queued', 'integrating', 'picked', 'integrated', 'conflict', 'redelegated', 'refused', 'failed')),
    owner TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    before_head TEXT,
    after_head TEXT,
    rebased INTEGER NOT NULL DEFAULT 0,
    acceptance_json TEXT,
    redelegated_to TEXT,
    detail_json TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX merge_queue_job ON merge_queue(job_id, created_at);
  CREATE INDEX merge_queue_task ON merge_queue(task_id, created_at);
  CREATE INDEX merge_queue_lock ON merge_queue(lock_key, state);
  `,
  `
  -- Agent teams (T2): the per-job team channel. Posts are append-only; only the brain mirror
  -- stamp (mirrored_at) may be set, once. A post is idempotent per (author session, call id).
  CREATE TABLE job_channel (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL REFERENCES tasks(id),
    author_task_id TEXT,
    author_session_id TEXT,
    author_role TEXT NOT NULL,
    author_label TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('finding', 'blocker', 'interface_contract')),
    refs_json TEXT NOT NULL,
    text TEXT NOT NULL,
    call_id TEXT,
    created_at INTEGER NOT NULL,
    mirrored_at INTEGER
  );
  CREATE INDEX job_channel_job ON job_channel(job_id, id);
  CREATE INDEX job_channel_author ON job_channel(author_task_id);
  CREATE UNIQUE INDEX job_channel_call ON job_channel(author_session_id, call_id) WHERE author_session_id IS NOT NULL AND call_id IS NOT NULL;
  CREATE TRIGGER job_channel_append_only BEFORE UPDATE ON job_channel
  WHEN NEW.id IS NOT OLD.id OR NEW.job_id IS NOT OLD.job_id OR NEW.author_task_id IS NOT OLD.author_task_id
    OR NEW.author_session_id IS NOT OLD.author_session_id OR NEW.author_role IS NOT OLD.author_role
    OR NEW.author_label IS NOT OLD.author_label OR NEW.kind IS NOT OLD.kind OR NEW.refs_json IS NOT OLD.refs_json
    OR NEW.text IS NOT OLD.text OR NEW.call_id IS NOT OLD.call_id OR NEW.created_at IS NOT OLD.created_at
    OR OLD.mirrored_at IS NOT NULL
  BEGIN
    SELECT RAISE(ABORT, 'channel posts are append-only');
  END;
  CREATE TRIGGER job_channel_no_delete BEFORE DELETE ON job_channel
  BEGIN
    SELECT RAISE(ABORT, 'channel posts are append-only');
  END;
  `,
  `
  -- Agent teams (T3): per-provider concurrency slots, shared by every process on this store.
  -- kind request: one in-flight model request (reserve to reconcile; a batch is one);
  -- claim: a task the scheduler admitted on this platform that has not sent a request yet;
  -- wait: a request waiting for a slot (priority 1 for supervisors and reviewers).
  -- A row counts only while its task's lease is live (see gateway/capacity.ts).
  CREATE TABLE provider_slots (
    id TEXT PRIMARY KEY,
    platform TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('request', 'claim', 'wait')),
    holder TEXT NOT NULL,
    task_id TEXT NOT NULL,
    lease_owner TEXT,
    priority INTEGER NOT NULL DEFAULT 0,
    since INTEGER NOT NULL,
    seen_at INTEGER NOT NULL
  );
  CREATE INDEX provider_slots_platform ON provider_slots(platform, kind);
  CREATE INDEX provider_slots_task ON provider_slots(task_id);
  CREATE INDEX provider_slots_holder ON provider_slots(holder);
  `,
  `
  -- Direct providers (P1): vault keys carry a Cloudflare-style account id, a quota group
  -- (keys sharing one provider quota), and optional user-configured per-key limits.
  ALTER TABLE paid_keys ADD COLUMN account_id TEXT;
  ALTER TABLE paid_keys ADD COLUMN quota_group TEXT;
  ALTER TABLE paid_keys ADD COLUMN rpm INTEGER;
  ALTER TABLE paid_keys ADD COLUMN rpd INTEGER;
  ALTER TABLE paid_keys ADD COLUMN tpm INTEGER;
  ALTER TABLE paid_keys ADD COLUMN tpd INTEGER;
  `,
  `
  -- Direct providers (P1): per-key state, keyed on the credential ref (vault:<id>,
  -- config:<provider>:env:<VAR>, config:<provider>:literal:<n>, none:<provider>), shared by every
  -- process on this store (see providers/keys.ts).
  CREATE TABLE provider_key_state (
    ref TEXT PRIMARY KEY,
    provider TEXT,
    -- Last four characters of the secret when it was disabled; a changed secret clears the disable.
    last4 TEXT,
    cooldown_until INTEGER,
    disabled_reason TEXT CHECK (disabled_reason IN ('auth_invalid', 'out_of_credits')),
    disabled_at INTEGER,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    last_error_at INTEGER,
    last_success_at INTEGER,
    rate_limits_json TEXT,
    quota_json TEXT,
    -- Round-robin cursor: among a provider's keys, the highest value was chosen last.
    selected_seq INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX provider_key_state_provider ON provider_key_state(provider);
  -- Sliding-window usage for configured and per-model limits (providers/limits.ts). Scopes:
  -- provider:<id>, key:<ref>, group:<provider>:<group>, model:<unit>:<model>. Rows older than a
  -- day are pruned.
  CREATE TABLE provider_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scope TEXT NOT NULL,
    at INTEGER NOT NULL,
    tokens INTEGER NOT NULL DEFAULT 0,
    reservation TEXT NOT NULL
  );
  CREATE INDEX provider_usage_scope ON provider_usage(scope, at);
  CREATE INDEX provider_usage_at ON provider_usage(at);
  CREATE INDEX provider_usage_reservation ON provider_usage(reservation);
  `,
  `
  -- Direct providers (P2): a paid request may go through a config-declared key, which has no
  -- vault id. key_ref is the credential ref (vault:<id> or config:...); key_id holds the vault id,
  -- or a stable negative id for a config key.
  ALTER TABLE paid_spend ADD COLUMN key_ref TEXT;
  `,
  `
  -- Direct providers (P2): the external gateway is gone. Drop its tables (chain verifications and
  -- its keys' billing classes) and its chain-routed endpoint rows; every stored endpoint now
  -- routes directly to its provider.
  DROP TABLE IF EXISTS fl_key_billing;
  DROP TABLE IF EXISTS pool_verifications;
  DELETE FROM endpoints WHERE json_extract(data_json, '$.route.kind') IS NOT 'direct';
  UPDATE endpoints SET data_json = json_remove(data_json, '$.flModelDbId');
  -- Paid spend is recorded by credential ref (vault:<id> or config:...), so a config-declared
  -- key keeps its identity across restarts; the numeric key_id goes.
  CREATE TABLE paid_spend_by_ref (
    request_id TEXT PRIMARY KEY REFERENCES model_requests(id),
    key_ref TEXT NOT NULL,
    provider TEXT NOT NULL,
    endpoint_id TEXT NOT NULL,
    reserved_usd REAL NOT NULL,
    actual_usd REAL,
    cost_basis TEXT,
    created_at INTEGER NOT NULL,
    settled_at INTEGER
  );
  INSERT INTO paid_spend_by_ref (request_id, key_ref, provider, endpoint_id, reserved_usd, actual_usd, cost_basis, created_at, settled_at)
    SELECT request_id, COALESCE(key_ref, 'vault:' || key_id), provider, endpoint_id, reserved_usd, actual_usd, cost_basis, created_at, settled_at FROM paid_spend;
  DROP TABLE paid_spend;
  ALTER TABLE paid_spend_by_ref RENAME TO paid_spend;
  CREATE INDEX paid_spend_created ON paid_spend(created_at);
  CREATE INDEX paid_spend_key ON paid_spend(key_ref, created_at);
  `,
  `
  -- Projects (J1): one install, many projects. Settings live in the config (projects.<slug>);
  -- this table records each project's lifecycle. Per-project rows carry project_id ('' until
  -- assigned: rows from before projects existed are given the primary project at start, see
  -- projects/backfill.ts). Repository aliases in tasks.writable_repo, file_leases.repository,
  -- and merge_queue.lock_key become <project>/<alias> there too.
  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    archived_at INTEGER,
    last_active_at INTEGER
  );
  ALTER TABLE tasks ADD COLUMN project_id TEXT NOT NULL DEFAULT '';
  CREATE INDEX tasks_project ON tasks(project_id, state, created_at);
  ALTER TABLE job_state ADD COLUMN project_id TEXT NOT NULL DEFAULT '';
  ALTER TABLE sessions ADD COLUMN project_id TEXT NOT NULL DEFAULT '';
  CREATE INDEX sessions_project ON sessions(project_id, created_at);
  ALTER TABLE brain_access_requests ADD COLUMN project_id TEXT NOT NULL DEFAULT '';
  ALTER TABLE brain_grants ADD COLUMN project_id TEXT NOT NULL DEFAULT '';
  ALTER TABLE job_plans ADD COLUMN project_id TEXT NOT NULL DEFAULT '';
  -- NULL for global events (no task).
  ALTER TABLE events ADD COLUMN project_id TEXT;
  -- '' for requests charged to no task (discovery probes).
  ALTER TABLE model_requests ADD COLUMN project_id TEXT NOT NULL DEFAULT '';
  CREATE INDEX model_requests_project ON model_requests(project_id, reserved_at);

  -- Rows hanging off a task take its project when written without one, whoever writes them.
  CREATE TRIGGER sessions_project AFTER INSERT ON sessions WHEN NEW.project_id = '' AND NEW.task_id IS NOT NULL
  BEGIN
    UPDATE sessions SET project_id = COALESCE((SELECT project_id FROM tasks WHERE id = NEW.task_id), '') WHERE id = NEW.id;
  END;
  CREATE TRIGGER job_state_project AFTER INSERT ON job_state WHEN NEW.project_id = ''
  BEGIN
    UPDATE job_state SET project_id = COALESCE((SELECT project_id FROM tasks WHERE id = NEW.task_id), '') WHERE task_id = NEW.task_id;
  END;
  CREATE TRIGGER brain_access_requests_project AFTER INSERT ON brain_access_requests WHEN NEW.project_id = '' AND COALESCE(NEW.task_id, NEW.job_id) IS NOT NULL
  BEGIN
    UPDATE brain_access_requests SET project_id = COALESCE((SELECT project_id FROM tasks WHERE id = COALESCE(NEW.task_id, NEW.job_id)), '') WHERE id = NEW.id;
  END;
  CREATE TRIGGER brain_grants_project AFTER INSERT ON brain_grants WHEN NEW.project_id = ''
  BEGIN
    UPDATE brain_grants SET project_id = COALESCE((SELECT project_id FROM tasks WHERE id = NEW.task_id), '') WHERE id = NEW.id;
  END;
  CREATE TRIGGER events_project AFTER INSERT ON events WHEN NEW.project_id IS NULL AND NEW.task_id IS NOT NULL
  BEGIN
    UPDATE events SET project_id = (SELECT project_id FROM tasks WHERE id = NEW.task_id) WHERE id = NEW.id;
  END;
  CREATE TRIGGER request_charges_project AFTER INSERT ON request_charges
  BEGIN
    UPDATE model_requests SET project_id = COALESCE((SELECT project_id FROM tasks WHERE id = NEW.task_id), '') WHERE id = NEW.request_id AND project_id = '';
  END;
  -- Plan versions stay immutable; the one change allowed is stamping the project on a row without one.
  DROP TRIGGER job_plans_immutable;
  CREATE TRIGGER job_plans_immutable BEFORE UPDATE ON job_plans
  WHEN NOT (OLD.project_id = '' AND NEW.job_id IS OLD.job_id AND NEW.version IS OLD.version AND NEW.plan_json IS OLD.plan_json
    AND NEW.note IS OLD.note AND NEW.created_by IS OLD.created_by AND NEW.created_at IS OLD.created_at)
  BEGIN
    SELECT RAISE(ABORT, 'plan versions are immutable; record a new version');
  END;
  CREATE TRIGGER job_plans_project AFTER INSERT ON job_plans WHEN NEW.project_id = ''
  BEGIN
    UPDATE job_plans SET project_id = COALESCE((SELECT project_id FROM tasks WHERE id = NEW.job_id), '') WHERE job_id = NEW.job_id AND version = NEW.version;
  END;
  `,
  // Models a key's plan refused (Ollama Cloud's free plan answers 402 for models outside it):
  // skipped for that key while the key keeps serving the rest.
  `
  ALTER TABLE provider_key_state ADD COLUMN plan_refusals_json TEXT;
  `,
  // Agents' web searches and page fetches: one row per attempt on a backend (`call_id` groups the
  // attempts of one tool call), for the per-task and per-day budgets, per-backend caps, task usage,
  // and the panel; and each web backend key's health (cooldowns, invalid, out of credits).
  `
  CREATE TABLE web_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    call_id TEXT NOT NULL,
    task_id TEXT,
    project_id TEXT NOT NULL DEFAULT '',
    session_id TEXT,
    kind TEXT NOT NULL,
    backend TEXT NOT NULL,
    key_ref TEXT,
    target TEXT NOT NULL,
    status TEXT NOT NULL,
    error_kind TEXT,
    results INTEGER,
    bytes INTEGER,
    error TEXT,
    started_at INTEGER NOT NULL,
    finished_at INTEGER
  );
  CREATE INDEX web_requests_task ON web_requests(task_id, started_at);
  CREATE INDEX web_requests_started ON web_requests(started_at);
  CREATE INDEX web_requests_backend ON web_requests(backend, started_at);
  CREATE INDEX web_requests_call ON web_requests(call_id);
  CREATE TRIGGER web_requests_project AFTER INSERT ON web_requests WHEN NEW.project_id = '' AND NEW.task_id IS NOT NULL
  BEGIN
    UPDATE web_requests SET project_id = COALESCE((SELECT project_id FROM tasks WHERE id = NEW.task_id), '') WHERE id = NEW.id;
  END;
  CREATE TABLE web_backend_state (
    ref TEXT PRIMARY KEY,
    backend TEXT NOT NULL,
    status TEXT NOT NULL,
    until INTEGER,
    failures INTEGER NOT NULL DEFAULT 0,
    last_used_at INTEGER,
    last_error TEXT,
    secret_fp TEXT,
    updated_at INTEGER NOT NULL
  );
  `,
  // Native web search inside model calls: how the request searched (the via, and whether the
  // count was assumed), the searches run, and the sources the provider cited (JSON).
  `
  ALTER TABLE model_requests ADD COLUMN native_web_search TEXT;
  ALTER TABLE model_requests ADD COLUMN web_search_requests INTEGER;
  ALTER TABLE model_requests ADD COLUMN web_citations_json TEXT;
  `,
  // Budget control (docs/working/budget-control.md): the request budget a supervisor granted each
  // worker task it delegated (held from the job's pool while the task is open), and workers'
  // requests for more model requests with their decisions.
  `
  CREATE TABLE task_request_grants (
    task_id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    requests INTEGER NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('supervisor', 'default')),
    created_at INTEGER NOT NULL
  );
  CREATE INDEX task_request_grants_job ON task_request_grants(job_id);
  CREATE TABLE budget_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    job_id TEXT,
    project_id TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL,
    requests INTEGER NOT NULL,
    reason TEXT NOT NULL,
    used INTEGER NOT NULL,
    cap INTEGER NOT NULL,
    approver TEXT NOT NULL CHECK (approver IN ('supervisor', 'external', 'auto', 'human')),
    status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'expired')),
    granted INTEGER NOT NULL DEFAULT 0,
    decided_by TEXT,
    decision_reason TEXT,
    created_at INTEGER NOT NULL,
    decided_at INTEGER
  );
  CREATE INDEX budget_requests_task ON budget_requests(task_id, status);
  CREATE INDEX budget_requests_job ON budget_requests(job_id, status);
  CREATE INDEX budget_requests_project ON budget_requests(project_id, status, created_at);
  CREATE TRIGGER budget_requests_project AFTER INSERT ON budget_requests WHEN NEW.project_id = ''
  BEGIN
    UPDATE budget_requests SET project_id = COALESCE((SELECT project_id FROM tasks WHERE id = NEW.task_id), '') WHERE id = NEW.id;
  END;
  `,
  // Project-scoped isolated labs, durable services/port reservations/checks and promotion queue.
  `
  CREATE TABLE labs (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL, state TEXT NOT NULL,
    root TEXT NOT NULL, recipe_json TEXT NOT NULL, repositories_json TEXT NOT NULL, ports_json TEXT NOT NULL,
    env_json TEXT NOT NULL, goal TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    last_activity INTEGER NOT NULL, UNIQUE(project_id, name)
  );
  CREATE TABLE lab_ports (port INTEGER PRIMARY KEY, lab_id TEXT NOT NULL REFERENCES labs(id), name TEXT NOT NULL, UNIQUE(lab_id,name));
  CREATE TABLE lab_services (
    lab_id TEXT NOT NULL REFERENCES labs(id), name TEXT NOT NULL, state TEXT NOT NULL,
    pid INTEGER, token TEXT, log_path TEXT NOT NULL, restart_count INTEGER NOT NULL DEFAULT 0,
    next_restart INTEGER, started_at INTEGER, owner_id TEXT, owner_until INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(lab_id,name)
  );
  CREATE TABLE lab_checks (
    id TEXT PRIMARY KEY, lab_id TEXT NOT NULL REFERENCES labs(id), name TEXT NOT NULL, repository TEXT NOT NULL,
    revision TEXT NOT NULL, result_json TEXT NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE TABLE lab_events (id INTEGER PRIMARY KEY AUTOINCREMENT, lab_id TEXT NOT NULL REFERENCES labs(id), type TEXT NOT NULL, data_json TEXT NOT NULL, created_at INTEGER NOT NULL);
  CREATE TABLE lab_promotions (
    id TEXT PRIMARY KEY, lab_id TEXT NOT NULL REFERENCES labs(id), state TEXT NOT NULL, policy TEXT NOT NULL,
    revisions_json TEXT NOT NULL DEFAULT '{}', targets_json TEXT NOT NULL DEFAULT '{}', details_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE INDEX labs_project_state ON labs(project_id,state);
  CREATE INDEX lab_events_lab ON lab_events(lab_id,id);
  CREATE INDEX lab_checks_lab ON lab_checks(lab_id,created_at);
  CREATE INDEX lab_promotions_state ON lab_promotions(state,created_at);
  `,
  // Cache creation usage is distinct from cache hits; nullable means unreported.
  `ALTER TABLE model_requests ADD COLUMN cache_creation_input_tokens INTEGER CHECK (cache_creation_input_tokens IS NULL OR cache_creation_input_tokens >= 0);`,
  // A retained lab owns one live root team; lifecycle commands route to its leased service owner.
  `
  CREATE TABLE lab_teams(lab_id TEXT PRIMARY KEY REFERENCES labs(id),root_job_id TEXT NOT NULL REFERENCES tasks(id),created_at INTEGER NOT NULL);
  CREATE TABLE lab_operations(id TEXT PRIMARY KEY,lab_id TEXT REFERENCES labs(id),project_id TEXT NOT NULL,lab_name TEXT NOT NULL,kind TEXT NOT NULL,input_json TEXT NOT NULL,state TEXT NOT NULL,requested_by TEXT NOT NULL,owner_id TEXT,lease_until INTEGER NOT NULL DEFAULT 0,result_json TEXT,error_code TEXT,error_message TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
  CREATE INDEX lab_operations_pending ON lab_operations(project_id,lab_name,state,created_at);
  ALTER TABLE labs ADD COLUMN creation_owner TEXT;
  ALTER TABLE labs ADD COLUMN creation_until INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE lab_target_locks(repository TEXT NOT NULL,target TEXT NOT NULL,holder_id TEXT NOT NULL,lease_until INTEGER NOT NULL,PRIMARY KEY(repository,target));
  `,
  // Task-owned verification Labs: immutable attempts, private queue and recoverable spawn intent.
  `
  ALTER TABLE labs ADD COLUMN kind TEXT NOT NULL DEFAULT 'retained' CHECK(kind IN ('retained','task_attempt'));
  CREATE TABLE task_workspace_attempts (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), project_id TEXT NOT NULL,
    run_count INTEGER NOT NULL CHECK(run_count>=1), lease_owner TEXT NOT NULL, execution_id TEXT NOT NULL UNIQUE,
    session_id TEXT, source_worktree TEXT NOT NULL, writable_alias TEXT NOT NULL, repositories_json TEXT NOT NULL,
    submitted_commit TEXT, submitted_tree TEXT, patch_digest TEXT, state TEXT NOT NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE INDEX task_workspace_attempts_task ON task_workspace_attempts(task_id,run_count);
  CREATE TABLE lab_task_attempts (
    attempt_id TEXT PRIMARY KEY REFERENCES task_workspace_attempts(id), lab_id TEXT UNIQUE REFERENCES labs(id),
    desired_state TEXT NOT NULL CHECK(desired_state IN ('running','stopped')), phase TEXT NOT NULL,
    checks_json TEXT NOT NULL, recipe_json TEXT NOT NULL, recipe_digest TEXT NOT NULL, deadline_at INTEGER NOT NULL,
    result_json TEXT, cleanup_error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE task_lab_operations (
    id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL REFERENCES task_workspace_attempts(id), kind TEXT NOT NULL CHECK(kind IN ('check','cleanup')),
    state TEXT NOT NULL CHECK(state IN ('pending','running','completed','failed')), owner_id TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
    result_json TEXT, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE INDEX task_lab_operations_pending ON task_lab_operations(state,lease_until);
  CREATE TABLE lab_attempt_processes (
    id TEXT PRIMARY KEY, lab_id TEXT NOT NULL REFERENCES labs(id), attempt_id TEXT NOT NULL REFERENCES task_workspace_attempts(id),
    kind TEXT NOT NULL, logical_name TEXT NOT NULL, token TEXT NOT NULL UNIQUE, pid INTEGER,
    directory TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE INDEX lab_attempt_processes_lab ON lab_attempt_processes(lab_id,state);
  `,
  // Private bounded normalized Gate payloads; accounting history remains independent.
  `
  CREATE TABLE request_captures (
    request_id TEXT PRIMARY KEY REFERENCES model_requests(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL, scope_json TEXT NOT NULL CHECK(length(CAST(scope_json AS BLOB)) <= 65536),
    payload_json TEXT CHECK(payload_json IS NULL OR length(CAST(payload_json AS BLOB)) <= 1048576),
    bytes INTEGER NOT NULL CHECK(bytes >= 0 AND bytes <= 1048576),
    phase TEXT NOT NULL CHECK(phase IN ('reserved','dispatch_intent','not_dispatched')),
    unavailable_reason TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
  );
  CREATE INDEX request_captures_expiry ON request_captures(expires_at,request_id);
  CREATE INDEX request_captures_project ON request_captures(project_id,created_at);
  `,

  // Local async task authority: insertion identity prevents explicit task-ID reuse collisions.
  `
  ALTER TABLE tasks ADD COLUMN lease_incarnation TEXT NOT NULL DEFAULT '';
  UPDATE tasks SET lease_incarnation=lower(hex(randomblob(16)));
  CREATE TRIGGER tasks_lease_incarnation AFTER INSERT ON tasks WHEN NEW.lease_incarnation=''
    BEGIN UPDATE tasks SET lease_incarnation=lower(hex(randomblob(16))) WHERE id=NEW.id; END;
  CREATE TABLE task_lease_operation_keys (
    id TEXT PRIMARY KEY, request_digest TEXT NOT NULL, expires_at INTEGER NOT NULL
  );
  CREATE INDEX task_lease_operation_keys_expiry ON task_lease_operation_keys(expires_at,id);
  CREATE TABLE task_lease_operations (
    id TEXT PRIMARY KEY REFERENCES task_lease_operation_keys(id) ON DELETE CASCADE, kind TEXT NOT NULL, request_digest TEXT NOT NULL,
    response_json TEXT NOT NULL CHECK(length(CAST(response_json AS BLOB))<=1048576),
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
  );
  CREATE INDEX task_lease_operations_expiry ON task_lease_operations(expires_at,id);
  CREATE TABLE task_lease_operation_projects (
    operation_id TEXT NOT NULL REFERENCES task_lease_operations(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL, PRIMARY KEY(operation_id,project_id)
  );
  CREATE INDEX task_lease_operation_projects_scope ON task_lease_operation_projects(project_id,operation_id);
  `,

  // Generation-bound request protocol; private bindings are purgeable, opaque keys prevent replay resurrection.
  `
  CREATE TABLE request_protocol_keys(id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
  CREATE TABLE request_protocol(
    request_id TEXT PRIMARY KEY REFERENCES request_protocol_keys(id), fingerprint TEXT NOT NULL,
    binding_json TEXT NOT NULL CHECK(length(CAST(binding_json AS BLOB))<=262144),
    reservation_json TEXT NOT NULL CHECK(length(CAST(reservation_json AS BLOB))<=262144),
    state TEXT NOT NULL CHECK(state IN ('reserved','dispatch_intent','settled')),
    dispatch_id TEXT, outcome_digest TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
  );
  CREATE TABLE request_protocol_projects(request_id TEXT NOT NULL REFERENCES request_protocol(request_id) ON DELETE CASCADE,
    project_id TEXT NOT NULL, PRIMARY KEY(request_id,project_id));
  CREATE INDEX request_protocol_scope ON request_protocol_projects(project_id,request_id);
  ALTER TABLE provider_slots ADD COLUMN lease_json TEXT;
  ALTER TABLE provider_slots ADD COLUMN nonce TEXT;
  ALTER TABLE provider_slots ADD COLUMN uncertain INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE request_charges ADD COLUMN lease_incarnation TEXT;
  ALTER TABLE request_charges ADD COLUMN run_count INTEGER;
  `,
  // Exact, generation-bound supervisor actions; never a blanket worker host permission.
  `
  CREATE TABLE worker_action_requests(
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    request_key TEXT NOT NULL, value_json TEXT NOT NULL CHECK(length(CAST(value_json AS BLOB))<=100000),
    created_at INTEGER NOT NULL, UNIQUE(project_id,request_key)
  );
  CREATE INDEX worker_actions_scope ON worker_action_requests(project_id,task_id,created_at);
  `,
  // Persist original model authority through queued Lab dispatch and service restarts.
  `
  ALTER TABLE lab_operations ADD COLUMN authority_json TEXT;
  ALTER TABLE lab_services ADD COLUMN authority_json TEXT;
  `,
];
