import { sql, type RawBuilder } from "kysely";

/** Both manual changes and directory membership retain their effective time. */
export function effectivePrincipalDepartment(
  enterpriseId: string,
  principalId: string | RawBuilder<unknown>,
  at: Date | RawBuilder<unknown>,
) {
  return sql`SELECT department_id,valid_from FROM (
    SELECT profile.department_id,profile.valid_from,0 AS priority FROM principal_accounting_assignment profile
      WHERE profile.enterprise_id=${enterpriseId}::uuid AND profile.principal_id=${principalId}
        AND profile.principal_type='EMPLOYEE' AND profile.valid_from<=${at}
        AND (profile.valid_until IS NULL OR profile.valid_until>${at})
    UNION ALL
    SELECT membership.organization_unit_id AS department_id,membership.valid_from,1 AS priority
      FROM organization_membership membership JOIN principal employee
        ON employee.enterprise_id=membership.enterprise_id AND employee.person_id=membership.person_id
      WHERE employee.enterprise_id=${enterpriseId}::uuid AND employee.id=${principalId}
        AND employee.type='EMPLOYEE' AND membership.is_primary AND membership.valid_from<=${at}
        AND (membership.valid_until IS NULL OR membership.valid_until>${at})
  ) departments ORDER BY valid_from DESC,priority ASC LIMIT 1`;
}
