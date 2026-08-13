import { sql, type Kysely } from "kysely";
import {
  DirectoryRepository,
  DirectoryRepositoryError,
  type Database,
  type DirectoryImportRun,
  type DirectorySource,
} from "@qianliu/database";
import {
  decodeKek,
  decryptCredential,
  type EncryptedCredential,
} from "@qianliu/provider-adapters";
import {
  DirectoryConnectorError,
  type DirectoryConnector,
  type DirectoryConnectorErrorCode,
} from "./connector.js";
import { FeishuDirectoryConnector } from "./feishu-connector.js";
import { WecomDirectoryConnector } from "./wecom-connector.js";

const DEFAULT_MAX_RUNS = 10;
const RUN_LEASE_MS = 15 * 60_000;
const MAX_RETRY_DELAY_MS = 60 * 60_000;

type DirectoryRunReasonCode = DirectoryConnectorErrorCode
  | "DIRECTORY_CONNECTOR_UNAVAILABLE"
  | "DIRECTORY_APPLY_RETRYABLE"
  | "DIRECTORY_APPLY_FAILED"
  | "SOURCE_INACTIVE";

export interface DirectorySyncTickResult {
  runsScanned: number;
  snapshotsPulled: number;
  applyRunsCompleted: number;
  succeeded: number;
  partial: number;
  failed: number;
  deferred: number;
}

export interface DirectorySyncLogRecord {
  event: "directory_sync_completed" | "directory_sync_failed" | "directory_sync_deferred";
  run_id: string;
  source_id?: string;
  provider?: "WECOM" | "FEISHU";
  status?: string;
  error_code?: DirectoryRunReasonCode;
}

type SafeLogger = (record: DirectorySyncLogRecord) => void;

function json(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.stringify(value) as unknown as Record<string, unknown>;
}

function defaultLogger(record: DirectorySyncLogRecord): void {
  const line = JSON.stringify(record);
  if (record.event === "directory_sync_completed") process.stdout.write(`${line}\n`);
  else process.stderr.write(`${line}\n`);
}

function retryAt(now: Date, attempt: number): Date {
  const exponent = Math.min(Math.max(attempt - 1, 0), 6);
  return new Date(now.getTime() + Math.min(60_000 * 2 ** exponent, MAX_RETRY_DELAY_MS));
}

function parseEncryptedConfig(source: DirectorySource, kekBase64: string): unknown {
  let plaintext: string;
  try {
    const envelope = JSON.parse(source.config_ciphertext) as EncryptedCredential;
    plaintext = decryptCredential(envelope, decodeKek(kekBase64));
  } catch {
    throw new DirectoryConnectorError("DIRECTORY_CREDENTIAL_DECRYPT_FAILED", false);
  }
  try {
    return JSON.parse(plaintext) as unknown;
  } catch {
    throw new DirectoryConnectorError("DIRECTORY_CONFIG_INVALID", false);
  }
}

async function claimNextSyncRun(
  db: Kysely<Database>, now: Date, runId?: string,
): Promise<DirectoryImportRun | null> {
  return db.transaction().execute(async (trx) => {
    let query = trx.selectFrom("directory_import_run").selectAll()
      .where("mode", "=", "SYNC")
      .where("job_type", "=", "DIRECTORY_SYNC")
      .where((eb) => eb.or([
        eb.and([
          eb("status", "=", "QUEUED"),
          eb.or([eb("next_attempt_at", "is", null), eb("next_attempt_at", "<=", now)]),
        ]),
        eb.and([
          eb("status", "=", "RUNNING"),
          eb.or([eb("lease_until", "is", null), eb("lease_until", "<=", now)]),
        ]),
      ]));
    if (runId) query = query.where("id", "=", runId);
    const candidate = await query.orderBy("created_at").forUpdate().skipLocked().executeTakeFirst();
    if (!candidate) return null;
    return trx.updateTable("directory_import_run").set({
      status: "RUNNING",
      attempt: sql`attempt + 1`,
      started_at: candidate.started_at ?? now,
      next_attempt_at: null,
      lease_until: new Date(now.getTime() + RUN_LEASE_MS),
      failure_reason_code: null,
      updated_at: now,
    }).where("enterprise_id", "=", candidate.enterprise_id).where("id", "=", candidate.id)
      .returningAll().executeTakeFirstOrThrow();
  });
}

async function updateSourceFailure(
  db: Kysely<Database>, source: DirectorySource | null, code: DirectoryRunReasonCode, now: Date,
): Promise<void> {
  if (!source) return;
  await db.updateTable("directory_source").set({
    last_error_code: code,
    version: sql`version + 1`,
    updated_at: now,
  }).where("enterprise_id", "=", source.enterprise_id).where("id", "=", source.id).execute();
}

