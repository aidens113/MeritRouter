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
];
