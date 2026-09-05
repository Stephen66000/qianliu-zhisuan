import type { FastifyInstance } from "fastify";
import { CurrentSubscriptionPeriodRequiredError } from "@qianliu/database";
import { requireAuth } from "../plugins/auth-guard.js";
import {
  financeManagedOperatingSnapshotError,
  operatingSnapshotModeError,
  toOperatingSnapshotInput,
} from "../providers/contracts.js";
import { UpdateResourceSchema, resourceView } from "./contracts.js";

export function registerAdminResourceUpdateRoute(app: FastifyInstance): void {
  app.patch<{ Params: { id: string } }>(
    "/provider-resources/:id",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const parsed = UpdateResourceSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_request", message: parsed.error.message });
      }
      const enterpriseId = req.admin!.enterpriseId;
      const before = (await app.providerRepo.listResources(enterpriseId)).find(
        (resource) => resource.id === req.params.id,
      );
      if (!before) return reply.code(404).send({ error: "not_found", message: "资源不存在" });
      if (parsed.data.operating_snapshot) {
        const financeError = app.providerFinanceMode === "OFF" ? null
          : financeManagedOperatingSnapshotError(before.mode, parsed.data.operating_snapshot);
        if (financeError) return reply.code(409).send({
          error: "finance_entry_moved", message: financeError,
        });
        const modeError = operatingSnapshotModeError(before.mode, parsed.data.operating_snapshot);
        if (modeError) return reply.code(400).send({
          error: "invalid_operating_mode", message: modeError,
        });
      }

      let updated;
      try {
        updated = await app.adminWriteRepo.updateProviderResource(
          enterpriseId, req.params.id, parsed.data.expected_version,
          {
            name: parsed.data.name,
            concurrency_limit: parsed.data.concurrency_limit,
            upstream_models: parsed.data.upstream_models,
            operating_snapshot: parsed.data.operating_snapshot
              ? toOperatingSnapshotInput(parsed.data.operating_snapshot, before.mode)
              : undefined,
            bind_current_subscription_period: app.providerFinanceMode !== "OFF",
          },
        );
      } catch (error) {
        if (error instanceof CurrentSubscriptionPeriodRequiredError) {
          return reply.code(409).send({
            error: "current_subscription_period_required",
            message: "当前没有有效订阅周期，请先在充值与订阅中登记当前周期",
          });
        }
        throw error;
      }
      if (!updated) return reply.code(409).send({
        error: "conflict", message: "该资源刚被其他管理员修改，请刷新后重试",
      });

      const snapshot = parsed.data.operating_snapshot
        ? (await app.providerRepo.listCurrentOperatingSnapshots(enterpriseId))
            .find((item) => item.provider_resource_id === updated.id) ?? null
        : null;
      await app.auditRepo.write({
        enterprise_id: enterpriseId,
        admin_user_id: req.admin!.adminUserId,
        action: "provider_resource.update",
        target_type: "provider_resource",
        target_id: updated.id,
        change_summary: {
          before: {
            name: before.name,
            concurrency_limit: before.concurrency_limit,
            upstream_models: before.upstream_models,
            monthly_budget_amount: before.monthly_budget_amount,
            monthly_budget_currency: before.monthly_budget_currency,
          },
          after: {
            name: updated.name,
            concurrency_limit: updated.concurrency_limit,
            upstream_models: updated.upstream_models,
            monthly_budget_amount: updated.monthly_budget_amount,
            monthly_budget_currency: updated.monthly_budget_currency,
            operating_snapshot: snapshot ? {
              id: snapshot.id, version: snapshot.version,
              subscription_period_id: snapshot.subscription_period_id,
              package_cost: snapshot.package_cost, total_quota: snapshot.total_quota,
              quota_unit: snapshot.quota_unit, effective_from: snapshot.effective_from,
              effective_until: snapshot.effective_until,
            } : null,
          },
        },
        result: "SUCCESS",
      });
      return { resource: resourceView(updated, snapshot) };
    },
  );
}
