export const RUNTIME_SCHEMA_VERSION = 4;

export const runtimeSchemaSql = /* sql */ `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS runtime_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS investigations (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  objective TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_investigations_thread ON investigations(thread_id);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  investigation_id TEXT NOT NULL REFERENCES investigations(id),
  thread_id TEXT NOT NULL,
  status TEXT NOT NULL,
  cancelled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  investigation_id TEXT NOT NULL,
  domain TEXT NOT NULL,
  question TEXT NOT NULL,
  status TEXT NOT NULL,
  payload TEXT NOT NULL,
  result TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- Keyed by (evidence_id, owner_id): an evidence id is a hash of the tool result,
-- so two people who run the same lookup get the same id and each keeps a row.
CREATE TABLE IF NOT EXISTS evidence (
  evidence_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  task_id TEXT,
  tool TEXT NOT NULL,
  payload TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  owner_id TEXT NOT NULL DEFAULT 'user-coo',
  PRIMARY KEY (evidence_id, owner_id)
);
CREATE INDEX IF NOT EXISTS idx_evidence_run ON evidence(run_id);
CREATE TABLE IF NOT EXISTS findings (
  finding_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS activity (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  run_id TEXT,
  message TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activity_thread ON activity(thread_id, created_at DESC);
CREATE TABLE IF NOT EXISTS surfaces (
  surface_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  thread_id TEXT NOT NULL,
  investigation_id TEXT NOT NULL,
  run_id TEXT,
  title TEXT NOT NULL,
  messages TEXT NOT NULL,
  data_model TEXT NOT NULL,
  finding_ids TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (surface_id, revision)
);
CREATE TABLE IF NOT EXISTS handled_actions (
  action_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS thread_state (
  thread_id TEXT PRIMARY KEY,
  investigation_id TEXT,
  active_run_id TEXT,
  active_surface_id TEXT,
  active_surface_revision INTEGER,
  selected_entities TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  owner_id TEXT,
  organization_id TEXT
);
CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  run_id TEXT,
  owner_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_artifacts_thread ON artifacts(thread_id, created_at DESC);
CREATE TABLE IF NOT EXISTS action_proposals (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  revision INTEGER NOT NULL,
  payload TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS operations (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  owner_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  proposal_id TEXT,
  status TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  actor_id TEXT,
  action TEXT NOT NULL,
  resource TEXT,
  outcome TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_events(actor_id, created_at DESC);
CREATE TABLE IF NOT EXISTS grant_revocations (
  principal_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  revoked_at TEXT NOT NULL,
  PRIMARY KEY (principal_id, capability)
);
`;
