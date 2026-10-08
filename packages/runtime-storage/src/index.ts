import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { RUNTIME_SCHEMA_VERSION, runtimeSchemaSql } from "./schema.js";

export { RUNTIME_SCHEMA_VERSION, runtimeSchemaSql } from "./schema.js";

export const DEFAULT_RUNTIME_DB_PATH = fileURLToPath(new URL("../../../data/runtime.sqlite", import.meta.url));

export type RuntimeDatabase = Database.Database;

export function openRuntimeDatabase(path = process.env.RUNTIME_DB_PATH ?? DEFAULT_RUNTIME_DB_PATH): RuntimeDatabase {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(runtimeSchemaSql);
  migrateRuntime(db);
  db.prepare("INSERT OR REPLACE INTO runtime_meta (key, value) VALUES (?, ?)").run("schema_version", String(RUNTIME_SCHEMA_VERSION));
  return db;
}

function hasColumn(db: RuntimeDatabase, table: string, column: string) {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((row) => row.name === column);
}

function migrateRuntime(db: RuntimeDatabase) {
  if (!hasColumn(db, "thread_state", "owner_id")) db.exec("ALTER TABLE thread_state ADD COLUMN owner_id TEXT");
  if (!hasColumn(db, "thread_state", "organization_id")) db.exec("ALTER TABLE thread_state ADD COLUMN organization_id TEXT");
  if (!hasColumn(db, "evidence", "owner_id")) db.exec("ALTER TABLE evidence ADD COLUMN owner_id TEXT");
  if (!hasColumn(db, "surfaces", "owner_id")) db.exec("ALTER TABLE surfaces ADD COLUMN owner_id TEXT");
  if (!hasColumn(db, "activity", "owner_id")) db.exec("ALTER TABLE activity ADD COLUMN owner_id TEXT");
  if (!hasColumn(db, "surfaces", "required_grants")) db.exec("ALTER TABLE surfaces ADD COLUMN required_grants TEXT NOT NULL DEFAULT '[]'");
  db.prepare("UPDATE thread_state SET owner_id = COALESCE(owner_id, ?), organization_id = COALESCE(organization_id, ?)").run("user-coo", "org-democo");
  db.prepare("UPDATE evidence SET owner_id = COALESCE(owner_id, ?)").run("user-coo");
  db.prepare("UPDATE surfaces SET owner_id = COALESCE(owner_id, ?)").run("user-coo");
  db.prepare("UPDATE activity SET owner_id = COALESCE(owner_id, ?)").run("user-coo");
}

export type ActivityKind = "agent_started" | "agent_completed" | "tool_queried" | "finding_discovered" | "task_delegated" | "investigation_completed" | "status" | "action";

export class RuntimeStore {
  constructor(private readonly db: RuntimeDatabase) {}

  upsertInvestigation(input: { id: string; threadId: string; objective: string; status: string; now: string }) {
    this.db.prepare(
      `INSERT INTO investigations (id, thread_id, objective, status, created_at, updated_at)
       VALUES (@id, @threadId, @objective, @status, @now, @now)
       ON CONFLICT(id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at, objective = excluded.objective`,
    ).run(input);
  }

  insertRun(input: { id: string; investigationId: string; threadId: string; status: string; now: string }) {
    this.db.prepare(
      `INSERT INTO runs (id, investigation_id, thread_id, status, cancelled, created_at)
       VALUES (@id, @investigationId, @threadId, @status, 0, @now)`,
    ).run(input);
  }

  updateRun(id: string, patch: { status?: string; cancelled?: boolean; finishedAt?: string }) {
    const current = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as { status: string; cancelled: number; finished_at: string | null } | undefined;
    if (!current) return;
    this.db.prepare("UPDATE runs SET status = ?, cancelled = ?, finished_at = ? WHERE id = ?").run(
      patch.status ?? current.status,
      patch.cancelled === undefined ? current.cancelled : Number(patch.cancelled),
      patch.finishedAt ?? current.finished_at,
      id,
    );
  }

  isRunCancelled(runId: string): boolean {
    const row = this.db.prepare("SELECT cancelled FROM runs WHERE id = ?").get(runId) as { cancelled: number } | undefined;
    return Boolean(row?.cancelled);
  }

