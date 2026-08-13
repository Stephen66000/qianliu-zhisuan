import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createKysely,
  migrateToLatest,
  OperatingBillAccountReferenceError,
  OperatingBillAccountRepository,
  OperatingBillRepository,
  UsageRepository,
} from "../index.js";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";

let pg: PostgresTestInstance;
let db: ReturnType<typeof createKysely>;
let accountRepo: OperatingBillAccountRepository;

const enterpriseId = randomUUID();
const otherEnterpriseId = randomUUID();
const adminId = randomUUID();
const employeeId = randomUUID();
const unknownEmployeeId = randomUUID();
const otherEmployeeId = randomUUID();
const projectId = randomUUID();
const directProjectId = randomUUID();
const projectOwnerPersonId = randomUUID();
const nextProjectOwnerPersonId = randomUUID();
const projectDepartmentId = randomUUID();
const directProjectDepartmentId = randomUUID();
const keyId = randomUUID();
const unknownKeyId = randomUUID();
const otherKeyId = randomUUID();
const projectKeyId = randomUUID();
const flashId = randomUUID();
const proId = randomUUID();
const unknownModelId = randomUUID();
const otherModelId = randomUUID();
let apiResourceId: string;
let planResourceId: string;
let incompletePlanResourceId: string;
let assignedRequestId: string;
let unassignedRequestId: string;
let directProjectRequestId: string;

interface UsageSeed {
  enterprise?: string;
  principal: string;
  key: string;
  modelId: string | null;
  alias: string;
  resource: string;
  mode: "API" | "CODING_PLAN";
  input: bigint;
  output: bigint;
  cache: bigint;
  deducted: bigint | null;
  cost: string | null;
  quality: string;
  at: Date;
}

async function addUsage(seed: UsageSeed): Promise<string> {
  const enterprise = seed.enterprise ?? enterpriseId;
  const requestId = randomUUID();
  await db.insertInto("ai_request").values({
    id: requestId, enterprise_id: enterprise, principal_id: seed.principal,
    principal_key_id: seed.key, protocol: "chat", unified_model: seed.alias,
    unified_model_id: seed.modelId, status: "SUCCEEDED", started_at: seed.at,
    finished_at: new Date(seed.at.getTime() + 500),
  }).execute();
  const attempt = await db.insertInto("upstream_attempt").values({
    ai_request_id: requestId, enterprise_id: enterprise, attempt_no: 1,
    provider_resource_id: seed.resource, upstream_model: "shared-upstream",
    finished_at: new Date(seed.at.getTime() + 500), http_status: 200, response_committed: true,
  }).returning("id").executeTakeFirstOrThrow();
  const usage = await db.insertInto("usage_event").values({
    ai_request_id: requestId, enterprise_id: enterprise, upstream_attempt_id: attempt.id,
    provider_resource_id: seed.resource, input_tokens: seed.input, output_tokens: seed.output,
    cache_tokens: seed.cache, reasoning_tokens: 0n, usage_quality: seed.quality,
    dedup_key: `pool043-${requestId}`, created_at: seed.at,
  }).returning("id").executeTakeFirstOrThrow();
  await db.insertInto("ledger_line").values({
    ai_request_id: requestId, enterprise_id: enterprise, usage_event_id: usage.id,
    upstream_attempt_id: attempt.id, provider_resource_id: seed.resource,
    principal_id: seed.principal, resource_mode: seed.mode,
    raw_input_tokens: seed.input, raw_output_tokens: seed.output,
    raw_cache_tokens: seed.cache, raw_reasoning_tokens: 0n,
    deducted_quota: seed.deducted, api_cost: seed.cost, usage_quality: seed.quality,
    created_at: seed.at,
  }).execute();
  await db.insertInto("ledger_transaction").values({
    ai_request_id: requestId, enterprise_id: enterprise, principal_id: seed.principal,
    total_input_tokens: seed.input, total_output_tokens: seed.output,
    total_cache_tokens: seed.cache, total_reasoning_tokens: 0n,
    total_deducted_quota: seed.deducted ?? 0n,
    total_api_cost: seed.mode === "API" ? seed.cost ?? "0" : "0",
    usage_quality: seed.quality, attempt_count: 1, status: "SETTLED", created_at: seed.at,
  }).execute();
  return requestId;
}

