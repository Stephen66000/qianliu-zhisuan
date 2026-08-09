/** POOL-043 —— 独立员工账／项目账与模型请求下钻。 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  InvalidOperatingBillMonthError,
  OperatingBillAccountEvidenceUnavailableError,
  OperatingBillAccountReferenceError,
} from "@qianliu/database";
import { requireAuth } from "../plugins/auth-guard.js";

const MonthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const IdSchema = z.string().uuid();
const AccountQuerySchema = z.object({
  provider_code: z.string().trim().min(1).max(64).optional(),
  search: z.string().trim().max(255).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});
const RequestQuerySchema = z.object({
  provider_code: z.string().trim().min(1).max(64).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

function invalid(reply: FastifyReply) {
  return reply.code(400).send({ error: "invalid_request", message: "请求参数不合法" });
}

function handleError(error: unknown, reply: FastifyReply) {
  if (error instanceof InvalidOperatingBillMonthError) return invalid(reply);
  if (error instanceof OperatingBillAccountReferenceError) {
    return reply.code(404).send({ error: "not_found", message: "员工或模型不存在" });
  }
  if (error instanceof OperatingBillAccountEvidenceUnavailableError) {
    return reply.code(409).send({
      error: "account_evidence_unavailable",
      message: "该历史结账版本未冻结账户下钻证据，请重开并重新结账后查看",
    });
  }
  throw error;
}

export function registerOperatingBillAccountRoutes(app: FastifyInstance): void {
  app.get<{ Params: { month: string }; Querystring: Record<string, unknown> }>(
    "/operating-bills/:month/employees",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const month = MonthSchema.safeParse(req.params.month);
      const query = AccountQuerySchema.safeParse(req.query);
      if (!month.success || !query.success) return invalid(reply);
      try {
        return await app.operatingBillAccountRepo.listAccounts(
          req.admin!.enterpriseId, month.data, "EMPLOYEE",
          {
            providerCode: query.data.provider_code, search: query.data.search,
            limit: query.data.limit, offset: query.data.offset,
          },
        );
      } catch (error) {
        return handleError(error, reply);
      }
    },
  );

  app.get<{ Params: { month: string }; Querystring: Record<string, unknown> }>(
    "/operating-bills/:month/projects",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const month = MonthSchema.safeParse(req.params.month);
      const query = AccountQuerySchema.safeParse(req.query);
      if (!month.success || !query.success) return invalid(reply);
      try {
        return await app.operatingBillAccountRepo.listAccounts(
          req.admin!.enterpriseId, month.data, "PROJECT",
          {
            providerCode: query.data.provider_code, search: query.data.search,
            limit: query.data.limit, offset: query.data.offset,
          },
        );
      } catch (error) {
        return handleError(error, reply);
      }
    },
  );

  app.get<{
    Params: { month: string; principalId: string };
    Querystring: Record<string, unknown>;
  }>(
    "/operating-bills/:month/employees/:principalId",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const params = z.object({ month: MonthSchema, principalId: IdSchema }).safeParse(req.params);
      const query = AccountQuerySchema.pick({ provider_code: true }).safeParse(req.query);
      if (!params.success || !query.success) return invalid(reply);
      try {
        return await app.operatingBillAccountRepo.getEmployeeDetail(
          req.admin!.enterpriseId, params.data.month, params.data.principalId,
          query.data.provider_code,
        );
      } catch (error) {
        return handleError(error, reply);
      }
    },
  );

  app.get<{
    Params: { month: string; principalId: string; unifiedModelId: string };
    Querystring: Record<string, unknown>;
  }>(
    "/operating-bills/:month/employees/:principalId/models/:unifiedModelId/requests",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const params = z.object({
        month: MonthSchema, principalId: IdSchema, unifiedModelId: IdSchema,
      }).safeParse(req.params);
      const query = RequestQuerySchema.safeParse(req.query);
      if (!params.success || !query.success) return invalid(reply);
      try {
        return await app.operatingBillAccountRepo.listEmployeeModelRequests(
          req.admin!.enterpriseId, params.data.month, params.data.principalId,
          params.data.unifiedModelId,
          { providerCode: query.data.provider_code, limit: query.data.limit, offset: query.data.offset },
        );
      } catch (error) {
        return handleError(error, reply);
      }
    },
  );
}
