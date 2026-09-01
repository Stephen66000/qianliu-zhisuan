import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql, type Kysely } from "kysely";

import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import { digestSessionToken, generateSessionToken } from "@qianliu/provider-adapters";
import { createKysely, type Database } from "../kysely.js";
import { migrateToLatest } from "../migrator.js";
import { AdminRepository } from "../repositories/admin-repository.js";
import { loadLiveDepartmentBill } from "../repositories/department-cost-read-model.js";
import { UsageOverviewRepository } from "../repositories/usage-overview-repository.js";
import { buildControlApi } from "../../../../apps/control-api/src/server.js";
import { SESSION_COOKIE_NAME } from "../../../../apps/control-api/src/plugins/auth-guard.js";

let pg: PostgresTestInstance;
let db: Kysely<Database>;
let app: ReturnType<typeof buildControlApi>;
let adminCookie: string;

const enterpriseId = randomUUID();
const adminId = randomUUID();
const providerId = randomUUID();
const resourceId = randomUUID();
const firstEmployeeId = "40000000-0000-4000-8000-000000000001";

function percentile95(samples: number[]): number {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? Number.POSITIVE_INFINITY;
}

async function measuredP95(
  operation: () => Promise<unknown>,
  samples = 20,
): Promise<number> {
  await operation();
  await operation();
  const durations: number[] = [];
  for (let index = 0; index < samples; index += 1) {
    const startedAt = performance.now();
    await operation();
    durations.push(performance.now() - startedAt);
  }
  return percentile95(durations);
}

