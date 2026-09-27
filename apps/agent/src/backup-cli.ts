import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { snapshotSqlite } from "@anc/runtime-storage";

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runtimePath = resolve(process.env.RUNTIME_DB_PATH ?? "./data/runtime.sqlite");
const companyPath = resolve(process.env.COMPANY_DB_PATH ?? "./data/company.sqlite");
const runtimeDest = resolve(process.argv[2] ?? `./data/backups/runtime-${stamp}.sqlite`);
const companyDest = resolve(process.argv[3] ?? `./data/backups/company-${stamp}.sqlite`);

if (!existsSync(runtimePath) || !existsSync(companyPath)) {
  console.error("Runtime and company databases must both exist before a backup.");
  process.exit(1);
}
await snapshotSqlite(runtimePath, runtimeDest);
await snapshotSqlite(companyPath, companyDest);
console.log(`Backed up runtime to ${runtimeDest}`);
console.log(`Backed up company data to ${companyDest}`);
