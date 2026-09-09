/**
 * 异常告警路由（P1-05 整改）—— 独立 alert_event 事实表 + 生命周期。
 *
 * 依据：PRD §11（四告警域、可标记已处理、可追踪）、TRD §13（阈值由配置管理、
 * 告警写入 alert_event、首页只展示未处理重要事件）。
 *
 * GET /alerts：先 evaluate（派生→落库→源恢复 AUTO_RESOLVED），返回未处理 + 历史分开。
 * POST /alerts/disposition：处置（RESOLVED/IGNORED/INVESTIGATING），写 audit。
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../plugins/auth-guard.js";

const DispositionSchema = z.object({
  alert_key: z.string().min(1).max(255),
  alert_id: z.string().uuid().optional(),
  status: z.enum(["INVESTIGATING", "RESOLVED", "IGNORED"]),
  resolution_note: z.string().trim().max(2000).optional(),
}).refine((value) => value.status === "INVESTIGATING" || Boolean(value.resolution_note), {
  message: "已处理必须填写处理说明", path: ["resolution_note"],
});

const ListQuerySchema = z.object({
  history: z.enum(["true", "false"]).optional(),
});

export function registerAlertRoutes(app: FastifyInstance): void {
  // 未处理告警（OPEN + INVESTIGATING）；?history=true 时含已处理历史
  app.get("/alerts", { preHandler: [requireAuth] }, async (req, reply) => {
    const parsed = ListQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", message: parsed.error.message });
    }
    const ent = req.admin!.enterpriseId;
    // 先评估（派生→落库→源恢复 AUTO_RESOLVED），保证看到的是最新状态
    const active = await app.alertEventRepo.evaluate(ent);
    if (parsed.data.history === "true") {
      const history = await app.alertEventRepo.listHistory(ent);
      return { alerts: active, history };
    }
    return { alerts: active };
  });

  // 处置（标记已处理/忽略/处理中）
  app.post("/alerts/disposition", { preHandler: [requireAuth] }, async (req, reply) => {
    const parsed = DispositionSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", message: parsed.error.message });
    }
    const ent = req.admin!.enterpriseId;
    const updated = await app.alertEventRepo.setDisposition(
      ent,
      parsed.data.alert_key,
      parsed.data.status,
      parsed.data.resolution_note,
      req.admin!.adminUserId,
      parsed.data.alert_id,
    );
    if (!updated) {
      return reply
        .code(404)
        .send({ error: "not_found", message: "告警不存在或已处理" });
    }
    return { ok: true };
  });
}
