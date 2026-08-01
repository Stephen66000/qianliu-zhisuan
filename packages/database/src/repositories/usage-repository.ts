/**
 * 用量账本仓储（W18/W20/POOL-012）—— 企业内请求级分页、搜索与组合筛选。
 *
 * 账本只消费已冻结事实：最终资源来自 ledger_line/upstream_attempt，超额来自
 * ledger_transaction.overage；不会根据当前 Grant/Counter 重算历史。
 */
import type { Kysely, RawBuilder } from "kysely";
import { sql } from "kysely";
import type { Database } from "../kysely.js";

export interface UsageQuery {
  enterpriseId: string;
  /** 请求 ID 或主体名称（字面量、不解释 SQL 通配符）的部分搜索。 */
  search?: string;
  principalId?: string;
  clientId?: string;
  providerId?: string;
  providerResourceId?: string;
  unifiedModel?: string;
  from?: Date;
  to?: Date;
  status?: string;
  overageOnly?: boolean;
  limit?: number;
  offset?: number;
}

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
  durationMs: number | null;
  finalProviderId: string | null;
  finalProviderCode: string | null;
  finalProviderName: string | null;
  finalProviderResourceId: string | null;
  finalProviderResourceName: string | null;
  /** null 表示迁移前历史没有保存该事实，禁止按当前配置猜测。 */
  overage: boolean | null;
  totalInputTokens: string;
  totalOutputTokens: string;
  totalCacheTokens: string;
  totalDeductedQuota: string;
  totalApiCost: string;
  usageQuality: string;
  attemptCount: number;
}

export interface UsageResult {
  records: UsageRecord[];
  total: number;
  limit: number;
  offset: number;
}

interface UsageSqlRow {
  request_id: string;
  principal_id: string;
  principal_name: string;
  principal_type: string;
  client_id: string | null;
  unified_model: string;
  request_status: string;
  error_classification: string | null;
  error_code: string | null;
  started_at: Date;
  finished_at: Date | null;
  final_provider_id: string | null;
  final_provider_code: string | null;
  final_provider_name: string | null;
  final_resource_id: string | null;
  final_resource_name: string | null;
  overage: boolean | null;
  total_input_tokens: bigint;
  total_output_tokens: bigint;
  total_cache_tokens: bigint;
  total_deducted_quota: bigint;
  total_api_cost: string;
  usage_quality: string;
  attempt_count: number | bigint;
}

export class UsageRepository {
  constructor(private db: Kysely<Database>) {}

