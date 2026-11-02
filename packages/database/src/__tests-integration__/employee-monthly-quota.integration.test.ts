import { listDashboardOverages } from "../repositories/dashboard-overages.js";
import { recordEmployeeQuotaChange } from "../repositories/principal-access-quota-management.js";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql, type Kysely } from "kysely";
import {
  startPostgresContainer,
  type PostgresTestInstance,
} from "@qianliu/testing";
import {
  createKysely,
  migrateToLatest,
  EmployeeQuotaRepository,
  GatewayLedgerRepository,
  GrantRepository,
  adjustEmployeeQuotaPeriod,
  settleEmployeeQuotaInTransaction,
  previewEmployeeQuotaReconciliation,
  type Database,
} from "../index.js";
let pg: PostgresTestInstance;
let db: Kysely<Database>;
beforeAll(async () => {
  pg = await startPostgresContainer("employee_monthly_quota");
  db = createKysely(pg.connectionString);
  await migrateToLatest(db);
}, 120_000);
afterAll(async () => {
  await db?.destroy();
  await pg?.stop();
}, 60_000);
const NOV = new Date("2026-11-30T15:59:00Z");
const DEC = new Date("2026-11-30T16:02:00Z");
async function fixture(
  options: {
    allowOverage?: boolean;
    basis?: "RAW_TOKEN" | "PLAN_QUOTA";
    activation?: Date | null;
    type?: "EMPLOYEE" | "PROJECT";
  } = {},
) {
  const enterpriseId = randomUUID(),
    principalId = randomUUID(),
    requestId = randomUUID();
  await db
    .insertInto("enterprise")
    .values({
      id: enterpriseId,
      name: "monthly test",
      timezone: "Asia/Shanghai",
      employee_quota_monthly_from:
        options.activation === undefined
          ? new Date("2026-10-31T16:00:00Z")
          : options.activation,
    })
    .execute();
  await db
    .insertInto("principal")
    .values({
      id: principalId,
      enterprise_id: enterpriseId,
      type: options.type ?? "EMPLOYEE",
      name: "test",
      department_label: null,
      person_id: null,
      owner_person_id: null,
    })
    .execute();
  const key = await db
    .insertInto("principal_key")
    .values({
      enterprise_id: enterpriseId,
      principal_id: principalId,
      key_prefix: "monthly",
      key_digest: randomUUID(),
      allowed_model_ids: JSON.stringify([]) as unknown as string[],
      ip_allowlist: null,
      expires_at: null,
      quota_limit: null,
      concurrency_limit: null,
      last_used_at: null,
      revoked_at: null,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  await db
    .insertInto("ai_request")
    .values({
      id: requestId,
      enterprise_id: enterpriseId,
      principal_id: principalId,
      principal_key_id: key.id,
      status: "IN_PROGRESS",
      protocol: "OPENAI",
      unified_model: "test",
      idempotency_key: null,
      client_request_id: null,
      request_fingerprint: null,
      client_id: null,
      agent_version: null,
      finished_at: null,
      error_classification: null,
      error_code: null,
    })
    .execute();
  const grant = await db
    .insertInto("principal_grant")
    .values({
      enterprise_id: enterpriseId,
      principal_id: principalId,
      provider: "deepseek",
      model_alias: "*",
      pool_model_alias: "*",
      quota_value: 1000n,
      quota_basis: options.basis ?? "RAW_TOKEN",
      allow_overage: options.allowOverage ?? false,
      valid_from: new Date("2026-10-01T00:00:00Z"),
      valid_until: null,
      authorization_rule_version_id: null,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  await db.insertInto("quota_counter").values({ grant_id: grant.id }).execute();
  const repo = new EmployeeQuotaRepository(db);
  const reserve = (estimate = 400n, now = NOV, attemptNo = 1) =>
    repo.reserveEmployeeQuota({
      enterpriseId,
      principalId,
      provider: "deepseek",
      modelAlias: "test",
      requestId,
      attemptNo,
      basis: options.basis ?? "RAW_TOKEN",
      estimatedCost: estimate,
      now,
    });
  return {
    enterpriseId,
    principalId,
    requestId,
    grantId: grant.id,
    repo,
    reserve,
  };
}

describe("employee monthly quota persisted accounting", () => {
  it("legacy grant creation rejects configured monthly employees while preserving project access", async () => {
    const employee = await fixture();
    await expect(
      new GrantRepository(db).create({
        enterprise_id: employee.enterpriseId,
        principal_id: employee.principalId,
        provider: "other",
        model_alias: "model",
        quota_value: 10n,
      }),
    ).rejects.toThrow("请使用厂商池接入配置");
    const project = await fixture({ type: "PROJECT" });
    const grant = await new GrantRepository(db).create({
      enterprise_id: project.enterpriseId,
      principal_id: project.principalId,
      provider: "other",
      model_alias: "model",
      quota_value: 10n,
    });
    expect(grant.quota_basis).toBeNull();
  });

  it("default legacy, future activation and projects do not write monthly facts", async () => {
    for (const opts of [
      { activation: null },
      { activation: new Date("2026-11-30T16:00:00Z") },
      { type: "PROJECT" as const },
    ]) {
      const t = await fixture(opts);
      expect((await t.reserve()).mode).toBe("LEGACY");
      expect(
        await t.repo.readQuotaPeriods({
          enterpriseId: t.enterpriseId,
          periodKey: "2026-11",
        }),
      ).toEqual([]);
    }
  });
  it("concurrent duplicate reservations allocate once; old-month late settlement cannot consume next month", async () => {
    const t = await fixture();
    const [a, b] = await Promise.all([t.reserve(), t.reserve()]);
    expect(a.usageId).toBe(b.usageId);
    expect((await t.reserve(400n, DEC, 1)).periodId).toBe(a.periodId);
    const next = await t.reserve(100n, DEC, 2);
    expect(next.periodId).not.toBe(a.periodId);
    await t.repo.settleEmployeeQuota({
      enterpriseId: t.enterpriseId,
      usageId: a.usageId!,
      periodId: a.periodId!,
      actual: 1200n,
      now: DEC,
      usageQuality: "PROVIDER_REPORTED",
    });
    await t.repo.settleEmployeeQuota({
      enterpriseId: t.enterpriseId,
      usageId: a.usageId!,
      periodId: a.periodId!,
      actual: 1200n,
      now: DEC,
      usageQuality: "PROVIDER_REPORTED",
    });
    const [nov] = await t.repo.readQuotaPeriods({
      enterpriseId: t.enterpriseId,
      periodKey: "2026-11",
    });
    const [dec] = await t.repo.readQuotaPeriods({
      enterpriseId: t.enterpriseId,
      periodKey: "2026-12",
    });
    expect(BigInt(nov!.used_value)).toBe(1200n);
    expect(BigInt(nov!.reserved_value)).toBe(0n);
    expect(BigInt(dec!.used_value)).toBe(0n);
    expect(BigInt(dec!.reserved_value)).toBe(100n);
    expect(
      BigInt(
        (
          await db
            .selectFrom("quota_counter")
            .select("used_value")
            .where("grant_id", "=", t.grantId)
            .executeTakeFirstOrThrow()
        ).used_value,
      ),
    ).toBe(0n);
  });
  it("allow overage reserves real estimate; deny overage rejects before creating usage", async () => {
    const no = await fixture();
    const rejected = await no.reserve(1200n);
    expect(rejected.decision).toBe("REJECT_EXHAUSTED");
    expect(rejected.periodEnd?.toISOString()).toBe("2026-11-30T16:00:00.000Z");
    expect(rejected.usageId).toBeUndefined();
    const yes = await fixture({ allowOverage: true });
    const outcome = await yes.reserve(1200n);
    expect(outcome.decision).toBe("ALLOW_OVERAGE");
    expect(
      await db
        .selectFrom("principal_quota_usage")
        .selectAll()
        .where("request_id", "=", no.requestId)
        .execute(),
    ).toHaveLength(0);
  });
  it("unknown preserves reservation, zero release clears it, replay cannot change consumption", async () => {
    const t = await fixture();
    const a = await t.reserve();
    const ref = {
      enterpriseId: t.enterpriseId,
      usageId: a.usageId!,
      periodId: a.periodId!,
    };
    await t.repo.settleEmployeeQuota({ ...ref, actual: null });
    await t.repo.settleEmployeeQuota({ ...ref, actual: null });
    let [period] = await t.repo.readQuotaPeriods({
      enterpriseId: t.enterpriseId,
      periodKey: "2026-11",
    });
    expect(BigInt(period!.reserved_value)).toBe(400n);
    expect(period!.quality).toBe("UNKNOWN");
    await t.repo.settleEmployeeQuota({ ...ref, actual: 0n, release: true });
    [period] = await t.repo.readQuotaPeriods({
      enterpriseId: t.enterpriseId,
      periodKey: "2026-11",
    });
    expect(BigInt(period!.reserved_value)).toBe(0n);
    expect(period!.quality).toBe("COMPLETE");
    await expect(
      t.repo.settleEmployeeQuota({ ...ref, actual: 1n }),
    ).rejects.toThrow("quota_settlement_replay_conflict");
  });
  it("API raw and plan frozen estimate remain separate bases, SET preserves consumption", async () => {
    for (const [basis, actual] of [
      ["RAW_TOKEN", 1200n],
      ["PLAN_QUOTA", 600n],
    ] as const) {
      const t = await fixture({ basis, allowOverage: true });
      const a = await t.reserve();
      await t.repo.settleEmployeeQuota({
        enterpriseId: t.enterpriseId,
        usageId: a.usageId!,
        periodId: a.periodId!,
        actual,
        now: NOV,
      });
      await db.transaction().execute(async (trx) => {
        await trx
          .updateTable("principal_grant")
          .set({ quota_value: 500n })
          .where("id", "=", t.grantId)
          .execute();
        const result = await adjustEmployeeQuotaPeriod(trx, {
          enterpriseId: t.enterpriseId,
          principalId: t.principalId,
          provider: "deepseek",
          now: NOV,
        });
        expect(result!.after.used).toBe(String(actual));
        expect(result!.after.limit).toBe("500");
      });
      const [period] = await t.repo.readQuotaPeriods({
        enterpriseId: t.enterpriseId,
        periodKey: "2026-11",
      });
      expect(period!.quota_basis).toBe(basis);
      expect(BigInt(period!.used_value)).toBe(actual);
    }
  });
  it("transaction fault rolls back quota and consumption together; foreign enterprise cannot settle", async () => {
    const t = await fixture();
    const a = await t.reserve();
    await expect(
      db.transaction().execute(async (trx) => {
        await settleEmployeeQuotaInTransaction(trx, {
          enterpriseId: t.enterpriseId,
          usageId: a.usageId!,
          periodId: a.periodId!,
          actual: 100n,
        });
        await sql`SELECT 1/0`.execute(trx);
      }),
    ).rejects.toThrow();
    const [period] = await t.repo.readQuotaPeriods({
      enterpriseId: t.enterpriseId,
      periodKey: "2026-11",
    });
    expect(BigInt(period!.used_value)).toBe(0n);
    expect(BigInt(period!.reserved_value)).toBe(400n);
    await expect(
      t.repo.settleEmployeeQuota({
        enterpriseId: randomUUID(),
        usageId: a.usageId!,
        periodId: a.periodId!,
        actual: 100n,
      }),
    ).rejects.toThrow();
  });
  it("disabling and recreating a grant reuses the employee provider monthly account", async () => {
    const t = await fixture();
    const a = await t.reserve();
    await t.repo.settleEmployeeQuota({
      enterpriseId: t.enterpriseId,
      usageId: a.usageId!,
      periodId: a.periodId!,
      actual: 300n,
    });
    await db
      .updateTable("principal_grant")
      .set({ status: "DISABLED" })
      .where("id", "=", t.grantId)
      .execute();
    expect(
      await t.repo.ensureCurrentQuotaPeriod({
        enterpriseId: t.enterpriseId,
        principalId: t.principalId,
        provider: "deepseek",
        now: NOV,
      }),
    ).toBeNull();
    await db
      .updateTable("principal_grant")
      .set({ status: "ACTIVE" })
      .where("id", "=", t.grantId)
      .execute();
    const restored = await t.repo.ensureCurrentQuotaPeriod({
      enterpriseId: t.enterpriseId,
      principalId: t.principalId,
      provider: "deepseek",
      now: NOV,
    });
    expect(restored!.id).toBe(a.periodId);
    expect(BigInt(restored!.used_value)).toBe(300n);
  });
  it("historical preview is read only, scoped, deterministic and cannot infer current authorization", async () => {
    const t = await fixture();
    const scope = {
      enterpriseId: t.enterpriseId,
      principalIds: [t.principalId],
      start: new Date("2026-10-01T00:00:00Z"),
      end: new Date("2026-11-01T00:00:00Z"),
    };
    const result = await db.transaction().execute(async (trx) => {
      await sql`SET TRANSACTION READ ONLY`.execute(trx);
      return previewEmployeeQuotaReconciliation(trx, scope);
    });
    expect(result.mode).toBe("READ_ONLY_PREVIEW");
    expect(result.hash).toBe(
      (await previewEmployeeQuotaReconciliation(db, scope)).hash,
    );
    expect(
      await t.repo.readQuotaPeriods({
        enterpriseId: t.enterpriseId,
        periodKey: "2026-10",
      }),
    ).toEqual([]);
    await expect(
      previewEmployeeQuotaReconciliation(db, { ...scope, principalIds: [] }),
    ).rejects.toThrow("quota_preview_scope_required");
  });
  it("migration rollback preserves accumulated monthly and legacy facts", async () => {
    const t = await fixture();
    const a = await t.reserve();
    const migrationPath = new URL(
      "../../migrations/0092_employee_monthly_quota.js",
      import.meta.url,
    ).href;
    const migration = await import(migrationPath);
    await migration.down(db);
    await migration.up(db);
    const [period] = await t.repo.readQuotaPeriods({
      enterpriseId: t.enterpriseId,
      periodKey: "2026-11",
    });
    expect(period!.id).toBe(a.periodId);
    expect(BigInt(period!.reserved_value)).toBe(400n);
    expect(
      await db
        .selectFrom("quota_counter")
        .select("grant_id")
        .where("grant_id", "=", t.grantId)
        .executeTakeFirst(),
    ).toBeDefined();
  });
  it("as-of policy uses audited before values when allocation and overage change after cutoff", async () => {
    const t = await fixture();
    const reservation = await t.reserve();
    await t.repo.settleEmployeeQuota({
      enterpriseId: t.enterpriseId,
      usageId: reservation.usageId!,
      periodId: reservation.periodId!,
      actual: 300n,
      now: NOV,
    });
    const cutoff = new Date(+NOV + 30000);
    const changedAt = new Date(+NOV + 45000);
    const admin = await db
      .insertInto("admin_user")
      .values({
        enterprise_id: t.enterpriseId,
        username: randomUUID(),
        password_hash: "test",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await db.transaction().execute(async (trx) => {
      const before = await trx
        .selectFrom("principal_grant")
        .selectAll()
        .where("id", "=", t.grantId)
        .executeTakeFirstOrThrow();
      await trx
        .updateTable("principal_grant")
        .set({ quota_value: 2000n, allow_overage: true, version: 2 })
        .where("id", "=", t.grantId)
        .execute();
      await recordEmployeeQuotaChange(trx, {
        enterpriseId: t.enterpriseId,
        principalId: t.principalId,
        provider: "deepseek",
        grantId: t.grantId,
        adminUserId: admin.id,
        action: "SET",
        before,
        now: changedAt,
      });
    });
    const [historical] = await t.repo.readQuotaPeriods({
      enterpriseId: t.enterpriseId,
      periodKey: "2026-11",
      asOf: cutoff,
    });
    const [current] = await t.repo.readQuotaPeriods({
      enterpriseId: t.enterpriseId,
      periodKey: "2026-11",
    });
    expect(BigInt(historical!.limit_value)).toBe(1000n);
    expect(historical!.allow_overage).toBe(false);
    expect(historical!.quality).toBe("COMPLETE");
    expect(BigInt(current!.limit_value)).toBe(2000n);
    expect(current!.allow_overage).toBe(true);
    await db
      .updateTable("principal_quota_period")
      .set({ limit_updated_at: new Date(+changedAt + 1) })
      .where("id", "=", reservation.periodId!)
      .execute();
    await db
      .updateTable("operation_log")
      .set({ change_summary: { schemaVersion: 1 } })
      .where("enterprise_id", "=", t.enterpriseId)
      .where("action", "=", "principal_quota.change")
      .execute();
    expect(
      (
        await t.repo.readQuotaPeriods({
          enterpriseId: t.enterpriseId,
          periodKey: "2026-11",
          asOf: cutoff,
        })
      )[0]!.quality,
    ).toBe("UNKNOWN");
  });
  it("timezone edits retain the already-open enterprise month boundaries", async () => {
    const t = await fixture();
    const reservation = await t.reserve();
    await db
      .updateTable("enterprise")
      .set({ timezone: "UTC" })
      .where("id", "=", t.enterpriseId)
      .execute();
    const period = await t.repo.ensureCurrentQuotaPeriod({
      enterpriseId: t.enterpriseId,
      principalId: t.principalId,
      provider: "deepseek",
      now: NOV,
    });
    expect(period!.id).toBe(reservation.periodId);
    expect(period!.timezone).toBe("Asia/Shanghai");
    expect(period!.period_end.toISOString()).toBe("2026-11-30T16:00:00.000Z");
  });
  it("dashboard reads active-month employee overages while preserving project legacy counters", async () => {
    const t = await fixture({ allowOverage: true });
    const a = await t.reserve();
    await t.repo.settleEmployeeQuota({
      enterpriseId: t.enterpriseId,
      usageId: a.usageId!,
      periodId: a.periodId!,
      actual: 1200n,
      now: NOV,
    });
    await db
      .updateTable("quota_counter")
      .set({ used_value: 10000n, overage_value: 9000n })
      .where("grant_id", "=", t.grantId)
      .execute();
    const project = await db
      .insertInto("principal")
      .values({
        enterprise_id: t.enterpriseId,
        type: "PROJECT",
        name: "project",
        department_label: null,
        person_id: null,
        owner_person_id: null,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const grant = await db
      .insertInto("principal_grant")
      .values({
        enterprise_id: t.enterpriseId,
        principal_id: project.id,
        provider: "deepseek",
        model_alias: "*",
        pool_model_alias: "*",
        quota_value: 1000n,
        valid_until: null,
        authorization_rule_version_id: null,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await db
      .insertInto("quota_counter")
      .values({ grant_id: grant.id, used_value: 1500n, overage_value: 500n })
      .execute();
    const overages = await listDashboardOverages(db, t.enterpriseId, NOV);
    expect(overages.map((row) => [row.principalId, row.overageValue])).toEqual([
      [project.id, "500"],
      [t.principalId, "200"],
    ]);
    expect(
      (await listDashboardOverages(db, t.enterpriseId, DEC)).map(
        (row) => row.principalId,
      ),
    ).toEqual([project.id]);
  });
  it("initialization catches up once and invalid reservations cannot consume a monthly account", async () => {
    const t=await fixture();
    expect(await t.repo.initializeCurrentQuotaPeriods({enterpriseId:t.enterpriseId,now:NOV})).toEqual({initialized:1});
    expect(await t.repo.initializeCurrentQuotaPeriods({enterpriseId:t.enterpriseId,now:NOV})).toEqual({initialized:1});
    expect(await t.repo.readQuotaPeriods({enterpriseId:t.enterpriseId,principalIds:[],periodKey:"2026-11"})).toEqual([]);
    await expect(t.reserve(-1n)).rejects.toThrow("invalid_quota_reservation");
    await expect(t.reserve(1n,NOV,0)).rejects.toThrow("invalid_quota_reservation");
    const reservation=await t.reserve(200n);
    await expect(t.reserve(300n)).rejects.toThrow("quota_reservation_replay_conflict");
    await expect(t.repo.reserveEmployeeQuota({enterpriseId:t.enterpriseId,principalId:t.principalId,provider:"deepseek",modelAlias:"test",requestId:t.requestId,attemptNo:2,basis:"PLAN_QUOTA",estimatedCost:1n,now:NOV})).rejects.toThrow("quota_basis_route_conflict");
    const [period]=await t.repo.readQuotaPeriods({enterpriseId:t.enterpriseId,periodKey:"2026-11"});
    expect(period!.id).toBe(reservation.periodId);expect(BigInt(period!.reserved_value)).toBe(200n);
  });
  it("disabled models and revoked pools reject without creating consumption facts", async () => {
    const t=await fixture();
    const model=await db.insertInto("unified_model").values({enterprise_id:t.enterpriseId,alias:"test",display_name:"disabled model"}).returning("id").executeTakeFirstOrThrow();
    await db.insertInto("principal_provider_disabled_model").values({enterprise_id:t.enterpriseId,principal_id:t.principalId,provider:"deepseek",unified_model_id:model.id,disable_rule_version_id:null}).execute();
    expect((await t.reserve()).decision).toBe("REJECT_NO_GRANT");
    await db.updateTable("principal_grant").set({status:"DISABLED"}).where("id","=",t.grantId).execute();
    expect((await t.reserve()).decision).toBe("REJECT_NO_GRANT");
    expect(await db.selectFrom("principal_quota_usage").select("id").where("enterprise_id","=",t.enterpriseId).execute()).toHaveLength(0);
    const future=await fixture({activation:new Date("2026-11-30T16:00:00Z")});
    expect(await future.repo.initializeCurrentQuotaPeriods({enterpriseId:future.enterpriseId,now:NOV})).toEqual({initialized:0});
  });
  it("binds the exact upstream Attempt and rejects changed identity or settlement scope", async () => {
    const t=await fixture();const reservation=await t.reserve();
    const provider=await db.insertInto("provider").values({enterprise_id:t.enterpriseId,code:"deepseek",name:"synthetic",adapter_type:"OPENAI_COMPATIBLE"}).returning("id").executeTakeFirstOrThrow();
    const resource=await db.insertInto("provider_resource").values({enterprise_id:t.enterpriseId,provider_id:provider.id,name:"synthetic API",mode:"API",credential_type:"API_KEY"}).returning("id").executeTakeFirstOrThrow();
    const attempts=await db.insertInto("upstream_attempt").values([1,2].map(attempt_no=>({enterprise_id:t.enterpriseId,ai_request_id:t.requestId,attempt_no,provider_resource_id:resource.id,upstream_model:"test"}))).returning(["id","attempt_no"]).execute();
    const first=attempts.find(row=>row.attempt_no===1)!;const second=attempts.find(row=>row.attempt_no===2)!;
    await t.repo.bindEmployeeQuotaAttempt({enterpriseId:t.enterpriseId,usageId:reservation.usageId!,upstreamAttemptId:first.id});
    await t.repo.bindEmployeeQuotaAttempt({enterpriseId:t.enterpriseId,usageId:reservation.usageId!,upstreamAttemptId:first.id});
    await expect(t.repo.bindEmployeeQuotaAttempt({enterpriseId:t.enterpriseId,usageId:reservation.usageId!,upstreamAttemptId:second.id})).rejects.toThrow("quota_attempt_binding_conflict");
    const ref={enterpriseId:t.enterpriseId,usageId:reservation.usageId!,periodId:reservation.periodId!};
    await expect(t.repo.settleEmployeeQuota({...ref,actual:-1n})).rejects.toThrow("negative_quota_actual");
    await expect(t.repo.settleEmployeeQuota({...ref,principalId:randomUUID(),actual:10n})).rejects.toThrow("quota_settlement_scope_conflict");
    await expect(t.repo.settleEmployeeQuota({...ref,actual:10n,release:true})).rejects.toThrow("quota_release_nonzero");
    expect((await db.selectFrom("principal_quota_usage").select("upstream_attempt_id").where("id","=",reservation.usageId!).executeTakeFirstOrThrow()).upstream_attempt_id).toBe(first.id);
    const [period]=await t.repo.readQuotaPeriods({enterpriseId:t.enterpriseId,periodKey:"2026-11"});expect(BigInt(period!.reserved_value)).toBe(400n);
  });
  it("rejects malformed activation or basis changes while retaining the current month's proven units", async () => {
    const malformed=await fixture({activation:new Date("2026-11-02T00:00:00Z")});
    await expect(malformed.reserve()).rejects.toThrow("quota_activation_not_month_start");
    const missing=await fixture();await db.updateTable("principal_grant").set({quota_basis:null}).where("id","=",missing.grantId).execute();
    await expect(missing.reserve()).rejects.toThrow("quota_basis_not_configured");
    const frozen=await fixture();const reservation=await frozen.reserve();
    await db.updateTable("principal_grant").set({quota_basis:"PLAN_QUOTA"}).where("id","=",frozen.grantId).execute();
    await expect(frozen.repo.ensureCurrentQuotaPeriod({enterpriseId:frozen.enterpriseId,principalId:frozen.principalId,provider:"deepseek",now:NOV})).rejects.toThrow("quota_basis_frozen_for_month");
    expect((await frozen.repo.readQuotaPeriods({enterpriseId:frozen.enterpriseId,periodKey:"2026-11"}))[0]!.id).toBe(reservation.periodId);
  });
  it("previews real API and Plan source rows without inventing historical authorization or changing costs", async () => {
    const t=await fixture();
    const provider=await db.insertInto("provider").values({enterprise_id:t.enterpriseId,code:"deepseek",name:"synthetic history",adapter_type:"OPENAI_COMPATIBLE"}).returning("id").executeTakeFirstOrThrow();
    for(const [attemptNo,mode,raw,deducted,cost] of [[1,"API",1200n,null,"0.012"],[2,"CODING_PLAN",600n,300n,null]] as const) {
      const resource=await db.insertInto("provider_resource").values({enterprise_id:t.enterpriseId,provider_id:provider.id,name:"historical "+mode,mode,credential_type:mode==="API"?"API_KEY":"SUBSCRIPTION_SESSION"}).returning("id").executeTakeFirstOrThrow();
      const attempt=await db.insertInto("upstream_attempt").values({enterprise_id:t.enterpriseId,ai_request_id:t.requestId,attempt_no:attemptNo,provider_resource_id:resource.id,upstream_model:"historical"}).returning("id").executeTakeFirstOrThrow();
      const usage=await db.insertInto("usage_event").values({enterprise_id:t.enterpriseId,ai_request_id:t.requestId,upstream_attempt_id:attempt.id,provider_resource_id:resource.id,input_tokens:raw,output_tokens:0n,cache_tokens:0n,usage_quality:"PROVIDER_REPORTED",dedup_key:randomUUID()}).returning("id").executeTakeFirstOrThrow();
      await db.insertInto("ledger_line").values({enterprise_id:t.enterpriseId,ai_request_id:t.requestId,usage_event_id:usage.id,upstream_attempt_id:attempt.id,provider_resource_id:resource.id,principal_id:t.principalId,resource_mode:mode,raw_input_tokens:raw,raw_output_tokens:0n,raw_cache_tokens:0n,deducted_quota:deducted,api_cost:cost,api_cost_status:mode==="API"?"PRICED_USAGE":"NOT_APPLICABLE",api_cost_currency:mode==="API"?"CNY":null,settled_at:NOV,usage_quality:"PROVIDER_REPORTED"}).execute();
    }
    const scope={enterpriseId:t.enterpriseId,principalIds:[t.principalId],start:new Date("2026-11-01T00:00:00+08:00"),end:new Date("2026-12-01T00:00:00+08:00")};
    const preview=await previewEmployeeQuotaReconciliation(db,scope);
    expect(preview.rows).toHaveLength(2);
    expect(preview.rows.find(row=>row.basis==="RAW_TOKEN")).toMatchObject({rawTokens:"1200",planQuota:null,quality:"UNKNOWN",grantVersionProvable:false,targetValue:null,difference:null});
    expect(preview.rows.find(row=>row.basis==="PLAN_QUOTA")).toMatchObject({rawTokens:"600",planQuota:"300",apiCost:null,quality:"UNKNOWN"});
    expect((await previewEmployeeQuotaReconciliation(db,scope)).hash).toBe(preview.hash);
    const api=await db.selectFrom("ledger_line").select(["api_cost","deducted_quota"]).where("enterprise_id","=",t.enterpriseId).where("resource_mode","=","API").executeTakeFirstOrThrow();
    expect(Number(api.api_cost)).toBe(0.012);expect(api.deducted_quota).toBeNull();
  });

  it.each(["complete", "missing-period", "missing-usage"] as const)("atomic consumed usage preserves the monthly/legacy partition: %s", async kind => {
    const t=await fixture();const reservation=await t.reserve();
    const provider=await db.insertInto("provider").values({enterprise_id:t.enterpriseId,code:"deepseek",name:"monthly terminal accounting",adapter_type:"OPENAI_COMPATIBLE"}).returning("id").executeTakeFirstOrThrow();
    const resource=await db.insertInto("provider_resource").values({enterprise_id:t.enterpriseId,provider_id:provider.id,name:"monthly API",mode:"API",credential_type:"API_KEY"}).returning("id").executeTakeFirstOrThrow();
    const attempt=await db.insertInto("upstream_attempt").values({enterprise_id:t.enterpriseId,ai_request_id:t.requestId,attempt_no:1,provider_resource_id:resource.id,upstream_model:"test"}).returning("id").executeTakeFirstOrThrow();
    await t.repo.bindEmployeeQuotaAttempt({enterpriseId:t.enterpriseId,usageId:reservation.usageId!,upstreamAttemptId:attempt.id});
    const repo=new GatewayLedgerRepository(db);
    const settlement=repo.persistAttemptUsageAccountingIfAbsent({
      usage:{enterprise_id:t.enterpriseId,ai_request_id:t.requestId,upstream_attempt_id:attempt.id,provider_resource_id:resource.id,input_tokens:1000n,output_tokens:200n,cache_tokens:0n,usage_quality:"PROVIDER_REPORTED",dedup_key:randomUUID()},
      ledger_line:{enterprise_id:t.enterpriseId,ai_request_id:t.requestId,upstream_attempt_id:attempt.id,provider_resource_id:resource.id,principal_id:t.principalId,resource_mode:"API",raw_input_tokens:1000n,raw_output_tokens:200n,raw_cache_tokens:0n,deducted_quota:null,api_cost:"0.12",api_cost_currency:"CNY",api_cost_status:"PRICED_USAGE",usage_quality:"PROVIDER_REPORTED",settled_at:DEC},
      attempt_result:{http_status:200,response_committed:true,finished_at:DEC,error_classification:null,error_code:null,switch_reason:null},
      quota_settlements:[{grant_id:t.grantId,reserved_estimate:400n,actual_deducted:1200n,period_id:kind==="missing-period"?undefined:reservation.periodId,usage_id:kind==="missing-usage"?undefined:reservation.usageId,usage_quality:"PROVIDER_REPORTED"}],
    });
    if(kind==="complete") {
      await expect(settlement).resolves.toMatchObject({created:true});
      const [period]=await t.repo.readQuotaPeriods({enterpriseId:t.enterpriseId,periodKey:"2026-11"});
      expect(BigInt(period!.used_value)).toBe(1200n);expect(BigInt(period!.reserved_value)).toBe(0n);
      expect((await db.selectFrom("principal_quota_usage").select(["status","actual"]).where("id","=",reservation.usageId!).executeTakeFirstOrThrow()).status).toBe("SETTLED");
      expect(await repo.listLedgerLines(t.requestId)).toHaveLength(1);
    } else {
      await expect(settlement).rejects.toThrow("quota_monthly_reference_incomplete");
      expect(await repo.listUsageEvents(t.requestId)).toEqual([]);expect(await repo.listLedgerLines(t.requestId)).toEqual([]);
      const [period]=await t.repo.readQuotaPeriods({enterpriseId:t.enterpriseId,periodKey:"2026-11"});
      expect(BigInt(period!.used_value)).toBe(0n);expect(BigInt(period!.reserved_value)).toBe(400n);
      expect((await db.selectFrom("upstream_attempt").select("finished_at").where("id","=",attempt.id).executeTakeFirstOrThrow()).finished_at).toBeNull();
    }
    expect(BigInt((await db.selectFrom("quota_counter").select("used_value").where("grant_id","=",t.grantId).executeTakeFirstOrThrow()).used_value)).toBe(0n);
  });

});