async function deferRun(
  db: Kysely<Database>, run: DirectoryImportRun, code: DirectoryRunReasonCode, now: Date,
): Promise<boolean> {
  return db.transaction().execute(async (trx) => {
    const deferred = await trx.updateTable("directory_import_run").set({
      status: "QUEUED",
      next_attempt_at: retryAt(now, run.attempt),
      lease_until: null,
      failure_reason_code: code,
      updated_at: now,
    }).where("enterprise_id", "=", run.enterprise_id).where("id", "=", run.id)
      .where("status", "in", ["QUEUED", "RUNNING"]).returning("id").executeTakeFirst();
    if (!deferred) return false;
    await trx.insertInto("operation_log").values({
      enterprise_id: run.enterprise_id,
      admin_user_id: run.created_by_admin_user_id,
      action: "directory_import_run.retry_scheduled",
      target_type: "directory_import_run",
      target_id: run.id,
      change_summary: json({ reason_code: code, attempt: run.attempt }),
      result: "FAILURE",
      failure_reason: code,
    }).execute();
    return true;
  });
}

async function failRun(
  repository: DirectoryRepository,
  run: DirectoryImportRun,
  code: DirectoryRunReasonCode,
): Promise<void> {
  try {
    await repository.markRunFailed(run.enterprise_id, run.id, code);
  } catch (error) {
    if (!(error instanceof DirectoryRepositoryError) || error.code !== "INVALID_STATE") throw error;
  }
}

async function completeSource(
  db: Kysely<Database>, source: DirectorySource, cursor: string,
  run: DirectoryImportRun, now: Date,
): Promise<void> {
  const successful = run.status === "SUCCEEDED" || run.status === "PARTIAL";
  await db.updateTable("directory_source").set({
    ...(successful ? { cursor, last_successful_sync_at: now, last_error_code: null } : {
      last_error_code: "DIRECTORY_APPLY_FAILED",
    }),
    version: sql`version + 1`,
    updated_at: now,
  }).where("enterprise_id", "=", source.enterprise_id).where("id", "=", source.id).execute();
}

function connectorFor(
  source: DirectorySource,
  fetchImpl: typeof fetch,
  now: Date,
  overrides?: Partial<Record<"WECOM" | "FEISHU", DirectoryConnector>>,
): DirectoryConnector {
  const overridden = overrides?.[source.type];
  if (overridden) return overridden;
  return source.type === "WECOM"
    ? new WecomDirectoryConnector(fetchImpl, () => now)
    : new FeishuDirectoryConnector(fetchImpl, () => now);
}

async function processSyncRun(input: {
  db: Kysely<Database>;
  repository: DirectoryRepository;
  run: DirectoryImportRun;
  kekBase64: string;
  fetchImpl: typeof fetch;
  now: Date;
  logger: SafeLogger;
  connectors?: Partial<Record<"WECOM" | "FEISHU", DirectoryConnector>>;
}): Promise<{
  outcome: "SUCCEEDED" | "PARTIAL" | "FAILED" | "DEFERRED";
  snapshotPulled: boolean;
  applyCompleted: boolean;
}> {
  const source = input.run.directory_source_id
    ? await input.repository.getSourceForWorker(input.run.enterprise_id, input.run.directory_source_id)
    : null;
  if (!source || source.status !== "ACTIVE") {
    await failRun(input.repository, input.run, "SOURCE_INACTIVE");
    input.logger({
      event: "directory_sync_failed", run_id: input.run.id,
      source_id: input.run.directory_source_id ?? undefined, error_code: "SOURCE_INACTIVE",
    });
    return { outcome: "FAILED", snapshotPulled: false, applyCompleted: false };
  }
  let snapshotPulled = false;
  let applyCompleted = false;
  try {
    const config = parseEncryptedConfig(source, input.kekBase64);
    const connector = connectorFor(source, input.fetchImpl, input.now, input.connectors);
    const snapshot = await connector.pull(config, source.cursor);
    snapshotPulled = true;
    await input.repository.stageRun({
      enterpriseId: input.run.enterprise_id,
      runId: input.run.id,
      items: snapshot.items,
      sourceSnapshotId: snapshot.snapshotId,
      sourceDataAt: snapshot.sourceDataAt,
    });
    const completed = await input.repository.applyRun(input.run.enterprise_id, input.run.id);
    applyCompleted = true;
    await completeSource(input.db, source, snapshot.cursor, completed, input.now);
    input.logger({
      event: "directory_sync_completed", run_id: input.run.id,
      source_id: source.id, provider: source.type, status: completed.status,
    });
    return {
      outcome: completed.status === "PARTIAL" ? "PARTIAL"
        : completed.status === "SUCCEEDED" ? "SUCCEEDED" : "FAILED",
      snapshotPulled,
      applyCompleted,
    };
  } catch (error) {
    const connectorError = error instanceof DirectoryConnectorError ? error : null;
    const repositoryError = error instanceof DirectoryRepositoryError ? error : null;
    const code: DirectoryRunReasonCode = connectorError?.code
      ?? (repositoryError?.code === "SOURCE_INACTIVE" ? "SOURCE_INACTIVE"
        : repositoryError ? "DIRECTORY_APPLY_FAILED" : "DIRECTORY_CONNECTOR_UNAVAILABLE");
    const retryable = connectorError?.retryable
      ?? (repositoryError ? repositoryError.code === "RUN_BUSY" : true);
    await updateSourceFailure(input.db, source, code, input.now);
    if (retryable && await deferRun(input.db, input.run, code, input.now)) {
      input.logger({
        event: "directory_sync_deferred", run_id: input.run.id,
        source_id: source.id, provider: source.type, error_code: code,
      });
      return { outcome: "DEFERRED", snapshotPulled, applyCompleted };
    }
    await failRun(input.repository, input.run, code);
    input.logger({
      event: "directory_sync_failed", run_id: input.run.id,
      source_id: source.id, provider: source.type, error_code: code,
    });
    return { outcome: "FAILED", snapshotPulled, applyCompleted };
  }
}