  async list(query: UsageQuery): Promise<UsageResult> {
    const requestedLimit = Number.isFinite(query.limit) ? Math.trunc(query.limit!) : 50;
    const requestedOffset = Number.isFinite(query.offset) ? Math.trunc(query.offset!) : 0;
    const limit = Math.max(1, Math.min(requestedLimit, 500));
    const offset = Math.max(0, requestedOffset);
    const conditions: RawBuilder<unknown>[] = [
      sql`lt.enterprise_id = ${query.enterpriseId}`,
      sql`ar.enterprise_id = ${query.enterpriseId}`,
      sql`p.enterprise_id = ${query.enterpriseId}`,
    ];

    const search = query.search?.trim();
    if (search) {
      const containsPattern = `%${search.replace(/[\\%_]/g, "\\$&")}%`;
      const escapeChar = "\\";
      conditions.push(sql`(
        lt.ai_request_id::text ILIKE ${containsPattern} ESCAPE ${escapeChar}
        OR p.name ILIKE ${containsPattern} ESCAPE ${escapeChar}
      )`);
    }
    if (query.principalId) conditions.push(sql`lt.principal_id = ${query.principalId}`);
    if (query.clientId) conditions.push(sql`ar.client_id = ${query.clientId}`);
    if (query.unifiedModel) conditions.push(sql`ar.unified_model = ${query.unifiedModel}`);
    if (query.status) conditions.push(sql`ar.status = ${query.status}`);
    if (query.from) conditions.push(sql`ar.started_at >= ${query.from}`);
    if (query.to) conditions.push(sql`ar.started_at <= ${query.to}`);
    if (query.overageOnly) conditions.push(sql`lt.overage = true`);

    if (query.providerId || query.providerResourceId) {
      conditions.push(sql`EXISTS (
        SELECT 1
          FROM (
            SELECT pv.id AS provider_id, pr.id AS resource_id
              FROM ledger_line ll
              INNER JOIN upstream_attempt ua
                ON ua.id = ll.upstream_attempt_id
               AND ua.enterprise_id = ${query.enterpriseId}
              INNER JOIN provider_resource pr
                ON pr.id = ll.provider_resource_id
               AND pr.enterprise_id = ${query.enterpriseId}
              INNER JOIN provider pv
                ON pv.id = pr.provider_id
               AND pv.enterprise_id = ${query.enterpriseId}
             WHERE ll.ai_request_id = lt.ai_request_id
               AND ll.enterprise_id = ${query.enterpriseId}
             ORDER BY ua.attempt_no DESC, ll.created_at DESC, ll.id DESC
             LIMIT 1
          ) filtered_final_resource
         WHERE ${query.providerId
           ? sql`filtered_final_resource.provider_id = ${query.providerId}`
           : sql`true`}
           AND ${query.providerResourceId
             ? sql`filtered_final_resource.resource_id = ${query.providerResourceId}`
             : sql`true`}
      )`);
    }

    const where = sql.join(conditions, sql` AND `);
    const countResult = await sql<{ cnt: bigint | string }>`
      SELECT count(*) AS cnt
        FROM ledger_transaction lt
        INNER JOIN principal p ON p.id = lt.principal_id
        INNER JOIN ai_request ar ON ar.id = lt.ai_request_id
       WHERE ${where}
    `.execute(this.db);
    const total = Number(countResult.rows[0]?.cnt ?? 0);

    const result = await sql<UsageSqlRow>`
      SELECT
        lt.ai_request_id AS request_id,
        lt.principal_id,
        p.name AS principal_name,
        p.type AS principal_type,
        ar.client_id,
        ar.unified_model,
        ar.status AS request_status,
        ar.error_classification,
        ar.error_code,
        ar.started_at,
        ar.finished_at,
        final_resource.provider_id AS final_provider_id,
        final_resource.provider_code AS final_provider_code,
        final_resource.provider_name AS final_provider_name,
        final_resource.resource_id AS final_resource_id,
        final_resource.resource_name AS final_resource_name,
        lt.overage,
        lt.total_input_tokens,
        lt.total_output_tokens,
        lt.total_cache_tokens,
        lt.total_deducted_quota,
        lt.total_api_cost,
        lt.usage_quality,
        lt.attempt_count
      FROM ledger_transaction lt
      INNER JOIN principal p ON p.id = lt.principal_id
      INNER JOIN ai_request ar ON ar.id = lt.ai_request_id
      LEFT JOIN LATERAL (
        SELECT
          pv.id AS provider_id,
          pv.code AS provider_code,
          pv.name AS provider_name,
          pr.id AS resource_id,
          pr.name AS resource_name
        FROM ledger_line ll
        INNER JOIN upstream_attempt ua
          ON ua.id = ll.upstream_attempt_id
         AND ua.enterprise_id = ${query.enterpriseId}
        INNER JOIN provider_resource pr
          ON pr.id = ll.provider_resource_id
         AND pr.enterprise_id = ${query.enterpriseId}
        INNER JOIN provider pv
          ON pv.id = pr.provider_id
         AND pv.enterprise_id = ${query.enterpriseId}
        WHERE ll.ai_request_id = lt.ai_request_id
          AND ll.enterprise_id = ${query.enterpriseId}
        ORDER BY ua.attempt_no DESC, ll.created_at DESC, ll.id DESC
        LIMIT 1
      ) final_resource ON true
      WHERE ${where}
      ORDER BY lt.created_at DESC, lt.ai_request_id DESC
      LIMIT ${limit}
      OFFSET ${offset}
    `.execute(this.db);

    const records: UsageRecord[] = result.rows.map((row) => ({
      requestId: row.request_id,
      principalId: row.principal_id,
      principalName: row.principal_name,
      principalType: row.principal_type,
      clientId: row.client_id,
      unifiedModel: row.unified_model,
      status: row.request_status,
      errorClassification: row.error_classification,
      errorCode: row.error_code,
      startedAt: row.started_at.toISOString(),
      finishedAt: row.finished_at?.toISOString() ?? null,
      durationMs: row.finished_at
        ? row.finished_at.getTime() - row.started_at.getTime()
        : null,
      finalProviderId: row.final_provider_id,
      finalProviderCode: row.final_provider_code,
      finalProviderName: row.final_provider_name,
      finalProviderResourceId: row.final_resource_id,
      finalProviderResourceName: row.final_resource_name,
      overage: row.overage,
      totalInputTokens: row.total_input_tokens.toString(),
      totalOutputTokens: row.total_output_tokens.toString(),
      totalCacheTokens: row.total_cache_tokens.toString(),
      totalDeductedQuota: row.total_deducted_quota.toString(),
      totalApiCost: row.total_api_cost,
      usageQuality: row.usage_quality,
      attemptCount: Number(row.attempt_count),
    }));

    return { records, total, limit, offset };
  }
}
