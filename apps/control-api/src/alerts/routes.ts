/**
 * 异常告警路由（W20）—— 四域派生告警 + 标记已处理。
 *
 * 依据：PRD §11（四告警域、可标记已处理、一期只在管理后台展示、可追踪到请求）。
 * 派生视图实时判定（AlertRepository），处置复用 discrepancy 状态机。
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../plugins/auth-guard.js";

const DispositionSchema = z.object({
  alert_key: z.string().min(1).max(255),
  domain: z.enum(["RESOURCE_UNAVAILABLE", "USAGE_SPIKE", "QUOTA_ANOMALY", "CREDENTIAL_INVALID"]),
  status: z.enum(["INVESTIGATING", "RESOLVED", "IGNORED"]),
  resolution_note: z.string().max(2000).optional(),
  ai_request_id: z.string().uuid().nullable().optional(),
});

export function registerAlertRoutes(app: FastifyInstance): void {
  // 四域告警（派生视图 + 处置状态合并）
  app.get("/alerts", { preHandler: [requireAuth] }, async (req) => {
    const alerts = await app.alertRepo.listAlerts(req.admin!.enterpriseId);
    return { alerts };
  });

  // 标记已处理（写操作日志）
  app.post("/alerts/disposition", { preHandler: [requireAuth] }, async (req, reply) => {
    const parsed = DispositionSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", message: parsed.error.message });
    }
    const ent = req.admin!.enterpriseId;
    await app.alertRepo.setDisposition(
      ent,
      parsed.data.alert_key,
      parsed.data.domain,
      parsed.data.status,
      parsed.data.resolution_note,
      parsed.data.ai_request_id ?? null,
    );
    await app.auditRepo.write({
      enterprise_id: ent,
      admin_user_id: req.admin!.adminUserId,
      action: "alert.disposition",
      target_type: "alert",
      // operation_log.target_id 是 uuid 类型，alert_key 是 "DOMAIN:uuid" 字符串，
      // 不能塞进 uuid 列（22P02）；target_id 置 null，alert_key 放 change_summary。
      target_id: null,
      change_summary: {
        alert_key: parsed.data.alert_key,
        status: parsed.data.status,
        domain: parsed.data.domain,
      },
      result: "SUCCESS",
    });
    return { ok: true };
  });
}
