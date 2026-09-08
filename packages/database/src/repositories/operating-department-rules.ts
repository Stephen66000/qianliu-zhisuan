import { sql } from "kysely";
import { effectivePrincipalDepartment } from "./principal-department-query.js";

/** One tenant-scoped projection of the saved rules, shared by project headings and open department bills.
 * Employee -> saved department; project -> saved owner's department. Materialize once, not per ledger line.
 * It only supplies missing attribution in an open bill; existing snapshots and closed bills remain authoritative.
 */
export function currentDepartmentRulesCte(enterpriseId: string) {
  return sql`current_department_rules AS MATERIALIZED (
    SELECT subject.id AS principal_id,subject.type AS principal_type,
      COALESCE(owner.person_id,legacy_owner.id) AS owner_person_id,
      COALESCE(owner.name,legacy_owner.name) AS owner_name,
      department.id AS department_id,department.name AS department_name
    FROM principal subject
    LEFT JOIN LATERAL (SELECT * FROM principal_accounting_assignment setting
      WHERE setting.enterprise_id=${enterpriseId}::uuid AND setting.principal_id=subject.id
        AND setting.valid_from<=CURRENT_TIMESTAMP AND setting.valid_until IS NULL
      ORDER BY setting.version DESC LIMIT 1) setting ON true
    LEFT JOIN principal owner ON owner.enterprise_id=${enterpriseId}::uuid AND owner.id=setting.owner_principal_id
    LEFT JOIN person legacy_owner ON legacy_owner.enterprise_id=${enterpriseId}::uuid AND legacy_owner.id=subject.owner_person_id
    LEFT JOIN LATERAL (${effectivePrincipalDepartment(enterpriseId,
      sql`CASE WHEN subject.type='PROJECT' THEN owner.id ELSE subject.id END`, sql`CURRENT_TIMESTAMP`)}) saved_department ON true
    LEFT JOIN LATERAL (SELECT organization_unit_id FROM project_department_assignment legacy
      WHERE legacy.enterprise_id=${enterpriseId}::uuid AND legacy.project_principal_id=subject.id
        AND legacy.valid_from<=CURRENT_TIMESTAMP AND (legacy.valid_until IS NULL OR legacy.valid_until>CURRENT_TIMESTAMP)
      ORDER BY legacy.valid_from DESC,legacy.version DESC LIMIT 1) legacy_department ON subject.type='PROJECT'
    LEFT JOIN organization_unit department ON department.enterprise_id=${enterpriseId}::uuid
      AND department.id=CASE WHEN subject.type='PROJECT' AND setting.id IS NOT NULL
        THEN saved_department.department_id ELSE COALESCE(saved_department.department_id,legacy_department.organization_unit_id) END
    WHERE subject.enterprise_id=${enterpriseId}::uuid
  )`;
}
