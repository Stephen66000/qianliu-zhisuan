import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { loadOperatingAnalysis } from "@qianliu/database";
import { requireAuth } from "../plugins/auth-guard.js";

export function registerOperatingAnalysisRoute(app: FastifyInstance) {
  app.get<{ Params: { month: string } }>(
    "/operating-bills/:month/analysis",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const month = z
        .string()
        .regex(/^(20\d{2}|21\d{2}|2200)-(0[1-9]|1[0-2])$/)
        .safeParse(req.params.month);
      if (!month.success)
        return reply
          .code(400)
          .send({ error: "invalid_request", message: "账单月份不合法" });
      return loadOperatingAnalysis(app.db, req.admin!.enterpriseId, month.data);
    },
  );
}
