import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { schemaSql, SCHEMA_VERSION } from './schema.js';
export { DEMO_CLOCK, DATASET_VERSION, DEFAULT_COMPANY_DB_PATH } from "./constants.js";

export type CompanyDatabase = Database.Database;

export function openCompanyDatabase(path: string, readOnly = false): CompanyDatabase {
  if (!readOnly) mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { readonly: readOnly, fileMustExist: readOnly });
  db.pragma('foreign_keys = ON');
  if (!readOnly) db.exec(schemaSql);
  return db;
}

export { schemaSql, SCHEMA_VERSION };
export { seedDatabase, seedScenario, type SeedScenario } from './seed.js';
