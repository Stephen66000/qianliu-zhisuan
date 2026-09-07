import { sql, type Kysely } from "kysely";
import type { Database } from "../kysely.js";
import type { PrincipalCleanupPreview } from "./principal-repository.js";

export async function readPrincipalCleanupPreview(
  db: Kysely<Database>,
  enterpriseId: string,
  id: string,
): Promise<PrincipalCleanupPreview> {
  const queryResult = await sql<{
    key_count: string;
    active_key_count: string;
    grant_count: string;
    active_grant_count: string;
    request_count: string;
    usage_count: string;
    ledger_count: string;
    employee_login_count: string;
    authorization_rule_assignment_count: string;
    accounting_assignment_count: string;
  }>`
    SELECT
      (SELECT count(*) FROM principal_key
        WHERE enterprise_id = ${enterpriseId}::uuid AND principal_id = ${id}::uuid) AS key_count,
      (SELECT count(*) FROM principal_key
        WHERE enterprise_id = ${enterpriseId}::uuid AND principal_id = ${id}::uuid
          AND status = 'ACTIVE') AS active_key_count,
      (SELECT count(*) FROM principal_grant
        WHERE enterprise_id = ${enterpriseId}::uuid AND principal_id = ${id}::uuid) AS grant_count,
      (SELECT count(*) FROM principal_grant
        WHERE enterprise_id = ${enterpriseId}::uuid AND principal_id = ${id}::uuid
          AND status = 'ACTIVE') AS active_grant_count,
      (SELECT count(*) FROM ai_request
        WHERE enterprise_id = ${enterpriseId}::uuid AND principal_id = ${id}::uuid) AS request_count,
      (SELECT count(*) FROM usage_event ue
        JOIN upstream_attempt ua ON ua.id = ue.upstream_attempt_id
        JOIN ai_request ar ON ar.id = ua.ai_request_id
        WHERE ar.enterprise_id = ${enterpriseId}::uuid AND ar.principal_id = ${id}::uuid) AS usage_count,
      ((SELECT count(*) FROM ledger_line
        WHERE enterprise_id = ${enterpriseId}::uuid AND principal_id = ${id}::uuid) +
       (SELECT count(*) FROM ledger_transaction
        WHERE enterprise_id = ${enterpriseId}::uuid AND principal_id = ${id}::uuid)) AS ledger_count,
      (SELECT count(*) FROM employee_login
        WHERE principal_id = ${id}::uuid) AS employee_login_count,
      (SELECT count(*) FROM employee_model_rule_assignment
        WHERE enterprise_id = ${enterpriseId}::uuid AND principal_id = ${id}::uuid)
        AS authorization_rule_assignment_count,
      ((SELECT count(*) FROM principal_accounting_assignment WHERE enterprise_id=${enterpriseId}::uuid
        AND (principal_id=${id}::uuid OR owner_principal_id=${id}::uuid)) +
       (SELECT count(*) FROM organization_membership membership JOIN principal employee
        ON employee.enterprise_id=membership.enterprise_id AND employee.person_id=membership.person_id
        WHERE employee.enterprise_id=${enterpriseId}::uuid AND employee.id=${id}::uuid)) AS accounting_assignment_count
  `.execute(db);
  const result = queryResult.rows[0];
  if (!result)
    throw new Error("principal cleanup preview query returned no row");
  const preview = {
    keyCount: Number(result.key_count),
    activeKeyCount: Number(result.active_key_count),
    grantCount: Number(result.grant_count),
    activeGrantCount: Number(result.active_grant_count),
    requestCount: Number(result.request_count),
    usageCount: Number(result.usage_count),
    ledgerCount: Number(result.ledger_count),
    employeeLoginCount: Number(result.employee_login_count),
    authorizationRuleAssignmentCount: Number(
      result.authorization_rule_assignment_count,
    ),
    accountingAssignmentCount: Number(result.accounting_assignment_count ?? 0),
    canDelete: false,
  };
  preview.canDelete =
    preview.requestCount === 0 &&
    preview.usageCount === 0 &&
    preview.ledgerCount === 0 &&
    preview.employeeLoginCount === 0 &&
    preview.authorizationRuleAssignmentCount === 0 &&
    preview.accountingAssignmentCount === 0;
  return preview;
}