  getRun(id: string) {
    const row = this.db.prepare("SELECT id, investigation_id, thread_id, status, cancelled, finished_at FROM runs WHERE id = ?").get(id) as
      | { id: string; investigation_id: string; thread_id: string; status: string; cancelled: number; finished_at: string | null }
      | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      investigationId: row.investigation_id,
      threadId: row.thread_id,
      status: row.status,
      cancelled: Boolean(row.cancelled),
      finishedAt: row.finished_at,
    };
  }

  upsertTask(input: { id: string; runId: string; investigationId: string; domain: string; question: string; status: string; payload: unknown; result?: unknown; now: string }) {
    this.db.prepare(
      `INSERT INTO tasks (id, run_id, investigation_id, domain, question, status, payload, result, created_at, updated_at)
       VALUES (@id, @runId, @investigationId, @domain, @question, @status, @payload, @result, @now, @now)
       ON CONFLICT(id) DO UPDATE SET status = excluded.status, result = excluded.result, updated_at = excluded.updated_at`,
    ).run({
      ...input,
      payload: JSON.stringify(input.payload),
      result: input.result === undefined ? null : JSON.stringify(input.result),
    });
  }

  saveEvidence(input: { evidenceId: string; runId: string; taskId?: string; tool: string; payload: unknown; payloadHash: string; now: string; ownerId?: string }) {
    this.db.prepare(
      `INSERT OR IGNORE INTO evidence (evidence_id, run_id, task_id, tool, payload, payload_hash, created_at, owner_id)
       VALUES (@evidenceId, @runId, @taskId, @tool, @payload, @payloadHash, @now, @ownerId)`,
    ).run({ ...input, taskId: input.taskId ?? null, ownerId: input.ownerId ?? "user-coo", payload: JSON.stringify(input.payload) });
  }

  getEvidence(evidenceId: string, ownerId?: string): Record<string, unknown> | undefined {
    const row = (ownerId
      ? this.db.prepare("SELECT payload, owner_id FROM evidence WHERE evidence_id = ? AND owner_id = ?").get(evidenceId, ownerId)
      : this.db.prepare("SELECT payload, owner_id FROM evidence WHERE evidence_id = ?").get(evidenceId)
    ) as { payload: string; owner_id?: string } | undefined;
    return row ? JSON.parse(row.payload) as Record<string, unknown> : undefined;
  }

  findEvidenceByToolArgs(tool: string, args: unknown, runId?: string): Record<string, unknown> | undefined {
    const rows = (runId
      ? this.db.prepare("SELECT payload FROM evidence WHERE tool = ? AND run_id = ? ORDER BY created_at DESC LIMIT 50").all(tool, runId)
      : this.db.prepare("SELECT payload FROM evidence WHERE tool = ? ORDER BY created_at DESC LIMIT 50").all(tool)
    ) as Array<{ payload: string }>;
    const wanted = JSON.stringify(args);
    for (const row of rows) {
      const payload = JSON.parse(row.payload) as Record<string, unknown>;
      if (JSON.stringify(payload.arguments ?? payload.appliedFilters) === wanted || JSON.stringify(payload.arguments) === wanted) {
        return payload;
      }
    }
    return undefined;
  }

  evidenceExists(evidenceId: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM evidence WHERE evidence_id = ?").get(evidenceId));
  }

  saveFinding(input: { findingId: string; runId: string; taskId: string; payload: unknown; now: string }) {
    this.db.prepare(
      `INSERT OR REPLACE INTO findings (finding_id, run_id, task_id, payload, created_at)
       VALUES (@findingId, @runId, @taskId, @payload, @now)`,
    ).run({ ...input, payload: JSON.stringify(input.payload) });
  }

  listFindings(runId: string): unknown[] {
    return this.db.prepare("SELECT payload FROM findings WHERE run_id = ?").all(runId).map((row) => JSON.parse((row as { payload: string }).payload));
  }

  appendActivity(input: { id: string; threadId: string; runId?: string; message: string; kind: ActivityKind; payload?: unknown; now: string; ownerId?: string }) {
    this.db.prepare(
      `INSERT INTO activity (id, thread_id, run_id, message, kind, payload, created_at, owner_id)
       VALUES (@id, @threadId, @runId, @message, @kind, @payload, @now, @ownerId)`,
    ).run({
      ...input,
      runId: input.runId ?? null,
      ownerId: input.ownerId ?? "user-coo",
      payload: input.payload === undefined ? null : JSON.stringify(input.payload),
    });
  }

  listActivity(threadId: string, limit = 80): Array<{ id: string; message: string; kind: string; createdAt: string; payload?: unknown }> {
    const rows = this.db.prepare("SELECT id, message, kind, payload, created_at FROM activity WHERE thread_id = ? ORDER BY created_at DESC LIMIT ?").all(threadId, limit) as Array<{
      id: string; message: string; kind: string; payload: string | null; created_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      message: row.message,
      kind: row.kind,
      createdAt: row.created_at,
      payload: row.payload ? JSON.parse(row.payload) : undefined,
    }));
  }

  saveSurface(input: {
    surfaceId: string;
    revision: number;
    threadId: string;
    investigationId: string;
    runId?: string;
    ownerId?: string;
    requiredGrants?: string[];
    title: string;
    messages: unknown;
    dataModel: unknown;
    findingIds: string[];
    now: string;
  }) {
    this.db.prepare(
      `INSERT OR REPLACE INTO surfaces (surface_id, revision, thread_id, investigation_id, run_id, title, messages, data_model, finding_ids, created_at, owner_id, required_grants)
       VALUES (@surfaceId, @revision, @threadId, @investigationId, @runId, @title, @messages, @dataModel, @findingIds, @now, @ownerId, @requiredGrants)`,
    ).run({
      ...input,
      runId: input.runId ?? null,
      ownerId: input.ownerId ?? "user-coo",
      requiredGrants: JSON.stringify(input.requiredGrants ?? []),
      messages: JSON.stringify(input.messages),
      dataModel: JSON.stringify(input.dataModel),
      findingIds: JSON.stringify(input.findingIds),
    });
  }

  getSurface(surfaceId: string, revision: number) {
    const row = this.db.prepare("SELECT * FROM surfaces WHERE surface_id = ? AND revision = ?").get(surfaceId, revision) as
      | { surface_id: string; revision: number; title: string; messages: string; data_model: string; finding_ids: string; thread_id: string; investigation_id: string; required_grants?: string | null }
      | undefined;
    if (!row) return undefined;
    return {
      surfaceId: row.surface_id,
      revision: row.revision,
      title: row.title,
      messages: JSON.parse(row.messages),
      dataModel: JSON.parse(row.data_model),
      findingIds: JSON.parse(row.finding_ids) as string[],
      requiredGrants: JSON.parse(row.required_grants || "[]") as string[],
      threadId: row.thread_id,
      investigationId: row.investigation_id,
    };
  }

  listSurfaces(threadId: string) {
    return (this.db.prepare("SELECT surface_id, revision, title, created_at FROM surfaces WHERE thread_id = ? ORDER BY created_at DESC").all(threadId) as Array<{
      surface_id: string; revision: number; title: string; created_at: string;
    }>).map((row) => ({ surfaceId: row.surface_id, revision: row.revision, title: row.title, createdAt: row.created_at }));
  }

  rememberAction(actionId: string, threadId: string, now: string): boolean {
    const result = this.db.prepare("INSERT OR IGNORE INTO handled_actions (action_id, thread_id, created_at) VALUES (?, ?, ?)").run(actionId, threadId, now);
    return result.changes > 0;
  }

  setThreadState(input: {
    threadId: string;
    investigationId?: string;
    activeRunId?: string | null;
    activeSurfaceId?: string | null;
    activeSurfaceRevision?: number | null;
    selectedEntities?: unknown;
    status: string;
    now: string;
    ownerId?: string | null;
    organizationId?: string | null;
  }) {
    const current = this.getThreadState(input.threadId);
    this.db.prepare(
      `INSERT INTO thread_state (thread_id, investigation_id, active_run_id, active_surface_id, active_surface_revision, selected_entities, status, updated_at, owner_id, organization_id)
       VALUES (@threadId, @investigationId, @activeRunId, @activeSurfaceId, @activeSurfaceRevision, @selectedEntities, @status, @now, @ownerId, @organizationId)
       ON CONFLICT(thread_id) DO UPDATE SET
         investigation_id = excluded.investigation_id,
         active_run_id = excluded.active_run_id,
         active_surface_id = excluded.active_surface_id,
         active_surface_revision = excluded.active_surface_revision,
         selected_entities = excluded.selected_entities,
         status = excluded.status,
         updated_at = excluded.updated_at,
         owner_id = excluded.owner_id,
         organization_id = excluded.organization_id`,
    ).run({
      threadId: input.threadId,
      investigationId: input.investigationId ?? current?.investigationId ?? null,
      activeRunId: input.activeRunId === undefined ? current?.activeRunId ?? null : input.activeRunId,
      activeSurfaceId: input.activeSurfaceId === undefined ? current?.activeSurfaceId ?? null : input.activeSurfaceId,
      activeSurfaceRevision: input.activeSurfaceRevision === undefined ? current?.activeSurfaceRevision ?? null : input.activeSurfaceRevision,
      selectedEntities: JSON.stringify(input.selectedEntities ?? current?.selectedEntities ?? []),
      status: input.status,
      now: input.now,
      ownerId: input.ownerId === undefined ? current?.ownerId ?? "user-coo" : input.ownerId,
      organizationId: input.organizationId === undefined ? current?.organizationId ?? "org-democo" : input.organizationId,
    });
  }

  getThreadState(threadId: string) {
    const row = this.db.prepare("SELECT * FROM thread_state WHERE thread_id = ?").get(threadId) as
      | {
          thread_id: string;
          investigation_id: string | null;
          active_run_id: string | null;
          active_surface_id: string | null;
          active_surface_revision: number | null;
          selected_entities: string;
          status: string;
          owner_id: string | null;
          organization_id: string | null;
        }
      | undefined;
    if (!row) return undefined;
    return {
      threadId: row.thread_id,
      investigationId: row.investigation_id,
      activeRunId: row.active_run_id,
      activeSurfaceId: row.active_surface_id,
      activeSurfaceRevision: row.active_surface_revision,
      selectedEntities: JSON.parse(row.selected_entities) as unknown[],
      status: row.status,
      ownerId: row.owner_id,
      organizationId: row.organization_id,
    };
  }

  assertThreadOwner(threadId: string, ownerId: string) {
    const thread = this.getThreadState(threadId);
    if (thread && thread.ownerId && thread.ownerId !== ownerId) {
      throw new Error("not authorized for this session");
    }
  }

  saveArtifact(input: { id: string; threadId: string; runId?: string; ownerId: string; kind: string; payload: unknown; now: string }) {
    this.db.prepare(
      `INSERT OR REPLACE INTO artifacts (id, thread_id, run_id, owner_id, kind, payload, created_at)
       VALUES (@id, @threadId, @runId, @ownerId, @kind, @payload, @now)`,
    ).run({ ...input, runId: input.runId ?? null, payload: JSON.stringify(input.payload) });
  }

  claimArtifacts(runId: string, threadId: string, ownerId: string) {
    this.db.prepare("UPDATE artifacts SET thread_id = ?, owner_id = ? WHERE run_id = ?").run(threadId, ownerId, runId);
  }

  listArtifacts(threadId: string, ownerId: string) {
    return (this.db.prepare("SELECT * FROM artifacts WHERE thread_id = ? AND owner_id = ? ORDER BY created_at DESC").all(threadId, ownerId) as Array<{
      id: string; kind: string; payload: string; run_id: string | null;
    }>).map((row) => ({ id: row.id, kind: row.kind, payload: JSON.parse(row.payload), runId: row.run_id }));
  }

  saveProposal(input: { id: string; threadId: string; ownerId: string; capability: string; revision: number; payload: unknown; expiresAt: string; status: string; now: string }) {
    this.db.prepare(
      `INSERT OR REPLACE INTO action_proposals (id, thread_id, owner_id, capability, revision, payload, expires_at, status, created_at)
       VALUES (@id, @threadId, @ownerId, @capability, @revision, @payload, @expiresAt, @status, @now)`,
    ).run({ ...input, payload: JSON.stringify(input.payload) });
  }

  getProposal(id: string, ownerId: string) {
    const row = this.db.prepare("SELECT * FROM action_proposals WHERE id = ? AND owner_id = ?").get(id, ownerId) as
      | { id: string; thread_id: string; capability: string; revision: number; payload: string; expires_at: string; status: string }
      | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      threadId: row.thread_id,
      capability: row.capability,
      revision: row.revision,
      payload: JSON.parse(row.payload) as Record<string, unknown>,
      expiresAt: row.expires_at,
      status: row.status,
    };
  }

  saveOperation(input: { id: string; idempotencyKey: string; ownerId: string; capability: string; proposalId?: string; status: string; payload: unknown; now: string }) {
    this.db.prepare(
      `INSERT INTO operations (id, idempotency_key, owner_id, capability, proposal_id, status, payload, created_at, updated_at)
       VALUES (@id, @idempotencyKey, @ownerId, @capability, @proposalId, @status, @payload, @now, @now)
       ON CONFLICT(idempotency_key) DO UPDATE SET status = excluded.status, payload = excluded.payload, updated_at = excluded.updated_at`,
    ).run({ ...input, proposalId: input.proposalId ?? null, payload: JSON.stringify(input.payload) });
  }

  getOperationByKey(idempotencyKey: string, ownerId: string) {
    const row = this.db.prepare("SELECT * FROM operations WHERE idempotency_key = ? AND owner_id = ?").get(idempotencyKey, ownerId) as
      | { id: string; status: string; payload: string }
      | undefined;
    if (!row) return undefined;
    return { id: row.id, status: row.status, payload: JSON.parse(row.payload) as Record<string, unknown> };
  }

  /** The tool an evidence record came from, whoever owns it; used to check the capability before ownership. */
  getEvidenceTool(evidenceId: string): string | undefined {
    const row = this.db.prepare("SELECT tool FROM evidence WHERE evidence_id = ?").get(evidenceId) as { tool: string } | undefined;
    return row?.tool;
  }

  getEvidenceRecord(evidenceId: string, ownerId: string): { tool: string; payload: Record<string, unknown> } | undefined {
    const row = this.db.prepare("SELECT tool, payload FROM evidence WHERE evidence_id = ? AND owner_id = ?").get(evidenceId, ownerId) as
      | { tool: string; payload: string }
      | undefined;
    return row ? { tool: row.tool, payload: JSON.parse(row.payload) as Record<string, unknown> } : undefined;
  }

  appendAudit(input: { id: string; organizationId: string; actorId?: string | null; action: string; resource?: string | null; outcome: string; detail?: string | null; now: string }) {
    this.db.prepare(
      `INSERT INTO audit_events (id, organization_id, actor_id, action, resource, outcome, detail, created_at)
       VALUES (@id, @organizationId, @actorId, @action, @resource, @outcome, @detail, @now)`,
    ).run({
      id: input.id,
      organizationId: input.organizationId,
      actorId: input.actorId ?? null,
      action: input.action,
      resource: input.resource ?? null,
      outcome: input.outcome,
      detail: input.detail ?? null,
      now: input.now,
    });
  }

  listAudit(actorId?: string) {
    const rows = (actorId
      ? this.db.prepare("SELECT * FROM audit_events WHERE actor_id = ? ORDER BY created_at DESC LIMIT 200").all(actorId)
      : this.db.prepare("SELECT * FROM audit_events ORDER BY created_at DESC LIMIT 200").all()
    ) as Array<{ id: string; actor_id: string | null; action: string; resource: string | null; outcome: string; detail: string | null; created_at: string }>;
    return rows.map((row) => ({
      id: row.id,
      actorId: row.actor_id,
      action: row.action,
      resource: row.resource,
      outcome: row.outcome,
      detail: row.detail,
      createdAt: row.created_at,
    }));
  }

  revokeGrant(principalId: string, capability: string, now: string) {
    this.db.prepare(
      `INSERT INTO grant_revocations (principal_id, capability, revoked_at) VALUES (?, ?, ?)
       ON CONFLICT(principal_id, capability) DO UPDATE SET revoked_at = excluded.revoked_at`,
    ).run(principalId, capability, now);
  }

  listRevocations(principalId: string): string[] {
    return (this.db.prepare("SELECT capability FROM grant_revocations WHERE principal_id = ?").all(principalId) as Array<{ capability: string }>)
      .map((row) => row.capability);
  }

  purgeOlderThan(cutoff: string): { evidence: number; surfaces: number; checkpoints: number } {
    const evidence = this.db.prepare("DELETE FROM evidence WHERE created_at < ?").run(cutoff).changes;
    const surfaces = this.db.prepare("DELETE FROM surfaces WHERE created_at < ?").run(cutoff).changes;
    this.db.prepare("DELETE FROM activity WHERE created_at < ?").run(cutoff);
    this.db.prepare("DELETE FROM artifacts WHERE created_at < ?").run(cutoff);
    this.db.prepare("DELETE FROM findings WHERE created_at < ?").run(cutoff);
    this.db.prepare("DELETE FROM audit_events WHERE created_at < ?").run(cutoff);
    const threads = (this.db.prepare("SELECT thread_id FROM thread_state WHERE updated_at < ? AND status != 'running'").all(cutoff) as Array<{ thread_id: string }>)
      .map((row) => row.thread_id);
    return { evidence, surfaces, checkpoints: this.deleteCheckpoints(threads) };
  }

  purgeOwner(ownerId: string): { evidence: number; surfaces: number; checkpoints: number } {
    const threads = (this.db.prepare("SELECT thread_id FROM thread_state WHERE owner_id = ?").all(ownerId) as Array<{ thread_id: string }>)
      .map((row) => row.thread_id);
    const purge = this.db.transaction(() => {
      if (threads.length) {
        const marks = threads.map(() => "?").join(", ");
        this.db.prepare(`DELETE FROM findings WHERE run_id IN (SELECT id FROM runs WHERE thread_id IN (${marks}))`).run(...threads);
        this.db.prepare(`DELETE FROM tasks WHERE run_id IN (SELECT id FROM runs WHERE thread_id IN (${marks}))`).run(...threads);
        this.db.prepare(`DELETE FROM handled_actions WHERE thread_id IN (${marks})`).run(...threads);
        this.db.prepare(`DELETE FROM runs WHERE thread_id IN (${marks})`).run(...threads);
        this.db.prepare(`DELETE FROM investigations WHERE thread_id IN (${marks})`).run(...threads);
      }
      const evidence = this.db.prepare("DELETE FROM evidence WHERE owner_id = ?").run(ownerId).changes;
      const surfaces = this.db.prepare("DELETE FROM surfaces WHERE owner_id = ?").run(ownerId).changes;
      this.db.prepare("DELETE FROM activity WHERE owner_id = ?").run(ownerId);
      this.db.prepare("DELETE FROM artifacts WHERE owner_id = ?").run(ownerId);
      this.db.prepare("DELETE FROM action_proposals WHERE owner_id = ?").run(ownerId);
      this.db.prepare("DELETE FROM operations WHERE owner_id = ?").run(ownerId);
      this.db.prepare("DELETE FROM thread_state WHERE owner_id = ?").run(ownerId);
      return { evidence, surfaces, checkpoints: this.deleteCheckpoints(threads) };
    });
    return purge();
  }

  deleteCheckpoints(threadIds: string[]): number {
    if (!threadIds.length) return 0;
    let removed = 0;
    const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
    for (const table of tables) {
      if (!/^[A-Za-z0-9_]+$/.test(table.name) || !table.name.includes("checkpoint")) continue;
      const columns = this.db.prepare(`PRAGMA table_info(${table.name})`).all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === "thread_id")) continue;
      const marks = threadIds.map(() => "?").join(", ");
      removed += this.db.prepare(`DELETE FROM ${table.name} WHERE thread_id IN (${marks})`).run(...threadIds).changes;
    }
    return removed;
  }

  backupTo(destination: string) {
    mkdirSync(dirname(destination), { recursive: true });
    return this.db.backup(destination);
  }

  close() {
    this.db.close();
  }
}

export async function backupDatabaseFile(db: RuntimeDatabase, destination: string): Promise<void> {
  mkdirSync(dirname(destination), { recursive: true });
  await db.backup(destination);
}

export async function snapshotSqlite(sourcePath: string, destination: string): Promise<void> {
  const db = new Database(sourcePath, { readonly: true, fileMustExist: true });
  try {
    await backupDatabaseFile(db, destination);
  } finally {
    db.close();
  }
}
