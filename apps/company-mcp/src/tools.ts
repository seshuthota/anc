import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { DATASET_VERSION, DEMO_CLOCK } from '@anc/database';
import { assertToolAllowed, redactForPrincipal, resolvePrincipal } from '@anc/policy';

const iso = z.string().datetime({ offset: true });
const windowSchema = z.object({ from: iso, to: iso }).refine(v => Date.parse(v.from) < Date.parse(v.to), 'from must be before to');
const pageSchema = z.object({ limit: z.number().int().min(1).max(100).default(25), offset: z.number().int().min(0).max(10000).default(0) });
const source = 'company.sqlite';

export type EvidenceEnvelope = {
  evidenceId: string; tool: string; toolVersion: string; source: string;
  arguments: unknown; appliedFilters: unknown; observationWindow?: unknown;
  aggregationGrain?: string; timezone: string; dataAsOf: string; retrievedAt: string;
  datasetVersion: string; units?: string; currency?: string; result: unknown;
  completeness: { complete: boolean; limit?: number; offset?: number; total?: number };
  payloadHash: string;
};

function envelope(tool: string, args: unknown, result: unknown, filters: unknown, extra: Partial<EvidenceEnvelope> = {}): EvidenceEnvelope {
  const payloadHash = createHash('sha256').update(JSON.stringify(result)).digest('hex');
  return { evidenceId: `${tool}-${payloadHash.slice(0, 16)}`, tool, toolVersion: '1.0.0', source, arguments: args, appliedFilters: filters, timezone: 'UTC', dataAsOf: DEMO_CLOCK, retrievedAt: new Date().toISOString(), datasetVersion: process.env.DATASET_VERSION ?? DATASET_VERSION, result, completeness: { complete: true }, payloadHash, ...extra };
}

export function asMcpResult(evidence: EvidenceEnvelope) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(evidence) }], structuredContent: evidence };
}