beforeAll(async () => {
  pg = await startPostgresContainer("w20_standard_capacity");
  db = createKysely(pg.connectionString);
  await migrateToLatest(db);

  await db.insertInto("enterprise").values({
    id: enterpriseId,
    name: "W20 标准容量企业",
    timezone: "Asia/Shanghai",
  }).execute();
  await db.insertInto("admin_user").values({
    id: adminId,
    enterprise_id: enterpriseId,
    username: "w20-capacity-admin",
    display_name: "W20 容量管理员",
    password_hash: "unused-in-capacity-test",
  }).execute();
  await db.insertInto("provider").values({
    id: providerId,
    enterprise_id: enterpriseId,
    code: "w20-capacity-provider",
    name: "W20 容量厂商",
    adapter_type: "openai",
  }).execute();
  await db.insertInto("provider_resource").values({
    id: resourceId,
    enterprise_id: enterpriseId,
    provider_id: providerId,
    name: "W20 容量 API",
    mode: "API",
    credential_type: "API_KEY",
  }).execute();

  // 冻结容量包络：100 员工 + 100 项目 = 200 Principal。
  await sql`
    INSERT INTO principal (id, enterprise_id, type, name)
    SELECT ('40000000-0000-4000-8000-' || lpad(to_hex(g), 12, '0'))::uuid,
           ${enterpriseId}::uuid,
           CASE WHEN g <= 100 THEN 'EMPLOYEE' ELSE 'PROJECT' END,
           CASE WHEN g <= 100
             THEN '员工-' || lpad(g::text, 3, '0')
             ELSE '项目-' || lpad((g - 100)::text, 3, '0')
           END
      FROM generate_series(1, 200) AS generated(g)
  `.execute(db);

  // 为单主体日／周／月查询构建完整日聚合；基础 Ledger 仍是权威事实。
  await sql`
    INSERT INTO usage_bucket_aggregate (
      enterprise_id, bucket_granularity, bucket_start, timezone,
      source_principal_id, project_principal_id, provider_resource_id,
      request_count, input_tokens, output_tokens, cache_tokens,
      reasoning_tokens, deducted_quota, api_cost, fact_watermark,
      max_fact_at, dirty, generated_at
    )
    SELECT ${enterpriseId}::uuid, 'DAY', day_start, 'Asia/Shanghai', p.id,
           CASE WHEN p.type = 'PROJECT' THEN p.id ELSE NULL END,
           ${resourceId}::uuid,
           162, 3240, 1620, 0, 0, 4860, 48.60000000,
           day_start + interval '23 hours', day_start + interval '23 hours',
           false, '2026-09-01 00:00:00+00'::timestamptz
      FROM principal p
      CROSS JOIN generate_series(
        '2026-07-31 16:00:00+00'::timestamptz,
        '2026-08-30 16:00:00+00'::timestamptz,
        interval '1 day'
      ) AS days(day_start)
     WHERE p.enterprise_id = ${enterpriseId}::uuid
  `.execute(db);
  await sql`
    INSERT INTO usage_aggregate_bucket_state (
      enterprise_id, bucket_granularity, bucket_start, timezone,
      fact_watermark, max_fact_at, generated_at
    )
    SELECT ${enterpriseId}::uuid, 'DAY', day_start, 'Asia/Shanghai',
           day_start + interval '23 hours', day_start + interval '23 hours',
           '2026-09-01 00:00:00+00'::timestamptz
      FROM generate_series(
        '2026-07-31 16:00:00+00'::timestamptz,
        '2026-08-30 16:00:00+00'::timestamptz,
        interval '1 day'
      ) AS days(day_start)
  `.execute(db);

  // 1,000,000 ledger 容量数据：仅跳过外键 trigger 以避免再造四百万行非本次容量对象。
  // 所有 ledger 主键、usage_event_id 及主体维度仍稳定唯一，索引与查询路径与真实表一致。
  await sql`SET synchronous_commit = off`.execute(db);
  await sql`SET session_replication_role = replica`.execute(db);
  try {
    await sql`
      INSERT INTO ledger_line (
        id, ai_request_id, enterprise_id, usage_event_id, upstream_attempt_id,
        provider_resource_id, principal_id, resource_mode, raw_input_tokens,
        raw_output_tokens, raw_cache_tokens, raw_reasoning_tokens,
        deducted_quota, api_cost, usage_quality, created_at
      )
      SELECT ('30000000-0000-4000-8000-' || lpad(to_hex(g), 12, '0'))::uuid,
             ('00000000-0000-4000-8000-' || lpad(to_hex(g), 12, '0'))::uuid,
             ${enterpriseId}::uuid,
             ('10000000-0000-4000-8000-' || lpad(to_hex(g), 12, '0'))::uuid,
             ('20000000-0000-4000-8000-' || lpad(to_hex(g), 12, '0'))::uuid,
             ${resourceId}::uuid,
             ('40000000-0000-4000-8000-'
               || lpad(to_hex(((g - 1) % 200) + 1), 12, '0'))::uuid,
             'API', 20, 10, 0, 0, NULL, 0.00030000,
             'PROVIDER_REPORTED',
             '2026-08-01 00:00:00+00'::timestamptz
               + (((g - 1) % 2678400) * interval '1 second')
        FROM generate_series(1, 1000000) AS generated(g)
    `.execute(db);
    await sql`
      INSERT INTO ledger_transaction (
        id, ai_request_id, enterprise_id, principal_id,
        total_input_tokens, total_output_tokens, total_cache_tokens,
        total_reasoning_tokens, total_deducted_quota, total_api_cost,
        usage_quality, attempt_count, status, created_at
      )
      SELECT ('50000000-0000-4000-8000-' || lpad(to_hex(g), 12, '0'))::uuid,
             ('00000000-0000-4000-8000-' || lpad(to_hex(g), 12, '0'))::uuid,
             ${enterpriseId}::uuid,
             ('40000000-0000-4000-8000-'
               || lpad(to_hex(((g - 1) % 200) + 1), 12, '0'))::uuid,
             20, 10, 0, 0, 0, 0.00030000,
             'PROVIDER_REPORTED', 1, 'SETTLED',
             '2026-08-01 00:00:00+00'::timestamptz
               + (((g - 1) % 2678400) * interval '1 second')
        FROM generate_series(1, 1000000) AS generated(g)
    `.execute(db);
  } finally {
    await sql`SET session_replication_role = origin`.execute(db);
  }
  await sql`ANALYZE principal, usage_bucket_aggregate, ledger_line, ledger_transaction`.execute(db);
  app = buildControlApi(db);
  await app.ready();
  const sessionToken = generateSessionToken();
  await new AdminRepository(db).createSession(
    adminId,
    digestSessionToken(sessionToken),
    new Date(Date.now() + 60 * 60_000),
  );
  adminCookie = `${SESSION_COOKIE_NAME}=${sessionToken}`;
}, 300_000);

