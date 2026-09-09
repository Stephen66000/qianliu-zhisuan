import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { z } from "zod";
import { requireAuth } from "./auth-guard.js";
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => {
  const d = new Date(v); return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}, "无效日期");
export function registerAuditQuery(app: FastifyInstance): void {
  app.get("/operation-logs", { preHandler: [requireAuth] }, async (req, reply) => {
    const parsed = z.object({ limit: z.coerce.number().int().min(1).max(500).default(50),
      offset: z.coerce.number().int().min(0).default(0), from: date.optional(), to: date.optional(),
      actor: z.string().uuid().optional(), result: z.enum(["SUCCESS", "FAILURE"]).optional(),
      search: z.string().trim().max(128).optional(), target_type: z.string().max(128).optional(),
      target_id: z.string().uuid().optional(),
    }).refine(q => !q.from || !q.to || q.from <= q.to, "开始日期不能晚于结束日期").safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_query", message: parsed.error.issues[0]?.message });
    const q = parsed.data;
    const enterprise = await app.db.selectFrom("enterprise").select("timezone").where("id", "=", req.admin!.enterpriseId).executeTakeFirstOrThrow();
    let base = app.db.selectFrom("operation_log as l").leftJoin("admin_user as a", j => j.onRef("a.id", "=", "l.admin_user_id").onRef("a.enterprise_id", "=", "l.enterprise_id"))
      .leftJoin("principal as p", j => j.onRef("p.id", "=", "l.target_id").onRef("p.enterprise_id", "=", "l.enterprise_id").on("l.target_type", "=", "principal"))
      .leftJoin("provider_resource as r", j => j.onRef("r.id", "=", "l.target_id").onRef("r.enterprise_id", "=", "l.enterprise_id").on("l.target_type", "=", "provider_resource"))
      .leftJoin("admin_user as target", j => j.onRef("target.id", "=", "l.target_id").onRef("target.enterprise_id", "=", "l.enterprise_id").on("l.target_type", "=", "admin_user"))
      .where("l.enterprise_id", "=", req.admin!.enterpriseId);
    if (q.from) base = base.where(sql<boolean>`(l.created_at AT TIME ZONE ${enterprise.timezone})::date >= ${q.from}::date`);
    if (q.to) base = base.where(sql<boolean>`(l.created_at AT TIME ZONE ${enterprise.timezone})::date <= ${q.to}::date`);
    if (q.actor) base = base.where("l.admin_user_id", "=", q.actor);
    if (q.result) base = base.where("l.result", "=", q.result);
    if (q.target_type) base = base.where("l.target_type", "=", q.target_type);
    if (q.target_id) base = base.where("l.target_id", "=", q.target_id);
    if (q.search) base = base.where(eb => eb.or([eb("l.action", "ilike", `%${q.search}%`),
      eb("a.display_name", "ilike", `%${q.search}%`), eb("p.name", "ilike", `%${q.search}%`),
      eb("r.name", "ilike", `%${q.search}%`), eb("target.display_name", "ilike", `%${q.search}%`)]));
    const count = await base.select(eb => eb.fn.countAll<string>().as("total")).executeTakeFirstOrThrow();
    const logs = await base.selectAll("l").select(["a.display_name as actor_name", "a.username as actor_username",
      sql<string | null>`coalesce(p.name, r.name, target.display_name)`.as("target_name")])
      .orderBy("l.created_at", "desc").orderBy("l.id", "desc").limit(q.limit).offset(q.offset).execute();
    const actors = await app.db.selectFrom("admin_user").select(["id", "display_name", "username"])
      .where("enterprise_id", "=", req.admin!.enterpriseId).orderBy("created_at").execute();
    return { logs, total: Number(count.total), timezone: enterprise.timezone, actors };
  });
}
