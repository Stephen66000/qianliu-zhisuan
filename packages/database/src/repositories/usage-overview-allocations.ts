import { sql, type Kysely } from "kysely";
import type { Database } from "../kysely.js";
import type { UsageOverviewRankingItem } from "./usage-overview-repository.js";

export async function loadEmployeeAllocations(db: Kysely<Database>, enterpriseId: string, subjectIds: string[], at: Date) {
  type Allocation = NonNullable<UsageOverviewRankingItem["providerAllocations"]>[number];
  const rows = await sql<Allocation & { principalId: string }>`
    SELECT g.principal_id AS "principalId", g.provider, COALESCE(p.name, g.provider) AS name,
           COALESCE(q.limit_value, g.quota_value)::text AS amount,
           COALESCE(q.quota_basis, g.quota_basis,
             CASE (SELECT CASE WHEN count(DISTINCT r.mode)=1 THEN min(r.mode) END
                     FROM provider_resource r WHERE r.enterprise_id=g.enterprise_id
                       AND r.provider_id=p.id AND r.archived_at IS NULL AND r.status NOT IN ('DELETED','DISABLED'))
               WHEN 'API' THEN 'RAW_TOKEN' WHEN 'CODING_PLAN' THEN 'PLAN_QUOTA' END) AS basis
      FROM principal_grant g
      LEFT JOIN provider p ON p.enterprise_id=g.enterprise_id AND p.code=g.provider
      LEFT JOIN principal_quota_period q ON q.enterprise_id=g.enterprise_id AND q.principal_id=g.principal_id
       AND q.provider=g.provider AND q.period_start<=${at} AND q.period_end>${at}
     WHERE g.enterprise_id=${enterpriseId} AND g.principal_id=ANY(${subjectIds}::uuid[])
       AND g.status='ACTIVE' AND g.pool_model_alias='*'
       AND g.valid_from<=${at} AND (g.valid_until IS NULL OR g.valid_until>${at})
     ORDER BY g.principal_id, name, g.provider
  `.execute(db);
  const bySubject = new Map<string, Allocation[]>();
  for (const { principalId, ...row } of rows.rows) {
    const list = bySubject.get(principalId) ?? [];
    list.push(row);
    bySubject.set(principalId, list);
  }
  return bySubject;
}
