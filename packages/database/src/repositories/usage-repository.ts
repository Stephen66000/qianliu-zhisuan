/**
 * 用量账本仓储（W18/W20）—— 只读查询，支持分页 + 多维筛选。
 *
 * 依据：PRD §10.3（用量账本，行 426-458）、TRD §11.2（/usage 端点）。
 *
 * 口径：每条记录对应一次业务请求（ledger_transaction），展示：
 *   仟流请求 ID / 发起主体 / 客户端 / 模型 / 上游账号 /
 *   输入输出缓存 Token / 实际扣减额度 / API 费用或套餐内 / 命中规则版本 /
 *   状态 / 错误类型 / 时间 / 耗时。
 *
 * 路由过程下钻（route-candidates / attempts / dispatch-decision）在 W20 的
 * /gateway-requests/{id} 子路由提供，本仓储只提供请求级列表。
 */
import type { Kysely } from "kysely";
import type { Database } from "../kysely.js";

/** 用量账本筛选条件（PRD §10.3 行 428-435）。 */
export interface UsageQuery {
  enterpriseId: string;
  /** 员工/项目 ID 筛选。 */
  principalId?: string;
  /** 客户端 ID 筛选。 */
  clientId?: string;
  /** 统一模型（对外别名）筛选。 */
  unifiedModel?: string;
  /** 时间范围（started_at）。 */
  from?: Date;
  to?: Date;
  /** 状态筛选：SUCCEEDED / FAILED / IN_PROGRESS。 */
  status?: string;
  /** 是否只看超额（ledger_transaction.total_deducted_quota 超出 grant.quota_value）。 */
  overageOnly?: boolean;
  /** 分页。 */
  limit?: number;
  offset?: number;
}

/** 用量账本单条记录（请求级，PRD §10.3 行 437-448）。 */
export interface UsageRecord {
  requestId: string;
  principalId: string;
  principalName: string;
  principalType: string;
  clientId: string | null;
  unifiedModel: string;
  status: string;
  errorClassification: string | null;
  errorCode: string | null;
  startedAt: string;
  finishedAt: string | null;
  /** 耗时毫秒（finished_at - started_at）；进行中为 null。 */
  durationMs: number | null;
  // 聚合 token（来自 ledger_transaction）
  totalInputTokens: string;
  totalOutputTokens: string;
  totalCacheTokens: string;
  totalDeductedQuota: string;
  totalApiCost: string;
  usageQuality: string;
  attemptCount: number;
}

/** 用量账本分页结果。 */
export interface UsageResult {
  records: UsageRecord[];
  total: number;
  limit: number;
  offset: number;
}

export class UsageRepository {
  constructor(private db: Kysely<Database>) {}

  /** 用量账本列表（分页 + 筛选，PRD §10.3）。 */
  async list(query: UsageQuery): Promise<UsageResult> {
    const limit = Math.min(query.limit ?? 50, 500);
    const offset = query.offset ?? 0;

    // 始终 join ai_request（usage 列表展示需要 client_id/unified_model/started_at/
    // finished_at/status/error，且避免二次查询 N+1）+ principal（发起主体名）
    let baseQuery = this.db
      .selectFrom("ledger_transaction")
      .innerJoin("principal", "principal.id", "ledger_transaction.principal_id")
      .innerJoin("ai_request", "ai_request.id", "ledger_transaction.ai_request_id")
      .where("ledger_transaction.enterprise_id", "=", query.enterpriseId);

    if (query.principalId) {
      baseQuery = baseQuery.where("ledger_transaction.principal_id", "=", query.principalId);
    }
    if (query.clientId) {
      baseQuery = baseQuery.where("ai_request.client_id", "=", query.clientId);
    }
    if (query.unifiedModel) {
      baseQuery = baseQuery.where("ai_request.unified_model", "=", query.unifiedModel);
    }
    if (query.status) {
      baseQuery = baseQuery.where("ledger_transaction.status", "=", query.status);
    }
    if (query.from) {
      baseQuery = baseQuery.where("ledger_transaction.created_at", ">=", query.from);
    }
    if (query.to) {
      baseQuery = baseQuery.where("ledger_transaction.created_at", "<=", query.to);
    }

    // 总数（分页元数据）
    const countQuery = baseQuery.select((eb) => eb.fn.countAll().as("cnt"));
    const countRow = await countQuery.executeTakeFirstOrThrow();
    const total = Number((countRow as { cnt: bigint | number }).cnt);

    // 分页数据（一次性 select 全字段，含 ai_request 的展示字段）
    const rows = await baseQuery
      .orderBy("ledger_transaction.created_at", "desc")
      .limit(limit)
      .offset(offset)
      .select([
        "ledger_transaction.ai_request_id as request_id",
        "ledger_transaction.principal_id",
        "principal.name as principal_name",
        "principal.type as principal_type",
        "ai_request.client_id",
        "ai_request.unified_model",
        "ai_request.started_at",
        "ai_request.finished_at",
        "ai_request.status as request_status",
        "ai_request.error_classification",
        "ai_request.error_code",
        "ledger_transaction.total_input_tokens",
        "ledger_transaction.total_output_tokens",
        "ledger_transaction.total_cache_tokens",
        "ledger_transaction.total_deducted_quota",
        "ledger_transaction.total_api_cost",
        "ledger_transaction.usage_quality",
        "ledger_transaction.attempt_count",
        "ledger_transaction.status",
        "ledger_transaction.created_at",
      ])
      .execute();

    const records: UsageRecord[] = rows.map((r) => {
      const row = r as {
        request_id: string;
        principal_id: string;
        principal_name: string;
        principal_type: string;
        client_id: string | null;
        unified_model: string;
        started_at: Date;
        finished_at: Date | null;
        request_status: string;
        error_classification: string | null;
        error_code: string | null;
        total_input_tokens: bigint;
        total_output_tokens: bigint;
        total_cache_tokens: bigint;
        total_deducted_quota: bigint;
        total_api_cost: string;
        usage_quality: string;
        attempt_count: number | bigint;
        status: string;
        created_at: Date;
      };
      const finishedAt = row.finished_at;
      const durationMs = finishedAt
        ? finishedAt.getTime() - row.started_at.getTime()
        : null;
      return {
        requestId: row.request_id,
        principalId: row.principal_id,
        principalName: row.principal_name,
        principalType: row.principal_type,
        clientId: row.client_id,
        unifiedModel: row.unified_model,
        status: row.request_status || row.status,
        errorClassification: row.error_classification,
        errorCode: row.error_code,
        startedAt: row.started_at.toISOString(),
        finishedAt: finishedAt ? finishedAt.toISOString() : null,
        durationMs,
        totalInputTokens: row.total_input_tokens.toString(),
        totalOutputTokens: row.total_output_tokens.toString(),
        totalCacheTokens: row.total_cache_tokens.toString(),
        totalDeductedQuota: row.total_deducted_quota.toString(),
        totalApiCost: row.total_api_cost,
        usageQuality: row.usage_quality,
        attemptCount: Number(row.attempt_count),
      };
    });

    // overageOnly 后置过滤（需 join grant 判定，复杂度高，简化为基于 transaction 状态标记）
    // 当前 overage 维度在 dashboard 的 overageList 提供，usage 列表暂不做 overage 过滤
    // （避免 N+1 join grant；如需可后续扩展为 SQL 级筛选）

    return { records, total, limit, offset };
  }
}
