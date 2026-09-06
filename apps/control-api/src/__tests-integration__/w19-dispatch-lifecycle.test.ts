import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { app, db, adminCookie, ENT_ID, ADM_ID, seedProviderResource, countAudit } from "./w19-admin-fixture.js";

describe("W19 调度生命周期", () => {
  it("调度策略草稿经校验后发布并停用，全部状态可查询且写审计", async () => {
    const { resource } = await seedProviderResource("ACTIVE", "CODING_PLAN");
    const model = await db
      .insertInto("unified_model")
      .values({
        enterprise_id: ENT_ID,
        alias: `glm-dispatch-${randomUUID().slice(0, 8)}`,
        display_name: "智谱调度模型",
        status: "ACTIVE",
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await db.insertInto("model_route").values({ enterprise_id: ENT_ID, unified_model_id: model.id,
      provider_resource_id: resource.id, upstream_model: "glm-ready", enabled: true }).execute();
    await db.insertInto("billing_rule").values({ enterprise_id: ENT_ID, provider_resource_id: resource.id,
      upstream_model: "glm-ready", rule_type: "MODEL_TIER", rule_version: "ready-v1", effective_from: new Date(0),
      multiplier: "1" }).execute();
    const principals = await db
      .insertInto("principal")
      .values([
        { enterprise_id: ENT_ID, type: "EMPLOYEE", name: "于滔", department_label: "研发部", status: "ACTIVE" },
        { enterprise_id: ENT_ID, type: "PROJECT", name: "智算项目", department_label: null, status: "ACTIVE" },
      ])
      .returning("id")
      .execute();
    const created = await app.inject({
      method: "POST",
      url: "/dispatch-policies",
      headers: { cookie: adminCookie },
      payload: {
        match_unified_model: model.alias,
        match_resource_mode: "CODING_PLAN",
        match_provider_resource_id: resource.id,
        match_timezone: "Asia/Shanghai",
        match_days_of_week: [1, 2, 3, 4, 5, 6, 7],
        match_start_time: "14:00:00",
        match_end_time: "18:00:00",
        action: "REJECT",
        policy_version: "zhipu-peak-reject-v1",
        priority: 10,
        description: "智谱高峰硬拒绝",
      },
    });
    expect(created.statusCode).toBe(201);
    const policy = created.json().policy;
    expect(policy.status).toBe("DRAFT");

    const edited = await app.inject({
      method: "PATCH",
      url: `/dispatch-policies/${policy.id}`,
      headers: { cookie: adminCookie },
      payload: {
        match_unified_model: model.alias,
        match_resource_mode: "CODING_PLAN",
        match_provider_resource_id: resource.id,
        match_timezone: "Asia/Shanghai",
        match_days_of_week: [1, 2, 3, 4, 5, 6, 7],
        match_start_time: "14:00:00",
        match_end_time: "18:00:00",
        match_principal_scope: principals.map((principal) => principal.id),
        action: "REJECT",
        policy_version: "zhipu-peak-reject-v2",
        priority: 9,
        description: "指定主体高峰硬拒绝",
      },
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json().policy).toMatchObject({
      status: "DRAFT",
      policyVersion: "zhipu-peak-reject-v2",
      matchPrincipalScope: principals.map((principal) => principal.id),
      priority: 9,
    });

    const directPublish = await app.inject({
      method: "POST",
      url: `/dispatch-policies/${policy.id}/publish`,
      headers: { cookie: adminCookie },
    });
    expect(directPublish.statusCode).toBe(409);

    const validated = await app.inject({
      method: "POST",
      url: `/dispatch-policies/${policy.id}/validate`,
      headers: { cookie: adminCookie },
    });
    expect(validated.statusCode).toBe(200);
    expect(validated.json().policy.status).toBe("VALIDATED");
    expect(validated.json().policy.validatedAt).toBeTruthy();
    expect(validated.json().policy.validatedByAdminId).toBe(ADM_ID);

    const published = await app.inject({
      method: "POST",
      url: `/dispatch-policies/${policy.id}/publish`,
      headers: { cookie: adminCookie },
    });
    expect(published.statusCode).toBe(200);
    expect(published.json().policy.status).toBe("PUBLISHED");
    expect(published.json().policy.publishedAt).toBeTruthy();
    expect(published.json().policy.effectiveAt).toBeTruthy();
    expect(published.json().policy.publishedByAdminId).toBe(ADM_ID);

    const immutableEdit = await app.inject({
      method: "PATCH",
      url: `/dispatch-policies/${policy.id}`,
      headers: { cookie: adminCookie },
      payload: {
        match_principal_scope: null,
        action: "REJECT",
        policy_version: "forbidden",
        priority: 1,
      },
    });
    expect(immutableEdit.statusCode).toBe(409);

    const listed = await app.inject({
      method: "GET",
      url: "/dispatch-policies",
      headers: { cookie: adminCookie },
    });
    expect(
      listed.json().policies.find((item: { id: string }) => item.id === policy.id),
    ).toMatchObject({
      status: "PUBLISHED",
      action: "REJECT",
      matchStartTime: "14:00:00",
      matchEndTime: "18:00:00",
    });

    const retired = await app.inject({
      method: "POST",
      url: `/dispatch-policies/${policy.id}/retire`,
      headers: { cookie: adminCookie },
    });
    expect(retired.statusCode).toBe(200);
    expect(retired.json().policy.status).toBe("RETIRED");
    expect(retired.json().policy.retiredAt).toBeTruthy();
    expect(retired.json().policy.retiredByAdminId).toBe(ADM_ID);

    const copied = await app.inject({
      method: "POST",
      url: `/dispatch-policies/${policy.id}/copy`,
      headers: { cookie: adminCookie },
    });
    expect(copied.statusCode).toBe(201);
    expect(copied.json().policy).toMatchObject({
      status: "DRAFT",
      policyVersion: "zhipu-peak-reject-v3",
      copiedFromPolicyId: policy.id,
      createdByAdminId: ADM_ID,
      matchPrincipalScope: principals.map((principal) => principal.id),
      action: "REJECT",
      priority: 9,
    });
    expect((await db.selectFrom("dispatch_policy").select("status").where("id", "=", policy.id)
      .executeTakeFirstOrThrow()).status).toBe("RETIRED");

    const restoreResponses = await Promise.all([1, 2].map(() => app.inject({
      method: "POST", url: `/dispatch-policies/${policy.id}/restore`,
      headers: { cookie: adminCookie },
    })));
    expect(restoreResponses.map((response) => response.statusCode).sort()).toEqual([200, 201]);
    const restored = restoreResponses.find((response) => response.statusCode === 201)!;
    expect(restored.json().policy).toMatchObject({
      status: "PUBLISHED",
      policyVersion: "zhipu-peak-reject-v4",
      copiedFromPolicyId: policy.id,
      createdByAdminId: ADM_ID,
      validatedByAdminId: ADM_ID,
      publishedByAdminId: ADM_ID,
      matchPrincipalScope: principals.map((principal) => principal.id),
    });
    expect(restored.json().policy.validatedAt).toBeTruthy();
    expect(restored.json().policy.publishedAt).toBeTruthy();
    expect(restoreResponses[0]!.json().policy.id).toBe(restoreResponses[1]!.json().policy.id);
    expect((await db.selectFrom("dispatch_policy").select("status").where("id", "=", policy.id)
      .executeTakeFirstOrThrow()).status).toBe("RETIRED");

    const otherEnterpriseId = randomUUID();
    await db.insertInto("enterprise").values({ id: otherEnterpriseId, name: "POOL-016 隔离企业" }).execute();
    const otherPrincipal = await db
      .insertInto("principal")
      .values({
        enterprise_id: otherEnterpriseId,
        type: "EMPLOYEE",
        name: "其他企业员工",
        department_label: null,
        status: "ACTIVE",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const crossEnterpriseDraft = await app.inject({
      method: "POST",
      url: "/dispatch-policies",
      headers: { cookie: adminCookie },
      payload: {
        match_principal_scope: [otherPrincipal.id],
        action: "REJECT",
        policy_version: "pool016-cross-enterprise",
        priority: 100,
      },
    });
    expect(crossEnterpriseDraft.statusCode).toBe(201);
    const crossEnterpriseValidation = await app.inject({
      method: "POST",
      url: `/dispatch-policies/${crossEnterpriseDraft.json().policy.id}/validate`,
      headers: { cookie: adminCookie },
    });
    expect(crossEnterpriseValidation.statusCode).toBe(400);
    expect(crossEnterpriseValidation.json().error).toBe("invalid_reference");

    expect(await countAudit("dispatch_policy.create")).toBe(2);
    expect(await countAudit("dispatch_policy.update")).toBe(1);
    expect(await countAudit("dispatch_policy.validate")).toBe(1);
    expect(await countAudit("dispatch_policy.publish")).toBe(1);
    expect(await countAudit("dispatch_policy.retire")).toBe(1);
    expect(await countAudit("dispatch_policy.copy")).toBe(1);
    expect(await countAudit("dispatch_policy.restore")).toBe(1);
  });

  it("恢复引用校验与主体停用并发时等待行锁并 fail-closed", async () => {
    const principal = await db.insertInto("principal").values({
      enterprise_id: ENT_ID, type: "EMPLOYEE", name: "恢复并发主体", status: "ACTIVE",
    }).returningAll().executeTakeFirstOrThrow();
    const source = await db.insertInto("dispatch_policy").values({
      enterprise_id: ENT_ID, status: "RETIRED", action: "ALLOW",
      match_principal_scope: JSON.stringify([principal.id]) as unknown as string[],
      policy_version: `restore-lock-${randomUUID().slice(0, 8)}`,
    }).returningAll().executeTakeFirstOrThrow();

    let release!: () => void;
    let locked!: () => void;
    const lockedPromise = new Promise<void>((resolve) => { locked = resolve; });
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    const disable = db.transaction().execute(async (trx) => {
      await trx.updateTable("principal").set({ status: "DISABLED" })
        .where("id", "=", principal.id).execute();
      locked();
      await releasePromise;
    });
    await lockedPromise;
    let settled = false;
    const restoring = app.inject({
      method: "POST", url: `/dispatch-policies/${source.id}/restore`, headers: { cookie: adminCookie },
    }).finally(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(settled).toBe(false);
    release();
    await disable;
    const response = await restoring;
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "invalid_reference" });
    expect(await db.selectFrom("dispatch_policy").select("id")
      .where("restore_source_policy_id", "=", source.id).execute()).toEqual([]);
  });
});
