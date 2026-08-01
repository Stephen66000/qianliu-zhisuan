import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  RuntimeAssuranceConflictError,
  type RuleVersionInput,
} from "@qianliu/database";
import { credentialFingerprint, encryptCredential } from "@qianliu/provider-adapters";
import { requireAuth } from "../plugins/auth-guard.js";

const ExpectedVersionSchema = z.object({ expected_version: z.number().int().positive() });
const PersonCreateSchema = z.object({
  name: z.string().trim().min(1).max(128),
  department_label: z.string().trim().max(128).nullable().optional(),
});
const PersonUpdateSchema = PersonCreateSchema.partial().extend({
  status: z.enum(["ACTIVE", "DISABLED"]).optional(),
  expected_version: z.number().int().positive(),
});
const WecomIdentitySchema = z.object({
  provider_user_id: z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9._@-]+$/),
  expected_version: z.number().int().positive(),
});
const BindSchema = z.object({ person_id: z.string().uuid(), expected_version: z.number().int().positive() });

const RuleVersionSchema = z.object({
  provider_id: z.string().uuid().nullable().optional(),
  provider_resource_id: z.string().uuid().nullable().optional(),
  unified_model_id: z.string().uuid().nullable().optional(),
  upstream_model: z.string().trim().max(128).nullable().optional(),
  unified_signal: z.enum([
    "RATE_LIMIT_RETRY_AFTER", "QUOTA_EXHAUSTED", "PLAN_EXPIRED", "MODEL_UNAUTHORIZED",
    "UPSTREAM_MAINTENANCE", "CONFIGURATION_ERROR", "TECHNICAL_FAILURE",
  ]).nullable().optional(),
  action: z.enum(["WARN_ONLY", "BLOCK"]),
  recovery_method: z.enum([
    "RETRY_AFTER", "UPSTREAM_RESET_TIME", "FIXED_DURATION", "SCHEDULE_END", "MANUAL",
  ]).nullable().optional(),
  fallback_duration_seconds: z.number().int().positive().max(31_536_000).nullable().optional(),
  schedule_timezone: z.string().trim().max(64).nullable().optional(),
  schedule_days_of_week: z.array(z.number().int().min(0).max(6)).max(7).nullable().optional(),
  schedule_start_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/).nullable().optional(),
  schedule_end_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/).nullable().optional(),
  priority: z.number().int().min(0).max(10_000).optional(),
  effective_from: z.coerce.date().nullable().optional(),
  effective_to: z.coerce.date().nullable().optional(),
});
const CreateRuleSchema = z.object({
  name: z.string().trim().min(1).max(128),
  rule_type: z.enum(["UPSTREAM_SIGNAL", "SCHEDULE_BLOCK", "OBSERVATION_ALERT"]),
  description: z.string().max(2000).nullable().optional(),
  version: RuleVersionSchema,
});
const UpdateRuleSchema = z.object({
  name: z.string().trim().min(1).max(128).optional(),
  description: z.string().max(2000).nullable().optional(),
  expected_version: z.number().int().positive(),
  version: RuleVersionSchema.partial().default({}),
});
const RollbackSchema = ExpectedVersionSchema.extend({ source_rule_version: z.number().int().positive() });
const RecoverSchema = z.object({ reason: z.string().trim().min(1).max(255) });
const EndpointSchema = z.object({
  corp_id: z.string().trim().min(1).max(128),
  agent_id: z.string().trim().min(1).max(64),
  secret: z.string().min(1).max(4096).optional(),
  status: z.enum(["ACTIVE", "DISABLED"]),
  expected_version: z.number().int().positive().optional(),
});

function invalid(reply: FastifyReply, error: z.ZodError) {
  return reply.code(400).send({ error: "invalid_request", message: error.issues[0]?.message ?? "参数错误" });
}

function conflict(reply: FastifyReply, error: unknown) {
  if (error instanceof RuntimeAssuranceConflictError) {
    const notFound = error.code.endsWith("_not_found");
    return reply.code(notFound ? 404 : 409).send({ error: error.code, message: error.message, details: error.details });
  }
  throw error;
}

