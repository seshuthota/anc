import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { schemaSql, SCHEMA_VERSION } from "./schema.js";
export { DEMO_CLOCK, DATASET_VERSION, DEFAULT_LOGISTICS_DB_PATH, TIMEZONE, toLocalIso, localMidnight } from "./constants.js";

export type LogisticsDatabase = Database.Database;

export function openLogisticsDatabase(path: string, readOnly = false): LogisticsDatabase {
  if (!readOnly) mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { readonly: readOnly, fileMustExist: readOnly });
  db.pragma("foreign_keys = ON");
  if (!readOnly) {
    db.exec(schemaSql);
    migrateLogisticsDatabase(db);
  }
  return db;
}

const EQUIPMENT_COLUMNS: Array<[name: string, ddl: string]> = [
  ["escalated_to", "ALTER TABLE equipment_events ADD COLUMN escalated_to TEXT REFERENCES employees(id)"],
  ["escalated_at", "ALTER TABLE equipment_events ADD COLUMN escalated_at TEXT"],
  ["version", "ALTER TABLE equipment_events ADD COLUMN version INTEGER NOT NULL DEFAULT 1"],
];

/** True when a database seeded before schema v2 still lacks the operation columns. */
export function logisticsSchemaOutdated(db: LogisticsDatabase): boolean {
  const columns = new Set((db.prepare("PRAGMA table_info(equipment_events)").all() as Array<{ name: string }>).map((row) => row.name));
  if (!columns.size) return false;
  const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name));
  return EQUIPMENT_COLUMNS.some(([name]) => !columns.has(name)) || !tables.has("hub_on_call") || !tables.has("shipper_notifications");
}

/**
 * Brings a database seeded before schema v2 up to date (new columns on
 * equipment_events; the new tables come from schemaSql). Schema only: no row is changed.
 */
export function migrateLogisticsDatabase(db: LogisticsDatabase) {
  const columns = new Set((db.prepare("PRAGMA table_info(equipment_events)").all() as Array<{ name: string }>).map((row) => row.name));
  for (const [name, ddl] of EQUIPMENT_COLUMNS) {
    if (columns.has(name)) continue;
    try {
      db.exec(ddl);
    } catch (error) {
      // Another process may have added it first.
      if (!/duplicate column/i.test(error instanceof Error ? error.message : "")) throw error;
    }
  }
}

/**
 * For a read-only opener: if the file predates schema v2, apply the schema-only
 * migration once through a short-lived writable handle, so read-only readers
 * see the columns they query. Never touches rows.
 */
export function ensureLogisticsSchema(path: string) {
  const probe = new Database(path, { readonly: true, fileMustExist: true });
  const outdated = logisticsSchemaOutdated(probe);
  probe.close();
  if (!outdated) return;
  const db = new Database(path, { fileMustExist: true, timeout: 5000 });
  try {
    db.exec(schemaSql);
    migrateLogisticsDatabase(db);
  } finally {
    db.close();
  }
}

export { schemaSql, SCHEMA_VERSION };
export { seedLogistics, type LogisticsScenario } from "./seed.js";
