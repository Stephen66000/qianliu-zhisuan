import { sql, type Kysely, type Selectable } from "kysely";

import type { Database, DeploymentLogEventTable, DeploymentLogTable } from "../kysely.js";

export type DeploymentLog = Selectable<DeploymentLogTable>;
export type DeploymentLogEvent = Selectable<DeploymentLogEventTable>;
export type DeploymentStatus = DeploymentLog["status"];

export interface DeploymentManifest {
  deploymentId: string;
  startedAt: Date;
  finishedAt?: Date | null;
  status: DeploymentStatus;
  fromVersion?: string | null;
  toVersion?: string | null;
  gitCommit?: string | null;
  artifactSha256?: string | null;
  migrationFrom?: string | null;
  migrationTo?: string | null;
  releaseId?: string | null;
  actor: string;
  summary: string;
  poolRefs?: string[];
  backupRef?: string | null;
  rollbackTarget?: string | null;
  healthSummary?: Record<string, unknown> | null;
  smokeSummary?: Record<string, unknown> | null;
  evidenceRefs?: string[];
  failureClassification?: string | null;
}

export class DeploymentLogImmutableError extends Error {}

export class DeploymentLogRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async importManifest(enterpriseId: string, manifest: DeploymentManifest): Promise<DeploymentLog> {
    // eslint-disable-next-line complexity -- 复杂度来自不可变发布清单逐字段补全；事务只有创建、完成、幂等三条状态路径。
    return this.db.transaction().execute(async (trx) => {
      let row = await trx.selectFrom("deployment_log").selectAll()
        .where("enterprise_id", "=", enterpriseId)
        .where("deployment_id", "=", manifest.deploymentId)
        .forUpdate().executeTakeFirst();
      if (!row) {
        row = await trx.insertInto("deployment_log").values({
          enterprise_id: enterpriseId,
          deployment_id: manifest.deploymentId,
          started_at: manifest.startedAt,
          finished_at: manifest.status === "IN_PROGRESS" ? null : manifest.finishedAt ?? new Date(),
          status: manifest.status,
          from_version: manifest.fromVersion ?? null,
          to_version: manifest.toVersion ?? null,
          git_commit: manifest.gitCommit ?? null,
          artifact_sha256: manifest.artifactSha256 ?? null,
          migration_from: manifest.migrationFrom ?? null,
          migration_to: manifest.migrationTo ?? null,
          release_id: manifest.releaseId ?? null,
          actor: manifest.actor,
          summary: manifest.summary,
          pool_refs: JSON.stringify(manifest.poolRefs ?? []) as unknown as string[],
          backup_ref: manifest.backupRef ?? null,
          rollback_target: manifest.rollbackTarget ?? null,
          health_summary: manifest.healthSummary ?? null,
          smoke_summary: manifest.smokeSummary ?? null,
          evidence_refs: JSON.stringify(manifest.evidenceRefs ?? []) as unknown as string[],
          failure_classification: manifest.failureClassification ?? null,
        }).returningAll().executeTakeFirstOrThrow();
        await trx.insertInto("deployment_log_event").values({
          enterprise_id: enterpriseId,
          deployment_log_id: row.id,
          event_key: `manifest:${manifest.status}`,
          event_type: manifest.status,
          occurred_at: manifest.status === "IN_PROGRESS"
            ? manifest.startedAt
            : manifest.finishedAt ?? row.finished_at ?? new Date(),
          actor: manifest.actor,
          note: manifest.summary,
          payload: {
            releaseId: manifest.releaseId ?? null,
            poolRefs: manifest.poolRefs ?? [],
          },
        }).execute();
        return row;
      }
      if (row.status === "IN_PROGRESS" && manifest.status !== "IN_PROGRESS") {
        row = await trx.updateTable("deployment_log").set({
          finished_at: manifest.finishedAt ?? new Date(),
          status: manifest.status,
          from_version: manifest.fromVersion ?? row.from_version,
          to_version: manifest.toVersion ?? row.to_version,
          git_commit: manifest.gitCommit ?? row.git_commit,
          artifact_sha256: manifest.artifactSha256 ?? row.artifact_sha256,
          migration_from: manifest.migrationFrom ?? row.migration_from,
          migration_to: manifest.migrationTo ?? row.migration_to,
          release_id: manifest.releaseId ?? row.release_id,
          summary: manifest.summary,
          pool_refs: JSON.stringify(manifest.poolRefs ?? row.pool_refs) as unknown as string[],
          backup_ref: manifest.backupRef ?? row.backup_ref,
          rollback_target: manifest.rollbackTarget ?? row.rollback_target,
          health_summary: manifest.healthSummary ?? row.health_summary,
          smoke_summary: manifest.smokeSummary ?? row.smoke_summary,
          evidence_refs: JSON.stringify(manifest.evidenceRefs ?? row.evidence_refs) as unknown as string[],
          failure_classification: manifest.failureClassification ?? row.failure_classification,
          updated_at: new Date(),
        }).where("id", "=", row.id).where("status", "=", "IN_PROGRESS")
          .returningAll().executeTakeFirstOrThrow();
        await trx.insertInto("deployment_log_event").values({
          enterprise_id: enterpriseId,
          deployment_log_id: row.id,
          event_key: `manifest:${manifest.status}`,
          event_type: manifest.status,
          occurred_at: manifest.finishedAt ?? row.finished_at ?? new Date(),
          actor: manifest.actor,
          note: manifest.summary,
          payload: { releaseId: manifest.releaseId ?? null, poolRefs: manifest.poolRefs ?? [] },
        }).onConflict((conflict) => conflict.doNothing()).execute();
        return row;
      }
      // 相同 deployment_id 的导入重试只读返回；已完成记录永不覆盖。
      if (row.status !== manifest.status && row.status !== "IN_PROGRESS") {
        throw new DeploymentLogImmutableError("已完成升级记录不可覆盖");
      }
      return row;
    });
  }

  async appendEvent(input: {
    enterpriseId: string;
    deploymentLogId: string;
    eventKey: string;
    eventType: string;
    occurredAt: Date;
    actor: string;
    note?: string | null;
    payload?: Record<string, unknown> | null;
  }): Promise<DeploymentLogEvent | null> {
    const event = await this.db.insertInto("deployment_log_event").values({
      enterprise_id: input.enterpriseId,
      deployment_log_id: input.deploymentLogId,
      event_key: input.eventKey,
      event_type: input.eventType,
      occurred_at: input.occurredAt,
      actor: input.actor,
      note: input.note ?? null,
      payload: input.payload ?? null,
    }).onConflict((conflict) => conflict.doNothing()).returningAll().executeTakeFirst();
    return event ?? null;
  }

  async list(enterpriseId: string, query: {
    limit: number;
    offset: number;
    status?: DeploymentStatus;
    version?: string;
    poolRef?: string;
    from?: Date;
    to?: Date;
  }): Promise<{ items: DeploymentLog[]; total: number }> {
    let rows = this.db.selectFrom("deployment_log").selectAll()
      .where("enterprise_id", "=", enterpriseId);
    let count = this.db.selectFrom("deployment_log").select((eb) => eb.fn.countAll().as("count"))
      .where("enterprise_id", "=", enterpriseId);
    if (query.status) {
      rows = rows.where("status", "=", query.status);
      count = count.where("status", "=", query.status);
    }
    if (query.version) {
      rows = rows.where((eb) => eb.or([
          eb("from_version", "ilike", `%${query.version}%`),
          eb("to_version", "ilike", `%${query.version}%`),
          eb("git_commit", "ilike", `%${query.version}%`),
      ]));
      count = count.where((eb) => eb.or([
        eb("from_version", "ilike", `%${query.version}%`),
        eb("to_version", "ilike", `%${query.version}%`),
        eb("git_commit", "ilike", `%${query.version}%`),
      ]));
    }
    if (query.poolRef) {
      const containsPool = sql<boolean>`pool_refs @> ${JSON.stringify([query.poolRef])}::jsonb`;
      rows = rows.where(containsPool);
      count = count.where(containsPool);
    }
    if (query.from) {
      rows = rows.where("started_at", ">=", query.from);
      count = count.where("started_at", ">=", query.from);
    }
    if (query.to) {
      rows = rows.where("started_at", "<", query.to);
      count = count.where("started_at", "<", query.to);
    }
    const [items, total] = await Promise.all([
      rows.orderBy("started_at", "desc").limit(query.limit).offset(query.offset).execute(),
      count.executeTakeFirstOrThrow(),
    ]);
    return { items, total: Number(total.count) };
  }

  async get(enterpriseId: string, id: string): Promise<{
    deployment: DeploymentLog;
    events: DeploymentLogEvent[];
  } | null> {
    const deployment = await this.db.selectFrom("deployment_log").selectAll()
      .where("enterprise_id", "=", enterpriseId).where("id", "=", id).executeTakeFirst();
    if (!deployment) return null;
    const events = await this.db.selectFrom("deployment_log_event").selectAll()
      .where("enterprise_id", "=", enterpriseId)
      .where("deployment_log_id", "=", id)
      .orderBy("occurred_at", "asc").execute();
    return { deployment, events };
  }
}