export function registerCompanyTools(server: any, db: Database.Database) {
  const run = (tool: string, args: unknown, result: unknown, filters: unknown, extra?: Partial<EvidenceEnvelope>) => {
    const principal = resolvePrincipal(process.env.ANC_PRINCIPAL_ID);
    assertToolAllowed(principal, tool);
    return asMcpResult(redactForPrincipal(principal, envelope(tool, args, result, filters, extra)));
  };

  server.registerTool('get_service_health', { description: 'Read weighted service health metrics for a service and time window.', inputSchema: z.object({ service: z.string().default('sync-service'), window: windowSchema }) }, (args: any) => {
    const rows = db.prepare(`SELECT service, SUM(requests) requests, SUM(errors) errors, ROUND(CAST(SUM(errors) AS REAL)/NULLIF(SUM(requests),0), 6) errorRate FROM service_metrics WHERE service = ? AND bucket >= ? AND bucket < ? GROUP BY service`).all(args.service, args.window.from, args.window.to);
    return run('get_service_health', args, { rows }, args.window, { observationWindow: args.window, aggregationGrain: 'requested window' });
  });
  server.registerTool('get_error_metrics', { description: 'Aggregate errors by signature, cohort, and customer for a time window.', inputSchema: z.object({ service: z.string().default('sync-service'), window: windowSchema, cohort: z.string().optional() }) }, (args: any) => {
    const rows = db.prepare(`SELECT error_signature signature, cohort, SUM(requests) requests, SUM(errors) errors, ROUND(CAST(SUM(errors) AS REAL)/NULLIF(SUM(requests),0), 6) errorRate, COUNT(DISTINCT customer_id) customers FROM service_metrics WHERE service = ? AND bucket >= ? AND bucket < ? AND (? IS NULL OR cohort = ?) GROUP BY error_signature, cohort ORDER BY errors DESC`).all(args.service, args.window.from, args.window.to, args.cohort ?? null, args.cohort ?? null);
    return run('get_error_metrics', args, { rows }, { ...args.window, cohort: args.cohort }, { observationWindow: args.window, aggregationGrain: 'signature/cohort' });
  });
  server.registerTool('get_recent_releases', { description: 'List releases deployed in a time window.', inputSchema: z.object({ window: windowSchema, service: z.string().optional() }) }, (args: any) => {
    const rows = db.prepare(`SELECT * FROM releases WHERE deployed_at >= ? AND deployed_at < ? AND (? IS NULL OR service = ?) ORDER BY deployed_at DESC`).all(args.window.from, args.window.to, args.service ?? null, args.service ?? null);
    return run('get_recent_releases', args, { rows }, args.window, { observationWindow: args.window });
  });
  server.registerTool('get_release_details', { description: 'Read a release and its rollout cohorts.', inputSchema: z.object({ releaseId: z.string().min(1) }) }, (args: any) => {
    const release = db.prepare('SELECT * FROM releases WHERE id = ?').get(args.releaseId); if (!release) throw new Error(`Unknown release: ${args.releaseId}`);
    const rollouts = db.prepare('SELECT * FROM release_rollouts WHERE release_id = ? ORDER BY started_at').all(args.releaseId);
    return run('get_release_details', args, { release, rollouts }, { releaseId: args.releaseId });
  });
  server.registerTool('list_impacted_customers', { description: 'List customers whose weighted error rate exceeds a threshold in a window.', inputSchema: z.object({ service: z.string().default('sync-service'), window: windowSchema, cohort: z.string().optional(), minErrorRate: z.number().min(0).max(1).default(0.05) }) }, (args: any) => {
    const rows = db.prepare(`SELECT customer_id customerId, SUM(requests) requests, SUM(errors) errors, ROUND(CAST(SUM(errors) AS REAL)/NULLIF(SUM(requests),0), 6) errorRate FROM service_metrics WHERE service = ? AND bucket >= ? AND bucket < ? AND (? IS NULL OR cohort = ?) GROUP BY customer_id HAVING errorRate >= ? ORDER BY errors DESC`).all(args.service, args.window.from, args.window.to, args.cohort ?? null, args.cohort ?? null, args.minErrorRate);
    return run('list_impacted_customers', args, { rows, customerIds: (rows as any[]).map((row) => row.customerId) }, { ...args.window, cohort: args.cohort, minErrorRate: args.minErrorRate }, { observationWindow: args.window, aggregationGrain: 'customer' });
  });
  server.registerTool('get_feature_usage', { description: 'Aggregate feature usage by day and cohort/customer.', inputSchema: z.object({ feature: z.string().default('synchronization'), window: windowSchema, customerIds: z.array(z.string()).max(100).optional() }) }, (args: any) => {
    const ids = args.customerIds ?? []; const placeholders = ids.map(() => '?').join(',');
    const sql = `SELECT bucket, SUM(usage_count) usageCount, COUNT(DISTINCT customer_id) customers FROM feature_usage WHERE feature = ? AND bucket >= ? AND bucket < ? ${ids.length ? `AND customer_id IN (${placeholders})` : ''} GROUP BY bucket ORDER BY bucket`;
    const rows = db.prepare(sql).all(args.feature, args.window.from, args.window.to, ...ids);
    return run('get_feature_usage', args, { rows }, args.window, { observationWindow: args.window, aggregationGrain: 'day' });
  });
  server.registerTool('compare_usage_periods', { description: 'Compare equal length feature usage periods using aggregate counts.', inputSchema: z.object({ feature: z.string().default('synchronization'), current: windowSchema, baseline: windowSchema, customerIds: z.array(z.string()).max(100).optional() }) }, (args: any) => {
    const ids = args.customerIds ?? []; const filter = ids.length ? `AND customer_id IN (${ids.map(() => '?').join(',')})` : ''; const q = `SELECT COALESCE(SUM(usage_count),0) usageCount, COUNT(DISTINCT customer_id) customers FROM feature_usage WHERE feature = ? AND bucket >= ? AND bucket < ? ${filter}`;
    const current = db.prepare(q).get(args.feature, args.current.from, args.current.to, ...ids); const baseline = db.prepare(q).get(args.feature, args.baseline.from, args.baseline.to, ...ids);
    return run('compare_usage_periods', args, { current, baseline }, { current: args.current, baseline: args.baseline }, { observationWindow: { current: args.current, baseline: args.baseline }, aggregationGrain: 'period' });
  });
  server.registerTool('get_customer_feature_usage', { description: 'Read feature usage for one customer.', inputSchema: z.object({ customerId: z.string().min(1), feature: z.string().default('synchronization'), window: windowSchema }) }, (args: any) => {
    if (!db.prepare('SELECT 1 FROM customers WHERE id = ?').get(args.customerId)) throw new Error(`Unknown customer: ${args.customerId}`);
    const rows = db.prepare('SELECT bucket, usage_count usageCount FROM feature_usage WHERE customer_id = ? AND feature = ? AND bucket >= ? AND bucket < ? ORDER BY bucket').all(args.customerId, args.feature, args.window.from, args.window.to);
    return run('get_customer_feature_usage', args, { rows }, { customerId: args.customerId, ...args.window }, { observationWindow: args.window, aggregationGrain: 'day' });
  });
  server.registerTool('search_customers', { description: 'Search customers by name, segment, and pagination.', inputSchema: z.object({ query: z.string().max(100).optional(), segment: z.enum(['enterprise', 'mid_market', 'startup']).optional(), page: pageSchema.optional() }) }, (args: any) => {
    const page = args.page ?? { limit: 25, offset: 0 }; const pattern = args.query ? `%${args.query}%` : '%'; const rows = db.prepare(`SELECT id,name,segment,timezone FROM customers WHERE name LIKE ? AND (? IS NULL OR segment = ?) ORDER BY id LIMIT ? OFFSET ?`).all(pattern, args.segment ?? null, args.segment ?? null, page.limit, page.offset); const total = (db.prepare('SELECT COUNT(*) total FROM customers WHERE name LIKE ? AND (? IS NULL OR segment = ?)').get(pattern, args.segment ?? null, args.segment ?? null) as any).total;
    return run('search_customers', args, { rows, page: { ...page, total } }, { query: args.query, segment: args.segment }, { completeness: { complete: page.offset + rows.length >= total, limit: page.limit, offset: page.offset, total } });
  });
  server.registerTool('get_customer', { description: 'Read customer identity, configuration history, and subscription.', inputSchema: z.object({ customerId: z.string().min(1) }) }, (args: any) => {
    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(args.customerId); if (!customer) throw new Error(`Unknown customer: ${args.customerId}`);
    const config = db.prepare('SELECT * FROM customer_config_history WHERE customer_id = ? ORDER BY effective_from').all(args.customerId); const subscription = db.prepare('SELECT * FROM subscriptions WHERE customer_id = ?').get(args.customerId);
    return run('get_customer', args, { customer, config, subscription }, { customerId: args.customerId }, { currency: 'USD' });
  });
  server.registerTool('search_support_tickets', { description: 'Search support tickets with bounded pagination.', inputSchema: z.object({ customerId: z.string().optional(), category: z.string().optional(), window: windowSchema.optional(), page: pageSchema.optional() }) }, (args: any) => {
    const page = args.page ?? { limit: 25, offset: 0 }; const rows = db.prepare(`SELECT * FROM support_tickets WHERE (? IS NULL OR customer_id = ?) AND (? IS NULL OR category = ?) AND (? IS NULL OR created_at >= ?) AND (? IS NULL OR created_at < ?) ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(args.customerId ?? null, args.customerId ?? null, args.category ?? null, args.category ?? null, args.window?.from ?? null, args.window?.from ?? null, args.window?.to ?? null, args.window?.to ?? null, page.limit, page.offset);
    return run('search_support_tickets', args, { rows, page }, { customerId: args.customerId, category: args.category, window: args.window }, { observationWindow: args.window, completeness: { complete: rows.length < page.limit, limit: page.limit, offset: page.offset } });
  });
  server.registerTool('get_customer_support_history', { description: 'Read support history for one customer.', inputSchema: z.object({ customerId: z.string().min(1), window: windowSchema.optional() }) }, (args: any) => {
    if (!db.prepare('SELECT 1 FROM customers WHERE id = ?').get(args.customerId)) throw new Error(`Unknown customer: ${args.customerId}`);
    const rows = db.prepare('SELECT * FROM support_tickets WHERE customer_id = ? AND (? IS NULL OR created_at >= ?) AND (? IS NULL OR created_at < ?) ORDER BY created_at DESC').all(args.customerId, args.window?.from ?? null, args.window?.from ?? null, args.window?.to ?? null, args.window?.to ?? null);
    return run('get_customer_support_history', args, { rows }, { customerId: args.customerId, window: args.window }, { observationWindow: args.window });
  });
  server.registerTool('calculate_account_exposure', { description: 'Sum ARR once per validated affected customer ID.', inputSchema: z.object({ customerIds: z.array(z.string()).min(1).max(100), definition: z.string().min(1).max(300) }) }, (args: any) => {
    const unique = [...new Set(args.customerIds)]; const rows = db.prepare(`SELECT customer_id customerId, arr_minor_units arrMinorUnits, currency FROM subscriptions WHERE status = 'active' AND customer_id IN (${unique.map(() => '?').join(',')})`).all(...unique) as any[];
    return run('calculate_account_exposure', args, { definition: args.definition, affectedAccounts: rows.length, arrMinorUnits: rows.reduce((sum, row) => sum + row.arrMinorUnits, 0), currency: 'USD', missingCustomerIds: unique.filter(id => !rows.some(row => row.customerId === id)) }, { customerIds: unique, definition: args.definition }, { currency: 'USD', units: 'minor currency units' });
  });
  server.registerTool('get_subscription', { description: 'Read the active subscription for one customer.', inputSchema: z.object({ customerId: z.string().min(1) }) }, (args: any) => {
    const row = db.prepare('SELECT * FROM subscriptions WHERE customer_id = ? AND status = ?').get(args.customerId, 'active'); if (!row) throw new Error(`No active subscription for: ${args.customerId}`); return run('get_subscription', args, row, { customerId: args.customerId }, { currency: 'USD', units: 'minor currency units' });
  });
  server.registerTool('list_open_incidents', { description: 'List currently open incidents.', inputSchema: z.object({ service: z.string().optional() }) }, (args: any) => {
    const rows = db.prepare(`SELECT id, started_at startedAt, ended_at endedAt, service, severity, summary FROM incidents WHERE ended_at IS NULL AND (? IS NULL OR service = ?) ORDER BY started_at DESC`).all(args.service ?? null, args.service ?? null);
    return run('list_open_incidents', args, { rows }, { service: args.service });
  });
  server.registerTool('list_maintenance_windows', { description: 'List maintenance windows that have not ended.', inputSchema: z.object({ service: z.string().optional() }) }, (args: any) => {
    const rows = db.prepare(`SELECT id, service, starts_at startsAt, ends_at endsAt, summary FROM maintenance_windows WHERE ends_at IS NULL AND (? IS NULL OR service = ?) ORDER BY starts_at DESC`).all(args.service ?? null, args.service ?? null);
    return run('list_maintenance_windows', args, { rows }, { service: args.service });
  });
  server.registerTool('list_invoice_aging', { description: 'List overdue or open invoices with deterministic aging buckets.', inputSchema: z.object({ asOf: iso.optional(), customerIds: z.array(z.string()).max(100).optional() }) }, (args: any) => {
    const asOf = args.asOf ?? DEMO_CLOCK;
    const ids = args.customerIds ?? [];
    const filter = ids.length ? `AND customer_id IN (${ids.map(() => '?').join(',')})` : '';
    const rows = db.prepare(`SELECT id, customer_id customerId, issued_at issuedAt, amount_minor_units amountMinorUnits, currency, status,
      CAST(julianday(?) - julianday(issued_at) AS INTEGER) daysOutstanding
      FROM invoices WHERE status IN ('open','overdue') ${filter} ORDER BY daysOutstanding DESC`).all(asOf, ...ids) as any[];
    const totals = rows.reduce((sum, row) => sum + Number(row.amountMinorUnits ?? 0), 0);
    return run('list_invoice_aging', args, { asOf, rows, totals: { amountMinorUnits: totals, currency: 'USD', count: rows.length } }, { asOf, customerIds: ids }, { currency: 'USD', units: 'minor currency units' });
  });
  server.registerTool('list_unassigned_escalations', { description: 'List open unassigned support tickets.', inputSchema: z.object({ category: z.string().optional(), page: pageSchema.optional() }) }, (args: any) => {
    const page = args.page ?? { limit: 25, offset: 0 };
    const rows = db.prepare(`SELECT id, customer_id customerId, created_at createdAt, category, status, subject, assignee_id assigneeId, version
      FROM support_tickets WHERE status = 'open' AND assignee_id IS NULL AND (? IS NULL OR category = ?)
      ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(args.category ?? null, args.category ?? null, page.limit, page.offset);
    return run('list_unassigned_escalations', args, { rows, page }, { category: args.category });
  });
  server.registerTool('list_eligible_assignees', { description: 'List employees eligible to own a support ticket.', inputSchema: z.object({ team: z.string().default('support') }) }, (args: any) => {
    const rows = db.prepare('SELECT id, name, team, title FROM employees WHERE team = ? ORDER BY name').all(args.team);
    return run('list_eligible_assignees', args, { rows }, { team: args.team });
  });
  server.registerTool('commit_ticket_assignment', { description: 'Assign an open ticket to an eligible owner using an expected version.', inputSchema: z.object({ ticketId: z.string().min(1), assigneeId: z.string().min(1), expectedVersion: z.number().int().positive() }) }, (args: any) => {
    const ticket = db.prepare('SELECT * FROM support_tickets WHERE id = ?').get(args.ticketId) as { id: string; version: number; assignee_id: string | null } | undefined;
    if (!ticket) throw new Error(`Unknown ticket: ${args.ticketId}`);
    const owner = db.prepare('SELECT id FROM employees WHERE id = ? AND team = ?').get(args.assigneeId, 'support');
    if (!owner) throw new Error(`Assignee ${args.assigneeId} is not eligible`);
    const now = new Date().toISOString();
    const result = db.prepare('UPDATE support_tickets SET assignee_id = ?, version = version + 1, updated_at = ?, status = ? WHERE id = ? AND version = ?')
      .run(args.assigneeId, now, 'open', args.ticketId, args.expectedVersion);
    if (!result.changes) throw new Error('Ticket version is stale');
    const updated = db.prepare('SELECT id, customer_id customerId, assignee_id assigneeId, version, status, updated_at updatedAt FROM support_tickets WHERE id = ?').get(args.ticketId);
    return run('commit_ticket_assignment', args, { before: ticket, after: updated }, args);
  });
}
