/**
 * 用量账本仓储（W18/W20/POOL-012）—— 企业内请求级分页、搜索与组合筛选。
 *
 * 已结算金额只消费冻结事实；请求列表同时保留尚未生成 ledger_transaction 的真实请求。
 * 最终资源来自 ledger_line/upstream_attempt，超额来自 ledger_transaction.overage；
 * 不会根据当前 Grant/Counter 重算历史。
 */
import type { Kysely, RawBuilder } from "kysely";
import { sql } from "kysely";
import type { Database } from "../kysely.js";

export interface UsageQuery {
  enterpriseId: string;
  /** 主体、部门或归属项目名称的部分搜索；兼容旧请求 ID 搜索（字面量）。 */
  search?: string;
  principalId?: string;
  projectId?: string;
  /** 2.0 概览下钻时限定主体口径；不传时保持 1.0 全部明细语义。 */
  subjectType?: "EMPLOYEE" | "PROJECT";
  clientId?: string;
  agentFamily?: string;
  providerId?: string;
  providerResourceId?: string;
  unifiedModel?: string;
  from?: Date;
  to?: Date;
  /** 新增的半开区间上界；旧 to 保持包含语义以兼容 1.0 URL。 */
  toExclusive?: Date;
  status?: string;
  /** 仅查询已结算账本，用于与概览口径守恒。 */
  settledOnly?: boolean;
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
  agentFamily: string;
  agentVersion: string | null;
  agentIdentitySource: string;
  agentIdentityConfidence: string;
  clientIdentityRuleVersion: string;
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
  totalReasoningTokens: string;
  totalDeductedQuota: string;
  totalApiCost: string;
  costCurrency: string | null;
  usageQuality: string;
  attemptCount: number;
  hasSettlement: boolean;
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
  agent_family: string;
  agent_version: string | null;
  agent_identity_source: string;
  agent_identity_confidence: string;
  client_identity_rule_version: string;
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
  cost_currency: string | null;
  overage: boolean | null;
  total_input_tokens: bigint;
  total_output_tokens: bigint;
  total_cache_tokens: bigint;
  total_reasoning_tokens: bigint;
  total_deducted_quota: bigint;
  total_api_cost: string;
  usage_quality: string;
  attempt_count: number | bigint;
  has_settlement: boolean;
}

export class UsageRepository {
  constructor(private db: Kysely<Database>) {}

