import { sql, type Transaction } from "kysely";
import type { Database } from "../kysely.js";
import { effectivePrincipalDepartment } from "./principal-department-query.js";
import { markUsageAggregateDirtyForRequest } from "./usage-aggregate-repository.js";

/**
 * 在请求结算事务内冻结部门归属 v1。只读取请求时点有效关系；缺事实就写
 * UNASSIGNED，绝不从可变 department_label 或当前负责人部门猜测历史。
 */
export async function ensureRequestAttributionSnapshot(
  trx: Transaction<Database>,
  enterpriseId: string,
  requestId: string,
): Promise<void> {
  await sql`
    WITH request_fact AS (
      SELECT ar.id AS ai_request_id, ar.started_at AS occurred_at,
             p.id AS source_principal_id, p.type AS principal_type, p.person_id
        FROM ai_request ar
        JOIN principal p ON p.id = ar.principal_id AND p.enterprise_id = ar.enterprise_id
       WHERE ar.enterprise_id = ${enterpriseId}::uuid AND ar.id = ${requestId}::uuid
    ), explicit_project AS (
      SELECT a.project_principal_id
        FROM operating_bill_request_project_assignment a
       WHERE a.enterprise_id = ${enterpriseId}::uuid AND a.ai_request_id = ${requestId}::uuid
       LIMIT 1
    ), resolved AS (
      SELECT r.*, profile.id AS accounting_profile_id,profile.department_id AS accounting_department_id,profile.owner_principal_id,
             CASE WHEN r.principal_type = 'PROJECT' THEN r.source_principal_id WHEN profile.id IS NOT NULL THEN NULL ELSE ep.project_principal_id END AS project_id,
             CASE WHEN r.principal_type = 'PROJECT' OR (profile.id IS NULL AND ep.project_principal_id IS NOT NULL) THEN 'PROJECT'
                  WHEN r.principal_type = 'EMPLOYEE' THEN 'EMPLOYEE_DIRECT' ELSE 'UNASSIGNED' END AS category
        FROM request_fact r LEFT JOIN explicit_project ep ON true
        LEFT JOIN LATERAL (SELECT * FROM principal_accounting_assignment
          WHERE enterprise_id=${enterpriseId}::uuid AND principal_id=r.source_principal_id
            AND valid_from<=r.occurred_at AND (valid_until IS NULL OR valid_until>r.occurred_at)
          ORDER BY version DESC LIMIT 1) profile ON true
    ), relation AS (
      SELECT r.*,
             CASE WHEN r.category='EMPLOYEE_DIRECT' THEN employee_department.department_id
                  WHEN r.accounting_profile_id IS NOT NULL THEN owner_department.department_id ELSE pa.organization_unit_id END AS department_id,
             CASE WHEN r.principal_type = 'PROJECT' THEN 'PROJECT_DIRECT'
                  WHEN r.project_id IS NOT NULL THEN 'EMPLOYEE_PROJECT'
                  WHEN employee_department.department_id IS NOT NULL OR om.organization_unit_id IS NOT NULL THEN 'EMPLOYEE_MEMBERSHIP'
                  ELSE 'UNASSIGNED' END AS source_code
        FROM resolved r
        LEFT JOIN LATERAL (${effectivePrincipalDepartment(enterpriseId, sql`r.owner_principal_id`, sql`r.occurred_at`)}) owner_department ON r.category='PROJECT'
        LEFT JOIN LATERAL (${effectivePrincipalDepartment(enterpriseId, sql`r.source_principal_id`, sql`r.occurred_at`)}) employee_department ON r.category='EMPLOYEE_DIRECT'
        LEFT JOIN LATERAL (
          SELECT organization_unit_id FROM project_department_assignment
           WHERE enterprise_id = ${enterpriseId}::uuid AND project_principal_id = r.project_id
             AND valid_from <= r.occurred_at AND (valid_until IS NULL OR valid_until > r.occurred_at)
           ORDER BY valid_from DESC, id DESC LIMIT 1
        ) pa ON r.category = 'PROJECT'
        LEFT JOIN LATERAL (
          SELECT organization_unit_id FROM organization_membership
           WHERE enterprise_id = ${enterpriseId}::uuid AND person_id = r.person_id AND is_primary
             AND valid_from <= r.occurred_at AND (valid_until IS NULL OR valid_until > r.occurred_at)
           ORDER BY valid_from DESC, id DESC LIMIT 1
        ) om ON r.category = 'EMPLOYEE_DIRECT'
    )
    INSERT INTO request_attribution_snapshot (
      enterprise_id, ai_request_id, source_principal_id, employee_person_id,
      project_principal_id, organization_unit_id, cost_category, attribution_source,
      request_occurred_at, version, snapshot_origin, reason_code
    )
    SELECT ${enterpriseId}::uuid, ai_request_id, source_principal_id,
           CASE WHEN principal_type = 'EMPLOYEE' THEN person_id ELSE NULL END,
           project_id, department_id,
           CASE WHEN department_id IS NULL THEN 'UNASSIGNED' ELSE category END,
           CASE WHEN department_id IS NULL THEN 'UNASSIGNED' ELSE source_code END,
           occurred_at, 1, 'RUNTIME',
           CASE
             WHEN department_id IS NOT NULL THEN NULL
             WHEN category = 'PROJECT' THEN 'PROJECT_DEPARTMENT_MISSING'
             WHEN person_id IS NULL THEN 'PERSON_MISSING'
             ELSE 'PRIMARY_MEMBERSHIP_MISSING'
           END
      FROM relation
    ON CONFLICT (enterprise_id, ai_request_id, version) DO NOTHING
  `.execute(trx);
  await markUsageAggregateDirtyForRequest(trx, enterpriseId, requestId);
}
