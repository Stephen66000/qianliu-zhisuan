import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { app, db, adminCookie, ENT_ID, seedProviderResource, countAudit } from "./w19-admin-fixture.js";

describe("W19 资源恢复与隔离", () => {
  it("POST /provider-resources/:id/recover：隔离态恢复 + 轮换凭证 + 明文 0 命中 canary", async () => {
    const { resource } = await seedProviderResource("CREDENTIAL_INVALID");
    const canarySecret = "sk-w19-ROTATION-CANARY-SECRET-98765";
    const res = await app.inject({
      method: "POST",
      url: `/provider-resources/${resource.id}/recover`,
      headers: { cookie: adminCookie },
      payload: { credential_plaintext: canarySecret },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.resource.status).toBe("DEGRADED");
    expect(body.resource.credential_version).toBe(2);
    expect(JSON.stringify(body)).not.toContain(canarySecret);

    // 状态迁移事件（actor=admin）
    const events = await db
      .selectFrom("resource_status_event")
      .selectAll()
      .where("provider_resource_id", "=", resource.id)
      .execute();
    expect(events).toHaveLength(1);
    expect(events[0]!.from_status).toBe("CREDENTIAL_INVALID");
    expect(events[0]!.to_status).toBe("DEGRADED");
    expect(events[0]!.actor).toBe("admin");

    // audit
    expect(await countAudit("provider_resource.recover")).toBe(1);

    // canary：轮换明文在 provider_resource 表 0 命中
    const scan = await sql`
      SELECT COUNT(*) AS hits FROM (
        SELECT row_to_json(t)::text AS row_text FROM provider_resource t
      ) s WHERE s.row_text LIKE ${"%" + canarySecret + "%"}
    `.execute(db);
    expect(Number((scan.rows[0] as { hits: number | bigint }).hits)).toBe(0);
    // 密文已写入且不含明文
    const row = await db
      .selectFrom("provider_resource")
      .select(["credential_ciphertext"])
      .where("id", "=", resource.id)
      .executeTakeFirstOrThrow();
    expect(row.credential_ciphertext).not.toBeNull();
    expect(row.credential_ciphertext).not.toContain(canarySecret);
  });

  it("POST /provider-resources/:id/recover：非隔离态 → 409 invalid_state", async () => {
    const { resource } = await seedProviderResource("ACTIVE");
    const res = await app.inject({
      method: "POST",
      url: `/provider-resources/${resource.id}/recover`,
      headers: { cookie: adminCookie },
      payload: {},
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("invalid_state");
  });

  it("POST /provider-resources/:id/recover：不轮换凭证也可恢复（仅状态）", async () => {
    const { resource } = await seedProviderResource("EXHAUSTED");
    const res = await app.inject({
      method: "POST",
      url: `/provider-resources/${resource.id}/recover`,
      headers: { cookie: adminCookie },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().resource.status).toBe("DEGRADED");
    expect(res.json().resource.credential_version).toBe(1);
  });

  it("GET /provider-resources/:id/health：展示 Coding Plan 自动同步恢复状态", async () => {
    const { resource } = await seedProviderResource("CREDENTIAL_INVALID", "CODING_PLAN");
    const recoveredAt = new Date();
    await db.updateTable("provider_resource").set({
      status: "DEGRADED",
      credential_refresh_status: "OK",
      refresh_error_classification: null,
      cooldown_until: null,
    }).where("id", "=", resource.id).execute();
    await db.insertInto("resource_status_event").values({
      enterprise_id: ENT_ID,
      provider_resource_id: resource.id,
      from_status: "CREDENTIAL_INVALID",
      to_status: "DEGRADED",
      reason: "QUOTA_SYNC_RECOVERED",
      actor: "system",
      created_at: recoveredAt,
    }).execute();

    const recovered = await app.inject({
      method: "GET",
      url: `/provider-resources/${resource.id}/health`,
      headers: { cookie: adminCookie },
    });
    expect(recovered.statusCode).toBe(200);
    expect(recovered.json()).toMatchObject({
      status: "DEGRADED",
      status_label: "额度已恢复，待调用确认",
      reason_code: "QUOTA_SYNC_RECOVERED",
      reason_label: "厂商额度同步确认恢复",
      credential_refresh_status: "OK",
    });
    expect(recovered.json().last_success_at).toBe(recoveredAt.toISOString());
    expect(recovered.json().recovery_guide).toContain("下一次成功请求后自动恢复");

    const { resource: waiting } = await seedProviderResource("EXHAUSTED", "CODING_PLAN");
    const cooldownUntil = new Date(Date.now() + 5 * 60_000);
    await db.updateTable("provider_resource").set({ cooldown_until: cooldownUntil })
      .where("id", "=", waiting.id).execute();
    const pending = await app.inject({
      method: "GET",
      url: `/provider-resources/${waiting.id}/health`,
      headers: { cookie: adminCookie },
    });
    expect(pending.statusCode).toBe(200);
    expect(pending.json().status_label).toBe("套餐额度耗尽");
    expect(pending.json().recovery_guide).toContain("自动重试同步");
    expect(pending.json().recovery_guide).toContain(cooldownUntil.toISOString());

    const { resource: apiExhausted } = await seedProviderResource("EXHAUSTED", "API");
    const apiHealth = await app.inject({ method: "GET",
      url: `/provider-resources/${apiExhausted.id}/health`, headers: { cookie: adminCookie } });
    expect(apiHealth.json()).toMatchObject({ status_label: "余额不足",
      recovery_guide: expect.stringContaining("API 余额不足") });

    const { resource: frozen } = await seedProviderResource("DEGRADED", "API");
    await db.insertInto("resource_status_event").values({ enterprise_id: ENT_ID,
      provider_resource_id: frozen.id, from_status: "ACTIVE", to_status: "DEGRADED",
      reason: "PASSIVE_FAILURE", actor: "system", time_reliable: false,
      created_at: frozen.created_at }).execute();
    const frozenHealth = await app.inject({ method: "GET",
      url: `/provider-resources/${frozen.id}/health`, headers: { cookie: adminCookie } });
    expect(frozenHealth.json()).toMatchObject({ status_event_time_reliable: false,
      first_occurred_at: null, last_occurred_at: null, last_success_at: null,
      reason_code: null, error_classification: null });

    const { resource: staleQuota } = await seedProviderResource("DEGRADED", "CODING_PLAN");
    const staleAt = new Date(Date.now() + 60_000);
    await db.insertInto("resource_status_event").values({ enterprise_id: ENT_ID,
      provider_resource_id: staleQuota.id, from_status: "ACTIVE", to_status: "DEGRADED",
      reason: "PASSIVE_FAILURE", actor: "system", created_at: new Date() }).execute();
    await db.insertInto("provider_quota_window").values({ enterprise_id: ENT_ID,
      provider_resource_id: staleQuota.id, window_type: "FIVE_HOUR", is_current: true,
      limit_value: "100", used_value: "1", remaining_value: "99", unit: "PERCENT",
      ratio: "0.01", reset_at: staleAt, provider_data_at: staleAt, collected_at: staleAt,
      source: "PROVIDER_SYNC", adapter_version: "audit-test", sync_status: "STALE",
      sync_error_code: "UPSTREAM_UNAVAILABLE", last_success_at: staleAt }).execute();
    const staleHealth = await app.inject({ method: "GET",
      url: `/provider-resources/${staleQuota.id}/health`, headers: { cookie: adminCookie } });
    expect(staleHealth.json()).toMatchObject({ reason_code: "PASSIVE_FAILURE",
      last_quota_sync_at: null, status_label: "降级（仍可使用）" });

    const { resource: syncedQuota } = await seedProviderResource("DEGRADED", "CODING_PLAN");
    await db.insertInto("provider_quota_window").values({ enterprise_id: ENT_ID,
      provider_resource_id: syncedQuota.id, window_type: "FIVE_HOUR", is_current: true,
      limit_value: "100", used_value: "1", remaining_value: "99", unit: "PERCENT",
      ratio: "0.01", reset_at: staleAt, provider_data_at: staleAt, collected_at: staleAt,
      source: "PROVIDER_SYNC", adapter_version: "audit-test", sync_status: "SUCCESS",
      sync_error_code: null, last_success_at: staleAt }).execute();
    const syncedHealth = await app.inject({ method: "GET",
      url: `/provider-resources/${syncedQuota.id}/health`, headers: { cookie: adminCookie } });
    expect(syncedHealth.json()).toMatchObject({ reason_code: "QUOTA_SYNC_RECOVERED",
      last_quota_sync_at: staleAt.toISOString(), status_label: "额度已恢复，待调用确认" });
    await db.insertInto("resource_status_event").values({ enterprise_id: ENT_ID,
      provider_resource_id: syncedQuota.id, from_status: "ACTIVE", to_status: "DEGRADED",
      reason: "PASSIVE_FAILURE", actor: "system", time_reliable: false,
      created_at: new Date(staleAt.getTime() - 60_000) }).execute();
    const laterFailureAt = new Date(staleAt.getTime() + 60_000);
    await db.insertInto("resource_status_event").values({ enterprise_id: ENT_ID,
      provider_resource_id: syncedQuota.id, from_status: "DEGRADED", to_status: "DEGRADED",
      reason: "PASSIVE_FAILURE", actor: "system", created_at: laterFailureAt }).execute();
    const failedAfterSync = await app.inject({ method: "GET",
      url: `/provider-resources/${syncedQuota.id}/health`, headers: { cookie: adminCookie } });
    expect(failedAfterSync.json()).toMatchObject({ reason_code: "PASSIVE_FAILURE",
      status_label: "降级（仍可使用）" });
  });

  it("六要素：未认证 401 / 不存在 404 / 跨企业不可见", async () => {
    const noAuth = await app.inject({
      method: "PATCH",
      url: `/provider-resources/${randomUUID()}`,
      payload: { expected_version: 1, name: "x" },
    });
    expect(noAuth.statusCode).toBe(401);

    const notFound = await app.inject({
      method: "PATCH",
      url: `/provider-resources/${randomUUID()}`,
      headers: { cookie: adminCookie },
      payload: { expected_version: 1, name: "x" },
    });
    expect(notFound.statusCode).toBe(404);

    const recoverNotFound = await app.inject({
      method: "POST",
      url: `/provider-resources/${randomUUID()}/recover`,
      headers: { cookie: adminCookie },
      payload: {},
    });
    expect(recoverNotFound.statusCode).toBe(404);
  });
});
