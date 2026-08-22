import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { Decimal } from "decimal.js";
import { sql } from "kysely";
import { z } from "zod";
import { requireAuth } from "../plugins/auth-guard.js";

const Month = z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/);
const MoneyDecimal = Decimal.clone({ precision: 48, rounding: Decimal.ROUND_HALF_UP });
const BudgetBody = z.object({
  amount: z.string().regex(/^\d+(?:\.\d{1,8})?$/).nullable(),
  currency: z.string().regex(/^[A-Z]{3,8}$/).nullable(),
  expected_version: z.number().int().nonnegative(),
  idempotency_key: z.string().min(1).max(128),
}).superRefine((value, ctx) => {
  if ((value.amount === null) !== (value.currency === null)) {
    ctx.addIssue({ code: "custom", path: ["amount"], message: "预算金额与币种必须同时填写或清除" });
  }
  if (value.amount !== null && new MoneyDecimal(value.amount).lte(0)) {
    ctx.addIssue({ code: "custom", path: ["amount"], message: "预算金额必须大于 0" });
  }
});

export function registerResourceMonthlyBudgetRoutes(app: FastifyInstance): void {
  app.get<{ Params: { id: string }; Querystring: { month?: string } }>(
    "/provider-resources/:id/monthly-budgets",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const month = Month.safeParse(req.query.month);
      if (!month.success) return reply.code(400).send({ error: "invalid_request", message: "month 必须为 YYYY-MM" });
      const enterpriseId = req.admin!.enterpriseId;
      const resource = await app.db.selectFrom("provider_resource")
        .select(["id", "name", "mode"]).where("enterprise_id", "=", enterpriseId)
        .where("id", "=", req.params.id).executeTakeFirst();
      if (!resource) return reply.code(404).send({ error: "not_found", message: "资源不存在" });
      const rows = await app.db.selectFrom("provider_resource_monthly_budget as budget")
        .innerJoin("admin_user as actor", (join) => join
          .onRef("actor.id", "=", "budget.created_by")
          .onRef("actor.enterprise_id", "=", "budget.enterprise_id"))
        .selectAll("budget").select("actor.display_name as created_by_name")
        .where("budget.enterprise_id", "=", enterpriseId)
        .where("budget.provider_resource_id", "=", resource.id)
        .where("budget.month", "=", `${month.data}-01`)
        .orderBy("budget.version", "desc").execute();
      const current = rows.find((row) => row.is_current);
      return {
        resource: { id: resource.id, name: resource.name, mode: resource.mode },
        month: month.data,
        current: current ? budgetView(current) : null,
        history: rows.map(budgetView),
      };
    },
  );

  app.put<{ Params: { id: string; month: string } }>(
    "/provider-resources/:id/monthly-budgets/:month",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const month = Month.safeParse(req.params.month);
      const body = BudgetBody.safeParse(req.body);
      if (!month.success || !body.success) {
        return reply.code(400).send({ error: "invalid_request", message: "月预算参数无效" });
      }
      const enterpriseId = req.admin!.enterpriseId;
      const resource = await app.db.selectFrom("provider_resource")
        .select(["id", "name", "mode"]).where("enterprise_id", "=", enterpriseId)
        .where("id", "=", req.params.id).executeTakeFirst();
      if (!resource) return reply.code(404).send({ error: "not_found", message: "资源不存在" });
      if (resource.mode !== "API") {
        return reply.code(409).send({ error: "resource_mode_conflict", message: "Coding Plan 不设置 API 月预算" });
      }
      const monthStart = `${month.data}-01`;
      const requestHash = createHash("sha256").update(JSON.stringify({
        resourceId: resource.id, month: month.data, amount: body.data.amount,
        currency: body.data.currency, expectedVersion: body.data.expected_version,
      })).digest("hex");
      const outcome = await app.db.transaction().execute(async (trx) => {
        await sql`select pg_advisory_xact_lock(hashtext(${`${enterpriseId}:${resource.id}:${month.data}`}))`.execute(trx);
        const prior = await trx.selectFrom("provider_resource_monthly_budget")
          .select(["request_hash", "response_snapshot"])
          .where("enterprise_id", "=", enterpriseId).where("provider_resource_id", "=", resource.id)
          .where("month", "=", monthStart).where("idempotency_key", "=", body.data.idempotency_key)
          .executeTakeFirst();
        if (prior) return prior.request_hash === requestHash
          ? { kind: "ok" as const, value: prior.response_snapshot, replayed: true }
          : { kind: "idempotency_conflict" as const };
        const current = await trx.selectFrom("provider_resource_monthly_budget").selectAll()
          .where("enterprise_id", "=", enterpriseId).where("provider_resource_id", "=", resource.id)
          .where("month", "=", monthStart).where("is_current", "=", true)
          .forUpdate().executeTakeFirst();
        if ((current?.version ?? 0) !== body.data.expected_version) {
          return { kind: "version_conflict" as const };
        }
        if (current) await trx.updateTable("provider_resource_monthly_budget")
          .set({ is_current: false }).where("id", "=", current.id).execute();
        const id = randomUUID();
        const createdAt = new Date();
        const status = body.data.amount === null ? "CLEARED" as const : "ACTIVE" as const;
        const value = { id, resourceId: resource.id, month: month.data,
          version: (current?.version ?? 0) + 1, status, amount: body.data.amount,
          currency: body.data.currency, createdAt: createdAt.toISOString(),
          createdBy: req.admin!.displayName };
        await trx.insertInto("provider_resource_monthly_budget").values({
          id, enterprise_id: enterpriseId, provider_resource_id: resource.id,
          month: monthStart, version: value.version, status, amount: body.data.amount,
          currency: body.data.currency, is_current: true, created_by: req.admin!.adminUserId,
          created_at: createdAt, idempotency_key: body.data.idempotency_key,
          request_hash: requestHash, response_snapshot: value,
        }).execute();
        await trx.insertInto("operation_log").values({
          enterprise_id: enterpriseId,
          admin_user_id: req.admin!.adminUserId,
          action: body.data.amount === null
            ? "provider_resource_monthly_budget.clear"
            : "provider_resource_monthly_budget.update",
          target_type: "provider_resource_monthly_budget",
          target_id: id,
          change_summary: { resource_id: resource.id, month: month.data, version: value.version },
          result: "SUCCESS",
          failure_reason: null,
        }).execute();
        return { kind: "ok" as const, value, replayed: false };
      });
      if (outcome.kind === "idempotency_conflict") {
        return reply.code(409).send({ error: "idempotency_conflict", message: "幂等键已用于不同预算内容" });
      }
      if (outcome.kind === "version_conflict") {
        return reply.code(409).send({ error: "conflict", message: "预算已被其他管理员修改，请刷新" });
      }
      return outcome.value;
    },
  );
}

function budgetView(row: {
  id: string; provider_resource_id: string; month: string | Date; version: number;
  status: "ACTIVE" | "CLEARED"; amount: string | null; currency: string | null;
  created_at: Date; created_by_name: string;
}) {
  const month = row.month instanceof Date ? row.month.toISOString().slice(0, 7) : String(row.month).slice(0, 7);
  return { id: row.id, resourceId: row.provider_resource_id, month, version: row.version,
    status: row.status, amount: row.amount, currency: row.currency,
    createdAt: row.created_at.toISOString(), createdBy: row.created_by_name };
}
