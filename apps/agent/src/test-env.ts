import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLogisticsDatabase, seedLogistics, type LogisticsScenario } from "@anc/logistics-db";

/**
 * Points this process at a freshly seeded company database and an empty runtime
 * database, with no model. Call before importing anything that opens them.
 */
export function prepareTestEnvironment(prefix: string, scenario: LogisticsScenario = "hub-fault"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  process.env.RUNTIME_DB_PATH = join(dir, "runtime.sqlite");
  process.env.LOGISTICS_DB_PATH = join(dir, "logistics.sqlite");
  process.env.MODEL_PROVIDER = "fixture";
  process.env.MODEL_EXECUTION_MODE = "fixture";
  process.env.VITEST = "true";
  const db = openLogisticsDatabase(process.env.LOGISTICS_DB_PATH);
  seedLogistics(db, scenario);
  db.close();
  return dir;
}
