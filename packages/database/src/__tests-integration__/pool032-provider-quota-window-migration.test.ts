import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { createKysely } from "../kysely.js";
import { createMigrator, migrateDown } from "../migrator.js";
import {
  ProviderQuotaWindowRepository,
  type QuotaWindowUpsertInput,
} from "../repositories/provider-quota-window-repository.js";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";

let pg: PostgresTestInstance;

beforeAll(async () => { pg = await startPostgresContainer(); }, 120_000);
afterAll(async () => { await pg?.stop(); }, 60_000);

describe("0041 厂商额度窗口迁移", () => {
  it("新增 provider_quota_window 表（约束/唯一索引），支持写入、保鲜与回滚", async () => {
    const db = createKysely(pg.connectionString);
    try {
      const migrator = createMigrator(db);
      // 迁移到 0040，表不存在。
      expect((await migrator.migrateTo("0040_employee_model_rule_pool_quotas")).error).toBeUndefined();
      const beforeCols = await sql`SELECT table_name FROM information_schema.tables
        WHERE table_name = 'provider_quota_window'`.execute(db);
      expect(beforeCols.rows).toHaveLength(0);

      // 迁移到 0041，表出现。
      expect((await migrator.migrateTo("0041_provider_quota_window")).error).toBeUndefined();

      // 校验 sync_status CHECK 约束拒绝非法值。
      await expect(sql`INSERT INTO provider_quota_window
        (enterprise_id, provider_resource_id, window_type, collected_at, source, adapter_version, sync_status)
        VALUES ('00000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-000000000001',
                'FIVE_HOUR', now(), 'PROVIDER_SYNC', 'pool032-v1', 'BOGUS')`.execute(db)).rejects.toMatchObject({
        code: "23514",
      });

      // 校验 ratio CHECK 约束（0-1）拒绝超界值。
      await expect(sql`INSERT INTO provider_quota_window
        (enterprise_id, provider_resource_id, window_type, collected_at, source, adapter_version,
         sync_status, ratio)
        VALUES ('00000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-000000000001',
                'FIVE_HOUR', now(), 'PROVIDER_SYNC', 'pool032-v1', 'SUCCESS', 1.5)`.execute(db)).rejects.toMatchObject({
        code: "23514",
      });

      // 准备企业 + 厂商 + 厂商资源（外键依赖），验证仓储 upsert + markStale + 归档。
      const entId = "41111111-1111-4111-8111-111111111111";
      const provId = "41222222-2222-4222-8222-222222222222";
      const resId = "41333333-3333-4333-8333-333333333333";
      await sql`INSERT INTO enterprise (id, name) VALUES (${entId}, 'pool032')`.execute(db);
      await sql`INSERT INTO provider (id, enterprise_id, code, name, adapter_type, status)
        VALUES (${provId}, ${entId}, 'kimi', 'Kimi', 'kimi', 'ACTIVE')`.execute(db);
      await sql`INSERT INTO provider_resource
        (id, enterprise_id, provider_id, name, mode, credential_type, status, version)
        VALUES (${resId}, ${entId}, ${provId}, 'Kimi 套餐', 'CODING_PLAN', 'SUBSCRIPTION_SESSION', 'ACTIVE', 1)`.execute(db);

      const repo = new ProviderQuotaWindowRepository(db);
      const successInput: QuotaWindowUpsertInput = {
        enterprise_id: entId, provider_resource_id: resId, window_type: "WEEKLY",
        limit_value: "100", used_value: "60", remaining_value: "40", unit: "POINT",
        ratio: "0.6", reset_at: new Date("2026-08-10T03:00:00Z"),
        provider_data_at: new Date("2026-08-07T02:33:42Z"), source: "PROVIDER_SYNC",
        adapter_version: "pool032-v1", sync_status: "SUCCESS", sync_error_code: null,
      };
      await repo.upsertCurrentWindow(successInput, new Date("2026-08-07T02:33:42Z"));
      let current = await repo.listCurrentWindowsByResource(resId);
      expect(current).toHaveLength(1);
      expect(current[0]).toMatchObject({ window_type: "WEEKLY", sync_status: "SUCCESS" });
      // numeric(30,8) 按声明精度回填小数零。
      expect(current[0]!.used_value).toBe("60.00000000");
      expect(current[0]!.last_success_at).not.toBeNull();

      // 再次 upsert 成功：旧行归档，新行成为当前，仍只有一条当前。
      await repo.upsertCurrentWindow(
        { ...successInput, used_value: "70", remaining_value: "30", ratio: "0.7" },
        new Date("2026-08-07T03:00:00Z"),
      );
      current = await repo.listCurrentWindowsByResource(resId);
      expect(current).toHaveLength(1);
      expect(current[0]!.used_value).toBe("70.00000000");
      const allRows = await sql`SELECT count(*)::int AS n FROM provider_quota_window
        WHERE provider_resource_id = ${resId}`.execute(db);
      expect(allRows.rows[0].n).toBe(2);

      // 唯一索引：同一资源同一窗口类型只能有一条 is_current=true。
      await expect(sql`INSERT INTO provider_quota_window
        (enterprise_id, provider_resource_id, window_type, is_current, collected_at,
         source, adapter_version, sync_status)
        VALUES (${entId}, ${resId}, 'WEEKLY', true, now(), 'PROVIDER_SYNC', 'pool032-v1', 'SUCCESS')`.execute(db)).rejects.toMatchObject({
        code: "23505",
      });

      // markStale 保鲜：不动数值，只更新 sync_status=STALE + 错误码。
      await repo.markStale(entId, resId, "WEEKLY", "MANUAL_SYNC", "pool032-v1", "RATE_LIMITED");
      current = await repo.listCurrentWindowsByResource(resId);
      expect(current).toHaveLength(1);
      expect(current[0]).toMatchObject({ used_value: "70.00000000", sync_status: "STALE", sync_error_code: "RATE_LIMITED" });

      // 首次失败的窗口（无历史快照）→ markStale 插入 FAILED 空快照。
      await repo.markStale(entId, resId, "FIVE_HOUR", "PROVIDER_SYNC", "pool032-v1", "UPSTREAM_UNAVAILABLE");
      const fiveHour = (await repo.listCurrentWindowsByResource(resId)).find((w) => w.window_type === "FIVE_HOUR");
      expect(fiveHour).toMatchObject({ sync_status: "FAILED", used_value: null, last_success_at: null });

      // 回滚到 0040，表消失。
      expect(await migrateDown(db)).toBe("0041_provider_quota_window");
      const rolledBack = await sql`SELECT table_name FROM information_schema.tables
        WHERE table_name = 'provider_quota_window'`.execute(db);
      expect(rolledBack.rows).toHaveLength(0);
    } finally {
      await db.destroy();
    }
  });
});
