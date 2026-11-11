/**
 * Provider/Resource/Model/Route 路由（W04）。
 *
 * 依据：TRD §5.4、§11.2（/providers /provider-resources /unified-models /model-routes）。
 * WT-01：登记资源账号（凭证加密存储，列表只返回指纹）。
 * WT-10：统一模型路由详情（候选、优先级、权重）。
 *
 * 安全：上游凭证明文绝不入 DB、绝不返回 API。createResource 接收明文 → 加密 → 存密文+指纹。
 *
 * 本文件只保留资源登记/查询主链路与各子路由模块的编排注册：
 * 厂商生命周期路由见 provider-lifecycle-routes.ts，统一模型/模型路由见 model-route-routes.ts。
 */
import type { FastifyInstance } from "fastify";
import {
  credentialFingerprint,
  encryptCredential,
} from "@qianliu/provider-adapters";
import {
  EnterpriseReferenceError,
  listOfficialBalanceStates,
  sumAllocatedQuota,
} from "@qianliu/database";
import {
  readProviderOperatingBalanceRefreshCooldownMs,
  readProviderOperatingBalanceExpireMs,
} from "@qianliu/config";
import { requireAuth } from "../plugins/auth-guard.js";
import {
  CreateResourceSchema,
  financeManagedOperatingSnapshotError,
  operatingSnapshotModeError,
  toOperatingSnapshotInput,
} from "./contracts.js";
import { registerProviderModelDiscoveryRoutes } from "./model-discovery-routes.js";
import { registerProviderQuotaWindowRoutes } from "./quota-window-routes.js";
import { registerOfficialBalanceRoutes } from "./official-balance-routes.js";
import { registerProviderHealthRoutes } from "./health-routes.js";
import { registerProviderUsageOverviewRoutes } from "./usage-overview-routes.js";
import { registerProviderLifecycleRoutes } from "./provider-lifecycle-routes.js";
import { registerModelRouteRoutes } from "./model-route-routes.js";
import { financeReadModelEnabled, shanghaiMonthAt } from "../provider-finance/dashboard-projection.js";
import { archivedResourceModels } from "./resource-model-visibility.js";

