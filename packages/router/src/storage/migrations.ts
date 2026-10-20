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
];
