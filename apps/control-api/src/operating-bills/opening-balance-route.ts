import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import {
  OperatingBillClosedError,
  OperatingBillFutureOpeningBalanceError,
  OperatingBillOpeningBalanceAlreadyAvailableError,
  OperatingBillOpeningBalanceCurrencyMismatchError,
  OperatingBillReferenceError,
} from "@qianliu/database";
import { requireAuth } from "../plugins/auth-guard.js";

const MonthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const MoneyText = z.union([z.string(), z.number()]).transform(String)
  .refine((value) => /^\d+(?:\.\d{1,2})?$/.test(value), "人工录入金额最多保留两位小数");
const OpeningBalanceSchema = z.object({
  provider_resource_id: z.string().uuid(),
  amount: MoneyText,
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3,8}$/),
  reason: z.string().trim().max(1000).nullable().optional(),
});

function handleError(error: unknown, reply: FastifyReply) {
  if (error instanceof OperatingBillFutureOpeningBalanceError) {
    return reply.code(400).send({ error: "future_month", message: "不能补录未来账期的期初余额" });
  }
  if (error instanceof OperatingBillOpeningBalanceCurrencyMismatchError) {
    return reply.code(409).send({
      error: "opening_balance_currency_mismatch",
      message: "期初余额币种与该账期资源余额币种不一致",
    });
  }
  if (error instanceof OperatingBillOpeningBalanceAlreadyAvailableError) {
    return reply.code(409).send({
      error: "opening_balance_already_available",
      message: "该账期已有自动承接或有效快照期初余额，无需人工补录",
    });
  }
  if (error instanceof OperatingBillClosedError) {
    return reply.code(409).send({ error: "bill_closed", message: "账期已结账，重开后才能修改" });
  }
  if (error instanceof OperatingBillReferenceError) {
    return reply.code(404).send({ error: "not_found", message: "账期或 API 资源不存在" });
  }
  throw error;
}

export function registerOpeningBalanceRoute(app: FastifyInstance): void {
  app.post<{ Params: { month: string } }>(
    "/operating-bills/:month/opening-balances",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const month = MonthSchema.safeParse(req.params.month);
      const body = OpeningBalanceSchema.safeParse(req.body);
      if (!month.success || !body.success) {
        return reply.code(400).send({
          error: "invalid_request",
          message: body.success ? "账期不合法" : (body.error.issues[0]?.message ?? "请求参数不合法"),
        });
      }
      try {
        const result = await app.operatingBillRepo.recordOpeningBalance({
          enterpriseId: req.admin!.enterpriseId, adminId: req.admin!.adminUserId,
          month: month.data, providerResourceId: body.data.provider_resource_id,
          amount: body.data.amount, currency: body.data.currency, reason: body.data.reason ?? null,
        });
        if (result.created) await app.auditRepo.write({
          enterprise_id: req.admin!.enterpriseId, admin_user_id: req.admin!.adminUserId,
          action: "operating_bill.opening_balance.create", target_type: "provider_resource",
          target_id: body.data.provider_resource_id,
          change_summary: {
            month: month.data, amount: body.data.amount, currency: body.data.currency,
            reason: body.data.reason ?? null,
          },
          result: "SUCCESS",
        });
        return reply.code(result.created ? 201 : 200).send(result.bill);
      } catch (error) {
        return handleError(error, reply);
      }
    },
  );
}