export function registerProviderRoutes(app: FastifyInstance): void {
  registerProviderModelDiscoveryRoutes(app);
  registerProviderQuotaWindowRoutes(app);
  registerOfficialBalanceRoutes(app);
  registerProviderHealthRoutes(app);
  registerProviderUsageOverviewRoutes(app);
  // ===== Provider（生命周期：CRUD/删除/归档/恢复）=====
  registerProviderLifecycleRoutes(app);

  // ===== Provider Resource（凭证加密存储）=====
  app.get<{ Querystring: { archived?: string } }>("/provider-resources", { preHandler: [requireAuth] }, async (req) => {
    const enterpriseId = req.admin!.enterpriseId;
    const now = new Date();
    const archiveFilter = req.query.archived === "only" ? "only" : req.query.archived === "all" ? "all" : "exclude";
    const financeRead = await financeReadModelEnabled(
      app.providerFinanceMode, app.providerFinanceRepo, enterpriseId,
    );
    const [resources, snapshots, syncStates, financeViews, archivedModels, providers, officialBalances] = await Promise.all([
      app.providerRepo.listResources(enterpriseId, archiveFilter),
      app.providerRepo.listCurrentOperatingSnapshots(enterpriseId),
      app.providerRepo.listLatestOperatingSyncStates(enterpriseId),
      !financeRead ? []
        : app.providerFinanceRepo.listResourceFinanceViews(enterpriseId, shanghaiMonthAt(now), now),
      archivedResourceModels(app.db, enterpriseId),
      app.providerRepo.listProviders(enterpriseId),
      // WP3 C2：官方余额状态（PROVIDER_SYNC 来源过滤；P2/P3 按请求时读取，可配置）。
      listOfficialBalanceStates(app.db, enterpriseId, {
        now,
        expireMs: readProviderOperatingBalanceExpireMs(process.env),
        cooldownMs: readProviderOperatingBalanceRefreshCooldownMs(process.env),
      }),
    ]);
    const providerById = new Map(providers.map((p) => [p.id, p]));
    const allocatedQuotas = new Map<string, string>();
    for (const r of resources) {
      const provider = providerById.get(r.provider_id);
      if (provider?.code) {
        const key = `${provider.code}:${r.mode}`;
        if (!allocatedQuotas.has(key)) {
          const quota = await sumAllocatedQuota(app.db, enterpriseId, provider.code, r.mode, now);
          allocatedQuotas.set(key, quota);
        }
      }
    }
    const byResource = new Map(snapshots.map((snapshot) => [
      snapshot.provider_resource_id,
      snapshot,
    ]));
    const syncByResource = new Map(syncStates.map((state) => [state.provider_resource_id, state]));
    const officialBalanceByResource = new Map(officialBalances.map((state) => [
      state.provider_resource_id, state,
    ]));
    const financeByResource = new Map(financeViews.map((view) => [view.resourceId, view]));
    const staleBefore = Date.now() - 36 * 60 * 60 * 1_000;
    // 列表只返回指纹，绝不返回密文/明文
    return {
      resources: resources.map((r) => {
        const sync = syncByResource.get(r.id);
        const lastSuccessAt = sync?.last_success_data_at ?? null;
        const provider = providerById.get(r.provider_id);
        const allocatedQuota = provider?.code ? (allocatedQuotas.get(`${provider.code}:${r.mode}`) ?? null) : null;
        return ({
        id: r.id,
        provider_id: r.provider_id,
        name: r.name,
        mode: r.mode,
        allocated_quota: allocatedQuota && allocatedQuota !== "0" ? allocatedQuota : null,
        credential_type: r.credential_type,
        credential_fingerprint: r.credential_fingerprint,
        credential_version: r.credential_version,
        status: r.status,
        // POOL-031：资源健康详情字段（脱敏运行元数据，不含凭证/正文）。
        consecutive_failures: r.consecutive_failures,
        cooldown_until: r.cooldown_until?.toISOString() ?? null,
        last_probe_at: r.last_probe_at?.toISOString() ?? null,
        credential_refresh_status: r.credential_refresh_status,
        refresh_error_classification: r.refresh_error_classification ?? null,
        credential_expires_at: r.credential_expires_at?.toISOString() ?? null,
        resource_pool_id: r.resource_pool_id ?? null,
        upstream_models: r.upstream_models,
        display_upstream_models: r.upstream_models?.filter((name) => !archivedModels.get(r.id)?.has(name)) ?? null,
        concurrency_limit: r.concurrency_limit,
        version: r.version,
        monthly_budget_amount: r.monthly_budget_amount,
        monthly_budget_currency: r.monthly_budget_currency,
        archived_at: r.archived_at?.toISOString() ?? null,
        created_at: r.created_at,
        updated_at: r.updated_at,
        operating_snapshot: byResource.get(r.id) ?? null,
        official_balance: officialBalanceByResource.get(r.id) ?? null,
        finance: financeByResource.get(r.id) ?? null,
        operating_sync: sync ? {
          balance_status: sync.balance_status,
          cost_status: sync.cost_status,
          data_status: !lastSuccessAt || lastSuccessAt.getTime() < staleBefore ? "STALE" : "FRESH",
          provider_data_at: sync.provider_data_at?.toISOString() ?? null,
          last_success_data_at: lastSuccessAt?.toISOString() ?? null,
          completed_at: sync.completed_at.toISOString(),
          next_sync_at: sync.next_sync_at.toISOString(),
          error_code: sync.error_code,
          failure_reason: sync.failure_reason,
          adapter_version: sync.adapter_version,
        } : {
          balance_status: "NOT_SUPPORTED",
          cost_status: "NOT_SUPPORTED",
          data_status: "STALE",
          provider_data_at: null,
          last_success_data_at: null,
          completed_at: null,
          next_sync_at: null,
          error_code: "SYNC_NOT_RUN",
          failure_reason: "尚未执行每日经营数据同步",
          adapter_version: null,
        },
      }); }),
    };
  });

  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    "/provider-resources/:id/operating-snapshots",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const limit = Number(req.query.limit ?? "20");
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        return reply.code(400).send({ error: "invalid_request", message: "limit 必须为 1-100" });
      }
      const resource = (await app.providerRepo.listResources(req.admin!.enterpriseId, "all"))
        .find((item) => item.id === req.params.id);
      if (!resource) {
        return reply.code(404).send({ error: "not_found", message: "资源不存在" });
      }
      return {
        snapshots: await app.providerRepo.listOperatingSnapshotHistory(
          req.admin!.enterpriseId,
          resource.id,
          limit,
        ),
      };
    },
  );

  app.post("/provider-resources", { preHandler: [requireAuth] }, async (req, reply) => {
    const parsed = CreateResourceSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", message: parsed.error.message });
    }
    const { credential_plaintext, operating_snapshot, ...rest } = parsed.data;
    if (operating_snapshot) {
      const financeError = app.providerFinanceMode === "OFF" ? null
        : financeManagedOperatingSnapshotError(rest.mode, operating_snapshot);
      if (financeError) return reply.code(409).send({
        error: "finance_entry_moved", message: financeError,
      });
      const modeError = operatingSnapshotModeError(rest.mode, operating_snapshot);
      if (modeError) {
        return reply.code(400).send({ error: "invalid_operating_mode", message: modeError });
      }
    }

    // 立即加密明文（绝不入库明文）
    const encrypted = encryptCredential(credential_plaintext, app.credentialKek);
    const fingerprint = credentialFingerprint(credential_plaintext);

    let resource;
    try {
      resource = await app.providerRepo.createResource({
        enterprise_id: req.admin!.enterpriseId,
        credential_encrypted: encrypted,
        credential_fingerprint: fingerprint,
        operating_snapshot: operating_snapshot
          ? toOperatingSnapshotInput(operating_snapshot, rest.mode)
          : undefined,
        ...rest,
      });
    } catch (error) {
      if (error instanceof EnterpriseReferenceError) {
        return reply.code(409).send({
          error: "invalid_reference",
          message: "厂商不存在、已停用或不属于当前企业",
        });
      }
      throw error;
    }

    await app.auditRepo.write({
      enterprise_id: req.admin!.enterpriseId,
      admin_user_id: req.admin!.adminUserId,
      action: "provider_resource.create",
      target_type: "provider_resource",
      target_id: resource.id,
      change_summary: { name: resource.name, mode: resource.mode, credential_fingerprint: fingerprint },
      result: "SUCCESS",
    });

    // 响应只返回指纹（明文不回显）
    return reply.code(201).send({
      resource: {
        id: resource.id,
        provider_id: resource.provider_id,
        name: resource.name,
        mode: resource.mode,
        credential_type: resource.credential_type,
        credential_fingerprint: resource.credential_fingerprint,
        credential_version: resource.credential_version,
        status: resource.status,
        upstream_models: resource.upstream_models,
        concurrency_limit: resource.concurrency_limit,
        version: resource.version,
        monthly_budget_amount: resource.monthly_budget_amount,
        monthly_budget_currency: resource.monthly_budget_currency,
        created_at: resource.created_at,
        updated_at: resource.updated_at,
        operating_snapshot: operating_snapshot
          ? (await app.providerRepo.listCurrentOperatingSnapshots(req.admin!.enterpriseId))
              .find((snapshot) => snapshot.provider_resource_id === resource.id) ?? null
          : null,
      },
    });
  });

  // ===== Unified Model / Model Route（WT-10）=====
  registerModelRouteRoutes(app);
}
