/**
 * 只读模型路由（W18）—— 计价规则 / 经营策略 / 供给预测列表。
 *
 * 依据：TRD §11.2（/billing-rules、/dispatch-policies、/supply-forecasts 端点）。
 * 供给预测、经营策略和路由诊断复用 /resources、/quota-rules 和 /usage 页面（TRD 行 731）。
 * 全部只读；写操作在 W19 落地。
 */
import type { FastifyInstance } from "fastify";
import { requireAuth } from "../plugins/auth-guard.js";

export function registerReadModelRoutes(app: FastifyInstance): void {
  // GET /billing-rules —— 计价规则列表（含 disabled/历史，管理后台用）
  app.get("/billing-rules", { preHandler: [requireAuth] }, async (req) => {
    const rules = await app.ledgerRepo.listAllBillingRules(req.admin!.enterpriseId);
    return { rules };
  });

  // GET /dispatch-policies —— 经营策略列表（含全部状态 DRAFT/VALIDATED/PUBLISHED/RETIRED）
  app.get("/dispatch-policies", { preHandler: [requireAuth] }, async (req) => {
    const policies = await app.dispatchRepo.listPublishedPolicies(req.admin!.enterpriseId);
    return { policies };
  });

  // GET /supply-forecasts —— 供给预测快照列表（每资源最新一条）
  app.get("/supply-forecasts", { preHandler: [requireAuth] }, async (req) => {
    const forecasts = await app.db
      .selectFrom("supply_forecast")
      .innerJoin(
        "provider_resource",
        "provider_resource.id",
        "supply_forecast.provider_resource_id",
      )
      .where("supply_forecast.enterprise_id", "=", req.admin!.enterpriseId)
      .orderBy("supply_forecast.snapshot_at", "desc")
      .select([
        "supply_forecast.id",
        "supply_forecast.provider_resource_id",
        "provider_resource.name as resource_name",
        "supply_forecast.rate_1h",
        "supply_forecast.rate_24h",
        "supply_forecast.rate_7d",
        "supply_forecast.forecast_exhaust_at",
        "supply_forecast.next_recover_at",
        "supply_forecast.coverage_hours",
        "supply_forecast.remaining_quota",
        "supply_forecast.confidence",
        "supply_forecast.data_points",
        "supply_forecast.not_calculable_reason",
        "supply_forecast.snapshot_at",
      ])
      .execute();
    return { forecasts };
  });
}
