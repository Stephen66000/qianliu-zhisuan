/** Credentials for the explicitly synthetic local HTTP server only; never loads an .env file. */
import { createKysely } from "../../../packages/database/src/index.js";
import { decodeKek, encryptCredential, credentialFingerprint } from "../../../packages/provider-adapters/src/index.js";
import { randomUUID } from "node:crypto";
import { employeeQuotaMonth } from "../../../packages/domain/src/employee-quota-period.js";
import { E2E_IDS } from "./fixtures";
export async function seedLocalUpstreamCredentials() {
  if (!process.env.E2E_UPSTREAM_ORIGIN) return;
  const target = new URL(process.env.DATABASE_URL!);
  const upstream = new URL(process.env.E2E_UPSTREAM_ORIGIN);
  if (target.hostname !== "127.0.0.1" || !target.pathname.endsWith("_e2e") || upstream.hostname !== "127.0.0.1") throw new Error("synthetic local fixture safeguard failed");
  const db = createKysely(target.toString());
  try {
    const plaintext = process.env.E2E_UPSTREAM_VALID_KEY!;
    const encrypted = JSON.stringify(encryptCredential(plaintext, decodeKek(process.env.CREDENTIAL_KEK!)));
    await db.updateTable("provider_resource").set({ credential_ciphertext: encrypted, credential_fingerprint: credentialFingerprint(plaintext), credential_version: 1 })
      .where("id", "in", [E2E_IDS.resource, E2E_IDS.isolatedResource]).execute();
    const resource = await db.selectFrom("provider_resource").select("enterprise_id").where("id", "=", E2E_IDS.isolatedResource).executeTakeFirstOrThrow();
    const admin = await db.selectFrom("admin_user").select("id").where("enterprise_id", "=", resource.enterprise_id).where("username", "=", "admin").executeTakeFirstOrThrow();
    const month = employeeQuotaMonth(new Date(), "Asia/Shanghai");
    await db.insertInto("provider_subscription_period").values({ enterprise_id: resource.enterprise_id, provider_resource_id: E2E_IDS.isolatedResource,
      finance_event_id: null, product_name: "E2E 已登记在用周期", period_start: month.periodStart, period_end_exclusive: month.periodEnd,
      source: "MIGRATED_CARRYOVER", migration_source_record_id: randomUUID(), created_by_admin_user_id: admin.id }).execute();
  } finally { await db.destroy(); }
}
