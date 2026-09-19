import Database from 'better-sqlite3';
import { DEFAULT_COMPANY_DB_PATH, DEMO_CLOCK, DATASET_VERSION } from "./constants.js";
import { openCompanyDatabase } from "./index.js";
import { schemaSql } from './schema.js';

export type SeedScenario = 'sync-regression' | 'quiet-day' | 'unrelated-anomaly';

const DAY = 86_400_000;
const ISO = (ms: number) => new Date(ms).toISOString();
const demoMs = Date.parse(DEMO_CLOCK);

function customerId(n: number) { return `customer-${String(n).padStart(3, '0')}`; }

export function seedDatabase(db: Database.Database, scenario: SeedScenario = 'sync-regression') {
  db.transaction(() => {
    db.exec('DROP TABLE IF EXISTS service_metrics; DROP TABLE IF EXISTS feature_usage; DROP TABLE IF EXISTS support_tickets; DROP TABLE IF EXISTS invoices; DROP TABLE IF EXISTS release_rollouts; DROP TABLE IF EXISTS releases; DROP TABLE IF EXISTS customer_config_history; DROP TABLE IF EXISTS subscriptions; DROP TABLE IF EXISTS incidents; DROP TABLE IF EXISTS customers; DROP TABLE IF EXISTS dataset_meta;');
    db.exec(schemaSql);
    const insertMeta = db.prepare('INSERT INTO dataset_meta (key,value) VALUES (?,?)');
    insertMeta.run('schema_version', '1'); insertMeta.run('dataset_version', `${DATASET_VERSION}:${scenario}`); insertMeta.run('demo_clock', DEMO_CLOCK); insertMeta.run('timezone', 'UTC');

    const insertCustomer = db.prepare('INSERT INTO customers VALUES (?,?,?,?,?)');
    const insertConfig = db.prepare('INSERT INTO customer_config_history VALUES (?,?,?,?,?,?)');
    const insertSub = db.prepare('INSERT INTO subscriptions VALUES (?,?,?,?,?,?)');
    const insertInvoice = db.prepare('INSERT INTO invoices VALUES (?,?,?,?,?,?)');
    for (let i = 1; i <= 100; i++) {
      const id = customerId(i); const segment = i <= 40 ? 'enterprise' : i <= 75 ? 'mid_market' : 'startup';
      insertCustomer.run(id, `Acme ${String(i).padStart(3, '0')}`, segment, 'UTC', ISO(demoMs - 365 * DAY));
      const impacted = i >= 1 && i <= 14;
      insertConfig.run(i, id, 'sync_engine', impacted ? 'v2' : 'v1', ISO(demoMs - 45 * DAY), null);
      const arr = impacted ? 15_000_000 : segment === 'enterprise' ? (100_000 + (i % 5) * 10_000) * 100 : segment === 'mid_market' ? 5_000_000 : 2_000_000;
      insertSub.run(`sub-${id}`, id, 'active', 'annual', arr, 'USD');
      insertInvoice.run(`inv-${id}`, id, ISO(demoMs - 15 * DAY), arr, 'USD', 'paid');
    }
    const releaseId = scenario === 'unrelated-anomaly' ? 'release-2026-09-19-4' : 'release-2026-09-19-3';
    db.prepare('INSERT INTO releases VALUES (?,?,?,?,?,?)').run(releaseId, releaseId.endsWith('3') ? '2026.09.19.3' : '2026.09.19.4', scenario === 'unrelated-anomaly' ? 'billing-api' : 'sync-service', scenario === 'unrelated-anomaly' ? 'invoice-retry' : 'sync-worker', ISO(demoMs - 13 * 60 * 60 * 1000), scenario === 'unrelated-anomaly' ? 'Invoice retry tuning' : 'Synchronization worker improvements');
    db.prepare('INSERT INTO release_rollouts VALUES (?,?,?,?,?,?)').run(1, releaseId, scenario === 'unrelated-anomaly' ? 'all-customers' : 'sync-v2', ISO(demoMs - 12 * 60 * 60 * 1000), ISO(demoMs - 11 * 60 * 60 * 1000), 100);
    db.prepare('INSERT INTO incidents VALUES (?,?,?,?,?,?)').run('incident-001', ISO(demoMs - 11 * 60 * 60 * 1000), null, scenario === 'unrelated-anomaly' ? 'billing-api' : 'sync-service', 'high', 'Elevated service errors detected');

    const metric = db.prepare('INSERT INTO service_metrics VALUES (?,?,?,?,?,?,?,?)');
    const usage = db.prepare('INSERT INTO feature_usage VALUES (?,?,?,?,?)');
    const ticket = db.prepare('INSERT INTO support_tickets VALUES (?,?,?,?,?,?,?)');
    let metricId = 1, usageId = 1, ticketId = 1;
    for (let d = 0; d < 30; d++) {
      // The final bucket is one hour before the fixed demo clock. This keeps
      // the incident observable in the current 24-hour window while leaving
      // the scenario clock as the stable “morning” reference.
      const dayMs = d === 29 ? demoMs - 60 * 60 * 1000 : demoMs - (29 - d) * DAY;
      for (let i = 1; i <= 100; i++) {
        const id = customerId(i); const impacted = i <= 14; const afterRelease = d === 29;
        let requests = 1000 + ((i * 17 + d * 7) % 100); let errors = 5 + ((i + d) % 4);
        if (scenario === 'sync-regression' && impacted && afterRelease) { errors = 430 + (i % 8); }
        if (scenario === 'unrelated-anomaly' && i > 80 && afterRelease) { errors = 350 + (i % 8); }
        metric.run(metricId++, ISO(dayMs), 'sync-service', id, impacted ? 'sync-v2' : 'sync-v1', requests, errors, errors > 100 ? 'SYNC_TIMEOUT' : null);
        const usageCount = afterRelease && ((scenario === 'sync-regression' && impacted) || (scenario === 'unrelated-anomaly' && i > 80)) ? 25 : 100 + ((i + d) % 20);
        usage.run(usageId++, ISO(dayMs), id, 'synchronization', usageCount);
      }
    }
    for (let i = 1; i <= 200; i++) {
      const impacted = i <= 14; const cid = customerId(impacted ? i : ((i * 7) % 86) + 15);
      const incidentTicket = scenario === 'sync-regression' && impacted && i <= 14;
      ticket.run(`ticket-${String(ticketId).padStart(4, '0')}`, cid, ISO(demoMs - (incidentTicket ? 10 : (i % 29) + 1) * 60 * 60 * 1000), incidentTicket ? 'sync_failure' : 'general', i % 9 === 0 ? 'open' : 'closed', incidentTicket ? 'Synchronization failures after latest release' : `Question about account ${cid}`, incidentTicket ? 'Sync jobs are timing out after the latest deployment.' : 'Customer requested assistance with account settings.'); ticketId++;
    }
  })();
}

export function seedScenario(path: string, scenario: SeedScenario = 'sync-regression') {
  const db = openCompanyDatabase(path);
  try { seedDatabase(db, scenario); } finally { db.close(); }
}

if (process.argv[1]?.endsWith('seed.ts')) {
  const path = process.env.COMPANY_DB_PATH ?? DEFAULT_COMPANY_DB_PATH;
  const scenario = (process.env.SCENARIO ?? 'sync-regression') as SeedScenario;
  seedScenario(path, scenario);
  console.log(JSON.stringify({ path, scenario, datasetVersion: `${DATASET_VERSION}:${scenario}`, demoClock: DEMO_CLOCK }));
}
