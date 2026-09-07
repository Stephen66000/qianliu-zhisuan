import { sql, type RawBuilder } from "kysely";

import { effectivePrincipalDepartment } from "./principal-department-query.js";
import type { OperatingBillAccountFact } from "./operating-bill-account-aggregate.js";
import type { OperatingBillAccountSubjectRow } from "./operating-bill-account-types.js";

export interface RawProjectMetadata {
  project_owner_person_id: string | null;
  project_owner_name: string | null;
  project_department_id: string | null;
  project_department_name: string | null;
}

export interface RawProjectSummaryMetadata {
  project_owner_person_id: string | null;
  project_owner_name: string | null;
  project_departments: Array<{ departmentId: string; departmentName: string }>;
}

/** 依赖调用方已声明 ll/source/assignment 别名；只解析稳定项目、负责人和请求时点部门。 */
export function liveProjectMetadataJoins(
  enterpriseId: string,
): RawBuilder<unknown> {
  return sql`
    LEFT JOIN LATERAL (
      SELECT snapshot.id, snapshot.project_principal_id, snapshot.organization_unit_id
        FROM request_attribution_snapshot snapshot
       WHERE snapshot.enterprise_id = ${enterpriseId}
         AND snapshot.ai_request_id = ll.ai_request_id
       ORDER BY snapshot.version DESC, snapshot.created_at DESC, snapshot.id DESC
       LIMIT 1
    ) attribution ON true
    LEFT JOIN principal project
      ON project.id = CASE
           WHEN source.type = 'PROJECT' THEN source.id
           WHEN attribution.id IS NOT NULL THEN attribution.project_principal_id
           ELSE assignment.project_principal_id
         END
     AND project.enterprise_id = ${enterpriseId} AND project.type = 'PROJECT'
    LEFT JOIN LATERAL (SELECT * FROM principal_accounting_assignment
      WHERE enterprise_id=${enterpriseId}::uuid AND principal_id=project.id
        AND valid_from<=ll.created_at AND (valid_until IS NULL OR valid_until>ll.created_at)
      ORDER BY version DESC LIMIT 1) accounting_profile ON true
    LEFT JOIN principal accounting_owner ON accounting_owner.enterprise_id=${enterpriseId}::uuid
      AND accounting_owner.id=accounting_profile.owner_principal_id
    LEFT JOIN LATERAL (${effectivePrincipalDepartment(enterpriseId, sql`accounting_owner.id`, sql`ll.created_at`)}) accounting_owner_department ON true
    LEFT JOIN person project_owner
      ON project_owner.id = COALESCE(accounting_owner.person_id,project.owner_person_id)
     AND project_owner.enterprise_id = ${enterpriseId}
    LEFT JOIN LATERAL (
      SELECT project_assignment.organization_unit_id
        FROM project_department_assignment project_assignment
       WHERE project_assignment.enterprise_id = ${enterpriseId}
         AND project_assignment.project_principal_id = project.id
         AND project_assignment.valid_from <= ll.created_at
         AND (project_assignment.valid_until IS NULL
           OR project_assignment.valid_until > ll.created_at)
       ORDER BY project_assignment.valid_from DESC,
                project_assignment.version DESC, project_assignment.id DESC
       LIMIT 1
    ) project_assignment ON true
    LEFT JOIN organization_unit project_department
      ON project.id IS NOT NULL
     AND project_department.id = CASE
           WHEN attribution.id IS NOT NULL THEN attribution.organization_unit_id
           WHEN accounting_profile.id IS NOT NULL THEN accounting_owner_department.department_id
           ELSE project_assignment.organization_unit_id
         END
     AND project_department.enterprise_id = ${enterpriseId}
  `;
}

export function projectMetadataSummarySql(): RawBuilder<unknown> {
  return sql`
    MIN(project_owner_person_id::text)::uuid AS project_owner_person_id,
    MIN(project_owner_name) AS project_owner_name,
    COALESCE(
      jsonb_agg(DISTINCT jsonb_build_object(
        'departmentId', project_department_id,
        'departmentName', project_department_name
      )) FILTER (WHERE project_department_id IS NOT NULL),
      '[]'::jsonb
    ) AS project_departments
  `;
}

export function mapRawProjectMetadata(row: RawProjectMetadata): Pick<
  OperatingBillAccountFact,
  "projectOwnerPersonId" | "projectOwnerName" | "projectDepartmentId" | "projectDepartmentName"
> {
  return {
    projectOwnerPersonId: row.project_owner_person_id,
    projectOwnerName: row.project_owner_name,
    projectDepartmentId: row.project_department_id,
    projectDepartmentName: row.project_department_name,
  };
}

export function projectSummaryMetadata(
  row: RawProjectSummaryMetadata,
  dimension: "EMPLOYEE" | "PROJECT",
): Pick<OperatingBillAccountSubjectRow, "projectOwner" | "projectDepartments"> {
  return {
    projectOwner:
      dimension === "PROJECT" && row.project_owner_name
        ? {
            personId: row.project_owner_person_id,
            personName: row.project_owner_name,
          }
        : null,
    projectDepartments: dimension === "PROJECT"
      ? [...row.project_departments].sort((left, right) =>
        left.departmentName.localeCompare(right.departmentName)
          || left.departmentId.localeCompare(right.departmentId))
      : [],
  };
}
