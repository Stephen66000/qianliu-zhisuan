/** WP3 task 3.2 / OAB-03：官方账户余额手动刷新（受 resources.operate 权限约束，
 * 冷却/在途/不支持显式分态，凭证解密后仅进程内使用，绝不下发浏览器/日志）。 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance, FastifyReply } from "fastify";
import {
  OfficialBalanceRefreshConflict,
  OfficialBalanceRefreshRepository,
  officialBalanceSyncDay,
  recordOfficialBalanceSyncAttempt,
  recordOfficialBalanceSyncSuccess,
} from "@qianliu/database";
import {
  canonicalProviderCode,
  decryptCredential,
  PROVIDER_OPERATING_ADAPTER_VERSION,
  ProviderOperatingFactsError,
  queryProviderOperatingBalance,
  type EncryptedCredential,
  type ProviderCode,
} from "@qianliu/provider-adapters";
import {
  readProviderOperatingBalanceRefreshCooldownMs,
  readProviderOperatingSyncIntervalMs,
} from "@qianliu/config";
import { requireAuth } from "../plugins/auth-guard.js";

/** 在途租约：官方查询适配器超时 8s 的充足余量；崩溃残留由下次 begin 按 expires_at 收敛。 */
const REFRESH_LEASE_MS = 60_000;

const refreshBodySchema = z.object({
  idempotency_key: z.string().uuid().optional(),
}).strict();

/** 幂等重放：同一键的历史请求直接复用既有终态，不再触达上游。 */
function replayResponse(row: { status: "RUNNING" | "SUCCEEDED" | "FAILED"; error_code: string | null; expires_at: Date }, now: Date) {
  if (row.status === "RUNNING") {
    return { state: "IN_PROGRESS" as const, retry_after_seconds: Math.max(1, Math.ceil((row.expires_at.getTime() - now.getTime()) / 1000)) };
  }
  return {
    state: "ACCEPTED" as const,
    result: row.status === "SUCCEEDED"
      ? { outcome: "SUCCEEDED" as const }
      : { outcome: "FAILED" as const, error_code: row.error_code },
  };
}