function endpointView(endpoint: Awaited<ReturnType<FastifyInstance["runtimeAssuranceRepo"]["getEndpoint"]>>) {
  if (!endpoint) return null;
  return {
    id: endpoint.id,
    provider: endpoint.provider,
    corp_id: endpoint.corp_id,
    agent_id: endpoint.agent_id,
    secret_masked: "••••••••",
    secret_fingerprint: endpoint.secret_fingerprint,
    status: endpoint.status,
    version: endpoint.version,
    created_at: endpoint.created_at,
    updated_at: endpoint.updated_at,
  };
}

export function registerRuntimeAssuranceRoutes(app: FastifyInstance): void {
  app.get("/people", { preHandler: [requireAuth] }, async () => ({ people: await app.runtimeAssuranceRepo.listPeople() }));

  app.post("/people", { preHandler: [requireAuth] }, async (req, reply) => {
    const parsed = PersonCreateSchema.safeParse(req.body);
    if (!parsed.success) return invalid(reply, parsed.error);
    const person = await app.runtimeAssuranceRepo.createPerson({
      name: parsed.data.name, departmentLabel: parsed.data.department_label,
    });
    await app.auditRepo.write({ enterprise_id: req.admin!.enterpriseId, admin_user_id: req.admin!.adminUserId,
      action: "person.create", target_type: "person", target_id: person.id,
      change_summary: { name: person.name }, result: "SUCCESS" });
    return reply.code(201).send({ person });
  });

  app.patch<{ Params: { id: string } }>("/people/:id", { preHandler: [requireAuth] }, async (req, reply) => {
    const parsed = PersonUpdateSchema.safeParse(req.body);
    if (!parsed.success) return invalid(reply, parsed.error);
    try {
      const person = await app.runtimeAssuranceRepo.updatePerson({
        id: req.params.id, expectedVersion: parsed.data.expected_version,
        name: parsed.data.name, departmentLabel: parsed.data.department_label, status: parsed.data.status,
      });
      await app.auditRepo.write({ enterprise_id: req.admin!.enterpriseId, admin_user_id: req.admin!.adminUserId,
        action: parsed.data.status === "DISABLED" ? "person.disable" : "person.update",
        target_type: "person", target_id: person.id,
        change_summary: { status: person.status, version: person.version }, result: "SUCCESS" });
      return { person };
    } catch (error) { return conflict(reply, error); }
  });

  app.patch<{ Params: { id: string } }>("/people/:id/wecom-identity", { preHandler: [requireAuth] }, async (req, reply) => {
    const parsed = WecomIdentitySchema.safeParse(req.body);
    if (!parsed.success) return invalid(reply, parsed.error);
    try {
      const identity = await app.runtimeAssuranceRepo.setWecomIdentity({
        personId: req.params.id, expectedPersonVersion: parsed.data.expected_version,
        userId: parsed.data.provider_user_id,
      });
      await app.auditRepo.write({ enterprise_id: req.admin!.enterpriseId, admin_user_id: req.admin!.adminUserId,
        action: "person.wecom_identity.update", target_type: "person", target_id: req.params.id,
        change_summary: { provider: "WECOM", configured: true }, result: "SUCCESS" });
      return { identity };
    } catch (error) { return conflict(reply, error); }
  });

  const bind = (relation: "PERSON" | "OWNER") => async (req: { params: { id: string }; body: unknown; admin?: { enterpriseId: string; adminUserId: string } }, reply: FastifyReply) => {
    const parsed = BindSchema.safeParse(req.body);
    if (!parsed.success) return invalid(reply, parsed.error);
    try {
      const principal = await app.runtimeAssuranceRepo.bindPrincipal({
        principalId: req.params.id, personId: parsed.data.person_id, relation,
        expectedVersion: parsed.data.expected_version,
      });
      await app.auditRepo.write({ enterprise_id: req.admin!.enterpriseId, admin_user_id: req.admin!.adminUserId,
        action: relation === "PERSON" ? "principal.person.bind" : "principal.owner.bind",
        target_type: "principal", target_id: principal.id,
        change_summary: { person_id: parsed.data.person_id, relation }, result: "SUCCESS" });
      return { principal };
    } catch (error) { return conflict(reply, error); }
  };
  app.patch<{ Params: { id: string } }>("/principals/:id/person", { preHandler: [requireAuth] }, bind("PERSON"));
  app.patch<{ Params: { id: string } }>("/principals/:id/owner", { preHandler: [requireAuth] }, bind("OWNER"));

  app.get("/availability-rules", { preHandler: [requireAuth] }, async (req) => {
    const history = (req.query as { history?: string }).history === "true";
    return { rules: await app.runtimeAssuranceRepo.listRules(history) };
  });
  app.get<{ Params: { id: string } }>("/availability-rules/:id", { preHandler: [requireAuth] }, async (req, reply) => {
    const rule = await app.runtimeAssuranceRepo.getRule(req.params.id);
    return rule ? { rule } : reply.code(404).send({ error: "rule_not_found", message: "规则不存在" });
  });
  app.post("/availability-rules", { preHandler: [requireAuth] }, async (req, reply) => {
    const parsed = CreateRuleSchema.safeParse(req.body);
    if (!parsed.success) return invalid(reply, parsed.error);
    const rule = await app.runtimeAssuranceRepo.createRule({
      name: parsed.data.name, ruleType: parsed.data.rule_type, description: parsed.data.description,
      actorId: req.admin!.adminUserId, version: parsed.data.version as RuleVersionInput,
    });
    await app.auditRepo.write({ enterprise_id: req.admin!.enterpriseId, admin_user_id: req.admin!.adminUserId,
      action: "availability_rule.create", target_type: "availability_rule", target_id: rule.rule.id,
      change_summary: { rule_type: rule.rule.rule_type, rule_version: 1 }, result: "SUCCESS" });
    return reply.code(201).send({ rule });
  });
  app.patch<{ Params: { id: string } }>("/availability-rules/:id", { preHandler: [requireAuth] }, async (req, reply) => {
    const parsed = UpdateRuleSchema.safeParse(req.body);
    if (!parsed.success) return invalid(reply, parsed.error);
    try {
      const rule = await app.runtimeAssuranceRepo.updateRuleDraft({
        ruleId: req.params.id, expectedVersion: parsed.data.expected_version, actorId: req.admin!.adminUserId,
        name: parsed.data.name, description: parsed.data.description, version: parsed.data.version,
      });
      await app.auditRepo.write({ enterprise_id: req.admin!.enterpriseId, admin_user_id: req.admin!.adminUserId,
        action: "availability_rule.edit", target_type: "availability_rule", target_id: req.params.id,
        change_summary: { rule_version: rule.current_version.rule_version, status: "DRAFT" }, result: "SUCCESS" });
      return { rule };
    } catch (error) { return conflict(reply, error); }
  });
  app.post<{ Params: { id: string } }>("/availability-rules/:id/publish", { preHandler: [requireAuth] }, async (req, reply) => {
    const parsed = ExpectedVersionSchema.safeParse(req.body);
    if (!parsed.success) return invalid(reply, parsed.error);
    try {
      const rule = await app.runtimeAssuranceRepo.publishRule(req.params.id, parsed.data.expected_version, req.admin!.adminUserId);
      await app.auditRepo.write({ enterprise_id: req.admin!.enterpriseId, admin_user_id: req.admin!.adminUserId,
        action: "availability_rule.publish", target_type: "availability_rule", target_id: req.params.id,
        change_summary: { rule_version: rule.current_version.rule_version }, result: "SUCCESS" });
      return { rule };
    } catch (error) { return conflict(reply, error); }
  });
  app.post<{ Params: { id: string } }>("/availability-rules/:id/disable", { preHandler: [requireAuth] }, async (req, reply) => {
    const parsed = ExpectedVersionSchema.safeParse(req.body);
    if (!parsed.success) return invalid(reply, parsed.error);
    try {
      const rule = await app.runtimeAssuranceRepo.disableRule(req.params.id, parsed.data.expected_version, req.admin!.adminUserId);
      await app.auditRepo.write({ enterprise_id: req.admin!.enterpriseId, admin_user_id: req.admin!.adminUserId,
        action: "availability_rule.disable", target_type: "availability_rule", target_id: req.params.id,
        change_summary: { rule_version: rule.current_version.rule_version }, result: "SUCCESS" });
      return { rule };
    } catch (error) { return conflict(reply, error); }
  });
  app.post<{ Params: { id: string } }>("/availability-rules/:id/rollback", { preHandler: [requireAuth] }, async (req, reply) => {
    const parsed = RollbackSchema.safeParse(req.body);
    if (!parsed.success) return invalid(reply, parsed.error);
    try {
      const rule = await app.runtimeAssuranceRepo.rollbackRule(
        req.params.id, parsed.data.source_rule_version, parsed.data.expected_version, req.admin!.adminUserId,
      );
      await app.auditRepo.write({ enterprise_id: req.admin!.enterpriseId, admin_user_id: req.admin!.adminUserId,
        action: "availability_rule.rollback", target_type: "availability_rule", target_id: req.params.id,
        change_summary: { source_rule_version: parsed.data.source_rule_version, new_rule_version: rule.current_version.rule_version }, result: "SUCCESS" });
      return { rule };
    } catch (error) { return conflict(reply, error); }
  });

  app.get("/runtime-assurance/overview", { preHandler: [requireAuth] }, async () => app.runtimeAssuranceRepo.getOverview());
  app.get("/availability-events", { preHandler: [requireAuth] }, async (req) => ({
    events: await app.runtimeAssuranceRepo.listEvents((req.query as { history?: string }).history === "true"),
  }));
  app.post<{ Params: { id: string } }>("/availability-events/:id/recover", { preHandler: [requireAuth] }, async (req, reply) => {
    const parsed = RecoverSchema.safeParse(req.body);
    if (!parsed.success) return invalid(reply, parsed.error);
    try {
      const event = await app.runtimeAssuranceRepo.recoverEvent(req.params.id, parsed.data.reason, true, true);
      await app.auditRepo.write({ enterprise_id: req.admin!.enterpriseId, admin_user_id: req.admin!.adminUserId,
        action: "availability_event.recover", target_type: "availability_event", target_id: event.id,
        change_summary: { status: event.status }, result: "SUCCESS" });
      return { event };
    } catch (error) { return conflict(reply, error); }
  });

  app.get("/notification-endpoints/wecom-app", { preHandler: [requireAuth] }, async () => ({
    endpoint: endpointView(await app.runtimeAssuranceRepo.getEndpoint()),
  }));
  app.patch("/notification-endpoints/wecom-app", { preHandler: [requireAuth] }, async (req, reply) => {
    const parsed = EndpointSchema.safeParse(req.body);
    if (!parsed.success) return invalid(reply, parsed.error);
    const current = await app.runtimeAssuranceRepo.getEndpoint();
    if (!current && !parsed.data.secret) {
      return reply.code(400).send({ error: "secret_required", message: "首次配置必须提供应用 Secret" });
    }
    try {
      const encrypted = parsed.data.secret
        ? encryptCredential(parsed.data.secret, app.credentialKek)
        : JSON.parse(current!.secret_ciphertext) as ReturnType<typeof encryptCredential>;
      const endpoint = await app.runtimeAssuranceRepo.saveEndpoint({
        corpId: parsed.data.corp_id, agentId: parsed.data.agent_id,
        secretCiphertext: JSON.stringify(encrypted),
        secretFingerprint: parsed.data.secret ? credentialFingerprint(parsed.data.secret) : current!.secret_fingerprint,
        status: parsed.data.status, expectedVersion: parsed.data.expected_version,
      });
      await app.auditRepo.write({ enterprise_id: req.admin!.enterpriseId, admin_user_id: req.admin!.adminUserId,
        action: "notification_endpoint.update", target_type: "notification_endpoint", target_id: endpoint.id,
        change_summary: { provider: "WECOM_APP", status: endpoint.status, secret_rotated: Boolean(parsed.data.secret) }, result: "SUCCESS" });
      return { endpoint: endpointView(endpoint) };
    } catch (error) { return conflict(reply, error); }
  });
  app.post("/notification-endpoints/wecom-app/test", { preHandler: [requireAuth] }, async (req, reply) => {
    const parsed = z.object({ person_id: z.string().uuid() }).safeParse(req.body);
    if (!parsed.success) return invalid(reply, parsed.error);
    try {
      const delivery = await app.runtimeAssuranceRepo.enqueueTestDelivery(parsed.data.person_id);
      await app.auditRepo.write({ enterprise_id: req.admin!.enterpriseId, admin_user_id: req.admin!.adminUserId,
        action: "notification_endpoint.test", target_type: "notification_delivery", target_id: delivery.id,
        change_summary: { person_id: parsed.data.person_id, queued: true }, result: "SUCCESS" });
      return reply.code(202).send({ delivery });
    } catch (error) { return conflict(reply, error); }
  });
  app.get("/notification-deliveries", { preHandler: [requireAuth] }, async (req) => ({
    deliveries: await app.runtimeAssuranceRepo.listDeliveries(Math.min(Number((req.query as { limit?: string }).limit ?? 100), 500)),
  }));
}
