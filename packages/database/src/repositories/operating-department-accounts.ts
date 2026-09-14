import { sql, type Kysely } from "kysely";
import type { Database } from "../kysely.js";
import type {
  OperatingBillAccountSubjectRow,
  OperatingBillAccountTotals,
} from "./operating-bill-account-types.js";
import { liveLineFactCtes } from "./operating-bill-account-month-lines.js";
import { finishAccountSummary } from "./operating-bill-account-aggregate.js";
import { loadDepartmentBill } from "./department-cost-evidence.js";

interface RawDepartmentAccount {
  level: string;
  department_id: string | null;
  department_name: string | null;
  provider_code: string | null;
  provider_name: string | null;
  input: string;
  output: string;
  cache: string;
  api: string | null;
  known_api?: string | null;
  subscription: string | null;
  quality: string | null;
  days: string;
  requests: string;
  last_at: Date | null;
}
const mapTotals = (row: RawDepartmentAccount | undefined) =>
  finishAccountSummary({
    inputTokens: row?.input ?? "0",
    outputTokens: row?.output ?? "0",
    cacheTokens: row?.cache ?? "0",
    reasoningTokens: "0",
    apiCost: row ? row.api : "0",
    knownApiCost: row?.known_api,
    packageAllocatedCost: row ? row.subscription : "0",
    deductedQuota: "0",
    qualities: row?.quality?.split(",") ?? [],
    activeDays: Number(row?.days ?? 0),
    requestCount: Number(row?.requests ?? 0),
    lastUsedAt: row?.last_at ?? null,
  });

