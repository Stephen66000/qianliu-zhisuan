import { sql, type Kysely } from "kysely";
import type { Database } from "@qianliu/database";
import { IDS } from "./seed-e2e-ids.js";

export async function seedE2eCatalog(db: Kysely<Database>, passwordHash: string): Promise<void> {
  await db.insertInto("enterprise").values({ id: IDS.enterprise, name: "仟流 M5 E2E 企业" }).execute();
  await db.insertInto("admin_user").values({
    id: IDS.admin, enterprise_id: IDS.enterprise, username: "admin", password_hash: passwordHash, status: "ACTIVE",
  }).execute();
  await sql`INSERT INTO organization_unit (id, enterprise_id, name, external_unit_id)
    VALUES (${IDS.department}::uuid, ${IDS.enterprise}::uuid, 'E2E 研发部', 'E2E/研发部')`.execute(db);
  await db.insertInto("provider").values({
    id: IDS.provider, enterprise_id: IDS.enterprise, code: "zhipu", name: "智谱 E2E", adapter_type: "zhipu",
    supported_protocols: JSON.stringify(["chat", "messages"]) as unknown as string[],
  }).execute();
  await db.insertInto("provider_resource").values([
    {
      id: IDS.resource, enterprise_id: IDS.enterprise, provider_id: IDS.provider, name: "E2E 智谱主资源",
      mode: "API", credential_type: "API_KEY", credential_fingerprint: "sha256:e2e-safe-fingerprint",
      credential_version: 1, upstream_models: JSON.stringify(["glm-4.6", "glm-4.5"]) as unknown as string[],
      concurrency_limit: 8, status: "ACTIVE",
    },
    {
      id: IDS.isolatedResource, enterprise_id: IDS.enterprise, provider_id: IDS.provider, name: "E2E 待恢复资源",
      mode: "CODING_PLAN", credential_type: "SUBSCRIPTION_SESSION",
      credential_fingerprint: "sha256:e2e-isolated-fingerprint", credential_version: 1,
      upstream_models: JSON.stringify(["glm-4.6"]) as unknown as string[], concurrency_limit: 2,
      status: "CREDENTIAL_INVALID", refresh_error_classification: "TOKEN_EXPIRED",
    },
  ]).execute();
  await db.insertInto("unified_model").values({
    id: IDS.model, enterprise_id: IDS.enterprise, alias: "qianliu-glm", display_name: "仟流 GLM",
    required_capabilities: JSON.stringify(["chat"]) as unknown as string[],
  }).execute();
  await db.insertInto("model_route").values({
    id: IDS.route, enterprise_id: IDS.enterprise, unified_model_id: IDS.model,
    provider_resource_id: IDS.resource, upstream_model: "glm-4.6", priority: 10, weight: 5, enabled: true,
  }).execute();
  await db.insertInto("principal").values({
    id: IDS.principal, enterprise_id: IDS.enterprise, type: "EMPLOYEE", name: "E2E 固定员工", department_label: "研发部",
  }).execute();
  await db.insertInto("principal_key").values({
    id: IDS.key, enterprise_id: IDS.enterprise, principal_id: IDS.principal, key_prefix: "sk-e2e01",
    key_digest: "e2e-digest-only-never-plaintext", allowed_model_ids: JSON.stringify([IDS.model]) as unknown as string[],
    status: "ACTIVE",
  }).execute();
  await db.insertInto("principal_grant").values({
    id: IDS.grant, enterprise_id: IDS.enterprise, principal_id: IDS.principal, provider: "zhipu",
    model_alias: "qianliu-glm", quota_value: 100_000n, allow_overage: true,
  }).execute();
  await db.insertInto("quota_counter").values({
    id: IDS.counter, grant_id: IDS.grant, used_value: 2_000n, overage_value: 100n,
  }).execute();
}
