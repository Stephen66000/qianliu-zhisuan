import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import { createKysely, DirectoryRepository, migrateToLatest } from "../index.js";

let pg: PostgresTestInstance;

beforeAll(async () => {
  pg = await startPostgresContainer("qianliu_directory_repository");
}, 120_000);

afterAll(async () => {
  if (pg) await pg.stop();
}, 60_000);

describe("DirectoryRepository", () => {
  it("Excel 逐项导入可部分成功，重试不重复建人且不生成 Key/Grant", async () => {
    const db = createKysely(pg.connectionString);
    try {
      await migrateToLatest(db);
      const enterprise = await db.insertInto("enterprise").values({ name: "通讯录测试企业" })
        .returning("id").executeTakeFirstOrThrow();
      const admin = await db.insertInto("admin_user").values({
        enterprise_id: enterprise.id,
        username: "directory-admin",
        password_hash: "test-only",
      }).returning("id").executeTakeFirstOrThrow();
      const repository = new DirectoryRepository(db);

      const concurrent = await Promise.all(Array.from({ length: 4 }, () => repository.createRun({
        enterpriseId: enterprise.id,
        mode: "EXCEL",
        idempotencyKey: "excel-v1:concurrent",
        requestHash: "request-hash-concurrent",
        createdByAdminUserId: admin.id,
        templateVersion: "v1",
        contentSha256: "c".repeat(64),
      })));
      expect(new Set(concurrent.map((result) => result.run.id)).size).toBe(1);
      expect(concurrent.filter((result) => !result.replayed)).toHaveLength(1);

      const first = await repository.createRun({
        enterpriseId: enterprise.id,
        mode: "EXCEL",
        idempotencyKey: "excel-v1:first",
        requestHash: "request-hash-first",
        createdByAdminUserId: admin.id,
        templateVersion: "v1",
        contentSha256: "a".repeat(64),
      });
      expect(first.replayed).toBe(false);
      await repository.stageRun({
        enterpriseId: enterprise.id,
        runId: first.run.id,
        items: [
          {
            rowNumber: 2,
            employeeNumber: "E-001",
            normalizedName: "张三",
            normalizedDepartmentPath: "研发中心/平台组",
            normalizedEmail: "zhangsan@example.test",
          },
          {
            rowNumber: 3,
            employeeNumber: "E-002",
            normalizedName: "李四",
            normalizedDepartmentPath: null,
          },
        ],
      });

      const completed = await repository.applyRun(enterprise.id, first.run.id);
      expect(completed).toMatchObject({
        status: "PARTIAL",
        total_count: 2,
        created_count: 1,
        failed_count: 1,
      });
      const items = await repository.listRunItems(enterprise.id, first.run.id);
      expect(items.items.map((item) => [item.row_number, item.status, item.reason_code])).toEqual([
        [2, "CREATED", null],
        [3, "FAILED", "DEPARTMENT_REQUIRED"],
      ]);

      const people = await db.selectFrom("person").selectAll()
        .where("enterprise_id", "=", enterprise.id).execute();
      const principals = await db.selectFrom("principal").selectAll()
        .where("enterprise_id", "=", enterprise.id).execute();
      expect(people).toHaveLength(1);
      expect(principals).toHaveLength(1);
      expect(principals[0]).toMatchObject({
        type: "EMPLOYEE",
        person_id: people[0]!.id,
        department_label: "平台组",
      });
      expect(await db.selectFrom("organization_membership").selectAll().execute()).toHaveLength(1);
      expect(await db.selectFrom("principal_access_config_state").selectAll().execute()).toHaveLength(1);
      expect(await db.selectFrom("principal_key").selectAll().execute()).toHaveLength(0);
      expect(await db.selectFrom("principal_grant").selectAll().execute()).toHaveLength(0);

      const replay = await repository.createRun({
        enterpriseId: enterprise.id,
        mode: "EXCEL",
        idempotencyKey: "excel-v1:first",
        requestHash: "request-hash-first",
        createdByAdminUserId: admin.id,
        templateVersion: "v1",
        contentSha256: "a".repeat(64),
      });
      expect(replay).toMatchObject({ replayed: true, run: { id: first.run.id } });

      const second = await repository.createRun({
        enterpriseId: enterprise.id,
        mode: "EXCEL",
        idempotencyKey: "excel-v1:second",
        requestHash: "request-hash-second",
        createdByAdminUserId: admin.id,
        templateVersion: "v1",
        contentSha256: "b".repeat(64),
      });
      await repository.stageRun({
        enterpriseId: enterprise.id,
        runId: second.run.id,
        items: [{
          rowNumber: 2,
          employeeNumber: "e-001",
          normalizedName: "张三",
          normalizedDepartmentPath: "研发中心/平台组",
        }],
      });
      const repeated = await repository.applyRun(enterprise.id, second.run.id);
      expect(repeated).toMatchObject({ status: "SUCCEEDED", matched_count: 1, created_count: 0 });
      expect(await db.selectFrom("person").select("id").execute()).toHaveLength(1);
      expect(await db.selectFrom("principal").select("id").execute()).toHaveLength(1);
      expect(await db.selectFrom("organization_membership").select("id").execute()).toHaveLength(1);

      const members = await repository.listMembers(enterprise.id);
      expect(members).toMatchObject({
        total: 1,
        members: [{ employee_number: "E-001", key_state: "PENDING_FIRST_CLAIM" }],
      });
    } finally {
      await db.destroy();
    }
  });

  it("稳定标识指向不同人时只标记冲突，其他 Item 继续", async () => {
    const db = createKysely(pg.connectionString);
    try {
      const enterprise = await db.insertInto("enterprise").values({ name: "冲突隔离企业" })
        .returning("id").executeTakeFirstOrThrow();
      const admin = await db.insertInto("admin_user").values({
        enterprise_id: enterprise.id,
        username: "conflict-admin",
        password_hash: "test-only",
      }).returning("id").executeTakeFirstOrThrow();
      const repository = new DirectoryRepository(db);
      const source = await repository.upsertSource({
        enterpriseId: enterprise.id,
        actorAdminUserId: admin.id,
        type: "WECOM",
        configCiphertext: "encrypted-test-secret",
        configFingerprint: "fingerprint-only",
      });
      expect(source).not.toHaveProperty("config_ciphertext");
      expect(source).toMatchObject({ configured: true, config_fingerprint: "fingerprint-only" });

      const firstPerson = await db.insertInto("person").values({
        enterprise_id: enterprise.id,
        employee_number: "E-101",
        name: "已绑定人员",
      }).returning("id").executeTakeFirstOrThrow();
      await db.insertInto("principal").values({
        enterprise_id: enterprise.id,
        type: "EMPLOYEE",
        person_id: firstPerson.id,
        name: "已绑定人员",
      }).execute();
      await db.insertInto("person_external_identity").values({
        enterprise_id: enterprise.id,
        person_id: firstPerson.id,
        directory_source_id: source.id,
        provider: "WECOM",
        provider_user_id: "wx-user-1",
        status: "ACTIVE",
      }).execute();
      await db.insertInto("person").values({
        enterprise_id: enterprise.id,
        employee_number: "E-102",
        name: "另一人",
      }).execute();

      const created = await repository.createRun({
        enterpriseId: enterprise.id,
        mode: "SYNC",
        idempotencyKey: "sync:snapshot-1",
        requestHash: "sync-request-1",
        createdByAdminUserId: admin.id,
        directorySourceId: source.id,
        sourceSnapshotId: "snapshot-1",
      });
      await repository.stageRun({
        enterpriseId: enterprise.id,
        runId: created.run.id,
        sourceSnapshotId: "snapshot-1",
        items: [
          {
            rowNumber: 1,
            externalMemberId: "wx-user-1",
            employeeNumber: "E-102",
            normalizedName: "冲突行",
            normalizedDepartmentPath: "研发中心",
          },
          {
            rowNumber: 2,
            externalMemberId: "wx-user-2",
            employeeNumber: "E-103",
            normalizedName: "可正常创建",
            normalizedDepartmentPath: "销售中心",
          },
        ],
      });
      const completed = await repository.applyRun(enterprise.id, created.run.id);
      expect(completed).toMatchObject({
        status: "PARTIAL",
        created_count: 1,
        conflict_count: 1,
      });
      const rows = await repository.listRunItems(enterprise.id, created.run.id);
      expect(rows.items.map((item) => [item.row_number, item.status, item.reason_code])).toEqual([
        [1, "CONFLICT", "STABLE_ID_CONFLICT"],
        [2, "CREATED", null],
      ]);
    } finally {
      await db.destroy();
    }
  });

  it("新导入员工自动继承当前已发布的 ALL 批量授权规则，但不生成 Key", async () => {
    const db = createKysely(pg.connectionString);
    try {
      const enterprise = await db.insertInto("enterprise").values({ name: "已发布规则导入企业" })
        .returning("id").executeTakeFirstOrThrow();
      const admin = await db.insertInto("admin_user").values({
        enterprise_id: enterprise.id,
        username: "published-rule-directory-admin",
        password_hash: "test-only",
      }).returning("id").executeTakeFirstOrThrow();
      const existingPerson = await db.insertInto("person").values({
        enterprise_id: enterprise.id,
        employee_number: "RULE-SEED-001",
        name: "已在规则中的员工",
      }).returning("id").executeTakeFirstOrThrow();
      const existingPrincipal = await db.insertInto("principal").values({
        enterprise_id: enterprise.id,
        type: "EMPLOYEE",
        person_id: existingPerson.id,
        name: "已在规则中的员工",
      }).returning("id").executeTakeFirstOrThrow();
      const provider = await db.insertInto("provider").values({
        enterprise_id: enterprise.id,
        code: "published-rule-kimi",
        name: "已发布规则测试厂商",
        adapter_type: "test",
      }).returning(["id", "code"]).executeTakeFirstOrThrow();
      const resource = await db.insertInto("provider_resource").values({
        enterprise_id: enterprise.id,
        provider_id: provider.id,
        name: "已发布规则测试资源",
        mode: "API",
        credential_type: "API_KEY",
      }).returning("id").executeTakeFirstOrThrow();
      const model = await db.insertInto("unified_model").values({
        enterprise_id: enterprise.id,
        alias: "published-rule-model",
        display_name: "已发布规则测试型号",
      }).returning("id").executeTakeFirstOrThrow();
      const validFrom = new Date(Date.now() - 60_000);
      const ruleVersion = await db.insertInto("employee_model_rule_version").values({
        enterprise_id: enterprise.id,
        rule_id: randomUUID(),
        version: 1,
        name: "当前全员批量授权",
        status: "PUBLISHED",
        employee_scope: "ALL",
        principal_ids: JSON.stringify([existingPrincipal.id]) as unknown as string[],
        model_scope: "SELECTED",
        model_targets: JSON.stringify([{
          unified_model_id: model.id,
          provider_resource_id: resource.id,
        }]) as unknown as never,
        quota_value: 500_000n,
        allow_overage: false,
        valid_from: validFrom,
        valid_until: null,
        pool_quotas: JSON.stringify([{
          provider_code: provider.code,
          quota_value: "800000",
          allow_overage: true,
          valid_until: null,
        }]) as unknown as never,
        publish_idempotency_key: "published-rule-directory-fixture",
        published_at: new Date(),
        owner_principal_id: null,
        created_by_admin_user_id: admin.id,
      }).returning("id").executeTakeFirstOrThrow();
      const seedGrant = await db.insertInto("principal_grant").values({
        enterprise_id: enterprise.id,
        principal_id: existingPrincipal.id,
        provider: provider.code,
        model_alias: "*",
        pool_model_alias: "*",
        quota_unit: "TOKEN",
        quota_value: 800_000n,
        allow_overage: true,
        valid_from: validFrom,
        valid_until: null,
        status: "ACTIVE",
        authorization_rule_version_id: ruleVersion.id,
      }).returning("id").executeTakeFirstOrThrow();
      await db.insertInto("quota_counter").values({ grant_id: seedGrant.id }).execute();
      await db.insertInto("employee_model_rule_assignment").values({
        enterprise_id: enterprise.id,
        rule_version_id: ruleVersion.id,
        principal_id: existingPrincipal.id,
        unified_model_id: model.id,
        provider_resource_id: resource.id,
        grant_id: seedGrant.id,
      }).execute();

      const repository = new DirectoryRepository(db);
      const run = await repository.createRun({
        enterpriseId: enterprise.id,
        mode: "EXCEL",
        idempotencyKey: "excel-v1:published-rule",
        requestHash: "request-hash-published-rule",
        createdByAdminUserId: admin.id,
        templateVersion: "v1",
        contentSha256: "d".repeat(64),
      });
      await repository.stageRun({
        enterpriseId: enterprise.id,
        runId: run.run.id,
        items: [{
          rowNumber: 2,
          employeeNumber: "RULE-NEW-002",
          normalizedName: "新导入员工",
          normalizedDepartmentPath: "研发中心/新人组",
        }],
      });

      expect(await repository.applyRun(enterprise.id, run.run.id)).toMatchObject({
        status: "SUCCEEDED",
        created_count: 1,
      });
      const importedPerson = await db.selectFrom("person").select("id")
        .where("enterprise_id", "=", enterprise.id)
        .where("employee_number", "=", "RULE-NEW-002").executeTakeFirstOrThrow();
      const importedPrincipal = await db.selectFrom("principal").select("id")
        .where("enterprise_id", "=", enterprise.id)
        .where("person_id", "=", importedPerson.id).executeTakeFirstOrThrow();
      const importedGrants = await db.selectFrom("principal_grant").selectAll()
        .where("enterprise_id", "=", enterprise.id)
        .where("principal_id", "=", importedPrincipal.id).execute();
      expect(importedGrants).toHaveLength(1);
      expect(importedGrants[0]).toMatchObject({
        provider: provider.code,
        model_alias: "*",
        pool_model_alias: "*",
        quota_unit: "TOKEN",
        allow_overage: true,
        authorization_rule_version_id: ruleVersion.id,
      });
      expect(BigInt(importedGrants[0]!.quota_value)).toBe(800_000n);
      expect(await db.selectFrom("quota_counter").select("id")
        .where("grant_id", "=", importedGrants[0]!.id).execute()).toHaveLength(1);
      expect(await db.selectFrom("employee_model_rule_assignment").selectAll()
        .where("enterprise_id", "=", enterprise.id)
        .where("principal_id", "=", importedPrincipal.id).execute()).toEqual([
        expect.objectContaining({
          rule_version_id: ruleVersion.id,
          unified_model_id: model.id,
          provider_resource_id: resource.id,
          grant_id: importedGrants[0]!.id,
          status: "ACTIVE",
        }),
      ]);
      expect(await db.selectFrom("principal_access_config_state").select("principal_id")
        .where("enterprise_id", "=", enterprise.id)
        .where("principal_id", "=", importedPrincipal.id).execute()).toHaveLength(1);
      expect(await db.selectFrom("principal_key").select("id")
        .where("enterprise_id", "=", enterprise.id)
        .where("principal_id", "=", importedPrincipal.id).execute()).toHaveLength(0);

      expect(await repository.applyRun(enterprise.id, run.run.id)).toMatchObject({
        status: "SUCCEEDED",
        created_count: 1,
      });
      expect(await db.selectFrom("principal_grant").select("id")
        .where("enterprise_id", "=", enterprise.id)
        .where("principal_id", "=", importedPrincipal.id).execute()).toHaveLength(1);
      expect(await db.selectFrom("employee_model_rule_assignment").select("id")
        .where("enterprise_id", "=", enterprise.id)
        .where("principal_id", "=", importedPrincipal.id).execute()).toHaveLength(1);
    } finally {
      await db.destroy();
    }
  });
});
