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
  if (!readOnly) db.exec(schemaSql);
  return db;
}

export { schemaSql, SCHEMA_VERSION };
export { seedLogistics, type LogisticsScenario } from "./seed.js";
