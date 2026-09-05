import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPostgresContainer, type PostgresTestInstance } from "@qianliu/testing";
import { createKysely, DashboardRepository, migrateToLatest, type Database } from "../index.js";

describe.sequential("POOL-042 首页 API 资源 Token 摘要", () => {
  let pg: PostgresTestInstance;
  let db: Database;
  const enterpriseId = randomUUID();
  const principalId = randomUUID();
  const keyId = randomUUID();
  const now = new Date("2026-08-10T08:00:00.000Z");

  beforeAll(async () => {
    pg = await startPostgresContainer();
    db = createKysely(pg.connectionString);
    await migrateToLatest(db);
    await db.insertInto("enterprise").values({ id: enterpriseId, name: "POOL-042" }).execute();
    await db.insertInto("principal").values({
      id: principalId, enterprise_id: enterpriseId, type: "EMPLOYEE", name: "Token 用户",
    }).execute();
    await db.insertInto("principal_key").values({
      id: keyId, enterprise_id: enterpriseId, principal_id: principalId,
      key_prefix: "ql_pool042", key_digest: randomUUID(), status: "ACTIVE",
    }).execute();
  }, 120_000);

  afterAll(async () => {
    if (db) await db.destroy();
    if (pg) await pg.stop();
  }, 60_000);

  async function createApiResource(providerCode: string, balance: string) {
    const provider = await db.insertInto("provider").values({
      enterprise_id: enterpriseId, code: providerCode, name: providerCode,
      adapter_type: "openai",
    }).returning("id").executeTakeFirstOrThrow();
    const resource = await db.insertInto("provider_resource").values({
      enterprise_id: enterpriseId, provider_id: provider.id, name: `${providerCode} API`,
      mode: "API", credential_type: "API_KEY", status: "ACTIVE",
    }).returning("id").executeTakeFirstOrThrow();
    await db.insertInto("provider_resource_operating_snapshot").values({
      enterprise_id: enterpriseId, provider_resource_id: resource.id, version: 1,
      source: "PROVIDER_SYNC", collected_at: new Date(now.getTime() - 60_000),
      currency: "CNY", current_balance: balance, current_period_cost: "6.32",
      balance_updated_at: new Date(now.getTime() - 60_000),
    }).execute();
    return resource.id;
  }

  async function addLine(input: {
    resourceId: string; modelId: string | null; historicalAlias: string; upstreamModel: string;
    input: bigint; output: bigint; cache: bigint; reasoning: bigint;
    cost: string | null; quality: string; at: Date;
    deductedQuota?: bigint | null;
    mode?: "API" | "CODING_PLAN";
    requestStatus?: "SUCCEEDED" | "FAILED";
    responseCommitted?: boolean;
    httpStatus?: number;
    errorCode?: string | null;
  }) {
    const requestId = randomUUID();
    await db.insertInto("ai_request").values({
      id: requestId, enterprise_id: enterpriseId, principal_id: principalId,
      principal_key_id: keyId, protocol: "chat", unified_model: input.historicalAlias,
      unified_model_id: input.modelId, status: input.requestStatus ?? "SUCCEEDED", started_at: input.at,
      finished_at: input.at,
    }).execute();
    const attempt = await db.insertInto("upstream_attempt").values({
      ai_request_id: requestId, enterprise_id: enterpriseId, attempt_no: 1,
      provider_resource_id: input.resourceId, upstream_model: input.upstreamModel,
      finished_at: input.at, http_status: input.httpStatus ?? 200,
      response_committed: input.responseCommitted ?? true,
      error_code: input.errorCode ?? null,
    }).returning("id").executeTakeFirstOrThrow();
    const usage = await db.insertInto("usage_event").values({
      ai_request_id: requestId, enterprise_id: enterpriseId, upstream_attempt_id: attempt.id,
      provider_resource_id: input.resourceId, input_tokens: input.input,
      output_tokens: input.output, cache_tokens: input.cache,
      reasoning_tokens: input.reasoning, usage_quality: input.quality,
      dedup_key: `pool042-${requestId}`, created_at: input.at,
    }).returning("id").executeTakeFirstOrThrow();
    await db.insertInto("ledger_line").values({
      ai_request_id: requestId, enterprise_id: enterpriseId, usage_event_id: usage.id,
      upstream_attempt_id: attempt.id, provider_resource_id: input.resourceId,
      principal_id: principalId, resource_mode: input.mode ?? "API", raw_input_tokens: input.input,
      raw_output_tokens: input.output, raw_cache_tokens: input.cache,
      raw_reasoning_tokens: input.reasoning, deducted_quota: input.deductedQuota ?? null,
      api_cost: input.cost,
      usage_quality: input.quality, created_at: input.at,
    }).execute();
  }

  it("聚合真实账本、多模型当前 alias，并按当前价格版本估算余额 Token", async () => {
    const resourceId = await createApiResource("deepseek", "68");
    const flashId = randomUUID();
    const proId = randomUUID();
    await db.insertInto("unified_model").values([
      { id: flashId, enterprise_id: enterpriseId, alias: "ql-deepseek-v4-flash", display_name: "Flash" },
      { id: proId, enterprise_id: enterpriseId, alias: "ql-deepseek-v4-pro", display_name: "Pro" },
    ]).execute();
    await db.insertInto("model_route").values([
      {
        enterprise_id: enterpriseId, unified_model_id: flashId,
        provider_resource_id: resourceId, upstream_model: "flash-upstream", enabled: true,
      },
      {
        enterprise_id: enterpriseId, unified_model_id: proId,
        provider_resource_id: resourceId, upstream_model: "pro-upstream", enabled: true,
      },
    ]).execute();
    await db.insertInto("billing_rule").values([
      {
        enterprise_id: enterpriseId, provider_resource_id: resourceId,
        upstream_model: "flash-upstream", rule_type: "API_PRICE", rule_version: "old",
        effective_from: new Date("2026-07-01T00:00:00Z"),
        effective_to: new Date("2026-08-01T00:00:00Z"),
        cache_hit_price: "9", cache_miss_price: "9", output_price: "9", enabled: true,
      },
      {
        enterprise_id: enterpriseId, provider_resource_id: resourceId,
        upstream_model: "flash-upstream", rule_type: "API_PRICE", rule_version: "current-flash",
        effective_from: new Date("2026-08-01T00:00:00Z"),
        cache_hit_price: "0.001", cache_miss_price: "0.002", output_price: "0.004", enabled: true,
      },
      {
        enterprise_id: enterpriseId, provider_resource_id: resourceId,
        upstream_model: "pro-upstream", rule_type: "API_PRICE", rule_version: "current-pro",
        effective_from: new Date("2026-08-01T00:00:00Z"),
        cache_hit_price: "0.001", cache_miss_price: "0.003", output_price: "0.006", enabled: true,
      },
    ]).execute();
    const usedAt = new Date(now.getTime() - 60 * 60 * 1000);
    await addLine({
      resourceId, modelId: flashId, historicalAlias: "legacy-flash",
      upstreamModel: "flash-upstream", input: 100n, output: 20n, cache: 40n,
      reasoning: 10n, cost: "0.5", quality: "PROVIDER_REPORTED", at: usedAt,
    });
    await addLine({
      resourceId, modelId: proId, historicalAlias: "legacy-pro",
      upstreamModel: "pro-upstream", input: 200n, output: 100n, cache: 0n,
      reasoning: 20n, cost: "2", quality: "PROVIDER_REPORTED", at: usedAt,
    });

    const overview = await new DashboardRepository(db).getResourceUsageOverview(enterpriseId, now.getTime());
    const item = overview.providerSummaries.find((row) => row.providerCode === "deepseek");
    expect(item).toMatchObject({
      monthlyInputTokens: "300", monthlyOutputTokens: "120", monthlyCacheTokens: "40",
      monthlyReasoningTokens: "30", monthlyTotalTokens: "420", monthlyUsageQuality: "EXACT",
      tokenRate24h: "17.50", costRate24h: "0.10416667",
      estimatedBalanceTokens: "19833", balanceTokenEstimateConfidence: "LOW",
      balanceTokenEstimateReason: null,
    });
    expect(item?.modelTokenBreakdown).toEqual(expect.arrayContaining([
      expect.objectContaining({ modelAlias: "ql-deepseek-v4-flash", totalTokens: "120" }),
      expect.objectContaining({ modelAlias: "ql-deepseek-v4-pro", totalTokens: "300" }),
    ]));
    expect(item?.balanceTokenEstimateBasis).toContain("最近24小时 2 条账本");
    expect(overview.modelDetails).toEqual(expect.arrayContaining([
      expect.objectContaining({
        resourceId, modelAlias: "ql-deepseek-v4-flash", monthlyCost: "0.50000000",
        monthlyTotalTokens: "120", consumptionRate24h: "5.00",
        consumptionRateUnit: "TOKEN_PER_HOUR",
      }),
      expect.objectContaining({
        resourceId, modelAlias: "ql-deepseek-v4-pro", monthlyCost: "2.00000000",
        monthlyTotalTokens: "300", consumptionRate24h: "12.50",
      }),
    ]));
  });

  it("同厂商多账号按各账号余额与价格分别估算，缺价或混合币种明确拒绝", async () => {
    async function createMultiAccountProvider(input: {
      code: string; currencies: [string, string]; omitSecondRule?: boolean;
      omitSecondUsage?: boolean;
      omitSecondSnapshot?: boolean;
      lineCounts?: [number, number];
    }) {
      const provider = await db.insertInto("provider").values({
        enterprise_id: enterpriseId, code: input.code, name: input.code, adapter_type: "openai",
      }).returning("id").executeTakeFirstOrThrow();
      const resources = await db.insertInto("provider_resource").values([0, 1].map((index) => ({
        enterprise_id: enterpriseId, provider_id: provider.id, name: `${input.code}-${index}`,
        mode: "API" as const, credential_type: "API_KEY", status: "ACTIVE" as const,
      }))).returning("id").execute();
      const snapshotResources = input.omitSecondSnapshot ? resources.slice(0, 1) : resources;
      await db.insertInto("provider_resource_operating_snapshot").values(snapshotResources.flatMap((resource, index) => ([
        {
          enterprise_id: enterpriseId, provider_resource_id: resource.id, version: 1,
          source: "PROVIDER_SYNC" as const, collected_at: new Date("2026-07-31T16:00:00.000Z"),
          currency: input.currencies[index]!, current_balance: index === 0 ? "12" : "24",
          current_period_cost: "0",
        },
        {
          enterprise_id: enterpriseId, provider_resource_id: resource.id, version: 2,
          source: "PROVIDER_SYNC" as const, collected_at: new Date(now.getTime() - 60_000),
          currency: input.currencies[index]!, current_balance: index === 0 ? "10" : "20",
          current_period_cost: "1",
        },
      ]))).execute();
      const modelId = randomUUID();
      await db.insertInto("unified_model").values({
        id: modelId, enterprise_id: enterpriseId, alias: `ql-${input.code}`,
        display_name: input.code,
      }).execute();
      for (const [index, resource] of resources.entries()) {
        const upstreamModel = `${input.code}-${index}`;
        if (!(input.omitSecondRule && index === 1)) {
          await db.insertInto("billing_rule").values({
            enterprise_id: enterpriseId, provider_resource_id: resource.id,
            upstream_model: upstreamModel, rule_type: "API_PRICE",
            rule_version: `${upstreamModel}-current`, effective_from: new Date("2026-08-01T00:00:00Z"),
            cache_miss_price: index === 0 ? "0.01" : "0.04",
            output_price: "0", currency: input.currencies[index]!, enabled: true,
          }).execute();
        }
        if (input.omitSecondUsage && index === 1) continue;
        for (let lineIndex = 0; lineIndex < (input.lineCounts?.[index] ?? 1); lineIndex += 1) {
          await addLine({
            resourceId: resource.id, modelId, historicalAlias: `old-${input.code}`,
            upstreamModel, input: 10n, output: 0n, cache: 0n, reasoning: 0n,
            cost: index === 0 ? "0.1" : "0.4", quality: "PROVIDER_REPORTED",
            at: new Date(now.getTime() - 30 * 60 * 1000),
          });
        }
      }
    }

    await createMultiAccountProvider({ code: "multi-price", currencies: ["CNY", "CNY"] });
    await createMultiAccountProvider({
      code: "multi-missing-price", currencies: ["CNY", "CNY"], omitSecondRule: true,
    });
    await createMultiAccountProvider({
      code: "multi-no-usage", currencies: ["CNY", "CNY"], omitSecondUsage: true,
    });
    await createMultiAccountProvider({
      code: "multi-missing-balance", currencies: ["CNY", "CNY"], omitSecondSnapshot: true,
    });
    await createMultiAccountProvider({
      code: "multi-confidence", currencies: ["CNY", "CNY"], lineCounts: [20, 1],
    });
    await createMultiAccountProvider({ code: "multi-currency", currencies: ["CNY", "USD"] });

    const items = (await new DashboardRepository(db).getResourceUsageOverview(enterpriseId, now.getTime()))
      .providerSummaries;
    expect(items.find((row) => row.providerCode === "multi-price")).toMatchObject({
      accountCount: 2, currentBalance: "30.00000000", estimatedBalanceTokens: "1500",
      balanceTokenEstimateConfidence: "LOW", balanceTokenEstimateReason: null,
    });
    expect(items.find((row) => row.providerCode === "multi-missing-price")).toMatchObject({
      estimatedBalanceTokens: null, balanceTokenEstimateReason: "CURRENT_PRICE_RULE_MISSING",
    });
    expect(items.find((row) => row.providerCode === "multi-no-usage")).toMatchObject({
      estimatedBalanceTokens: null, balanceTokenEstimateReason: "RECENT_USAGE_MISSING",
    });
    expect(items.find((row) => row.providerCode === "multi-missing-balance")).toMatchObject({
      estimatedBalanceTokens: null, balanceTokenEstimateReason: "BALANCE_MISSING",
    });
    expect(items.find((row) => row.providerCode === "multi-confidence")).toMatchObject({
      estimatedBalanceTokens: "1500", balanceTokenEstimateConfidence: "LOW",
    });
    expect(items.find((row) => row.providerCode === "multi-currency")).toMatchObject({
      currentBalance: null, monthlyCost: null, estimatedBalanceTokens: null,
      monthlyCostReason: expect.stringMatching(/multi-currency-0 CNY.*multi-currency-1 USD/),
      balanceTokenEstimateReason: "PRICE_CURRENCY_MISMATCH",
    });
  });

  it("未知 usage 与零用量不伪造精确 Token 或余额估算", async () => {
    const unknownResource = await createApiResource("unknown-api", "10");
    const unknownModel = randomUUID();
    await db.insertInto("unified_model").values({
      id: unknownModel, enterprise_id: enterpriseId, alias: "ql-unknown", display_name: "Unknown",
    }).execute();
    await addLine({
      resourceId: unknownResource, modelId: unknownModel, historicalAlias: "old-unknown",
      upstreamModel: "unknown", input: 0n, output: 0n, cache: 0n, reasoning: 0n,
      cost: null, quality: "UNKNOWN", at: new Date(now.getTime() - 30 * 60 * 1000),
    });
    await createApiResource("zero-api", "10");
    const estimatedResource = await createApiResource("estimated-api", "10");
    const estimatedModel = randomUUID();
    await db.insertInto("unified_model").values({
      id: estimatedModel, enterprise_id: enterpriseId,
      alias: "ql-estimated", display_name: "Estimated",
    }).execute();
    await addLine({
      resourceId: estimatedResource, modelId: estimatedModel, historicalAlias: "old-estimated",
      upstreamModel: "estimated", input: 10n, output: 2n, cache: 0n, reasoning: 0n,
      cost: "0.1", quality: "ESTIMATED", at: new Date(now.getTime() - 30 * 60 * 1000),
    });
    const currencyResource = await createApiResource("currency-api", "10");
    const currencyModel = randomUUID();
    await db.insertInto("unified_model").values({
      id: currencyModel, enterprise_id: enterpriseId,
      alias: "ql-currency", display_name: "Currency",
    }).execute();
    await db.insertInto("billing_rule").values({
      enterprise_id: enterpriseId, provider_resource_id: currencyResource,
      upstream_model: "currency", rule_type: "API_PRICE", rule_version: "currency-usd",
      effective_from: new Date("2026-08-01T00:00:00Z"), cache_miss_price: "0.01",
      output_price: "0.02", currency: "USD", enabled: true,
    }).execute();
    await addLine({
      resourceId: currencyResource, modelId: currencyModel, historicalAlias: "old-currency",
      upstreamModel: "currency", input: 10n, output: 2n, cache: 0n, reasoning: 0n,
      cost: "0.1", quality: "PROVIDER_REPORTED", at: new Date(now.getTime() - 30 * 60 * 1000),
    });

    const items = (await new DashboardRepository(db).getResourceUsageOverview(enterpriseId, now.getTime()))
      .providerSummaries;
    expect(items.find((row) => row.providerCode === "unknown-api")).toMatchObject({
      monthlyTotalTokens: "0", monthlyUsageQuality: "UNKNOWN", monthlyUnknownCount: 1,
      tokenRate24h: null, costRate24h: null,
      estimatedBalanceTokens: null, balanceTokenEstimateReason: "USAGE_UNKNOWN",
    });
    expect(items.find((row) => row.providerCode === "zero-api")).toMatchObject({
      monthlyTotalTokens: "0", monthlyUsageQuality: "EXACT", tokenRate24h: null,
      costRate24h: null, estimatedBalanceTokens: null,
      balanceTokenEstimateReason: "RECENT_USAGE_MISSING",
    });
    expect(items.find((row) => row.providerCode === "estimated-api")).toMatchObject({
      monthlyTotalTokens: "12", monthlyUsageQuality: "ESTIMATED", tokenRate24h: "0.50",
      estimatedBalanceTokens: null, balanceTokenEstimateReason: "CURRENT_PRICE_RULE_MISSING",
    });
    expect(items.find((row) => row.providerCode === "currency-api")).toMatchObject({
      monthlyTotalTokens: "12", estimatedBalanceTokens: null,
      balanceTokenEstimateReason: "PRICE_CURRENCY_MISMATCH",
    });
  });

  it("POOL20-045：用量总览只统计成功消耗，失败诊断行不污染任何指标", async () => {
    const resourceId = await createApiResource("pool20-045", "10");
    const modelId = randomUUID();
    await db.insertInto("unified_model").values({
      id: modelId,
      enterprise_id: enterpriseId,
      alias: "ql-k3-256k",
      display_name: "K3 256K",
    }).execute();
    const usedAt = new Date(now.getTime() - 30 * 60 * 1000);
    await addLine({
      resourceId, modelId, historicalAlias: "ql-k3-256k", upstreamModel: "k3-256k",
      input: 100n, output: 20n, cache: 10n, reasoning: 0n,
      cost: "0.10000000", quality: "PROVIDER_REPORTED", at: usedAt,
    });
    await addLine({
      resourceId, modelId, historicalAlias: "ql-k3-256k", upstreamModel: "k3-256k",
      input: 999n, output: 1n, cache: 100n, reasoning: 10n,
      cost: "9.00000000", deductedQuota: 1000n, quality: "UNKNOWN", at: usedAt,
      requestStatus: "FAILED",
      responseCommitted: false, httpStatus: 403,
      errorCode: "candidate_admission_revoked",
    });

    const overview = await new DashboardRepository(db).getResourceUsageOverview(
      enterpriseId, now.getTime(),
    );
    const item = overview.providerSummaries.find((row) => row.providerCode === "pool20-045");
    expect(item).toMatchObject({
      monthlyTotalTokens: "120",
      monthlyUsageQuality: "EXACT",
      monthlyUnknownCount: 0,
      tokenRate24h: "5.00",
      costRate24h: "0.00416667",
      modelTokenBreakdown: [expect.objectContaining({
        modelAlias: "ql-k3-256k",
        totalTokens: "120",
        usageQuality: "EXACT",
        unknownCount: 0,
      })],
    });
  });

  it("POOL20-051：独立展示 API Grant、已记录 Token、余额和历史未归属守恒", async () => {
    const resourceId = await createApiResource("pool20-051", "87.9");
    const modelId = randomUUID();
    await db.insertInto("unified_model").values({
      id: modelId, enterprise_id: enterpriseId,
      alias: "ql-pool20-051", display_name: "POOL20-051",
    }).execute();
    await db.insertInto("model_route").values({
      enterprise_id: enterpriseId, unified_model_id: modelId,
      provider_resource_id: resourceId, upstream_model: "pool20-051-current", enabled: true,
    }).execute();
    await db.insertInto("principal_grant").values({
      enterprise_id: enterpriseId, principal_id: principalId,
      provider: "pool20-051", model_alias: "ql-pool20-051", quota_value: 1_000n,
    }).execute();
    const usedAt = new Date(now.getTime() - 30 * 60 * 1000);
    await addLine({
      resourceId, modelId, historicalAlias: "ql-pool20-051",
      upstreamModel: "pool20-051-current", input: 100n, output: 20n,
      cache: 10n, reasoning: 0n, cost: "1", quality: "PROVIDER_REPORTED", at: usedAt,
    });
    await addLine({
      resourceId, modelId, historicalAlias: "ql-pool20-051",
      upstreamModel: "pool20-051-current", input: 0n, output: 0n,
      cache: 0n, reasoning: 0n, cost: null, quality: "UNKNOWN", at: usedAt,
      requestStatus: "FAILED", responseCommitted: false, httpStatus: 400,
      errorCode: "invalid_request_error",
    });
    await addLine({
      resourceId, modelId: null, historicalAlias: "qianliu-pool20-051",
      upstreamModel: "pool20-051-legacy", input: 50n, output: 10n,
      cache: 0n, reasoning: 0n, cost: "0.5", quality: "PROVIDER_REPORTED", at: usedAt,
    });

    const overview = await new DashboardRepository(db).getResourceUsageOverview(
      enterpriseId, now.getTime(),
    );
    const provider = overview.providerSummaries.find((row) => row.providerCode === "pool20-051");
    expect(provider).toMatchObject({
      allocatedQuota: "1000", currentBalance: "87.90000000",
      monthlyTotalTokens: "180", monthlyUsageQuality: "EXACT", monthlyUnknownCount: 0,
    });
    const current = overview.modelDetails.find((row) => row.modelAlias === "ql-pool20-051");
    expect(current).toMatchObject({
      remainingQuota: "87.90000000", monthlyCost: "1.00000000",
      monthlyTotalTokens: "120", usageQuality: "EXACT", unknownCount: 0,
      historicalUnattributed: false,
    });
    const historical = overview.modelDetails.find(
      (row) => row.modelAlias === "qianliu-pool20-051",
    );
    expect(historical).toMatchObject({
      unifiedModelId: null, remainingQuota: "87.90000000", monthlyCost: "0.50000000",
      monthlyTotalTokens: "60", usageQuality: "EXACT", historicalUnattributed: true,
    });
    const conserved = overview.modelDetails
      .filter((row) => row.providerCode === "pool20-051")
      .reduce((sum, row) => sum + BigInt(row.monthlyTotalTokens ?? 0), 0n);
    expect(conserved.toString()).toBe(provider?.monthlyTotalTokens);
  });

  it("覆盖套餐、缺余额、零价格与 HIGH/MEDIUM 估算可信度", async () => {
    const modelId = randomUUID();
    await db.insertInto("unified_model").values({
      id: modelId, enterprise_id: enterpriseId, alias: "ql-boundary", display_name: "Boundary",
    }).execute();
    const usedAt = new Date(now.getTime() - 15 * 60 * 1000);
    const createRule = (resourceId: string, version: string, prices: {
      cache?: string | null; miss?: string | null; output?: string | null;
    }) => db.insertInto("billing_rule").values({
      enterprise_id: enterpriseId, provider_resource_id: resourceId,
      upstream_model: version, rule_type: "API_PRICE", rule_version: version,
      effective_from: new Date("2026-08-01T00:00:00Z"), cache_hit_price: prices.cache ?? null,
      cache_miss_price: prices.miss ?? null, output_price: prices.output ?? null, enabled: true,
    }).execute();

    const noBalanceProvider = await db.insertInto("provider").values({
      enterprise_id: enterpriseId, code: "no-balance", name: "no-balance", adapter_type: "openai",
    }).returning("id").executeTakeFirstOrThrow();
    const noBalance = await db.insertInto("provider_resource").values({
      enterprise_id: enterpriseId, provider_id: noBalanceProvider.id, name: "no-balance",
      mode: "API", credential_type: "API_KEY",
    }).returning("id").executeTakeFirstOrThrow();
    await createRule(noBalance.id, "no-balance", { miss: "0.01" });
    await addLine({ resourceId: noBalance.id, modelId, historicalAlias: "old", upstreamModel: "no-balance",
      input: 10n, output: 0n, cache: 0n, reasoning: 0n, cost: "0.1",
      quality: "PROVIDER_REPORTED", at: usedAt });

    const zeroPrice = await createApiResource("zero-price", "10");
    await createRule(zeroPrice, "zero-price", { miss: "0", output: "0" });
    await addLine({ resourceId: zeroPrice, modelId, historicalAlias: "old", upstreamModel: "zero-price",
      input: 10n, output: 2n, cache: 0n, reasoning: 0n, cost: "0",
      quality: "PROVIDER_REPORTED", at: usedAt });

    const medium = await createApiResource("medium-confidence", "10");
    await createRule(medium, "medium-confidence", { output: "0.02" });
    for (let index = 0; index < 20; index += 1) {
      await addLine({ resourceId: medium, modelId, historicalAlias: "old", upstreamModel: "medium-confidence",
        input: 10n, output: 2n, cache: 0n, reasoning: 0n, cost: "0.04",
        quality: "ESTIMATED", at: usedAt });
    }

    const mediumBoundary = await createApiResource("medium-boundary", "10");
    await createRule(mediumBoundary, "medium-boundary", { output: "0.02" });
    for (let index = 0; index < 5; index += 1) {
      await addLine({ resourceId: mediumBoundary, modelId, historicalAlias: "old",
        upstreamModel: "medium-boundary", input: 10n, output: 2n, cache: 0n,
        reasoning: 0n, cost: "0.04", quality: "PROVIDER_REPORTED", at: usedAt });
    }

    const high = await createApiResource("high-confidence", "10");
    await createRule(high, "high-confidence", { miss: "0.01" });
    for (let index = 0; index < 20; index += 1) {
      await addLine({ resourceId: high, modelId, historicalAlias: "old", upstreamModel: "high-confidence",
        input: 10n, output: 0n, cache: 0n, reasoning: 0n, cost: "0.1",
        quality: "PROVIDER_REPORTED", at: usedAt });
    }

    const planProvider = await db.insertInto("provider").values({
      enterprise_id: enterpriseId, code: "plan-boundary", name: "plan-boundary", adapter_type: "openai",
    }).returning("id").executeTakeFirstOrThrow();
    const plan = await db.insertInto("provider_resource").values({
      enterprise_id: enterpriseId, provider_id: planProvider.id, name: "plan-boundary",
      mode: "CODING_PLAN", credential_type: "API_KEY",
    }).returning("id").executeTakeFirstOrThrow();
    await db.insertInto("provider_resource_operating_snapshot").values({
      enterprise_id: enterpriseId, provider_resource_id: plan.id, version: 1,
      source: "ADMIN", collected_at: new Date(now.getTime() - 60_000), currency: "CNY",
      package_cost: "300", total_quota: "100", used_quota: "20",
      remaining_quota: "80", quota_unit: "POINT",
      effective_from: new Date("2026-08-01T00:00:00.000Z"),
      effective_until: new Date("2026-09-01T00:00:00.000Z"),
    }).execute();
    await db.insertInto("model_route").values({
      enterprise_id: enterpriseId, unified_model_id: modelId,
      provider_resource_id: plan.id, upstream_model: "plan-boundary", enabled: true,
    }).execute();
    await addLine({ resourceId: plan.id, modelId, historicalAlias: "old", upstreamModel: "plan-boundary",
      input: 10n, output: 2n, cache: 0n, reasoning: 0n, cost: "999",
      quality: "PROVIDER_REPORTED", at: usedAt, mode: "CODING_PLAN", deductedQuota: 12n });

    const overview = await new DashboardRepository(db).getResourceUsageOverview(enterpriseId, now.getTime());
    const items = overview.providerSummaries;
    expect(items.find((row) => row.providerCode === "no-balance")).toMatchObject({
      costRate24h: "0.00416667", estimatedBalanceTokens: null,
      balanceTokenEstimateReason: "BALANCE_MISSING",
    });
    expect(items.find((row) => row.providerCode === "zero-price")).toMatchObject({
      estimatedBalanceTokens: null, balanceTokenEstimateReason: "CURRENT_PRICE_ZERO",
    });
    expect(items.find((row) => row.providerCode === "medium-confidence")).toMatchObject({
      estimatedBalanceTokens: "3000", balanceTokenEstimateConfidence: "MEDIUM",
    });
    expect(items.find((row) => row.providerCode === "high-confidence")).toMatchObject({
      estimatedBalanceTokens: "1000", balanceTokenEstimateConfidence: "HIGH",
    });
    expect(items.find((row) => row.providerCode === "medium-boundary")).toMatchObject({
      estimatedBalanceTokens: "3000", balanceTokenEstimateConfidence: "MEDIUM",
    });
    expect(items.find((row) => row.providerCode === "plan-boundary")).toMatchObject({
      tokenRate24h: "0.50", costRate24h: null, estimatedBalanceTokens: null,
      balanceTokenEstimateReason: "NOT_API_RESOURCE",
    });
    expect(overview.modelDetails.find((row) => row.resourceId === plan.id)).toMatchObject({
      modelAlias: "ql-boundary", usedQuota: "12", remainingQuota: "80.00000000",
      quotaUnit: "POINT", monthlyCost: null, monthlyCostReason: "套餐固定费，不按模型拆分",
      monthlyTotalTokens: "12", consumptionRate24h: "0.50",
      consumptionRateUnit: "QUOTA_PER_HOUR",
    });
  });
});
