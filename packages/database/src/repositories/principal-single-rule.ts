import { randomUUID } from "node:crypto";
import type { Transaction } from "kysely";
import type { Database } from "../kysely.js";
import type { AccessConfigPutInput } from "./principal-access-config-repository.js";

function jsonValue<T>(value: T): T {
  return JSON.stringify(value) as unknown as T;
}

/** 单主体配置只复用草稿/校验版本；已发布版本必须递增新版本，避免静默覆盖。 */
export async function ensureSingleRule(
  trx: Transaction<Database>,
  input: AccessConfigPutInput,
): Promise<string> {
  const existing = await trx.selectFrom("employee_model_rule_version")
    .select(["id", "rule_id", "version", "status"])
    .where("enterprise_id", "=", input.enterpriseId).where("owner_principal_id", "=", input.principalId)
    .orderBy("version", "desc").forUpdate().executeTakeFirst();
  if (existing && (existing.status === "DRAFT" || existing.status === "VALIDATED")) return existing.id;
  const ruleId = existing?.rule_id ?? randomUUID();
  const version = existing ? existing.version + 1 : 1;
  const created = await trx.insertInto("employee_model_rule_version").values({
    enterprise_id: input.enterpriseId, rule_id: ruleId, version,
    name: `接入配置-${input.principalId}`, employee_scope: "SELECTED",
    principal_ids: jsonValue([input.principalId]), model_scope: "SELECTED",
    model_targets: jsonValue([]), quota_value: null, allow_overage: false,
    valid_from: new Date(), valid_until: null, owner_principal_id: input.principalId,
    created_by_admin_user_id: input.adminUserId, status: "DRAFT",
  }).returning("id").executeTakeFirstOrThrow();
  return created.id;
}
