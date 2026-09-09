/**
 * 审计仓储 —— operation_log 只追加写入与查询（W02）。
 *
 * 依据：TRD §5.7、PRD §5.1 L137 / §13 L537。
 * 审计内容只存元数据与变化摘要（脱敏，无 Secret/正文）；只追加不更新。
 */
import type { Kysely, Selectable } from "kysely";
import type { Database, OperationLogTable } from "../kysely.js";

export type OperationLog = Selectable<OperationLogTable>;

export interface WriteAuditInput {
  actor_source?: "ADMIN" | "SYSTEM" | "UNKNOWN";
  enterprise_id: string;
  admin_user_id: string;
  action: string;
  target_type: string;
  target_id?: string | null;
  change_summary?: Record<string, unknown> | null;
  result: "SUCCESS" | "FAILURE";
  failure_reason?: string | null;
}

export class AuditRepository {
  constructor(private db: Kysely<Database>) {}

  /** 只追加写入。change_summary 必须已脱敏（不含 Secret/正文）。 */
  async write(input: WriteAuditInput): Promise<OperationLog> {
    return this.db
      .insertInto("operation_log")
      .values({
        enterprise_id: input.enterprise_id,
        admin_user_id: input.admin_user_id,
        actor_source: input.actor_source ?? "ADMIN",
        action: input.action,
        target_type: input.target_type,
        target_id: input.target_id ?? null,
        change_summary: input.change_summary ?? null,
        result: input.result,
        failure_reason: input.failure_reason ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async list(
    enterpriseId: string,
    opts?: { limit?: number; targetType?: string; targetId?: string },
  ): Promise<OperationLog[]> {
    let q = this.db
      .selectFrom("operation_log")
      .selectAll()
      .where("enterprise_id", "=", enterpriseId);
    if (opts?.targetType) q = q.where("target_type", "=", opts.targetType);
    if (opts?.targetId) q = q.where("target_id", "=", opts.targetId);
    return q.orderBy("created_at", "desc").limit(opts?.limit ?? 100).execute();
  }
}
