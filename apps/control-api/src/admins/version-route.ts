import type { FastifyInstance } from "fastify";
import { requireAuth } from "../plugins/auth-guard.js";
export function registerVersionRoute(app: FastifyInstance) {
  app.get("/system-version", { preHandler: [requireAuth] }, async req => {
    const releases = await app.db.selectFrom("deployment_log")
      .select(["id", "from_version", "to_version", "status", "started_at", "finished_at", "summary"])
      .where("enterprise_id", "=", req.admin!.enterpriseId).orderBy("started_at", "desc").limit(30).execute();
    return { product: "仟流智算", version: process.env.APP_VERSION ?? null, releases };
  });
}