afterAll(async () => {
  await app?.close();
  await db?.destroy();
  await pg?.stop();
}, 60_000);

describe("W20-10 标准容量合同", () => {
  it("100 员工、100 项目与 200 Principal 达到冻结包络", async () => {
    const dimensions = await sql<{ employees: string; projects: string; principals: string }>`
      SELECT count(*) FILTER (WHERE type = 'EMPLOYEE')::text AS employees,
             count(*) FILTER (WHERE type = 'PROJECT')::text AS projects,
             count(*)::text AS principals
        FROM principal WHERE enterprise_id = ${enterpriseId}::uuid
    `.execute(db);
    expect(dimensions.rows[0]).toEqual({ employees: "100", projects: "100", principals: "200" });
  });

  it("1,000,000 ledger 的常用管理、单主体聚合、资源与部门月账 P95 达标", async () => {
    const ledger = await sql<{ lines: string; actual_tokens: string; api_cost: string }>`
      SELECT count(*)::text AS lines,
             sum(raw_input_tokens + raw_output_tokens)::text AS actual_tokens,
             sum(api_cost)::numeric(24,8)::text AS api_cost
        FROM ledger_line WHERE enterprise_id = ${enterpriseId}::uuid
    `.execute(db);
    expect(ledger.rows[0]).toEqual({
      lines: "1000000",
      actual_tokens: "30000000",
      api_cost: "300.00000000",
    });

    const commonAdminP95 = await measuredP95(async () => {
      await sql`
        SELECT id, name, type, status
          FROM principal
         WHERE enterprise_id = ${enterpriseId}::uuid
         ORDER BY name, id
         LIMIT 100
      `.execute(db);
    });

    const usageRepository = new UsageOverviewRepository(
      db,
      () => new Date("2026-09-01T00:00:00.000Z"),
    );
    const subjectUsageP95 = await measuredP95(async () => {
      const result = await usageRepository.getOverview({
        enterpriseId,
        subjectType: "EMPLOYEE",
        subjectId: firstEmployeeId,
        period: "MONTH",
        anchor: new Date("2026-08-15T00:00:00.000Z"),
      });
      expect(result.source).toBe("BUCKET_AGGREGATE");
      expect(result.metrics.requestCount).toBe("5022");
    });

    const resourceUtilizationP95 = await measuredP95(async () => {
      const response = await app.inject({
        method: "GET",
        url: "/provider-resources/utilization?month=2026-08",
        headers: { cookie: adminCookie },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().resources).toEqual([
        expect.objectContaining({
          resourceId,
          requestCount: 1_000_000,
          realTokens: "30000000",
          apiCost: null,
          notCalculableReason: "MONTHLY_BUDGET_NOT_CONFIGURED",
        }),
      ]);
    });

    const departmentBillP95 = await measuredP95(async () => {
      const bill = await loadLiveDepartmentBill(db, enterpriseId, "2026-08");
      expect(bill.totals.requestCount).toBe(1_000_000);
      expect(bill.conservation.status).toBe("BALANCED");
    });

    if (process.env.W20_CAPACITY_EVIDENCE === "true") {
      process.stdout.write(`${JSON.stringify({
        commonAdminP95Ms: commonAdminP95,
        subjectUsageP95Ms: subjectUsageP95,
        resourceUtilizationP95Ms: resourceUtilizationP95,
        departmentBillP95Ms: departmentBillP95,
      })}\n`);
    }

    expect(commonAdminP95).toBeLessThanOrEqual(500);
    expect(subjectUsageP95).toBeLessThanOrEqual(800);
    expect(resourceUtilizationP95).toBeLessThanOrEqual(1_000);
    expect(departmentBillP95).toBeLessThanOrEqual(1_000);
  }, 300_000);

});