export function registerOfficialBalanceRoutes(app: FastifyInstance): void {
  const refreshRepo = new OfficialBalanceRefreshRepository(app.db);

  app.post<{ Params: { id: string } }>(
    "/provider-resources/:id/official-balance/refresh",
    { preHandler: [requireAuth] },
    async (req, reply): Promise<FastifyReply> => {
      const enterpriseId = req.admin!.enterpriseId;
      const adminUserId = req.admin!.adminUserId;
      const parsed = refreshBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_request", message: "请求体不合法" });
      }
      const now = new Date();
      // P3 冷却 / P1 周期节奏均按请求时读取（可配置，建议默认值见 packages/config）。
      const cooldownMs = readProviderOperatingBalanceRefreshCooldownMs(process.env);
      const intervalMs = readProviderOperatingSyncIntervalMs(process.env);

      const resource = await app.db.selectFrom("provider_resource")
        .innerJoin("provider", "provider.id", "provider_resource.provider_id")
        .select([
          "provider_resource.id", "provider_resource.mode",
          "provider_resource.credential_ciphertext", "provider.code as provider_code",
        ])
        .where("provider_resource.id", "=", req.params.id)
        .where("provider_resource.enterprise_id", "=", enterpriseId)
        .where("provider.enterprise_id", "=", enterpriseId)
        .where("provider.status", "=", "ACTIVE")
        .executeTakeFirst();
      if (!resource) {
        return reply.code(404).send({ error: "not_found", message: "资源不存在" });
      }
      // 不支持厂商（OAB-02）：canonical 判定与适配器同源；零写入（快照/attempt/
      // refresh 表均不动，周期同步自然留下 NOT_SUPPORTED 痕迹）。
      const providerCode = canonicalProviderCode(resource.provider_code);
      if (providerCode !== "deepseek" || resource.mode !== "API") {
        return reply.code(422).send({ error: "official_balance_not_supported",
          message: "该厂商或接入模式未实现官方余额查询，暂不支持手动刷新" });
      }
      if (!resource.credential_ciphertext) {
        return reply.code(409).send({ error: "credential_missing",
          message: "资源没有可用凭证，无法刷新官方余额" });
      }

      let requestId: string;
      let startedAt: Date;
      try {
        const begun = await refreshRepo.begin({
          enterpriseId,
          resourceId: resource.id,
          actorAdminId: adminUserId,
          idempotencyKey: parsed.data.idempotency_key ?? randomUUID(),
          cooldownMs,
          leaseMs: REFRESH_LEASE_MS,
          now,
        });
        if (begun.replay) {
          return reply.code(200).send(replayResponse(begun.row, now));
        }
        requestId = begun.row.id;
        startedAt = begun.row.started_at;
      } catch (cause) {
        if (cause instanceof OfficialBalanceRefreshConflict) {
          return reply.code(200).send({
            state: cause.code === "cooldown" ? "COOLDOWN" : "IN_PROGRESS",
            retry_after_seconds: cause.retryAfterSeconds,
          });
        }
        throw cause;
      }

      const completedAt = new Date();
      const attemptIdentity = {
        syncDay: officialBalanceSyncDay(completedAt),
        startedAt,
        completedAt,
        // 手动刷新计入 P1 节奏：周期调度在该资源下次到点前不再重复查询官方。
        nextSyncAt: new Date(startedAt.getTime() + intervalMs),
        adapterVersion: PROVIDER_OPERATING_ADAPTER_VERSION,
      };
      try {
        const credential = decryptCredential(
          JSON.parse(resource.credential_ciphertext) as EncryptedCredential,
          app.credentialKek,
        );
        const balance = await queryProviderOperatingBalance({
          providerCode: providerCode as ProviderCode,
          mode: "API",
          credential,
        });
        // 前置判定已保证 deepseek+API，适配器 null 属于异常响应：按失败留痕，不冒充余额。
        if (balance === null) {
          throw new ProviderOperatingFactsError("INVALID_RESPONSE", "厂商余额响应不可用");
        }
        const { snapshotId } = await recordOfficialBalanceSyncSuccess(app.db, {
          ...attemptIdentity, enterpriseId, resourceId: resource.id, balance,
        });
        await refreshRepo.finish({ requestId, outcome: "SUCCEEDED", errorCode: null, now: completedAt });
        await app.auditRepo.write({
          enterprise_id: enterpriseId, admin_user_id: adminUserId,
          action: "provider_resource.official_balance_refresh",
          target_type: "provider_resource", target_id: resource.id,
          change_summary: { outcome: "SUCCEEDED", snapshot_id: snapshotId,
            currency: balance.currency },
          result: "SUCCESS",
        });
        // 只返回官方余额事实摘要；凭证与解密中间值绝不出现在响应/审计/日志。
        return reply.code(200).send({
          state: "ACCEPTED",
          result: {
            outcome: "SUCCEEDED",
            collected_at: balance.providerDataAt.toISOString(),
            balance: {
              currency: balance.currency,
              total_balance: balance.totalBalance,
              granted_balance: balance.grantedBalance,
              topped_up_balance: balance.toppedUpBalance,
              available: balance.available,
            },
          },
        });
      } catch (cause) {
        const errorCode = cause instanceof ProviderOperatingFactsError
          ? cause.code
          : "UPSTREAM_UNAVAILABLE";
        const failureReason = cause instanceof Error ? cause.message.slice(0, 500) : "官方余额刷新失败";
        await recordOfficialBalanceSyncAttempt(app.db, {
          ...attemptIdentity, enterpriseId, resourceId: resource.id,
          balanceStatus: "FAILED", errorCode, failureReason,
        });
        await refreshRepo.finish({ requestId, outcome: "FAILED", errorCode, now: new Date() });
        await app.auditRepo.write({
          enterprise_id: enterpriseId, admin_user_id: adminUserId,
          action: "provider_resource.official_balance_refresh",
          target_type: "provider_resource", target_id: resource.id,
          change_summary: { outcome: "FAILED", error_code: errorCode },
          result: "FAILURE",
        });
        // 失败不覆盖上次成功值（快照未动）；冷却到期后可按合同再次刷新。
        return reply.code(200).send({
          state: "ACCEPTED",
          result: { outcome: "FAILED", error_code: errorCode },
        });
      }
    },
  );
}
