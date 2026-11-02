import { sql, type Kysely } from "kysely";
import type { Database } from "@qianliu/database";
import { formatModelName } from "./format-utils.js";

export interface ModelUsageSummary {
  model: string;
  tokens: number;
  requestCount: number;
}

export interface ModelUsageForRange {
  models: ModelUsageSummary[];
  totalModels: number;
}

/** 保留周报、月报与激励的既有 Top-N 调用合同。 */
export async function queryTopModelsForRange(
  db: Kysely<Database>, enterpriseId: string, rangeStart: Date, rangeEnd: Date,
  principalId?: string, limit = 5, employeesOnly = false,
): Promise<ModelUsageSummary[]> {
  return (await queryModelUsageForRange(db, enterpriseId, rangeStart, rangeEnd, principalId, limit, employeesOnly)).models;
}

/** 同一次查询内统计完整模型数，再应用展示条数限制，保持数据快照一致。 */
export async function queryModelUsageForRange(
  db: Kysely<Database>,
  enterpriseId: string,
  rangeStart: Date,
  rangeEnd: Date,
  principalId?: string,
  limit: number = 5,
  employeesOnly: boolean = false,
): Promise<ModelUsageForRange> {
  try {
    const principalFilter = principalId ? sql`AND lt.principal_id = ${principalId}` : sql``;
    const employeeFilter = employeesOnly ? sql`AND EXISTS (SELECT 1 FROM principal pr WHERE pr.id=ar.principal_id AND pr.enterprise_id=ar.enterprise_id AND pr.type='EMPLOYEE')` : sql``;
    const result = await sql<{
      model_name: string | null;
      model_count: string | number | bigint;
      request_count: string | number | bigint;
      total_tokens: string | number | bigint;
    }>`
      SELECT COALESCE(um.display_name, ar.unified_model) AS model_name,
             COUNT(*) OVER () AS model_count,
             COUNT(ar.id) AS request_count,
             COALESCE(SUM(lt.total_input_tokens + lt.total_output_tokens), 0) AS total_tokens
        FROM ledger_transaction lt
        JOIN ai_request ar
          ON ar.id = lt.ai_request_id AND ar.enterprise_id = lt.enterprise_id
        LEFT JOIN unified_model um
          ON (um.id = ar.unified_model_id OR um.alias = ar.unified_model)
         AND um.enterprise_id = ar.enterprise_id
       WHERE lt.enterprise_id = ${enterpriseId}
         AND lt.status = 'SETTLED'
         AND ar.status = 'SUCCEEDED'
         AND lt.created_at >= ${rangeStart}
         AND lt.created_at < ${rangeEnd}
         ${principalFilter}
         ${employeeFilter}
       GROUP BY COALESCE(um.display_name, ar.unified_model)
       ORDER BY total_tokens DESC, request_count DESC
       LIMIT ${limit}
    `.execute(db);

    const rows = result.rows || [];
    if (rows.length > 0) {
      const models = rows.map((r) => ({
        model: formatModelName(r.model_name ?? "通用模型"),
        tokens: Number(r.total_tokens ?? 0),
        requestCount: Number(r.request_count ?? 0),
      }));
      return { models, totalModels: Number(rows[0]!.model_count) };
    }
    if (employeesOnly) return { models: [], totalModels: 0 }; // Closed-month reports use the same settled facts as their totals.

    // 备用兜底查询 usage_event
    const fallbackRows = await db
      .selectFrom("ai_request as r")
      .innerJoin("usage_event as u", "u.ai_request_id", "r.id")
      .leftJoin("unified_model as um", (join) =>
        join.on((eb) =>
          eb.and([
            eb("um.enterprise_id", "=", eb.ref("r.enterprise_id")),
            eb.or([
              eb("um.id", "=", eb.ref("r.unified_model_id")),
              eb("um.alias", "=", eb.ref("r.unified_model")),
            ]),
          ]),
        ),
      )
      .select([
        sql<string>`COALESCE(um.display_name, r.unified_model)`.as("unified_model"),
        sql<string>`coalesce(sum(u.input_tokens + u.output_tokens), 0)`.as("total_tokens"),
        sql<string>`count(r.id)`.as("req_count"),
        sql<string>`count(*) over ()`.as("model_count"),
      ])
      .where("r.enterprise_id", "=", enterpriseId)
      .where("r.status", "=", "SUCCEEDED")
      .where("r.started_at", ">=", rangeStart)
      .where("r.started_at", "<", rangeEnd)
      .$if(employeesOnly, qb => qb.where(sql<boolean>`EXISTS (SELECT 1 FROM principal pr WHERE pr.id=r.principal_id AND pr.enterprise_id=r.enterprise_id AND pr.type='EMPLOYEE')`))
      .$if(Boolean(principalId), (qb) => qb.where("r.principal_id", "=", principalId!))
      .groupBy(sql`COALESCE(um.display_name, r.unified_model)`)
      .orderBy(sql`sum(u.input_tokens + u.output_tokens)`, "desc")
      .limit(limit)
      .execute();

    const models = fallbackRows.map((m) => ({
      model: formatModelName(m.unified_model),
      tokens: Number(m.total_tokens),
      requestCount: Number(m.req_count),
    }));
    return { models, totalModels: Number(fallbackRows[0]?.model_count ?? 0) };
  } catch {
    throw new Error("REPORT_MODEL_FACTS_UNAVAILABLE");
  }
}