beforeAll(async () => {
  pg = process.env.POOL043_ACCOUNT_DATABASE_URL
    ? { connectionString: process.env.POOL043_ACCOUNT_DATABASE_URL, stop: async () => undefined }
    : await startPostgresContainer("pool043_accounts");
  db = createKysely(pg.connectionString);
  await migrateToLatest(db);
  await db.insertInto("enterprise").values([
    { id: enterpriseId, name: "POOL-043 企业" },
    { id: otherEnterpriseId, name: "隔离企业" },
  ]).execute();
  await db.insertInto("admin_user").values({
    id: adminId, enterprise_id: enterpriseId, username: "pool043", display_name: "经营管理员",
    password_hash: "not-used", status: "ACTIVE",
  }).execute();
  await db.insertInto("person").values([
    { id: projectOwnerPersonId, enterprise_id: enterpriseId, name: "项目负责人" },
    { id: nextProjectOwnerPersonId, enterprise_id: enterpriseId, name: "变更后负责人" },
  ]).execute();
  await db.insertInto("organization_unit").values([
    { id: projectDepartmentId, enterprise_id: enterpriseId, parent_id: null,
      name: "研发中心", external_source_id: null, external_unit_id: "研发中心" },
    { id: directProjectDepartmentId, enterprise_id: enterpriseId, parent_id: null,
      name: "产品中心", external_source_id: null, external_unit_id: "产品中心" },
  ]).execute();
  await db.insertInto("principal").values([
    { id: employeeId, enterprise_id: enterpriseId, type: "EMPLOYEE", name: "于滔" },
    { id: unknownEmployeeId, enterprise_id: enterpriseId, type: "EMPLOYEE", name: "未知员工" },
    { id: projectId, enterprise_id: enterpriseId, type: "PROJECT", name: "星河项目",
      owner_person_id: projectOwnerPersonId },
    { id: directProjectId, enterprise_id: enterpriseId, type: "PROJECT", name: "直接项目",
      owner_person_id: projectOwnerPersonId },
    { id: otherEmployeeId, enterprise_id: otherEnterpriseId, type: "EMPLOYEE", name: "隔离员工" },
  ]).execute();
  await db.insertInto("project_department_assignment").values([
    { enterprise_id: enterpriseId, project_principal_id: projectId,
      organization_unit_id: projectDepartmentId, valid_from: new Date("2026-07-01T00:00:00Z"),
      valid_until: null, source: "EXPLICIT", owner_person_id_at_assignment: projectOwnerPersonId,
      created_by: adminId, reason: "项目账时点部门测试" },
    { enterprise_id: enterpriseId, project_principal_id: directProjectId,
      organization_unit_id: directProjectDepartmentId, valid_from: new Date("2026-07-01T00:00:00Z"),
      valid_until: null, source: "EXPLICIT", owner_person_id_at_assignment: projectOwnerPersonId,
      created_by: adminId, reason: "项目账时点部门测试" },
  ]).execute();
  await db.insertInto("unified_model").values([
    { id: flashId, enterprise_id: enterpriseId, alias: "ql-deepseek-v4-flash", display_name: "DeepSeek V4 Flash" },
    { id: proId, enterprise_id: enterpriseId, alias: "ql-deepseek-v4-pro", display_name: "DeepSeek V4 Pro" },
    { id: unknownModelId, enterprise_id: enterpriseId, alias: "ql-unknown", display_name: "Unknown" },
    { id: otherModelId, enterprise_id: otherEnterpriseId, alias: "ql-other", display_name: "Other" },
  ]).execute();
  await db.insertInto("principal_key").values([
    { id: keyId, enterprise_id: enterpriseId, principal_id: employeeId, key_prefix: "ql_yt", key_digest: randomUUID(), allowed_model_ids: JSON.stringify([flashId, proId]) as unknown as string[] },
    { id: unknownKeyId, enterprise_id: enterpriseId, principal_id: unknownEmployeeId, key_prefix: "ql_un", key_digest: randomUUID(), allowed_model_ids: JSON.stringify([unknownModelId]) as unknown as string[] },
    { id: projectKeyId, enterprise_id: enterpriseId, principal_id: directProjectId, key_prefix: "ql_pr", key_digest: randomUUID(), allowed_model_ids: JSON.stringify([flashId]) as unknown as string[] },
    { id: otherKeyId, enterprise_id: otherEnterpriseId, principal_id: otherEmployeeId, key_prefix: "ql_ot", key_digest: randomUUID(), allowed_model_ids: JSON.stringify([otherModelId]) as unknown as string[] },
  ]).execute();
  const provider = await db.insertInto("provider").values({
    enterprise_id: enterpriseId, code: "deepseek", name: "DeepSeek", adapter_type: "openai",
  }).returning("id").executeTakeFirstOrThrow();
  const otherProvider = await db.insertInto("provider").values({
    enterprise_id: otherEnterpriseId, code: "other", name: "Other", adapter_type: "openai",
  }).returning("id").executeTakeFirstOrThrow();
  const resources = await db.insertInto("provider_resource").values([
    { enterprise_id: enterpriseId, provider_id: provider.id, name: "API", mode: "API", credential_type: "API_KEY" },
    { enterprise_id: enterpriseId, provider_id: provider.id, name: "Coding Plan", mode: "CODING_PLAN", credential_type: "API_KEY" },
    { enterprise_id: enterpriseId, provider_id: provider.id, name: "缺失扣减 Coding Plan", mode: "CODING_PLAN", credential_type: "API_KEY" },
  ]).returning(["id", "mode"]).execute();
  apiResourceId = resources.find((row) => row.mode === "API")!.id;
  [planResourceId, incompletePlanResourceId] = resources
    .filter((row) => row.mode === "CODING_PLAN").map((row) => row.id);
  const otherResource = await db.insertInto("provider_resource").values({
    enterprise_id: otherEnterpriseId, provider_id: otherProvider.id, name: "Other API",
    mode: "API", credential_type: "API_KEY",
  }).returning("id").executeTakeFirstOrThrow();
  await db.insertInto("model_route").values([
    { enterprise_id: enterpriseId, unified_model_id: flashId, provider_resource_id: apiResourceId, upstream_model: "shared-upstream" },
    { enterprise_id: enterpriseId, unified_model_id: proId, provider_resource_id: apiResourceId, upstream_model: "shared-upstream" },
  ]).execute();
  await db.insertInto("provider_resource_operating_snapshot").values({
    enterprise_id: enterpriseId, provider_resource_id: planResourceId, version: 1,
    source: "ADMIN", collected_at: new Date("2026-08-01T00:00:00Z"), package_cost: "300",
    total_quota: "500", used_quota: "500", remaining_quota: "0", quota_unit: "TOKEN",
    effective_from: new Date("2026-08-01T00:00:00+08:00"),
    effective_until: new Date("2026-09-01T00:00:00+08:00"),
  }).execute();
  await db.insertInto("provider_resource_operating_snapshot").values({
    enterprise_id: enterpriseId, provider_resource_id: incompletePlanResourceId, version: 1,
    source: "ADMIN", collected_at: new Date("2026-09-01T00:00:00Z"), package_cost: "90",
    total_quota: "200", used_quota: "100", remaining_quota: "100", quota_unit: "TOKEN",
    effective_from: new Date("2026-09-01T00:00:00+08:00"),
    effective_until: new Date("2026-10-01T00:00:00+08:00"),
  }).execute();
  assignedRequestId = await addUsage({ principal: employeeId, key: keyId, modelId: flashId,
    alias: "qianliu-deepseek-deepseek-v4-flash", resource: apiResourceId, mode: "API",
    input: 100n, output: 20n, cache: 30n, deducted: null, cost: "2.5",
    quality: "PROVIDER_REPORTED", at: new Date("2026-08-02T04:00:00Z") });
  unassignedRequestId = await addUsage({ principal: employeeId, key: keyId, modelId: flashId,
    alias: "ql-deepseek-v4-flash", resource: planResourceId, mode: "CODING_PLAN",
    input: 200n, output: 50n, cache: 100n, deducted: 200n, cost: "999",
    quality: "ESTIMATED", at: new Date("2026-08-03T04:00:00Z") });
  await addUsage({ principal: employeeId, key: keyId, modelId: proId,
    alias: "ql-deepseek-v4-pro", resource: planResourceId, mode: "CODING_PLAN",
    input: 9007199254740993n, output: 70n, cache: 150n, deducted: 300n, cost: "999",
    quality: "PROVIDER_REPORTED", at: new Date("2026-08-04T04:00:00Z") });
  await addUsage({ principal: employeeId, key: keyId, modelId: proId,
    alias: "ql-deepseek-v4-pro", resource: apiResourceId, mode: "API",
    input: 0n, output: 0n, cache: 0n, deducted: null, cost: null,
    quality: "UNKNOWN", at: new Date("2026-08-05T04:00:00Z") });
  await addUsage({ principal: unknownEmployeeId, key: unknownKeyId, modelId: unknownModelId,
    alias: "ql-unknown", resource: apiResourceId, mode: "API", input: 0n, output: 0n,
    cache: 0n, deducted: null, cost: null, quality: "UNKNOWN", at: new Date("2026-08-06T04:00:00Z") });
  directProjectRequestId = await addUsage({ principal: directProjectId, key: projectKeyId, modelId: flashId,
    alias: "ql-deepseek-v4-flash", resource: apiResourceId, mode: "API", input: 10n,
    output: 1n, cache: 0n, deducted: null, cost: "1", quality: "PROVIDER_REPORTED",
    at: new Date("2026-08-07T04:00:00Z") });
  await addUsage({ enterprise: otherEnterpriseId, principal: otherEmployeeId, key: otherKeyId,
    modelId: otherModelId, alias: "ql-other", resource: otherResource.id, mode: "API",
    input: 999n, output: 1n, cache: 0n, deducted: null, cost: "999",
    quality: "PROVIDER_REPORTED", at: new Date("2026-08-02T04:00:00Z") });
  await addUsage({ principal: employeeId, key: keyId, modelId: flashId,
    alias: "ql-deepseek-v4-flash", resource: incompletePlanResourceId, mode: "CODING_PLAN",
    input: 80n, output: 20n, cache: 10n, deducted: 100n, cost: null,
    quality: "PROVIDER_REPORTED", at: new Date("2026-09-02T04:00:00Z") });
  await addUsage({ principal: unknownEmployeeId, key: unknownKeyId, modelId: unknownModelId,
    alias: "ql-unknown", resource: incompletePlanResourceId, mode: "CODING_PLAN",
    input: 10n, output: 5n, cache: 0n, deducted: null, cost: null,
    quality: "PROVIDER_REPORTED", at: new Date("2026-09-03T04:00:00Z") });
  await db.insertInto("operating_bill_request_project_assignment").values({
    enterprise_id: enterpriseId, ai_request_id: assignedRequestId,
    project_principal_id: projectId, assigned_by: adminId, reason: "客户交付",
  }).execute();
  await db.insertInto("request_attribution_snapshot").values([
    { enterprise_id: enterpriseId, ai_request_id: assignedRequestId,
      source_principal_id: employeeId, employee_person_id: null,
      project_principal_id: projectId, organization_unit_id: projectDepartmentId,
      cost_category: "PROJECT", attribution_source: "EMPLOYEE_PROJECT",
      request_occurred_at: new Date("2026-08-02T04:00:00Z"), version: 1,
      supersedes_id: null, snapshot_origin: "RUNTIME" },
    { enterprise_id: enterpriseId, ai_request_id: directProjectRequestId,
      source_principal_id: directProjectId, employee_person_id: null,
      project_principal_id: directProjectId, organization_unit_id: directProjectDepartmentId,
      cost_category: "PROJECT", attribution_source: "PROJECT_DIRECT",
      request_occurred_at: new Date("2026-08-07T04:00:00Z"), version: 1,
      supersedes_id: null, snapshot_origin: "RUNTIME" },
    { enterprise_id: enterpriseId, ai_request_id: unassignedRequestId,
      source_principal_id: employeeId, employee_person_id: null,
      project_principal_id: null, organization_unit_id: projectDepartmentId,
      cost_category: "EMPLOYEE_DIRECT", attribution_source: "EMPLOYEE_MEMBERSHIP",
      request_occurred_at: new Date("2026-08-03T04:00:00Z"), version: 1,
      supersedes_id: null, snapshot_origin: "RUNTIME" },
  ]).execute();
  accountRepo = new OperatingBillAccountRepository(db);
}, 120_000);