  async list(query: UsageQuery): Promise<UsageResult> {
    const requestedLimit = Number.isFinite(query.limit) ? Math.trunc(query.limit!) : 50;
    const requestedOffset = Number.isFinite(query.offset) ? Math.trunc(query.offset!) : 0;
    const limit = Math.max(1, Math.min(requestedLimit, 500));
    const offset = Math.max(0, Math.min(requestedOffset, 10_000));
    const conditions: RawBuilder<unknown>[] = [
      sql`ar.enterprise_id = ${query.enterpriseId}`,
      sql`p.enterprise_id = ${query.enterpriseId}`,
    ];

    if (query.principalId) conditions.push(sql`ar.principal_id = ${query.principalId}`);
    const attributedProject = sql`coalesce(
      (
        SELECT ras.project_principal_id
          FROM request_attribution_snapshot ras
         WHERE ras.enterprise_id = ${query.enterpriseId}
           AND ras.ai_request_id = ar.id
         ORDER BY ras.version DESC, ras.created_at DESC, ras.id DESC
         LIMIT 1
      ),
      (
        SELECT opa.project_principal_id
          FROM operating_bill_request_project_assignment opa
         WHERE opa.enterprise_id = ${query.enterpriseId}
           AND opa.ai_request_id = ar.id
         LIMIT 1
      )
    )`;
    const search = query.search?.trim();
    if (search) {
      const containsPattern = `%${search.replace(/[\\%_]/g, "\\$&")}%`;
      const escapeChar = "\\";
      conditions.push(sql`(
        ar.id::text ILIKE ${containsPattern} ESCAPE ${escapeChar}
        OR p.name ILIKE ${containsPattern} ESCAPE ${escapeChar}
        OR p.department_label ILIKE ${containsPattern} ESCAPE ${escapeChar}
        OR EXISTS (
          SELECT 1 FROM principal project
           WHERE project.enterprise_id = ${query.enterpriseId}
             AND project.type = 'PROJECT'
             AND project.id = ${attributedProject}
             AND project.name ILIKE ${containsPattern} ESCAPE ${escapeChar}
        )
      )`);
    }
    if (query.subjectType === "EMPLOYEE") conditions.push(sql`p.type = 'EMPLOYEE'`);
    if (query.subjectType === "PROJECT") {
      conditions.push(sql`(p.type = 'PROJECT' OR ${attributedProject} IS NOT NULL)`);
    }
    if (query.projectId) conditions.push(sql`(
      (p.type = 'PROJECT' AND p.id = ${query.projectId})
      OR ${attributedProject} = ${query.projectId}
    )`);
    if (query.clientId) conditions.push(sql`ar.client_id = ${query.clientId}`);
    if (query.agentFamily) conditions.push(sql`ar.agent_family = ${query.agentFamily}`);
    if (query.unifiedModel) conditions.push(sql`ar.unified_model = ${query.unifiedModel}`);
    if (query.status) conditions.push(sql`ar.status = ${query.status}`);
    if (query.settledOnly) conditions.push(sql`lt.status = 'SETTLED'`);
    const usageTime = query.settledOnly
      ? sql`COALESCE(lt.created_at, ar.started_at)`
      : sql`ar.started_at`;
    if (query.from) conditions.push(sql`${usageTime} >= ${query.from}`);
    if (query.to) conditions.push(sql`${usageTime} <= ${query.to}`);
    if (query.toExclusive) conditions.push(sql`${usageTime} < ${query.toExclusive}`);
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
             WHERE ll.ai_request_id = ar.id
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
        FROM ai_request ar
        INNER JOIN principal p
          ON p.id = ar.principal_id AND p.enterprise_id = ${query.enterpriseId}
        LEFT JOIN ledger_transaction lt
          ON lt.ai_request_id = ar.id AND lt.enterprise_id = ${query.enterpriseId}
       WHERE ${where}
    `.execute(this.db);
    const total = Number(countResult.rows[0]?.cnt ?? 0);

    const result = await sql<UsageSqlRow>`
      SELECT
        ar.id AS request_id,
        ar.principal_id,
        p.name AS principal_name,
        p.type AS principal_type,
        ar.client_id,
        ar.agent_family,
        ar.agent_version,
        ar.agent_identity_source,
        ar.agent_identity_confidence,
        ar.client_identity_rule_version,
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
        final_resource.cost_currency AS cost_currency,
        lt.overage,
        COALESCE(lt.total_input_tokens, 0) AS total_input_tokens,
        COALESCE(lt.total_output_tokens, 0) AS total_output_tokens,
        COALESCE(lt.total_cache_tokens, 0) AS total_cache_tokens,
        COALESCE(lt.total_reasoning_tokens, 0) AS total_reasoning_tokens,
        COALESCE(lt.total_deducted_quota, 0) AS total_deducted_quota,
        COALESCE(lt.total_api_cost, 0)::text AS total_api_cost,
        COALESCE(lt.usage_quality, 'UNKNOWN') AS usage_quality,
        COALESCE(lt.attempt_count, 0) AS attempt_count,
        (lt.id IS NOT NULL) AS has_settlement
      FROM ai_request ar
      INNER JOIN principal p
        ON p.id = ar.principal_id AND p.enterprise_id = ${query.enterpriseId}
      LEFT JOIN ledger_transaction lt
        ON lt.ai_request_id = ar.id AND lt.enterprise_id = ${query.enterpriseId}
      LEFT JOIN LATERAL (
        SELECT
          pv.id AS provider_id,
          pv.code AS provider_code,
          pv.name AS provider_name,
          pr.id AS resource_id,
          pr.name AS resource_name,
          ll.api_cost_currency AS cost_currency
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
        WHERE ll.ai_request_id = ar.id
          AND ll.enterprise_id = ${query.enterpriseId}
        ORDER BY ua.attempt_no DESC, ll.created_at DESC, ll.id DESC
        LIMIT 1
      ) final_resource ON true
      WHERE ${where}
      ORDER BY ar.started_at DESC, ar.id DESC
      LIMIT ${limit}
      OFFSET ${offset}
    `.execute(this.db);

    const records: UsageRecord[] = result.rows.map((row) => ({
      requestId: row.request_id,
      principalId: row.principal_id,
      principalName: row.principal_name,
      principalType: row.principal_type,
      clientId: row.client_id,
      agentFamily: row.agent_family,
      agentVersion: row.agent_version,
      agentIdentitySource: row.agent_identity_source,
      agentIdentityConfidence: row.agent_identity_confidence,
      clientIdentityRuleVersion: row.client_identity_rule_version,
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
      costCurrency: row.cost_currency ?? (Number(row.total_api_cost) > 0 ? "CNY" : null),
      overage: row.overage,
      totalInputTokens: row.total_input_tokens.toString(),
      totalOutputTokens: row.total_output_tokens.toString(),
      totalCacheTokens: row.total_cache_tokens.toString(),
      totalReasoningTokens: row.total_reasoning_tokens.toString(),
      totalDeductedQuota: row.total_deducted_quota.toString(),
      totalApiCost: row.total_api_cost,
      usageQuality: row.usage_quality,
      attemptCount: Number(row.attempt_count),
      hasSettlement: row.has_settlement,
    }));

    return { records, total, limit, offset };
  }

  async summarizePrincipalAgents(enterpriseId: string, principalId: string): Promise<AgentUsageSummary[]> {
    const result = await sql<{
      agent_family: string;
      latest_version: string | null;
      identity_source: string;
      identity_sources: string[];
      identity_confidence: string;
      first_used_at: Date;
      last_used_at: Date;
      request_count: bigint;
      total_tokens: bigint;
      total_api_cost: string;
      models: string[];
    }>`
      SELECT
        ar.agent_family,
        (array_agg(ar.agent_version ORDER BY ar.started_at DESC) FILTER (WHERE ar.agent_version IS NOT NULL))[1] AS latest_version,
        (array_agg(ar.agent_identity_source ORDER BY ar.started_at DESC))[1] AS identity_source,
        array_agg(DISTINCT ar.agent_identity_source ORDER BY ar.agent_identity_source) AS identity_sources,
        (array_agg(ar.agent_identity_confidence ORDER BY ar.started_at DESC))[1] AS identity_confidence,
        min(ar.started_at) AS first_used_at,
        max(ar.started_at) AS last_used_at,
        count(*) AS request_count,
        COALESCE(sum(lt.total_input_tokens + lt.total_output_tokens), 0) AS total_tokens,
        COALESCE(sum(lt.total_api_cost), 0)::text AS total_api_cost,
        array_agg(DISTINCT ar.unified_model) AS models
      FROM ai_request ar
      LEFT JOIN ledger_transaction lt
        ON lt.ai_request_id = ar.id AND lt.enterprise_id = ${enterpriseId}
      WHERE ar.enterprise_id = ${enterpriseId} AND ar.principal_id = ${principalId}
      GROUP BY ar.agent_family
      ORDER BY max(ar.started_at) DESC, ar.agent_family ASC
    `.execute(this.db);
    return result.rows.map((row) => ({
      agentFamily: row.agent_family,
      latestVersion: row.latest_version,
      identitySource: row.identity_source,
      identitySources: row.identity_sources,
      identityConfidence: row.identity_confidence,
      firstUsedAt: row.first_used_at.toISOString(),
      lastUsedAt: row.last_used_at.toISOString(),
      requestCount: row.request_count.toString(),
      totalTokens: row.total_tokens.toString(),
      totalApiCost: row.total_api_cost,
      models: row.models,
    }));
  }

  async listExpectedAgentFamilies(enterpriseId: string, principalId: string): Promise<string[]> {
    const rows = await this.db.selectFrom("principal_agent_expectation")
      .select("agent_family")
      .where("enterprise_id", "=", enterpriseId)
      .where("principal_id", "=", principalId)
      .orderBy("agent_family", "asc")
      .execute();
    return rows.map((row) => row.agent_family);
  }

  async replaceExpectedAgentFamilies(enterpriseId: string, principalId: string, families: string[]): Promise<string[]> {
    const unique = [...new Set(families)];
    await this.db.transaction().execute(async (trx) => {
      await trx.deleteFrom("principal_agent_expectation")
        .where("enterprise_id", "=", enterpriseId).where("principal_id", "=", principalId).execute();
      if (unique.length > 0) await trx.insertInto("principal_agent_expectation").values(
        unique.map((agentFamily) => ({ enterprise_id: enterpriseId, principal_id: principalId, agent_family: agentFamily })),
      ).execute();
    });
    return this.listExpectedAgentFamilies(enterpriseId, principalId);
  }
}

export interface AgentUsageSummary {
  agentFamily: string;
  latestVersion: string | null;
  identitySource: string;
  identitySources: string[];
  identityConfidence: string;
  firstUsedAt: string;
  lastUsedAt: string;
  requestCount: string;
  totalTokens: string;
  totalApiCost: string;
  models: string[];
}