async function findApplyRuns(
  db: Kysely<Database>, now: Date, limit: number, runId?: string,
): Promise<DirectoryImportRun[]> {
  let query = db.selectFrom("directory_import_run").selectAll()
    .where("job_type", "=", "DIRECTORY_IMPORT_APPLY")
    .where((eb) => eb.or([
      eb.and([
        eb("status", "=", "QUEUED"),
        eb.or([eb("next_attempt_at", "is", null), eb("next_attempt_at", "<=", now)]),
      ]),
      eb.and([
        eb("status", "=", "RUNNING"),
        eb.or([eb("lease_until", "is", null), eb("lease_until", "<=", now)]),
      ]),
    ]));
  if (runId) query = query.where("id", "=", runId);
  return query.orderBy("created_at").limit(limit).execute();
}

/**
 * 统一目录 Worker tick：先拉取已排队的只读来源快照，再处理 SYNC/EXCEL 共用的 apply 队列。
 * 不创建同步 Run，也不自动停用 Person/Principal/Key/Grant。
 */
export async function runDirectorySyncTick(input: {
  db: Kysely<Database>;
  kekBase64: string;
  fetch?: typeof fetch;
  now?: Date;
  maxRuns?: number;
  runId?: string;
  logger?: SafeLogger;
  connectors?: Partial<Record<"WECOM" | "FEISHU", DirectoryConnector>>;
}): Promise<DirectorySyncTickResult> {
  const now = input.now ?? new Date();
  const maxRuns = Math.min(Math.max(input.maxRuns ?? DEFAULT_MAX_RUNS, 1), 100);
  const repository = new DirectoryRepository(input.db);
  const logger = input.logger ?? defaultLogger;
  const result: DirectorySyncTickResult = {
    runsScanned: 0,
    snapshotsPulled: 0,
    applyRunsCompleted: 0,
    succeeded: 0,
    partial: 0,
    failed: 0,
    deferred: 0,
  };

  while (result.runsScanned < maxRuns) {
    const run = await claimNextSyncRun(input.db, now, input.runId);
    if (!run) break;
    result.runsScanned += 1;
    const processed = await processSyncRun({
      db: input.db,
      repository,
      run,
      kekBase64: input.kekBase64,
      fetchImpl: input.fetch ?? fetch,
      now,
      logger,
      connectors: input.connectors,
    });
    if (processed.snapshotPulled) result.snapshotsPulled += 1;
    if (processed.applyCompleted) result.applyRunsCompleted += 1;
    if (processed.outcome === "SUCCEEDED") result.succeeded += 1;
    else if (processed.outcome === "PARTIAL") result.partial += 1;
    else if (processed.outcome === "FAILED") result.failed += 1;
    else result.deferred += 1;
    if (input.runId) break;
  }

  const remaining = maxRuns - result.runsScanned;
  const applyRuns = remaining > 0
    ? await findApplyRuns(input.db, now, remaining, input.runId)
    : [];
  for (const run of applyRuns) {
    result.runsScanned += 1;
    try {
      const completed = await repository.applyRun(run.enterprise_id, run.id);
      if (run.mode === "SYNC" && run.directory_source_id && run.source_snapshot_id) {
        const source = await repository.getSourceForWorker(run.enterprise_id, run.directory_source_id);
        if (source) await completeSource(input.db, source, run.source_snapshot_id, completed, now);
      }
      result.applyRunsCompleted += 1;
      if (completed.status === "SUCCEEDED") result.succeeded += 1;
      else if (completed.status === "PARTIAL") result.partial += 1;
      else result.failed += 1;
      logger({
        event: "directory_sync_completed", run_id: run.id,
        source_id: run.directory_source_id ?? undefined, status: completed.status,
      });
    } catch (error) {
      if (error instanceof DirectoryRepositoryError && error.code === "RUN_BUSY") continue;
      if (error instanceof DirectoryRepositoryError && error.code === "SOURCE_INACTIVE") {
        await failRun(repository, run, "SOURCE_INACTIVE");
        result.failed += 1;
        logger({
          event: "directory_sync_failed", run_id: run.id,
          source_id: run.directory_source_id ?? undefined, error_code: "SOURCE_INACTIVE",
        });
        continue;
      }
      if (await deferRun(input.db, run, "DIRECTORY_APPLY_RETRYABLE", now)) {
        result.deferred += 1;
        logger({
          event: "directory_sync_deferred", run_id: run.id,
          source_id: run.directory_source_id ?? undefined, error_code: "DIRECTORY_APPLY_RETRYABLE",
        });
      }
    }
  }
  return result;
}
