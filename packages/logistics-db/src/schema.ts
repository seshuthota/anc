export const SCHEMA_VERSION = 2;

/**
 * A regional parcel carrier. Parcels are collected from shippers, sorted
 * overnight at the hub that serves the destination district, then delivered
 * by a route run to a door or a parcel locker.
 *
 * No table states why something went wrong: a cause has to be read across the
 * hub, route, shipment and shipper records.
 */
export const schemaSql = `
CREATE TABLE IF NOT EXISTS dataset_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS hubs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  city TEXT NOT NULL,
  sort_capacity_per_hour INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS districts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  hub_id TEXT NOT NULL REFERENCES hubs(id)
);

CREATE TABLE IF NOT EXISTS employees (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  team TEXT NOT NULL,
  title TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS shippers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  tier TEXT NOT NULL CHECK (tier IN ('key_account','standard','small')),
  on_time_target REAL NOT NULL,
  account_manager_id TEXT REFERENCES employees(id)
);

CREATE TABLE IF NOT EXISTS locker_sites (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  district_id TEXT NOT NULL REFERENCES districts(id),
  compartments INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS route_runs (
  id TEXT PRIMARY KEY,
  service_date TEXT NOT NULL,
  hub_id TEXT NOT NULL REFERENCES hubs(id),
  district_id TEXT NOT NULL REFERENCES districts(id),
  wave INTEGER NOT NULL,
  truck_id TEXT NOT NULL,
  driver_name TEXT NOT NULL,
  scheduled_departure TEXT NOT NULL,
  actual_departure TEXT,
  status TEXT NOT NULL CHECK (status IN ('scheduled','held','departed','completed')),
  parcels_planned INTEGER NOT NULL,
  parcels_loaded INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS route_runs_date ON route_runs(service_date, hub_id);

CREATE TABLE IF NOT EXISTS shipments (
  id TEXT PRIMARY KEY,
  shipper_id TEXT NOT NULL REFERENCES shippers(id),
  dest_district_id TEXT NOT NULL REFERENCES districts(id),
  hub_id TEXT NOT NULL REFERENCES hubs(id),
  service_level TEXT NOT NULL CHECK (service_level IN ('standard','express')),
  delivery_mode TEXT NOT NULL CHECK (delivery_mode IN ('door','locker')),
  locker_site_id TEXT REFERENCES locker_sites(id),
  created_at TEXT NOT NULL,
  promised_by TEXT NOT NULL,
  arrived_hub_at TEXT,
  sorted_at TEXT,
  route_run_id TEXT REFERENCES route_runs(id),
  delivered_at TEXT,
  collected_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('in_transit','at_hub','sorted','out_for_delivery','in_locker','delivered','exception'))
);
CREATE INDEX IF NOT EXISTS shipments_hub_status ON shipments(hub_id, status);
CREATE INDEX IF NOT EXISTS shipments_promised ON shipments(promised_by);
CREATE INDEX IF NOT EXISTS shipments_shipper ON shipments(shipper_id);
CREATE INDEX IF NOT EXISTS shipments_locker ON shipments(locker_site_id, status);

CREATE TABLE IF NOT EXISTS hub_hourly (
  hub_id TEXT NOT NULL REFERENCES hubs(id),
  hour TEXT NOT NULL,
  parcels_arrived INTEGER NOT NULL,
  parcels_sorted INTEGER NOT NULL,
  backlog INTEGER NOT NULL,
  PRIMARY KEY (hub_id, hour)
);

CREATE TABLE IF NOT EXISTS equipment_events (
  id TEXT PRIMARY KEY,
  hub_id TEXT NOT NULL REFERENCES hubs(id),
  equipment TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  severity TEXT NOT NULL CHECK (severity IN ('low','medium','high')),
  summary TEXT NOT NULL,
  -- Set by the escalate_equipment_fault operation; version guards concurrent writes.
  escalated_to TEXT REFERENCES employees(id),
  escalated_at TEXT,
  version INTEGER NOT NULL DEFAULT 1
);

-- Who maintenance escalations go to at each hub.
CREATE TABLE IF NOT EXISTS hub_on_call (
  hub_id TEXT PRIMARY KEY REFERENCES hubs(id),
  engineer_id TEXT NOT NULL REFERENCES employees(id)
);

-- Notices queued for a shipper's account manager. Nothing in this demo sends
-- them anywhere: a row is the whole effect of the notify_shipper operation.
CREATE TABLE IF NOT EXISTS shipper_notifications (
  id TEXT PRIMARY KEY,
  shipper_id TEXT NOT NULL REFERENCES shippers(id),
  account_manager_id TEXT REFERENCES employees(id),
  topic TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','cancelled')),
  idempotency_key TEXT NOT NULL UNIQUE,
  requested_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS complaints (
  id TEXT PRIMARY KEY,
  shipper_id TEXT NOT NULL REFERENCES shippers(id),
  shipment_id TEXT REFERENCES shipments(id),
  created_at TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('late','damaged','missing','locker','other')),
  subject TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open','closed')),
  assignee_id TEXT REFERENCES employees(id),
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS complaints_created ON complaints(created_at);
`;
