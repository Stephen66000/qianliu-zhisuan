/**
 * gateway 运行入口。测试不 import 此文件。
 *
 * W18 整改（F-12）：生产入口由 stubPipeline 切换为 createRealPipeline。
 *   - 生产部署 contract = real-pipeline（账本/路由/调度/额度全链路真实执行）
 *   - caller = StubUpstream 包装：模拟上游响应形状，不接真实 HTTP
 *   - 真实 fetch caller 待 DEP-PROVIDER-CREDENTIALS 解锁后实现并替换；
 *     M6/M7 上线签字前必须替换 caller 为真实 HTTP 实现 + 三厂商真实回归
 *   - quotaRepo 已注入：M4 额度门禁（预占/结算/并发租约）在生产热路径生效
 *
 * 注：当前 caller 为 stub 形状——生产请求会落账本/路由/计费/额度，但上游响应
 * 为模拟值。这是 DEP-PROVIDER-CREDENTIALS 未解锁下的过渡态，Evidence 须显式披露。
 */
import { createKysely, GatewayLedgerRepository, ResourcePoolRepository, DispatchPolicyRepository, QuotaGateRepository } from "@qianliu/database";
import { StubUpstream } from "@qianliu/provider-adapters";
import { buildGateway } from "./server.js";
import { createRealPipeline, type RouteCandidateRow } from "./pipeline/real-pipeline.js";

async function start(): Promise<void> {
  const port = Number(process.env.GATEWAY_PORT ?? 8787);
  const host = process.env.GATEWAY_HOST ?? "127.0.0.1";
  const db = createKysely();
  const pepper = requireEnv("GATEWAY_KEY_PEPPER");

  // 真实仓储（生产 deps）
  const ledgerRepo = new GatewayLedgerRepository(db);
  const poolRepo = new ResourcePoolRepository(db);
  const dispatchRepo = new DispatchPolicyRepository(db);
  const quotaRepo = new QuotaGateRepository(db);

  // caller：StubUpstream 包装（真实 HTTP 待 DEP-PROVIDER-CREDENTIALS 解锁）
  const stub = new StubUpstream({
    default: { kind: "SUCCESS", usage: { input: 11, output: 7, cache: 0 } },
    providerCode: "deepseek",
  });
  const caller = async (res: unknown, req: unknown, n: number) =>
    stub.invoke(res as never, req as never, n);

  // listCandidates：model_route join 查询（与 w08~w16 集成测试一致的生产实现）
  const listCandidates = async (enterpriseId: string, model: string): Promise<RouteCandidateRow[]> => {
    const routes = await db
      .selectFrom("model_route")
      .innerJoin("unified_model", "unified_model.id", "model_route.unified_model_id")
      .innerJoin("provider_resource", "provider_resource.id", "model_route.provider_resource_id")
      .innerJoin("provider", "provider.id", "provider_resource.provider_id")
      .select([
        "provider_resource.id as resource_id",
        "provider.code as provider_code",
        "model_route.upstream_model",
        "model_route.priority",
        "model_route.weight",
        "provider_resource.mode",
        "provider_resource.status",
      ])
      .where("model_route.enterprise_id", "=", enterpriseId)
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
      principalId: "", // 由 pipeline 从 allCandidates 填充（生产查询不直接带 principal_id）
    }));
  };

  const pipeline = createRealPipeline({
    db, ledgerRepo, caller, poolRepo, dispatchRepo, quotaRepo, listCandidates, maxAttempts: 2,
  });
  const app = buildGateway(db, pepper, pipeline, { port, host });
  await app.listen({ port, host });
  app.log.info({ port, host }, "gateway listening (real-pipeline; caller=stub pending DEP-PROVIDER-CREDENTIALS)");
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

start().catch((err) => {
  console.error("gateway 启动失败:", err);
  process.exit(1);
});
