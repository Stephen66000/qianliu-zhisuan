import type { Transaction } from "kysely";
import type { Database } from "../kysely.js";
import { refreshEmployeeKeyModels } from "./employee-model-rule-lifecycle.js";

/** Refresh only subjects whose existing grants or assignments depend on this resource. */
export async function refreshProbeResourceModels(trx: Transaction<Database>, enterpriseId: string,
  resourceId: string, providerCode: string) {
  const [pool, assigned, manual] = await Promise.all([
    trx.selectFrom("principal_grant").select("principal_id").where("enterprise_id", "=", enterpriseId)
      .where("provider", "=", providerCode).where("status", "=", "ACTIVE").execute(),
    trx.selectFrom("employee_model_rule_assignment").select("principal_id")
      .where("enterprise_id", "=", enterpriseId).where("provider_resource_id", "=", resourceId)
      .where("status", "=", "ACTIVE").execute(),
    trx.selectFrom("principal_model_manual_authorization").innerJoin("model_route", join => join
      .onRef("model_route.enterprise_id", "=", "principal_model_manual_authorization.enterprise_id")
      .onRef("model_route.unified_model_id", "=", "principal_model_manual_authorization.unified_model_id"))
      .select("principal_model_manual_authorization.principal_id")
      .where("principal_model_manual_authorization.enterprise_id", "=", enterpriseId)
      .where("model_route.provider_resource_id", "=", resourceId).execute(),
  ]);
  const ids = [...new Set([...pool, ...assigned, ...manual].map(row => row.principal_id))].sort();
  for (const id of ids) await refreshEmployeeKeyModels(trx, enterpriseId, id);
}
