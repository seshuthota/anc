import Database from "better-sqlite3";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureLogisticsSchema, logisticsSchemaOutdated } from "@anc/logistics-db";
import { createLogisticsMcpServer } from "./server.js";

/** A company database as seeded before schema v2 (no operation columns or tables). */
function oldDatabase(): string {
  const path = join(mkdtempSync(join(tmpdir(), "anc-mcp-old-")), "old.sqlite");
  const db = new Database(path);
  db.exec("CREATE TABLE hubs (id TEXT PRIMARY KEY, name TEXT NOT NULL, city TEXT NOT NULL, sort_capacity_per_hour INTEGER NOT NULL); CREATE TABLE employees (id TEXT PRIMARY KEY, name TEXT NOT NULL, team TEXT NOT NULL, title TEXT NOT NULL); CREATE TABLE equipment_events (id TEXT PRIMARY KEY, hub_id TEXT NOT NULL, equipment TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT, severity TEXT NOT NULL, summary TEXT NOT NULL);");
  db.close();
  return path;
}

const outdated = (path: string) => {
  const db = new Database(path, { readonly: true });
  try { return logisticsSchemaOutdated(db); } finally { db.close(); }
};

describe("company MCP server and the schema v2 migration", () => {
  const writable = process.env.LOGISTICS_DB_WRITABLE;
  afterEach(() => { if (writable === undefined) delete process.env.LOGISTICS_DB_WRITABLE; else process.env.LOGISTICS_DB_WRITABLE = writable; });

  it("a read-only server never migrates (no writable handle): it refuses an old database and leaves the file untouched", () => {
    const path = oldDatabase();
    const before = statSync(path).mtimeMs;
    process.env.LOGISTICS_DB_WRITABLE = "false";
    expect(() => createLogisticsMcpServer(path)).toThrow(/predates schema v2/);
    expect(outdated(path)).toBe(true);
    expect(statSync(path).mtimeMs).toBe(before);
  });

  it("after the runtime's one-time startup migration, a read-only server opens it", () => {
    const path = oldDatabase();
    ensureLogisticsSchema(path);
    process.env.LOGISTICS_DB_WRITABLE = "false";
    const { db } = createLogisticsMcpServer(path);
    expect(db.readonly).toBe(true);
    db.close();
  });

  it("the writable operation connection opens with the schema applied", () => {
    const path = oldDatabase();
    process.env.LOGISTICS_DB_WRITABLE = "true";
    const { db } = createLogisticsMcpServer(path);
    expect(db.readonly).toBe(false);
    expect(logisticsSchemaOutdated(db)).toBe(false);
    db.close();
  });
});
