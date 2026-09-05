import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { savePricingConfiguration, PricingConfigurationError, PricingModeConflictError, listPricingReadyRoutes } from "@qianliu/database";
import { requireAuth } from "../plugins/auth-guard.js";
import { CreateBillingRuleSchema } from "./billing-rule-contract.js";

const ConfigurationSchema = z.object({
  submission_id: z.string().uuid(), route_id: z.string().uuid(),
  expected_route_version: z.number().int().positive(), expected_model_version: z.number().int().positive(),
  priority: z.number().int(), weight: z.number().int().positive(),
  source_rule_ids: z.array(z.string().uuid()).max(64).default([]),
  replace_existing: z.boolean().default(false),
  rules: z.array(CreateBillingRuleSchema).min(1).max(64),
});

export function registerPricingConfigurationRoutes(app: FastifyInstance) {
  app.get("/pricing-ready-routes", { preHandler: [requireAuth] }, async (req) => ({
    routes: await listPricingReadyRoutes(app.db, req.admin!.enterpriseId),
  }));
  app.post("/pricing-configurations", { preHandler: [requireAuth] }, async (req, reply) => {
    const parsed = ConfigurationSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", message: parsed.error.message });
    const input = parsed.data;
    try {
      const result = await savePricingConfiguration(app.db, {
        enterpriseId: req.admin!.enterpriseId, adminId: req.admin!.adminUserId,
        routeId: input.route_id, expectedRouteVersion: input.expected_route_version,
        expectedModelVersion: input.expected_model_version, priority: input.priority, weight: input.weight,
        submissionId: input.submission_id, requestHash: createHash("sha256").update(JSON.stringify(input)).digest("hex"),
        sourceRuleIds: input.source_rule_ids, replaceExisting: input.replace_existing,
        rules: input.rules.map((rule) => ({ ...rule, effective_from: new Date(rule.effective_from),
          effective_to: rule.effective_to ? new Date(rule.effective_to) : null,
          time_windows: rule.windows?.map((window) => ({ ...window, days_of_week: window.days_of_week ?? null })) ?? null })),
      });
      return reply.code(result.replayed ? 200 : 201).send(result);
    } catch (error) {
      if (error instanceof PricingConfigurationError || error instanceof PricingModeConflictError) return reply.code(409).send({ error: "configuration_conflict", message: error.message });
      throw error;
    }
  });
}
