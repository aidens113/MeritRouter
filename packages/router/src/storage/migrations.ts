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
];