export async function loadOperatingDepartmentAccounts(
  db: Kysely<Database>,
  enterpriseId: string,
  month: string,
) {
  return db
    .transaction()
    .setIsolationLevel("repeatable read")
    .execute(async (trx) => {
      await sql`SET TRANSACTION READ ONLY`.execute(trx);
      const period = await trx
        .selectFrom("operating_bill_period")
        .select("status")
        .where("enterprise_id", "=", enterpriseId)
        .where("period_month", "=", `${month}-01`)
        .executeTakeFirst();
      if (period?.status === "CLOSED") {
        const legacy = await loadDepartmentBill(trx, enterpriseId, month);
        const makeTotals = (
          input: string,
          output: string,
          actual: string,
          api: string | null,
          subscription: string | null,
          total: string | null,
          requests: number,
        ): OperatingBillAccountTotals => ({
          inputTokens: input,
          outputTokens: output,
          cacheTokens: null,
          reasoningTokens: null,
          totalTokens: actual,
          allocatedQuota: "0",
          apiCost: api,
          packageAllocatedCost: subscription,
          totalAllocatedCost: total,
          deductedQuota: null,
          activeDays: null,
          requestCount: requests,
          lastUsedAt: null,
          usageQuality: "ACCOUNT_AGGREGATED",
        });
        return {
          month,
          status: "CLOSED" as const,
          totals: makeTotals(
            legacy.totals.inputTokens,
            legacy.totals.outputTokens,
            legacy.totals.actualTokens,
            legacy.totals.apiCost,
            legacy.totals.packageCost,
            legacy.totals.totalCost,
            legacy.totals.requestCount,
          ),
          rows: legacy.rows
            .filter((row) => row.requestCount > 0)
            .map((row) => ({
              subjectId: row.departmentId,
              subjectName: row.departmentName,
              isUnassigned: row.isUnassigned,
              allocatedQuota: "0",
              projectOwner: null,
              projectDepartments: [],
              providers: [
                { providerCode: "deepseek", providerName: "DeepSeek" },
                { providerCode: "kimi", providerName: "Kimi" },
                { providerCode: "zhipu", providerName: "智谱" },
              ],
              totals: makeTotals(
                row.inputTokens,
                row.outputTokens,
                row.actualTokens,
                row.apiCost,
                row.packageAllocatedCost,
                row.totalCost,
                row.requestCount,
              ),
            })),
        };
      }
      const [result, deptQuotas, totalDeptQuota] = await Promise.all([
        sql<RawDepartmentAccount>`WITH ${liveLineFactCtes(enterpriseId, month)}
      SELECT CASE WHEN GROUPING(line.department_id)=1 THEN 'TOTAL' WHEN GROUPING(line.provider_code)=1 THEN 'DEPARTMENT' ELSE 'PROVIDER' END AS level,
        line.department_id,department.name AS department_name,line.provider_code,line.provider_name,
        SUM(raw_input_tokens)::text AS input,SUM(raw_output_tokens)::text AS output,SUM(raw_cache_tokens)::text AS cache,
        (CASE WHEN COUNT(*) FILTER(WHERE resource_mode='API' AND api_cost IS NULL)>0 THEN NULL
          ELSE COALESCE(SUM(api_cost) FILTER(WHERE resource_mode='API'),0) END)::text AS api,
        COALESCE(SUM(api_cost) FILTER(WHERE resource_mode='API'),0)::text AS known_api,
        (CASE WHEN COUNT(*) FILTER(WHERE resource_mode='CODING_PLAN' AND package_line_cost IS NULL)>0 THEN NULL
          ELSE COALESCE(SUM(package_line_cost) FILTER(WHERE resource_mode='CODING_PLAN'),0) END)::text AS subscription,
        STRING_AGG(DISTINCT usage_quality,',') AS quality,COUNT(DISTINCT (line.created_at AT TIME ZONE 'Asia/Shanghai')::date)::text AS days,
        COUNT(DISTINCT request_id)::text AS requests,MAX(line.created_at) AS last_at
        FROM line_facts line LEFT JOIN organization_unit department ON department.enterprise_id=${enterpriseId}::uuid AND department.id=line.department_id
        GROUP BY GROUPING SETS((line.department_id,department.name,line.provider_code,line.provider_name),(line.department_id,department.name),())`.execute(
          trx,
        ),
        sql<{ department_id: string; allocated_quota: string }>`
          SELECT om.organization_unit_id AS department_id, COALESCE(SUM(pg.quota_value), 0)::text AS allocated_quota
            FROM organization_membership om
            JOIN principal pr ON pr.person_id = om.person_id AND pr.enterprise_id = ${enterpriseId}::uuid
            JOIN principal_grant pg ON pg.principal_id = pr.id AND pg.enterprise_id = ${enterpriseId}::uuid
           WHERE om.enterprise_id = ${enterpriseId}::uuid
             AND pg.status = 'ACTIVE'
             AND (pg.valid_until IS NULL OR pg.valid_until > (${`${month}-01`}::date + interval '1 month'))
             AND (om.valid_until IS NULL OR om.valid_until > (${`${month}-01`}::date + interval '1 month'))
           GROUP BY om.organization_unit_id
        `.execute(trx),
        sql<{ total_allocated_quota: string }>`
          SELECT COALESCE(SUM(pg.quota_value), 0)::text AS total_allocated_quota
            FROM principal_grant pg
            JOIN principal pr ON pr.id = pg.principal_id AND pr.enterprise_id = ${enterpriseId}::uuid AND pr.type = 'EMPLOYEE'
           WHERE pg.enterprise_id = ${enterpriseId}::uuid
             AND pg.status = 'ACTIVE'
             AND (pg.valid_until IS NULL OR pg.valid_until > (${`${month}-01`}::date + interval '1 month'))
        `.execute(trx),
      ]);
      const deptQuotaMap = new Map<string, string>();
      for (const dq of deptQuotas.rows) {
        deptQuotaMap.set(dq.department_id, dq.allocated_quota);
      }
      const totalAllocatedQuota = totalDeptQuota.rows[0]?.total_allocated_quota ?? "0";
      const rows: OperatingBillAccountSubjectRow[] = result.rows
        .filter((row) => row.level === "DEPARTMENT")
        .map((row) => {
          const quota = row.department_id ? deptQuotaMap.get(row.department_id) ?? "0" : "0";
          return {
            subjectId: row.department_id,
            subjectName: row.department_name ?? "待归属",
            isUnassigned: row.department_id === null,
            allocatedQuota: quota,
            projectOwner: null,
            projectDepartments: [],
            providers: [],
            totals: {
              ...mapTotals(row),
              allocatedQuota: quota,
            },
          };
        });
      for (const fact of result.rows.filter(
        (row) => row.level === "PROVIDER",
      )) {
        const row = rows.find((row) => row.subjectId === fact.department_id);
        if (row && fact.provider_code && fact.provider_name)
          row.providers.push({
            providerCode: fact.provider_code,
            providerName: fact.provider_name,
            totals: mapTotals(fact),
          });
      }
      rows.sort(
        (a, b) =>
          Number(a.isUnassigned) - Number(b.isUnassigned) ||
          a.subjectName.localeCompare(b.subjectName),
      );
      return {
        month,
        status: "DRAFT" as const,
        rows,
        totals: {
          ...mapTotals(result.rows.find((row) => row.level === "TOTAL")),
          allocatedQuota: totalAllocatedQuota,
        },
      };
    });
}