afterAll(async () => {
  await db?.destroy();
  await pg?.stop();
}, 60_000);

describe("POOL-043 经营员工账与项目账 PostgreSQL 聚合", () => {
  it("返回员工月度字段、provider/model 稳定分组、历史 alias 与未知口径", async () => {
    const list = await accountRepo.listAccounts(enterpriseId, "2026-08", "EMPLOYEE");
    expect(list.rows.map((row) => row.subjectName)).toEqual(["于滔", "未知员工"]);
    const yutao = list.rows.find((row) => row.subjectId === employeeId)!;
    expect(yutao.providers).toEqual([{ providerCode: "deepseek", providerName: "DeepSeek" }]);
    expect(yutao.totals).toMatchObject({
      inputTokens: "9007199254741293", outputTokens: "140", cacheTokens: "280",
      totalTokens: "9007199254741433", deductedQuota: "500",
      apiCost: null, packageAllocatedCost: "300.00000000",
      activeDays: 4, requestCount: 4, usageQuality: "MIXED",
    });
    expect(yutao.totals.lastUsedAt).toBe("2026-08-05T04:00:00.000Z");
    expect(list.rows.find((row) => row.subjectId === unknownEmployeeId)!.totals)
      .toMatchObject({ totalTokens: null, apiCost: null, usageQuality: "UNKNOWN" });

    const detail = await accountRepo.getEmployeeDetail(enterpriseId, "2026-08", employeeId);
    const models = detail.providers[0]!.models;
    expect(models.map((model) => model.currentAlias)).toEqual([
      "ql-deepseek-v4-flash", "ql-deepseek-v4-pro",
    ]);
    expect(models[0]).toMatchObject({
      unifiedModelId: flashId, identityStatus: "RESOLVED",
      historicalAliases: ["qianliu-deepseek-deepseek-v4-flash", "ql-deepseek-v4-flash"].sort(),
      totals: { inputTokens: "300", outputTokens: "70", cacheTokens: "130",
        requestCount: 2, apiCost: "2.50000000", packageAllocatedCost: "120.00000000" },
    });
    expect(detail.gaps).toEqual([]);
  });

  it("请求明细按 stable ID 下钻，保留发生时 alias、状态、时间和独立费用字段", async () => {
    const requests = await accountRepo.listEmployeeModelRequests(
      enterpriseId, "2026-08", employeeId, flashId, { limit: 20, offset: 0 },
    );
    expect(requests.total).toBe(2);
    expect(requests.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        requestId: assignedRequestId,
        modelAliasAtRequest: "qianliu-deepseek-deepseek-v4-flash",
        currentAlias: "ql-deepseek-v4-flash", status: "SUCCEEDED",
        tokens: expect.objectContaining({ totalTokens: "120" }),
        costs: expect.objectContaining({ apiCost: "2.50000000", packageAllocatedCost: "0.00000000" }),
      }),
      expect.objectContaining({
        requestId: unassignedRequestId, usageQuality: "ESTIMATED",
        costs: expect.objectContaining({ deductedQuota: "200", apiCost: "0.00000000",
          packageAllocatedCost: "120.00000000" }),
      }),
    ]));
    const unknown = await accountRepo.listEmployeeModelRequests(
      enterpriseId, "2026-08", unknownEmployeeId, unknownModelId, { limit: 20, offset: 0 },
    );
    expect(unknown.items[0]).toMatchObject({
      usageQuality: "UNKNOWN", tokens: { inputTokens: null, outputTokens: null,
        cacheTokens: null, reasoningTokens: null, totalTokens: null },
      costs: expect.objectContaining({ apiCost: null }),
    });
  });

  it("项目账只投影一次请求，明确未归属，归属变更沿用 ledger 月份与结账门禁", async () => {
    const before = await accountRepo.listAccounts(enterpriseId, "2026-08", "PROJECT");
    expect(before.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        subjectId: projectId, subjectName: "星河项目", isUnassigned: false,
        projectOwner: { personId: projectOwnerPersonId, personName: "项目负责人" },
        projectDepartments: [{ departmentId: projectDepartmentId, departmentName: "研发中心" }],
      }),
      expect.objectContaining({
        subjectId: null, subjectName: "未归属项目", isUnassigned: true,
        projectOwner: null, projectDepartments: [],
      }),
      expect.objectContaining({
        subjectId: directProjectId, subjectName: "直接项目", isUnassigned: false,
        projectOwner: { personId: projectOwnerPersonId, personName: "项目负责人" },
        projectDepartments: [{
          departmentId: directProjectDepartmentId, departmentName: "产品中心",
        }],
      }),
    ]));
    expect(before.totals.totalTokens).toBe("9007199254741444");
    expect(before.totals.requestCount).toBe(6);
    await new OperatingBillRepository(db).assignRequestToProject({
      enterpriseId, adminId, month: "2026-08", requestId: unassignedRequestId,
      projectPrincipalId: projectId, reason: "补充归属",
    });
    const after = await accountRepo.listAccounts(enterpriseId, "2026-08", "PROJECT");
    expect(after.rows.find((row) => row.subjectId === projectId)!.totals.requestCount).toBe(2);
    expect(after.totals.totalTokens).toBe(before.totals.totalTokens);
    const usageRepo = new UsageRepository(db);
    expect((await usageRepo.list({ enterpriseId, projectId })).records.map((row) => row.requestId))
      .toEqual(expect.arrayContaining([assignedRequestId, unassignedRequestId]));
    await expect(new OperatingBillRepository(db).assignRequestToProject({
      enterpriseId, adminId, month: "2026-08", requestId: randomUUID(),
      projectPrincipalId: projectId,
    })).rejects.toBeInstanceOf(Error);
  });

  it("结账冻结账户事实，底层账本变化不改写历史，但展示最新正式 alias", async () => {
    const billRepo = new OperatingBillRepository(db);
    const before = await accountRepo.getEmployeeDetail(enterpriseId, "2026-08", employeeId);
    const beforeProjects = await accountRepo.listAccounts(enterpriseId, "2026-08", "PROJECT");
    await billRepo.closeMonth({
      enterpriseId, adminId, month: "2026-08", allowIncomplete: true,
      note: "POOL-043 冻结证据测试允许既有快照缺口",
    });
    await db.updateTable("ledger_line").set({
      raw_input_tokens: 999999n, api_cost: "999.99",
    }).where("enterprise_id", "=", enterpriseId)
      .where("ai_request_id", "=", assignedRequestId).execute();
    await db.updateTable("unified_model").set({ alias: "ql-deepseek-v4-flash-current" })
      .where("enterprise_id", "=", enterpriseId).where("id", "=", flashId).execute();
    await db.updateTable("principal").set({ name: "于滔-当前名称" })
      .where("enterprise_id", "=", enterpriseId).where("id", "=", employeeId).execute();
    await db.updateTable("principal").set({ owner_person_id: nextProjectOwnerPersonId })
      .where("enterprise_id", "=", enterpriseId).where("id", "=", projectId).execute();
    await db.updateTable("person").set({ name: "当前负责人改名" })
      .where("enterprise_id", "=", enterpriseId).where("id", "=", projectOwnerPersonId).execute();
    await db.updateTable("organization_unit").set({ name: "当前部门改名" })
      .where("enterprise_id", "=", enterpriseId).where("id", "=", projectDepartmentId).execute();

    const frozen = await accountRepo.getEmployeeDetail(enterpriseId, "2026-08", employeeId);
    expect(frozen.status).toBe("CLOSED");
    expect(frozen.employee.principalName).toBe("于滔");
    expect(frozen.totals).toEqual(before.totals);
    expect((await accountRepo.listAccounts(enterpriseId, "2026-08", "PROJECT")).rows)
      .toEqual(beforeProjects.rows);
    expect(frozen.providers[0]!.models.find((model) => model.unifiedModelId === flashId))
      .toMatchObject({
        currentAlias: "ql-deepseek-v4-flash-current",
        historicalAliases: expect.arrayContaining([
          "qianliu-deepseek-deepseek-v4-flash", "ql-deepseek-v4-flash",
        ]),
      });
    expect((await accountRepo.getEmployeeDetail(
      enterpriseId, "2026-08", employeeId, "deepseek",
    )).providers).toHaveLength(1);
    expect((await accountRepo.listEmployeeModelRequests(
      enterpriseId, "2026-08", employeeId, flashId,
      { providerCode: "deepseek", limit: 1, offset: 0 },
    )).employee.principalName).toBe("于滔");
    expect((await accountRepo.listAccounts(
      enterpriseId, "2026-08", "PROJECT", { providerCode: "deepseek", search: "星河" },
    )).rows.map((row) => row.subjectName)).toEqual(["星河项目"]);
    await expect(billRepo.assignRequestToProject({
      enterpriseId, adminId, month: "2026-08", requestId: assignedRequestId,
      projectPrincipalId: projectId,
    })).rejects.toThrow();
  });

  it("支持筛选、空数据并严格隔离企业与主体类型", async () => {
    const filtered = await accountRepo.listAccounts(
      enterpriseId, "2026-08", "EMPLOYEE", { providerCode: "deepseek", search: "于滔" },
    );
    expect(filtered.rows).toHaveLength(1);
    const empty = await accountRepo.listAccounts(enterpriseId, "2026-07", "EMPLOYEE");
    expect(empty.rows).toEqual([]);
    expect(empty.totals).toMatchObject({
      totalTokens: "0", deductedQuota: "0", apiCost: "0.00000000",
      packageAllocatedCost: "0.00000000", requestCount: 0, usageQuality: "EXACT",
    });
    expect(await accountRepo.getEmployeeDetail(enterpriseId, "2026-07", employeeId))
      .toMatchObject({ totals: { totalTokens: "0", requestCount: 0 }, providers: [], gaps: [] });
    expect(await accountRepo.listEmployeeModelRequests(
      enterpriseId, "2026-07", employeeId, flashId, { limit: 1, offset: 0 },
    )).toMatchObject({ total: 0, items: [] });
    expect((await accountRepo.listAccounts(enterpriseId, "2026-08", "EMPLOYEE")).rows)
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ subjectName: "隔离员工" })]));
    await expect(accountRepo.getEmployeeDetail(otherEnterpriseId, "2026-08", employeeId))
      .rejects.toBeInstanceOf(OperatingBillAccountReferenceError);
    await expect(accountRepo.getEmployeeDetail(enterpriseId, "2026-08", projectId))
      .rejects.toBeInstanceOf(OperatingBillAccountReferenceError);
  });

  it("同一套餐资源任一扣减事实缺失时，不把其余请求分摊伪装为精确值", async () => {
    const september = await accountRepo.listAccounts(enterpriseId, "2026-09", "EMPLOYEE");
    expect(september.totals.packageAllocatedCost).toBeNull();
    expect(september.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ subjectId: employeeId,
        totals: expect.objectContaining({ deductedQuota: "100", packageAllocatedCost: null }) }),
      expect.objectContaining({ subjectId: unknownEmployeeId,
        totals: expect.objectContaining({ deductedQuota: null, packageAllocatedCost: null }) }),
    ]));
    expect((await accountRepo.getEmployeeDetail(
      enterpriseId, "2026-09", employeeId, "deepseek",
    )).totals.packageAllocatedCost).toBeNull();
    expect((await accountRepo.listEmployeeModelRequests(
      enterpriseId, "2026-09", employeeId, flashId, { providerCode: "deepseek", limit: 1, offset: 0 },
    )).items[0]!.costs.packageAllocatedCost).toBeNull();
  });

  it("SQL 下推请求分页保留全量 total，并用 request ID 稳定解决同时间次序", async () => {
    const sameTime = new Date("2026-10-10T04:00:00Z");
    const requestIds = await Promise.all([1n, 2n, 3n].map((input) => addUsage({
      principal: employeeId, key: keyId, modelId: flashId,
      alias: "ql-deepseek-v4-flash", resource: apiResourceId, mode: "API",
      input, output: 1n, cache: 0n, deducted: null, cost: "0",
      quality: "PROVIDER_REPORTED", at: sameTime,
    })));
    const expected = [...requestIds].sort((left, right) => right.localeCompare(left));
    for (const [offset, requestId] of expected.entries()) {
      const page = await accountRepo.listEmployeeModelRequests(
        enterpriseId, "2026-10", employeeId, flashId, { limit: 1, offset },
      );
      expect(page.total).toBe(3);
      expect(page.items.map((item) => item.requestId)).toEqual([requestId]);
    }
    const pastEnd = await accountRepo.listEmployeeModelRequests(
      enterpriseId, "2026-10", employeeId, flashId, { limit: 1, offset: 99 },
    );
    expect(pastEnd).toMatchObject({ total: 3, items: [] });

    await new OperatingBillRepository(db).closeMonth({
      enterpriseId, adminId, month: "2026-10", allowIncomplete: true,
      note: "POOL-043 分页冻结证据测试",
    });
    const frozen = await accountRepo.listEmployeeModelRequests(
      enterpriseId, "2026-10", employeeId, flashId, { limit: 1, offset: 1 },
    );
    expect(frozen).toMatchObject({ status: "CLOSED", total: 3 });
    expect(frozen.items.map((item) => item.requestId)).toEqual([expected[1]]);
  });

  it("未指定 provider 时先合并同一 request 的跨厂商账本行，再计数和分页", async () => {
    const kimi = await db.insertInto("provider").values({
      enterprise_id: enterpriseId, code: "kimi-pool043", name: "Kimi", adapter_type: "openai",
    }).returning("id").executeTakeFirstOrThrow();
    const kimiResource = await db.insertInto("provider_resource").values({
      enterprise_id: enterpriseId, provider_id: kimi.id, name: "Kimi API",
      mode: "API", credential_type: "API_KEY",
    }).returning("id").executeTakeFirstOrThrow();
    const at = new Date("2026-12-12T04:00:00Z");
    const requestId = await addUsage({
      principal: employeeId, key: keyId, modelId: flashId, alias: "ql-deepseek-v4-flash",
      resource: apiResourceId, mode: "API", input: 10n, output: 1n, cache: 0n,
      deducted: null, cost: "0.1", quality: "PROVIDER_REPORTED", at,
    });
    const attempt = await db.insertInto("upstream_attempt").values({
      ai_request_id: requestId, enterprise_id: enterpriseId, attempt_no: 2,
      provider_resource_id: kimiResource.id, upstream_model: "shared-upstream",
      finished_at: at, http_status: 200, response_committed: true,
    }).returning("id").executeTakeFirstOrThrow();
    const usage = await db.insertInto("usage_event").values({
      ai_request_id: requestId, enterprise_id: enterpriseId, upstream_attempt_id: attempt.id,
      provider_resource_id: kimiResource.id, input_tokens: 20n, output_tokens: 2n,
      cache_tokens: 0n, reasoning_tokens: 0n, usage_quality: "PROVIDER_REPORTED",
      dedup_key: `pool043-provider-${requestId}`, created_at: at,
    }).returning("id").executeTakeFirstOrThrow();
    await db.insertInto("ledger_line").values({
      ai_request_id: requestId, enterprise_id: enterpriseId, usage_event_id: usage.id,
      upstream_attempt_id: attempt.id, provider_resource_id: kimiResource.id,
      principal_id: employeeId, resource_mode: "API", raw_input_tokens: 20n,
      raw_output_tokens: 2n, raw_cache_tokens: 0n, raw_reasoning_tokens: 0n,
      deducted_quota: null, api_cost: "0.2", usage_quality: "PROVIDER_REPORTED", created_at: at,
    }).execute();
    await db.updateTable("ledger_transaction").set({
      total_input_tokens: 30n,
      total_output_tokens: 3n,
      total_api_cost: "0.3",
      attempt_count: 2,
    }).where("ai_request_id", "=", requestId).execute();

    const all = await accountRepo.listEmployeeModelRequests(
      enterpriseId, "2026-12", employeeId, flashId, { limit: 1, offset: 0 },
    );
    expect(all).toMatchObject({ total: 1, items: [expect.objectContaining({
      requestId, tokens: expect.objectContaining({ totalTokens: "33" }),
      costs: expect.objectContaining({ apiCost: "0.30000000" }),
    })] });
    expect((await accountRepo.listEmployeeModelRequests(
      enterpriseId, "2026-12", employeeId, flashId,
      { providerCode: "deepseek", limit: 1, offset: 0 },
    )).items[0]!.tokens.totalTokens).toBe("11");
    expect((await accountRepo.listEmployeeModelRequests(
      enterpriseId, "2026-12", employeeId, flashId,
      { providerCode: "kimi-pool043", limit: 1, offset: 0 },
    )).items[0]!.tokens.totalTokens).toBe("22");
    const detail = await accountRepo.getEmployeeDetail(enterpriseId, "2026-12", employeeId);
    expect(detail.totals).toMatchObject({ totalTokens: "33", requestCount: 1 });
    expect(detail.providers.map((provider) => provider.providerCode).sort())
      .toEqual(["deepseek", "kimi-pool043"]);
    expect((await accountRepo.getEmployeeDetail(
      enterpriseId, "2026-12", employeeId, "kimi-pool043",
    )).totals.totalTokens).toBe("22");
    await new OperatingBillRepository(db).closeMonth({
      enterpriseId, adminId, month: "2026-12", allowIncomplete: true,
      note: "POOL-043 跨厂商冻结聚合测试",
    });
    const frozen = await accountRepo.listEmployeeModelRequests(
      enterpriseId, "2026-12", employeeId, flashId, { limit: 1, offset: 0 },
    );
    expect(frozen).toMatchObject({ status: "CLOSED", total: 1,
      items: [expect.objectContaining({ tokens: expect.objectContaining({ totalTokens: "33" }) })] });
    expect((await accountRepo.getEmployeeDetail(
      enterpriseId, "2026-12", employeeId,
    )).providers.map((provider) => provider.providerCode).sort())
      .toEqual(["deepseek", "kimi-pool043"]);
  });

  it("同一请求的多条 ledger line 跨北京日界时，活跃天数为 2 且请求数仍为 1", async () => {
    const firstAt = new Date("2026-11-20T15:59:00Z");
    const requestId = await addUsage({
      principal: employeeId, key: keyId, modelId: proId, alias: "ql-deepseek-v4-pro",
      resource: apiResourceId, mode: "API", input: 10n, output: 1n, cache: 0n,
      deducted: null, cost: "0.1", quality: "PROVIDER_REPORTED", at: firstAt,
    });
    const attempt = await db.insertInto("upstream_attempt").values({
      ai_request_id: requestId, enterprise_id: enterpriseId, attempt_no: 2,
      provider_resource_id: apiResourceId, upstream_model: "shared-upstream",
      finished_at: new Date("2026-11-20T16:01:00Z"), http_status: 200, response_committed: true,
    }).returning("id").executeTakeFirstOrThrow();
    const usage = await db.insertInto("usage_event").values({
      ai_request_id: requestId, enterprise_id: enterpriseId, upstream_attempt_id: attempt.id,
      provider_resource_id: apiResourceId, input_tokens: 20n, output_tokens: 2n,
      cache_tokens: 0n, reasoning_tokens: 0n, usage_quality: "PROVIDER_REPORTED",
      dedup_key: `pool043-second-${requestId}`, created_at: new Date("2026-11-20T16:01:00Z"),
    }).returning("id").executeTakeFirstOrThrow();
    await db.insertInto("ledger_line").values({
      ai_request_id: requestId, enterprise_id: enterpriseId, usage_event_id: usage.id,
      upstream_attempt_id: attempt.id, provider_resource_id: apiResourceId,
      principal_id: employeeId, resource_mode: "API", raw_input_tokens: 20n,
      raw_output_tokens: 2n, raw_cache_tokens: 0n, raw_reasoning_tokens: 0n,
      deducted_quota: null, api_cost: "0.2", usage_quality: "PROVIDER_REPORTED",
      created_at: new Date("2026-11-20T16:01:00Z"),
    }).execute();
    const november = await accountRepo.listAccounts(enterpriseId, "2026-11", "EMPLOYEE");
    expect(november.rows.find((row) => row.subjectId === employeeId)!.totals)
      .toMatchObject({ activeDays: 2, requestCount: 1, totalTokens: "33" });
    expect((await accountRepo.getEmployeeDetail(enterpriseId, "2026-11", employeeId)).totals)
      .toMatchObject({ activeDays: 2, requestCount: 1, totalTokens: "33" });
  });

  it("CLOSED 空月的员工、项目、详情和请求下钻都返回精确空态", async () => {
    await new OperatingBillRepository(db).closeMonth({
      enterpriseId, adminId, month: "2027-01", allowIncomplete: true,
      note: "POOL-043 CLOSED 空月分支证据",
    });
    const employees = await accountRepo.listAccounts(
      enterpriseId, "2027-01", "EMPLOYEE", { providerCode: "deepseek", search: "于滔" },
    );
    expect(employees).toMatchObject({ status: "CLOSED", rows: [],
      totals: { totalTokens: "0", requestCount: 0, usageQuality: "EXACT" } });
    expect(await accountRepo.listAccounts(
      enterpriseId, "2027-01", "PROJECT", { providerCode: "deepseek", search: "未归属" },
    )).toMatchObject({ status: "CLOSED", rows: [], totals: { requestCount: 0 } });
    expect(await accountRepo.getEmployeeDetail(
      enterpriseId, "2027-01", employeeId, "deepseek",
    )).toMatchObject({ status: "CLOSED", employee: { principalName: "于滔-当前名称" },
      totals: { totalTokens: "0", requestCount: 0 }, providers: [], gaps: [] });
    expect(await accountRepo.listEmployeeModelRequests(
      enterpriseId, "2027-01", employeeId, flashId,
      { providerCode: "deepseek", limit: 1, offset: 0 },
    )).toMatchObject({ status: "CLOSED", total: 0, items: [],
      employee: { principalName: "于滔-当前名称" } });
  });

  it("真实 PostgreSQL 对无法证明稳定 ID 的历史 alias 保持未解析并可冻结追溯", async () => {
    await addUsage({
      principal: employeeId, key: keyId, modelId: null, alias: "legacy-unmapped-model",
      resource: apiResourceId, mode: "API", input: 5n, output: 1n, cache: 0n,
      deducted: null, cost: "0.1", quality: "PROVIDER_REPORTED",
      at: new Date("2027-03-08T04:00:00Z"),
    });
    const draft = await accountRepo.getEmployeeDetail(enterpriseId, "2027-03", employeeId);
    expect(draft.gaps).toEqual([{
      code: "MODEL_ID_UNRESOLVED", historicalAlias: "legacy-unmapped-model",
    }]);
    expect(draft.providers[0]!.models[0]).toMatchObject({
      unifiedModelId: null, identityStatus: "UNRESOLVED", currentAlias: null,
      historicalAliases: ["legacy-unmapped-model"], totals: { totalTokens: "6" },
    });
    await new OperatingBillRepository(db).closeMonth({
      enterpriseId, adminId, month: "2027-03", allowIncomplete: true,
      note: "POOL-043 未解析模型冻结证据",
    });
    expect(await accountRepo.getEmployeeDetail(enterpriseId, "2027-03", employeeId)).toMatchObject({
      status: "CLOSED",
      gaps: [{ code: "MODEL_ID_UNRESOLVED", historicalAlias: "legacy-unmapped-model" }],
      providers: [{
        models: [{
          unifiedModelId: null, identityStatus: "UNRESOLVED", currentAlias: null,
          historicalAliases: ["legacy-unmapped-model"], totals: { totalTokens: "6" },
        }],
      }],
    });
  });
});
