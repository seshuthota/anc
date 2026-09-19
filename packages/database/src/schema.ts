export const SCHEMA_VERSION = 1;

export const schemaSql = /* sql */ `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS dataset_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  segment TEXT NOT NULL CHECK (segment IN ('enterprise', 'mid_market', 'startup')),
  timezone TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS customer_config_history (
  id INTEGER PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  config_key TEXT NOT NULL,
  config_value TEXT NOT NULL,
  effective_from TEXT NOT NULL,
  effective_to TEXT
);
CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  status TEXT NOT NULL,
  term TEXT NOT NULL,
  arr_minor_units INTEGER NOT NULL CHECK (arr_minor_units >= 0),
  currency TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS releases (
  id TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  service TEXT NOT NULL,
  component TEXT NOT NULL,
  deployed_at TEXT NOT NULL,
  description TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS release_rollouts (
  id INTEGER PRIMARY KEY,
  release_id TEXT NOT NULL REFERENCES releases(id),
  cohort TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  percentage INTEGER NOT NULL CHECK (percentage BETWEEN 0 AND 100)
);
CREATE TABLE IF NOT EXISTS service_metrics (
  id INTEGER PRIMARY KEY,
  bucket TEXT NOT NULL,
  service TEXT NOT NULL,
  customer_id TEXT REFERENCES customers(id),
  cohort TEXT,
  requests INTEGER NOT NULL CHECK (requests >= 0),
  errors INTEGER NOT NULL CHECK (errors >= 0 AND errors <= requests),
  error_signature TEXT
);
CREATE INDEX IF NOT EXISTS idx_service_metrics_bucket ON service_metrics(bucket);
CREATE INDEX IF NOT EXISTS idx_service_metrics_customer ON service_metrics(customer_id);
CREATE TABLE IF NOT EXISTS feature_usage (
  id INTEGER PRIMARY KEY,
  bucket TEXT NOT NULL,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  feature TEXT NOT NULL,
  usage_count INTEGER NOT NULL CHECK (usage_count >= 0)
);
CREATE INDEX IF NOT EXISTS idx_feature_usage_bucket ON feature_usage(bucket);
CREATE INDEX IF NOT EXISTS idx_feature_usage_customer ON feature_usage(customer_id);
CREATE TABLE IF NOT EXISTS support_tickets (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  created_at TEXT NOT NULL,
  category TEXT NOT NULL,
  status TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_support_tickets_customer ON support_tickets(customer_id);
CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  issued_at TEXT NOT NULL,
  amount_minor_units INTEGER NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS incidents (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  service TEXT NOT NULL,
  severity TEXT NOT NULL,
  summary TEXT NOT NULL
);
`;
