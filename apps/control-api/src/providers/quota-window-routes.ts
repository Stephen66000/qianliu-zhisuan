/** POOL-032：厂商 Coding Plan 额度窗口同步与查询 API。 */
import type { FastifyInstance, FastifyReply } from "fastify";
import {
  decryptCredential,
  queryCodingPlanQuota,
  ProviderCodingPlanQuotaError,
  type EncryptedCredential,
  type ProviderCode,
} from "@qianliu/provider-adapters";
import { requireAuth } from "../plugins/auth-guard.js";

function isProviderCode(code: string): code is ProviderCode {
  const lower = (code || "").toLowerCase();
  return lower === "deepseek" || lower === "kimi" || lower === "zhipu";
}

export function registerProviderQuotaWindowRoutes(app: FastifyInstance): void {
  // 查询某资源当前的厂商额度窗口快照（供前端展示）。
  app.get<{ Params: { id: string } }>(
    "/provider-resources/:id/quota-windows", { preHandler: [requireAuth] }, async (req) => {
      const windows = await app.quotaWindowRepo.listCurrentWindowsByResource(req.params.id);
      return { windows: windows.map((w) => ({
        ...w,
        // 日期序列化为 ISO 字符串（bigint 无，numeric 已是 string）。
        reset_at: w.reset_at?.toISOString() ?? null,
        provider_data_at: w.provider_data_at?.toISOString() ?? null,
        collected_at: w.collected_at.toISOString(),
        last_success_at: w.last_success_at?.toISOString() ?? null,
      })) };
    },
  );

  // 管理员手动触发厂商额度同步（照抄 models/sync 模板）。
  app.post<{ Params: { id: string } }>(
    "/provider-resources/:id/quota-sync", { preHandler: [requireAuth] }, async (req, reply) => {
      const resource = await app.providerRepo.getResourceForModelDiscovery(
        req.admin!.enterpriseId, req.params.id,
      );
      if (!resource || !resource.credential_ciphertext) {
        const isolated = await app.db.selectFrom("provider_resource").select("status")
          .where("id", "=", req.params.id).where("enterprise_id", "=", req.admin!.enterpriseId)
          .where("status", "=", "CREDENTIAL_INVALID").executeTakeFirst();
        if (isolated) return reply.code(409).send({ error: "credential_isolated",
          message: "资源因 Chat 鉴权失败已隔离，额度同步不能解除隔离；请在供给与健康中验证当前凭证" });
        return reply.code(404).send({ error: "not_found", message: "资源不存在或没有可用凭证" });
      }
      if (resource.mode !== "CODING_PLAN" || !isProviderCode(resource.provider_code)) {
        return reply.code(409).send({
          error: "not_applicable",
          message: "非 Coding Plan 套餐资源，无厂商窗口额度",
        });
      }
      try {
        const credential = decryptCredential(
          JSON.parse(resource.credential_ciphertext) as EncryptedCredential, app.credentialKek,
        );
        const result = await queryCodingPlanQuota({
          providerCode: resource.provider_code, mode: resource.mode, credential,
        });
        for (const window of result.windows) {
          await app.quotaWindowRepo.upsertCurrentWindow({
            enterprise_id: req.admin!.enterpriseId,
            provider_resource_id: resource.id,
            window_type: window.windowType,
            limit_value: window.limit,
            used_value: window.used,
            remaining_value: window.remaining,
            unit: window.unit,
            ratio: window.ratio,
            reset_at: window.resetAt,
            provider_data_at: result.providerDataAt,
            source: "MANUAL_SYNC",
            adapter_version: result.adapterVersion,
            sync_status: window.unsupported ? "UNSUPPORTED" : "SUCCESS",
            sync_error_code: null,
          });
        }
        await app.auditRepo.write({
          enterprise_id: req.admin!.enterpriseId, admin_user_id: req.admin!.adminUserId,
          action: "provider_resource.quota_sync", target_type: "provider_resource",
          target_id: resource.id,
          change_summary: { windows: result.windows.length, adapter: result.adapterVersion },
          result: "SUCCESS",
        });
        const windows = await app.quotaWindowRepo.listCurrentWindowsByResource(resource.id);
        return { windows };
      } catch (cause) {
        const code = cause instanceof ProviderCodingPlanQuotaError ? cause.code : "UPSTREAM_UNAVAILABLE";
        // 失败保鲜：标记两个窗口类型 stale/failed，不动已有数值。
        for (const windowType of ["FIVE_HOUR", "WEEKLY"] as const) {
          await app.quotaWindowRepo.markStale(
            req.admin!.enterpriseId, resource.id, windowType, "MANUAL_SYNC",
            "pool032-v1", code,
          );
        }
        await app.auditRepo.write({
          enterprise_id: req.admin!.enterpriseId,
          admin_user_id: req.admin!.adminUserId,
          action: "provider_resource.quota_sync",
          target_type: "provider_resource",
          target_id: resource.id,
          change_summary: { failureCode: code },
          result: "FAILURE",
        });
        return sendQuotaSyncError(reply, cause);
      }
    },
  );
}

function sendQuotaSyncError(reply: FastifyReply, cause: unknown): FastifyReply {
  if (cause instanceof ProviderCodingPlanQuotaError) {
    const status = cause.code === "UNAUTHORIZED" ? 401
      : cause.code === "RATE_LIMITED" ? 429
      : cause.code === "INVALID_RESPONSE" ? 502
      : 503;
    return reply.code(status).send({ error: cause.code.toLowerCase(), message: cause.message });
  }
  return reply.code(503).send({ error: "upstream_unavailable", message: "额度同步失败" });
}
