/**
 * gateway 运行入口。测试不 import 此文件。
 *
 * 生产部署 contract：
 *   - createRealPipeline 执行账本、路由、调度、权限与额度全链路；
 *   - createOpenAiCompatibleCaller 真实访问 DeepSeek/智谱/Kimi Chat Completions；
 *   - 资源凭证优先从 provider_resource 密文按 CREDENTIAL_KEK 解密；
 *     历史数据没有资源密文时才兼容回退厂商环境变量；
 *   - 缺凭证/Base URL 明确失败，生产路径不返回 Stub 模拟结果。
 */
import { createKysely, GatewayLedgerRepository, ResourcePoolRepository, DispatchPolicyRepository, QuotaGateRepository, RuntimeAssuranceRepository } from "@qianliu/database";
import {
  createOpenAiCompatibleCaller,
  decodeKek,
  resolveProviderSecret,
} from "@qianliu/provider-adapters";
import { buildGateway } from "./server.js";
import { createRealPipeline, type RouteCandidateRow } from "./pipeline/real-pipeline.js";

async function start(): Promise<void> {
  const port = Number(process.env.GATEWAY_PORT ?? 8787);
  const host = process.env.GATEWAY_HOST ?? "127.0.0.1";
  const db = createKysely();
  const pepper = requireEnv("GATEWAY_KEY_PEPPER");
  const credentialKek = decodeKek(requireEnv("CREDENTIAL_KEK"));

  // 真实仓储（生产 deps）
  const ledgerRepo = new GatewayLedgerRepository(db);
  const poolRepo = new ResourcePoolRepository(db);
  const dispatchRepo = new DispatchPolicyRepository(db);
  const quotaRepo = new QuotaGateRepository(db);
  const runtimeAssuranceRepo = new RuntimeAssuranceRepository(db);

  // 真实 OpenAI-compatible HTTP caller。缺配置时返回可解释错误，不模拟成功。
  const caller = createOpenAiCompatibleCaller({
    firstByteTimeoutMs: positiveEnvMs("GATEWAY_UPSTREAM_FIRST_BYTE_TIMEOUT_MS", 30_000),
    streamIdleTimeoutMs: positiveEnvMs("GATEWAY_UPSTREAM_STREAM_IDLE_TIMEOUT_MS", 45_000),
    requestTimeoutMs: positiveEnvMs("GATEWAY_UPSTREAM_REQUEST_TIMEOUT_MS", 10 * 60_000),
  });

  // listCandidates：model_route join 查询（与 w08~w16 集成测试一致的生产实现）
  const listCandidates = async (enterpriseId: string, model: string): Promise<RouteCandidateRow[]> => {
    const routes = await db
      .selectFrom("model_route")
      .innerJoin("unified_model", "unified_model.id", "model_route.unified_model_id")
      .innerJoin("provider_resource", "provider_resource.id", "model_route.provider_resource_id")
      .innerJoin("provider", "provider.id", "provider_resource.provider_id")
      .select([
        "provider_resource.id as resource_id",
        "provider_resource.provider_id",
        "unified_model.id as unified_model_id",
        "provider.code as provider_code",
        "model_route.upstream_model",
        "model_route.priority",
        "model_route.weight",
        "provider_resource.mode",
        "provider_resource.status",
        "provider_resource.credential_ciphertext",
        "provider_resource.concurrency_limit",
      ])
      .where("model_route.enterprise_id", "=", enterpriseId)
      .where("unified_model.enterprise_id", "=", enterpriseId)
      .where("provider_resource.enterprise_id", "=", enterpriseId)
      .where("provider.enterprise_id", "=", enterpriseId)
      .where("unified_model.alias", "=", model)
      .where("model_route.enabled", "=", true)
      .execute();
    return routes.map((r) => ({
      resourceId: r.resource_id,
      providerCode: r.provider_code,
      upstreamModel: r.upstream_model,
      priority: r.priority,
      weight: r.weight,
      mode: r.mode as "API" | "CODING_PLAN",
      status: r.status,
      probe: false,
      principalId: "", // 路由候选不携带主体；pipeline 用已认证的 principal.principalId 做额度/账本归因（R2-N1）
      providerId: r.provider_id,
      unifiedModelId: r.unified_model_id,
      secret: resolveProviderSecret({
        providerCode: r.provider_code as "deepseek" | "zhipu" | "kimi",
        credentialCiphertext: r.credential_ciphertext,
        credentialKek,
      }),
      // 0 表示数据库未配置本地上限；不得用臆造的 100 放大套餐并发。
      concurrencyLimit: r.concurrency_limit ?? 0,
    }));
  };

  const pipeline = createRealPipeline({
    db,
    ledgerRepo,
    caller,
    poolRepo,
    dispatchRepo,
    quotaRepo,
    runtimeAssuranceRepo,
    runtimeAssuranceMode: runtimeMode(process.env.RUNTIME_ASSURANCE_MODE),
    runtimeAssuranceWecomNotify: process.env.RUNTIME_ASSURANCE_WECOM_NOTIFY === "true",
    listCandidates,
    resolveDispatchInput: (
      enterpriseId,
      _principalId,
      _unifiedModel,
      winnerResourceId,
      _winnerMode,
      now,
    ) => dispatchRepo.resolveResourceOperatingInput(enterpriseId, winnerResourceId, now),
    maxAttempts: 2,
  });
  const app = buildGateway(db, pepper, pipeline, { port, host });
  await app.listen({ port, host });
  app.log.info({ port, host }, "gateway listening (real-pipeline; caller=openai-compatible-http)");
}

function runtimeMode(value: string | undefined): "OFF" | "OBSERVE" | "ENFORCE" {
  const mode = value ?? "OBSERVE";
  if (mode !== "OFF" && mode !== "OBSERVE" && mode !== "ENFORCE") {
    throw new Error("RUNTIME_ASSURANCE_MODE 必须是 OFF、OBSERVE 或 ENFORCE");
  }
  return mode;
}

/** F-02：敏感环境变量缺失即启动失败（不提供 dev fallback）。 */
function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) {
    console.error(`启动失败：必需环境变量 ${name} 未设置（不提供 dev fallback；见 F-02 整改）`);
    process.exit(1);
  }
  return val;
}

function positiveEnvMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} 必须是正整数毫秒`);
  }
  return value;
}

start().catch((err) => {
  console.error("gateway 启动失败:", err);
  process.exit(1);
});
